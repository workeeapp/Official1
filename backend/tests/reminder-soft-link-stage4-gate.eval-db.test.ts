/**
 * Stage 4 Gate — exact-key OFF (isolated eval-db / workee_test only).
 *
 * Proves NEW nested + EXISTING item_id joins without itemKey fallback.
 * Does not mutate prod env, Prompt, Schema, or exact-key implementation.
 *
 * Run:
 *   cross-env WORKEE_SOFT_LINK_EXACT_KEY=0 npm run test:eval-db -- tests/reminder-soft-link-stage4-gate.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertApprovedEvalDatabaseUrl,
  evalDatabaseNameFromUrl,
} from "../src/eval/studio-db-guard.js";
import { prisma } from "../src/database/prisma.js";
import { loadItemReminderLinkIds } from "../src/services/employee-records.service.js";
import {
  createItemWithNestedRemindersAtomic,
  linkRemindersByItemId,
  linkRemindersToItems,
  linkRemindersToWorkerTasks,
} from "../src/services/reminder.service.js";
import {
  EXACT_KEY_SOFT_LINK_ENV,
  isExactKeySoftLinkEnabled,
} from "../src/services/reminder-soft-link.js";

// Isolate: Gate requires exact-key OFF for this process.
process.env[EXACT_KEY_SOFT_LINK_ENV] = "0";

const dbUrl = process.env.DATABASE_URL;
assertApprovedEvalDatabaseUrl(dbUrl);
const dbName = evalDatabaseNameFromUrl(dbUrl!);
expect(dbName).toBe("workee_test");

console.info(
  `[stage4-gate] ${EXACT_KEY_SOFT_LINK_ENV}=${process.env[EXACT_KEY_SOFT_LINK_ENV]} → enabled=${isExactKeySoftLinkEnabled()}`,
);
console.info(`[stage4-gate] DATABASE_URL host/db → workee_test (asserted name=${dbName})`);
expect(isExactKeySoftLinkEnabled()).toBe(false);

const MARK = `stage4-gate-${Date.now()}`;
let userId = "";
let humanId = "";
let digitalId = "";
let listId = "";
let digitalListId = "";
const createdItemIds: string[] = [];
const createdReminderIds: string[] = [];

const actor = {
  id: "",
  name: "Eval",
  surname: "",
  nickname: null as string | null,
  email: null as string | null,
  phone: null as string | null,
  kind: "human" as const,
  isOwner: true,
};

beforeAll(async () => {
  // Re-assert after setup-eval-env loaded .env.live-full-eval
  process.env[EXACT_KEY_SOFT_LINK_ENV] = "0";
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(evalDatabaseNameFromUrl(process.env.DATABASE_URL!)).toBe("workee_test");
  expect(isExactKeySoftLinkEnabled()).toBe(false);

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
    throw new Error("stage4-gate: need a human on workee_test");
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
    where: { kind: "digital", userId },
    select: { id: true },
  });
  if (!digital) {
    throw new Error("stage4-gate: need a digital worker on workee_test");
  }
  digitalId = digital.id;

  const list =
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
  listId = list.id;

  const dList =
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
        visibleTo: [digitalId],
      },
      select: { id: true },
    }));
  digitalListId = dList.id;
});

afterAll(async () => {
  delete process.env.WORKEE_TEST_NESTED_FAIL_AFTER;
  if (createdReminderIds.length > 0) {
    await prisma.reminder.deleteMany({
      where: { id: { in: createdReminderIds } },
    });
  }
  if (createdItemIds.length > 0) {
    await prisma.employeeListItem.deleteMany({
      where: { id: { in: createdItemIds } },
    });
  }
  await prisma.employeeListItem.deleteMany({
    where: { itemKey: { startsWith: MARK } },
  });
  await prisma.reminder.deleteMany({
    where: { itemKey: { startsWith: MARK } },
  });
});

function fireParts(hour: number) {
  return {
    date: "2026-12-20",
    time: `${String(hour).padStart(2, "0")}:00`,
  };
}

async function createTask(itemKey: string) {
  const row = await prisma.employeeListItem.create({
    data: {
      listId,
      itemKey,
      data: { "שם משימה": itemKey },
      scope: "personal",
      visibleTo: [humanId],
      addedById: humanId,
    },
  });
  createdItemIds.push(row.id);
  return row;
}

async function createOrphanClock(itemKey: string, fireAt: Date) {
  const row = await prisma.reminder.create({
    data: {
      userId,
      ownerId: humanId,
      actorId: humanId,
      itemKey,
      itemLabel: itemKey,
      listType: "tasks",
      fireAt,
      repeat: "once",
      pingIds: [humanId],
      status: "active",
    },
  });
  createdReminderIds.push(row.id);
  return row;
}

describe("Stage 4 Gate — exact-key OFF (workee_test)", () => {
  it("env isolation: exact-key OFF on workee_test", () => {
    expect(process.env[EXACT_KEY_SOFT_LINK_ENV]).toBe("0");
    expect(isExactKeySoftLinkEnabled()).toBe(false);
    expect(evalDatabaseNameFromUrl(process.env.DATABASE_URL!)).toBe(
      "workee_test",
    );
  });

  it("NEW: nested remind → item + clock + join (no exact-key)", async () => {
    expect(isExactKeySoftLinkEnabled()).toBe(false);
    const itemKey = `${MARK}-new-one`;
    const result = await createItemWithNestedRemindersAtomic({
      userId,
      actorId: humanId,
      ownerEmployeeId: humanId,
      listId,
      listType: "tasks",
      itemKey,
      itemLabel: itemKey,
      itemCreateData: {
        data: { "שם משימה": itemKey },
        scope: "personal",
        addedById: humanId,
        visibleTo: [humanId],
      },
      reminds: [{ ...fireParts(9), text: "gate-new" }],
      employees: [actor],
    });
    createdItemIds.push(result.itemId);
    createdReminderIds.push(...result.saved.map((r) => r.id));
    expect(result.saved).toHaveLength(1);
    const links = await prisma.employeeListItemReminderLink.findMany({
      where: { listItemId: result.itemId },
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.reminderId).toBe(result.saved[0]?.id);
  });

  it("NEW: two nested clocks → two joins (LINK-only, no worker)", async () => {
    expect(isExactKeySoftLinkEnabled()).toBe(false);
    const itemKey = `${MARK}-new-two`;
    const result = await createItemWithNestedRemindersAtomic({
      userId,
      actorId: humanId,
      ownerEmployeeId: humanId,
      listId,
      listType: "tasks",
      itemKey,
      itemLabel: itemKey,
      itemCreateData: {
        data: { "שם משימה": itemKey },
        scope: "personal",
        addedById: humanId,
        visibleTo: [humanId],
      },
      reminds: [
        { ...fireParts(9), text: "am" },
        { ...fireParts(18), text: "pm" },
      ],
      employees: [actor],
    });
    createdItemIds.push(result.itemId);
    createdReminderIds.push(...result.saved.map((r) => r.id));
    expect(result.saved).toHaveLength(2);
    const links = await prisma.employeeListItemReminderLink.findMany({
      where: { listItemId: result.itemId },
    });
    expect(links).toHaveLength(2);
    // No worker task created in this path.
    const workerHits = await prisma.employeeListItem.count({
      where: {
        listId: digitalListId,
        itemKey: { contains: itemKey },
        deletedAt: null,
      },
    });
    expect(workerHits).toBe(0);
  });

  it("NEW: rollback on forced reminder fail", async () => {
    const itemKey = `${MARK}-rollback`;
    process.env.WORKEE_TEST_NESTED_FAIL_AFTER = "reminder";
    await expect(
      createItemWithNestedRemindersAtomic({
        userId,
        actorId: humanId,
        ownerEmployeeId: humanId,
        listId,
        listType: "tasks",
        itemKey,
        itemLabel: itemKey,
        itemCreateData: {
          id: randomUUID(),
          data: { "שם משימה": itemKey },
          scope: "personal",
          addedById: humanId,
          visibleTo: [humanId],
        },
        reminds: [{ ...fireParts(10), text: "fail" }],
        employees: [actor],
      }),
    ).rejects.toThrow(/nested_remind_forced_reminder_fail/);
    delete process.env.WORKEE_TEST_NESTED_FAIL_AFTER;
    expect(
      await prisma.employeeListItem.count({ where: { itemKey } }),
    ).toBe(0);
    expect(
      await prisma.reminder.count({ where: { itemKey } }),
    ).toBe(0);
  });

  it("EXISTING: ESD item_id → join; multi clocks", async () => {
    expect(isExactKeySoftLinkEnabled()).toBe(false);
    const item = await createTask(`${MARK}-existing`);
    const c1 = await createOrphanClock(
      `${MARK}-existing`,
      new Date("2026-12-21T07:00:00.000Z"),
    );
    const c2 = await createOrphanClock(
      `${MARK}-existing`,
      new Date("2026-12-21T15:00:00.000Z"),
    );
    await linkRemindersByItemId({
      userId,
      actorId: humanId,
      saved: [
        { id: c1.id, requestedItemId: item.id },
        { id: c2.id, requestedItemId: item.id },
      ],
    });
    const byItem = await loadItemReminderLinkIds([item.id]);
    expect(new Set(byItem.get(item.id))).toEqual(new Set([c1.id, c2.id]));
  });

  it("EXISTING: bad item_id → no join", async () => {
    const clock = await createOrphanClock(
      `${MARK}-bad-id`,
      new Date("2026-12-22T09:00:00.000Z"),
    );
    await linkRemindersByItemId({
      userId,
      actorId: humanId,
      saved: [
        {
          id: clock.id,
          requestedItemId: "00000000-0000-4000-8000-000000000099",
        },
      ],
    });
    expect(
      await prisma.employeeListItemReminderLink.findMany({
        where: { reminderId: clock.id },
      }),
    ).toEqual([]);
  });

  it("no exact-key fallback: same itemKey orphan does NOT join when OFF", async () => {
    expect(isExactKeySoftLinkEnabled()).toBe(false);
    const key = `${MARK}-no-fallback`;
    const item = await createTask(key);
    const orphan = await createOrphanClock(
      key,
      new Date("2026-12-23T11:00:00.000Z"),
    );
    // Would soft-link by exact key if flag were ON.
    await linkRemindersToItems(
      [{ id: orphan.id, itemKey: key, itemLabel: key }],
      [{ id: item.id, itemKey: key, itemLabel: key }],
    );
    expect(
      await prisma.employeeListItemReminderLink.findMany({
        where: { reminderId: orphan.id },
      }),
    ).toEqual([]);
  });

  it("Worker 1+1 FK pairing still works with exact-key OFF", async () => {
    expect(isExactKeySoftLinkEnabled()).toBe(false);
    const key = `${MARK}-worker`;
    const clock = await createOrphanClock(
      key,
      new Date("2026-12-24T08:00:00.000Z"),
    );
    const worker = await prisma.employeeListItem.create({
      data: {
        listId: digitalListId,
        itemKey: key,
        data: { "שם משימה": `להזכיר ${key}` },
        scope: "personal",
        visibleTo: [digitalId],
        addedById: digitalId,
      },
    });
    createdItemIds.push(worker.id);
    await linkRemindersToWorkerTasks(
      [{ id: clock.id, itemKey: key, itemLabel: key }],
      [{ id: worker.id, itemKey: key }],
    );
    const rem = await prisma.reminder.findUnique({ where: { id: clock.id } });
    const task = await prisma.employeeListItem.findUnique({
      where: { id: worker.id },
    });
    expect(rem?.workerItemId).toBe(worker.id);
    expect(task?.reminderId).toBe(clock.id);
  });
});
