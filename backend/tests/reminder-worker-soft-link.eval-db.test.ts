/**
 * Worker soft-link — PostgreSQL proof (workee_test).
 *
 * Proves Reminder ↔ digital-worker task FKs, no wrong pairing, cancel cascades,
 * and coexistence with user-task EmployeeListItemReminderLinks.
 * Exact-key stays ON. No Prompt/Schema/LIVE. Implementation unchanged unless fail.
 *
 * Run: npm run test:eval-db -- tests/reminder-worker-soft-link.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmReminderAction, PublicEmployee } from "@workee/shared";
import {
  assertApprovedEvalDatabaseUrl,
  evalDatabaseNameFromUrl,
} from "../src/eval/studio-db-guard.js";
import { prisma } from "../src/database/prisma.js";
import {
  applyReminders,
  cancelReminderLinkedToWorkerItem,
  linkRemindersByItemId,
  linkRemindersToWorkerTasks,
  pairWorkerItemsToReminders,
  removeReminderAndLinkedWorkerTask,
} from "../src/services/reminder.service.js";
import { isExactKeySoftLinkEnabled } from "../src/services/reminder-soft-link.js";

const dbUrl = process.env.DATABASE_URL;
assertApprovedEvalDatabaseUrl(dbUrl);
expect(evalDatabaseNameFromUrl(dbUrl!)).toBe("workee_test");

const MARK = `worker-sl-${Date.now()}`;
let userId = "";
let humanId = "";
let digitalId = "";
let humanListId = "";
let workerListId = "";

const actor: PublicEmployee = {
  id: "",
  name: "Eval",
  surname: "",
  nickname: null,
  email: null,
  phone: null,
  kind: "human",
  isOwner: true,
} as PublicEmployee;

const createdItemIds: string[] = [];
const createdReminderIds: string[] = [];

beforeAll(async () => {
  delete process.env.WORKEE_SOFT_LINK_EXACT_KEY;
  expect(isExactKeySoftLinkEnabled()).toBe(true);

  const human = await prisma.employee.findFirst({
    where: { kind: "human", isGuest: false },
    select: {
      id: true,
      userId: true,
      name: true,
      surname: true,
      nickname: true,
      email: true,
      phone: true,
      isOwner: true,
    },
  });
  if (!human) {
    throw new Error("eval-db: need a human employee on workee_test");
  }
  humanId = human.id;
  userId = human.userId;
  actor.id = human.id;
  actor.name = human.name;
  actor.surname = human.surname ?? "";
  actor.nickname = human.nickname;
  actor.email = human.email;
  actor.phone = human.phone;
  actor.isOwner = human.isOwner === true;

  const digital = await prisma.employee.findFirst({
    where: { userId, kind: "digital" },
    select: { id: true, name: true },
  });
  if (!digital) {
    throw new Error(
      "eval-db: need a digital employee on workee_test for worker soft-link proof",
    );
  }
  digitalId = digital.id;

  const humanList =
    (await prisma.employeeList.findFirst({
      where: { employeeId: humanId, listType: "tasks", deletedAt: null },
      select: { id: true },
    })) ??
    (await prisma.employeeList.create({
      data: {
        employeeId: humanId,
        listType: "tasks",
        name: "",
        scope: "personal",
        visibleTo: [humanId],
      },
      select: { id: true },
    }));
  humanListId = humanList.id;

  const workerList =
    (await prisma.employeeList.findFirst({
      where: { employeeId: digitalId, listType: "tasks", deletedAt: null },
      select: { id: true },
    })) ??
    (await prisma.employeeList.create({
      data: {
        employeeId: digitalId,
        listType: "tasks",
        name: "",
        scope: "personal",
        visibleTo: [digitalId, humanId],
      },
      select: { id: true },
    }));
  workerListId = workerList.id;
});

afterAll(async () => {
  if (createdReminderIds.length > 0) {
    await prisma.employeeListItemReminderLink.deleteMany({
      where: { reminderId: { in: createdReminderIds } },
    });
    await prisma.reminder.deleteMany({
      where: { id: { in: createdReminderIds } },
    });
  }
  if (createdItemIds.length > 0) {
    await prisma.employeeListItem.deleteMany({
      where: { id: { in: createdItemIds } },
    });
  }
  await prisma.employeeListItemReminderLink.deleteMany({
    where: { listItem: { itemKey: { startsWith: MARK } } },
  });
  await prisma.reminder.deleteMany({
    where: { itemKey: { startsWith: MARK } },
  });
  await prisma.employeeListItem.deleteMany({
    where: { itemKey: { startsWith: MARK } },
  });
});

function trackItem(id: string) {
  createdItemIds.push(id);
  return id;
}
function trackRem(id: string) {
  createdReminderIds.push(id);
  return id;
}

function baseAdd(
  overrides: Partial<LlmReminderAction> & Pick<LlmReminderAction, "item" | "time">,
): LlmReminderAction {
  return {
    action: "add",
    item: overrides.item,
    listType: "tasks",
    date: overrides.date ?? "2026-12-22",
    time: overrides.time,
    repeat: "once",
    ping: overrides.ping ?? [],
    about: [],
    targets: overrides.targets ?? [],
    text: overrides.text ?? "",
    inSeconds: null,
    everyCount: null,
    everyUnit: null,
    weekdays: null,
    confirmed: false,
    compose: false,
    composeSource: "",
    composeLookbackHours: 0,
    composePlace: "",
    reminderId: "",
    ...(overrides.itemId ? { itemId: overrides.itemId } : {}),
  };
}

async function createSpeakerTask(itemKey: string) {
  const row = await prisma.employeeListItem.create({
    data: {
      id: randomUUID(),
      listId: humanListId,
      itemKey,
      data: { "שם משימה": itemKey },
      scope: "personal",
      addedById: humanId,
      visibleTo: [humanId],
    },
  });
  return trackItem(row.id);
}

async function createWorkerTask(itemKey: string) {
  const row = await prisma.employeeListItem.create({
    data: {
      id: randomUUID(),
      listId: workerListId,
      itemKey,
      data: { "שם משימה": itemKey },
      scope: "personal",
      addedById: humanId,
      visibleTo: [digitalId, humanId],
    },
  });
  return trackItem(row.id);
}

async function createClock(itemKey: string, time: string, itemId?: string) {
  const result = await applyReminders({
    userId,
    actor,
    employees: [actor],
    reminders: [
      baseAdd({
        item: itemKey,
        time,
        text: itemKey,
        ...(itemId ? { itemId } : {}),
      }),
    ],
  });
  expect(result.saved).toHaveLength(1);
  const id = trackRem(result.saved[0]!.id);
  if (itemId) {
    await linkRemindersByItemId({
      userId,
      actorId: humanId,
      saved: result.saved,
    });
  }
  return { id, saved: result.saved[0]! };
}

async function snapshot(label: string, ids: {
  reminderId?: string;
  workerItemId?: string;
  speakerItemId?: string;
}) {
  const reminder = ids.reminderId
    ? await prisma.reminder.findUnique({
        where: { id: ids.reminderId },
        select: {
          id: true,
          status: true,
          workerItemId: true,
          itemKey: true,
        },
      })
    : null;
  const worker = ids.workerItemId
    ? await prisma.employeeListItem.findUnique({
        where: { id: ids.workerItemId },
        select: {
          id: true,
          deletedAt: true,
          reminderId: true,
          itemKey: true,
        },
      })
    : null;
  const speaker = ids.speakerItemId
    ? await prisma.employeeListItem.findUnique({
        where: { id: ids.speakerItemId },
        select: {
          id: true,
          deletedAt: true,
          reminderId: true,
          linkedReminderId: true,
          itemKey: true,
        },
      })
    : null;
  const joins = ids.reminderId
    ? await prisma.employeeListItemReminderLink.findMany({
        where: { reminderId: ids.reminderId },
        select: { listItemId: true, reminderId: true },
      })
    : ids.speakerItemId
      ? await prisma.employeeListItemReminderLink.findMany({
          where: { listItemId: ids.speakerItemId },
          select: { listItemId: true, reminderId: true },
        })
      : [];
  // Visible in vitest reporter for the approval report.
  console.info(`[worker-sl] ${label}`, {
    reminder,
    worker,
    speaker,
    joins,
  });
  return { reminder, worker, speaker, joins };
}

describe("Worker soft-link (eval-db / PostgreSQL)", () => {
  it("1+2: create reminder linked to digital worker task (both FKs)", async () => {
    const key = `${MARK}-link`;
    const workerId = await createWorkerTask(key);
    const { id: remId } = await createClock(key, "09:00");

    await linkRemindersToWorkerTasks(
      [{ id: remId, itemKey: key, itemLabel: key }],
      [{ id: workerId, itemKey: key }],
    );

    const snap = await snapshot("after worker link", {
      reminderId: remId,
      workerItemId: workerId,
    });
    expect(snap.reminder?.status).toBe("active");
    expect(snap.reminder?.workerItemId).toBe(workerId);
    expect(snap.worker?.deletedAt).toBeNull();
    expect(snap.worker?.reminderId).toBe(remId);
    expect(snap.joins).toEqual([]);
  });

  it("3a: multi pair — exact key only; wrong worker task not linked", async () => {
    const rightKey = `${MARK}-right`;
    const wrongKey = `${MARK}-wrong`;
    const rightWorker = await createWorkerTask(rightKey);
    const wrongWorker = await createWorkerTask(wrongKey);
    const { id: remId } = await createClock(rightKey, "10:00");

    const pairs = pairWorkerItemsToReminders(
      [{ id: remId, itemKey: rightKey, itemLabel: rightKey }],
      [
        { id: wrongWorker, itemKey: wrongKey },
        { id: rightWorker, itemKey: rightKey },
      ],
    );
    expect(pairs).toEqual([{ reminderId: remId, workerItemId: rightWorker }]);

    await linkRemindersToWorkerTasks(
      [{ id: remId, itemKey: rightKey, itemLabel: rightKey }],
      [
        { id: wrongWorker, itemKey: wrongKey },
        { id: rightWorker, itemKey: rightKey },
      ],
    );

    const right = await snapshot("right worker after multi-pair", {
      reminderId: remId,
      workerItemId: rightWorker,
    });
    const wrong = await prisma.employeeListItem.findUnique({
      where: { id: wrongWorker },
      select: { reminderId: true, deletedAt: true },
    });
    console.info("[worker-sl] wrong worker after multi-pair", wrong);

    expect(right.reminder?.workerItemId).toBe(rightWorker);
    expect(right.worker?.reminderId).toBe(remId);
    expect(wrong?.reminderId).toBeNull();
  });

  it("3b: re-link same pair is idempotent — no second clock, FKs stay one-to-one", async () => {
    const key = `${MARK}-idem`;
    const workerId = await createWorkerTask(key);
    const { id: remId } = await createClock(key, "11:00");

    await linkRemindersToWorkerTasks(
      [{ id: remId, itemKey: key, itemLabel: key }],
      [{ id: workerId, itemKey: key }],
    );
    await linkRemindersToWorkerTasks(
      [{ id: remId, itemKey: key, itemLabel: key }],
      [{ id: workerId, itemKey: key }],
    );

    const clocks = await prisma.reminder.count({
      where: { itemKey: key, status: "active" },
    });
    const snap = await snapshot("idempotent re-link", {
      reminderId: remId,
      workerItemId: workerId,
    });
    expect(clocks).toBe(1);
    expect(snap.reminder?.workerItemId).toBe(workerId);
    expect(snap.worker?.reminderId).toBe(remId);
  });

  it("4: delete reminder → cancel clock, soft-delete worker, clear FKs + joins", async () => {
    const key = `${MARK}-del-rem`;
    const speakerId = await createSpeakerTask(key);
    const workerId = await createWorkerTask(`להזכיר ${key}`);
    const { id: remId } = await createClock(key, "12:00", speakerId);

    await linkRemindersToWorkerTasks(
      [{ id: remId, itemKey: key, itemLabel: key }],
      [{ id: workerId, itemKey: `להזכיר ${key}` }],
    );
    // 1:1 special-case pairs even when keys differ — prove both FKs + speaker join coexist.
    const before = await snapshot("before reminder delete", {
      reminderId: remId,
      workerItemId: workerId,
      speakerItemId: speakerId,
    });
    expect(before.reminder?.workerItemId).toBe(workerId);
    expect(before.worker?.reminderId).toBe(remId);
    expect(before.joins).toEqual([
      { listItemId: speakerId, reminderId: remId },
    ]);
    expect(before.speaker?.deletedAt).toBeNull();

    await removeReminderAndLinkedWorkerTask({
      id: remId,
      workerItemId: workerId,
      userId,
      actorEmployeeId: humanId,
      label: key,
    });

    const after = await snapshot("after reminder delete", {
      reminderId: remId,
      workerItemId: workerId,
      speakerItemId: speakerId,
    });
    expect(after.reminder?.status).toBe("cancelled");
    expect(after.reminder?.workerItemId).toBeNull();
    expect(after.worker?.deletedAt).not.toBeNull();
    expect(after.worker?.reminderId).toBeNull();
    expect(after.joins).toEqual([]);
    // Speaker user-task must remain live (join-only; not soft-deleted as worker).
    expect(after.speaker?.deletedAt).toBeNull();
  });

  it("5: delete worker task → cancel linked reminder (contract cascade)", async () => {
    const key = `${MARK}-del-worker`;
    const workerId = await createWorkerTask(key);
    const { id: remId } = await createClock(key, "13:00");
    await linkRemindersToWorkerTasks(
      [{ id: remId, itemKey: key, itemLabel: key }],
      [{ id: workerId, itemKey: key }],
    );

    const cancelled = await cancelReminderLinkedToWorkerItem(workerId);
    expect(cancelled).toEqual([
      expect.objectContaining({ reminderId: remId }),
    ]);

    // Soft-delete the worker row the same way list-remove would after cascade.
    await prisma.employeeListItem.update({
      where: { id: workerId },
      data: { deletedAt: new Date(), reminderId: null },
    });

    const after = await snapshot("after worker delete cascade", {
      reminderId: remId,
      workerItemId: workerId,
    });
    expect(after.reminder?.status).toBe("cancelled");
    expect(after.reminder?.workerItemId).toBeNull();
    expect(after.worker?.deletedAt).not.toBeNull();
    expect(after.worker?.reminderId).toBeNull();
    expect(after.joins).toEqual([]);
  });

  it("6: user-task join coexists and survives wrong-worker non-link; cancel does not delete speaker", async () => {
    const speakerKey = `${MARK}-user-join`;
    const workerKey = `${MARK}-worker-other`;
    const decoyKey = `${MARK}-decoy`;
    const speakerId = await createSpeakerTask(speakerKey);
    const wrongWorker = await createWorkerTask(workerKey);
    const decoyWorker = await createWorkerTask(decoyKey);
    const { id: remId } = await createClock(speakerKey, "14:00", speakerId);

    // Multi workers + mismatched keys → exact-key path; no pair; speaker join intact.
    // (1:1 special-case would pair regardless of key — must use multi set.)
    await linkRemindersToWorkerTasks(
      [{ id: remId, itemKey: speakerKey, itemLabel: speakerKey }],
      [
        { id: wrongWorker, itemKey: workerKey },
        { id: decoyWorker, itemKey: decoyKey },
      ],
    );

    const mid = await snapshot("after refused wrong worker link", {
      reminderId: remId,
      workerItemId: wrongWorker,
      speakerItemId: speakerId,
    });
    expect(mid.reminder?.status).toBe("active");
    expect(mid.reminder?.workerItemId).toBeNull();
    expect(mid.worker?.reminderId).toBeNull();
    expect(mid.joins).toEqual([
      { listItemId: speakerId, reminderId: remId },
    ]);
    expect(mid.speaker?.deletedAt).toBeNull();

    // Matching worker (1:1) — join must remain alongside worker FKs.
    const matchedWorker = await createWorkerTask(speakerKey);
    await linkRemindersToWorkerTasks(
      [{ id: remId, itemKey: speakerKey, itemLabel: speakerKey }],
      [{ id: matchedWorker, itemKey: speakerKey }],
    );
    const linked = await snapshot("worker + user-task join together", {
      reminderId: remId,
      workerItemId: matchedWorker,
      speakerItemId: speakerId,
    });
    expect(linked.reminder?.workerItemId).toBe(matchedWorker);
    expect(linked.worker?.reminderId).toBe(remId);
    expect(linked.joins).toEqual([
      { listItemId: speakerId, reminderId: remId },
    ]);

    // Cancel via worker path must clear join but leave speaker row alive.
    await cancelReminderLinkedToWorkerItem(matchedWorker);
    await prisma.employeeListItem.update({
      where: { id: matchedWorker },
      data: { deletedAt: new Date(), reminderId: null },
    });
    const end = await snapshot("after worker cancel — speaker intact", {
      reminderId: remId,
      workerItemId: matchedWorker,
      speakerItemId: speakerId,
    });
    expect(end.reminder?.status).toBe("cancelled");
    expect(end.joins).toEqual([]);
    expect(end.speaker?.deletedAt).toBeNull();
    expect(end.speaker?.reminderId).toBeNull();
  });
});
