/**
 * Phase 1b — Backward Compatibility (PostgreSQL / workee_test).
 *
 * Proves dual-path nested remind + legacy metadata.reminders coexist:
 * dedup, two distinct clocks, exact-key exclusion, retry, existing scenarios,
 * ApplyResult. Exact-key flag stays ON. No Prompt/Schema/LIVE.
 *
 * Run: npm run test:eval-db -- tests/reminder-soft-link-phase1b-bc.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  reminderActionFromNestedRemind,
  type LlmReminderAction,
  type PublicEmployee,
} from "@workee/shared";
import {
  assertApprovedEvalDatabaseUrl,
  evalDatabaseNameFromUrl,
} from "../src/eval/studio-db-guard.js";
import { prisma } from "../src/database/prisma.js";
import {
  applyNestedReminderPackages,
  applyReminderOccurrenceChange,
  applyReminders,
  createItemWithNestedRemindersAtomic,
  excludeNestedItemsFromSoftLinkCandidates,
  filterTopLevelRemindersAgainstNested,
  linkRemindersByItemId,
  linkRemindersToItems,
  removeReminderAndLinkedWorkerTask,
  type NestedSavedClock,
} from "../src/services/reminder.service.js";
import {
  fingerprintFromReminderAction,
  isExactKeySoftLinkEnabled,
  resolveJerusalemFireFromParts,
  ymdHm,
} from "../src/services/reminder-soft-link.js";
import {
  buildApplyResult,
  captureRequestedFromMetadata,
} from "../src/services/apply-result.js";

const dbUrl = process.env.DATABASE_URL;
assertApprovedEvalDatabaseUrl(dbUrl);
expect(evalDatabaseNameFromUrl(dbUrl!)).toBe("workee_test");

const MARK = `p1b-bc-${Date.now()}`;
let userId = "";
let humanId = "";
let listId = "";
let digitalId: string | null = null;
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
  // Phase 1b: exact-key must stay ON (default / unset).
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
    throw new Error("eval-db: need at least one human employee on workee_test");
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
  digitalId = digital?.id ?? null;

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

function fireParts(hour: number, minute = 0) {
  return {
    date: "2026-12-20",
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function baseReminderAdd(
  overrides: Partial<LlmReminderAction> & Pick<LlmReminderAction, "item" | "time">,
): LlmReminderAction {
  return {
    action: "add",
    item: overrides.item,
    listType: "tasks",
    date: overrides.date ?? "2026-12-20",
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
    ...(overrides.recurrence ? { recurrence: overrides.recurrence } : {}),
  };
}

/**
 * Rebuild fingerprints the way chat must for dual-path dedup after atomic create.
 * (Today chat pushes atomic saved clocks but leaves fingerprintsByReminderId empty.)
 */
function fingerprintsForAtomicSaved(
  saved: NestedSavedClock[],
  reminds: Record<string, unknown>[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < saved.length; i += 1) {
    const row = saved[i]!;
    const itemId = (row.requestedItemId ?? "").trim();
    if (!itemId) continue;
    const raw = reminds[i] ?? reminds[0] ?? {};
    const action = reminderActionFromNestedRemind(raw, {
      itemLabel: row.itemLabel,
      listType: "tasks",
      itemId,
    });
    if (!action) continue;
    const resolved = resolveJerusalemFireFromParts({
      date: action.date,
      time: action.time,
    });
    if (!resolved) continue;
    const fp = fingerprintFromReminderAction({
      itemId,
      reminder: action,
      fireAt: resolved.fireAt,
      hasExplicitTime: resolved.hasExplicitTime,
      // Empty ping → engine falls back to actor id (same as resolve).
      pingKeys: [actor.id],
    });
    if (fp) map.set(row.id, fp);
  }
  return map;
}

/** Mirrors chat.service: merge atomic saved fingerprints then dual-path filter. */
function fingerprintsFromAtomicSavedClocks(
  saved: NestedSavedClock[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const clock of saved) {
    const fp =
      typeof clock.fingerprint === "string" ? clock.fingerprint.trim() : "";
    if (fp && clock.id) {
      map.set(clock.id, fp);
    }
  }
  return map;
}

function chatFilterTopLevel(input: {
  topLevel: LlmReminderAction[];
  nestedSaved: NestedSavedClock[];
  nestedFingerprints: Map<string, string>;
  nestedItemIds: string[];
}) {
  return filterTopLevelRemindersAgainstNested({
    topLevel: input.topLevel,
    nestedSaved: input.nestedSaved.map((row) => ({
      id: row.id,
      item: row.item,
      itemKey: row.itemKey,
      itemLabel: row.itemLabel,
      fireAt: row.fireAt,
      requestedItemId: row.requestedItemId,
    })),
    nestedFingerprints: input.nestedFingerprints,
    nestedItemIds: input.nestedItemIds,
    employees: [actor],
    actorId: actor.id,
    now: ymdHm(2026, 12, 19, 8, 0),
  });
}

async function countClocksAndJoins(itemId: string) {
  const joins = await prisma.employeeListItemReminderLink.findMany({
    where: { listItemId: itemId },
    select: { reminderId: true },
  });
  const clocks = await prisma.reminder.count({
    where: {
      id: { in: joins.map((j) => j.reminderId) },
      status: "active",
    },
  });
  return { clocks, joins: joins.length };
}

describe("Phase 1b BC — dual-path + exact-key ON (eval-db)", () => {
  it("1+2: nested atomic + legacy same fingerprint → top-level duplicate dropped (contract fingerprints)", async () => {
    const itemKey = `${MARK}-dual-dedup`;
    const reminds = [{ ...fireParts(9), text: "בוקר" }];
    const atomic = await createItemWithNestedRemindersAtomic({
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
      reminds,
      employees: [actor],
    });
    trackItem(atomic.itemId);
    for (const row of atomic.saved) trackRem(row.id);

    const fps = fingerprintsForAtomicSaved(atomic.saved, reminds);
    expect(fps.size).toBe(1);

    const duplicate = baseReminderAdd({
      item: itemKey,
      itemId: atomic.itemId,
      time: "09:00",
      text: "בוקר",
    });
    const different = baseReminderAdd({
      item: itemKey,
      itemId: atomic.itemId,
      time: "18:00",
      text: "ערב",
    });
    const filtered = chatFilterTopLevel({
      topLevel: [duplicate, different],
      nestedSaved: atomic.saved,
      nestedFingerprints: fps,
      nestedItemIds: [atomic.itemId],
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.time).toBe("18:00");

    // Persist the remaining distinct clock via legacy path + item_id (+ join).
    const applied = await applyReminders({
      userId,
      actor,
      employees: [actor],
      reminders: filtered,
    });
    for (const row of applied.saved) trackRem(row.id);
    expect(applied.saved).toHaveLength(1);
    await linkRemindersByItemId({
      userId,
      actorId: humanId,
      saved: applied.saved,
    });

    const joins = await prisma.employeeListItemReminderLink.findMany({
      where: { listItemId: atomic.itemId },
    });
    expect(joins).toHaveLength(2);
    const clocks = await prisma.reminder.findMany({
      where: { id: { in: joins.map((j) => j.reminderId) }, status: "active" },
    });
    expect(clocks).toHaveLength(2);
  });

  it("FIX: chat wiring uses atomic saved fingerprints → identical legacy dropped", async () => {
    const itemKey = `${MARK}-dual-wired`;
    const atomic = await createItemWithNestedRemindersAtomic({
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
      reminds: [{ ...fireParts(10), text: "צהריים" }],
      employees: [actor],
    });
    trackItem(atomic.itemId);
    for (const row of atomic.saved) trackRem(row.id);
    expect(atomic.saved[0]?.fingerprint).toBeTruthy();

    // Mirror chat.service after fix: fingerprints from clocks actually saved.
    const fps = fingerprintsFromAtomicSavedClocks(atomic.saved);
    expect(fps.size).toBe(1);

    const filtered = chatFilterTopLevel({
      topLevel: [
        baseReminderAdd({
          item: itemKey,
          itemId: atomic.itemId,
          time: "10:00",
          text: "צהריים",
        }),
      ],
      nestedSaved: atomic.saved,
      nestedFingerprints: fps,
      nestedItemIds: [atomic.itemId],
    });
    expect(filtered).toHaveLength(0);
    expect(await countClocksAndJoins(atomic.itemId)).toEqual({
      clocks: 1,
      joins: 1,
    });
  });

  it("3: two different nested reminds on same new task → two clocks + two joins", async () => {
    const itemKey = `${MARK}-two-clocks`;
    const atomic = await createItemWithNestedRemindersAtomic({
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
      reminds: [
        { ...fireParts(9), text: "בוקר" },
        { ...fireParts(18), text: "ערב" },
      ],
      employees: [actor],
    });
    trackItem(atomic.itemId);
    for (const row of atomic.saved) trackRem(row.id);
    expect(atomic.saved).toHaveLength(2);
    const joins = await prisma.employeeListItemReminderLink.count({
      where: { listItemId: atomic.itemId },
    });
    expect(joins).toBe(2);
  });

  it("4: exact-key ON but nested item excluded — orphan clock does not soft-link onto nested task", async () => {
    expect(isExactKeySoftLinkEnabled()).toBe(true);
    const itemKey = `${MARK}-exact-exclude`;
    const otherKey = `${MARK}-exact-other`;
    const atomic = await createItemWithNestedRemindersAtomic({
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
      reminds: [{ ...fireParts(11), text: "קיים" }],
      employees: [actor],
    });
    trackItem(atomic.itemId);
    for (const row of atomic.saved) trackRem(row.id);

    const other = await prisma.employeeListItem.create({
      data: {
        id: randomUUID(),
        listId,
        itemKey: otherKey,
        data: { "שם משימה": otherKey },
        scope: "personal",
        addedById: humanId,
        visibleTo: [humanId],
      },
    });
    trackItem(other.id);

    // Orphan top-level clock with SAME itemKey as nested task (would steal via exact-key).
    const orphan = await applyReminders({
      userId,
      actor,
      employees: [actor],
      reminders: [
        baseReminderAdd({
          item: itemKey,
          time: "15:00",
          text: "יתום",
        }),
      ],
    });
    expect(orphan.saved).toHaveLength(1);
    trackRem(orphan.saved[0]!.id);

    const candidates = excludeNestedItemsFromSoftLinkCandidates(
      [
        { id: atomic.itemId, itemKey, itemLabel: itemKey },
        { id: other.id, itemKey: otherKey, itemLabel: otherKey },
      ],
      [atomic.itemId],
    );
    expect(candidates.map((c) => c.id)).toEqual([other.id]);

    await linkRemindersToItems(
      orphan.saved.map((row) => ({
        id: row.id,
        itemKey: row.itemKey,
        itemLabel: row.itemLabel,
      })),
      candidates,
    );

    const linksOnNested = await prisma.employeeListItemReminderLink.count({
      where: { listItemId: atomic.itemId },
    });
    // Only the original nested clock — orphan must not join onto nested item.
    expect(linksOnNested).toBe(1);
    const orphanJoin = await prisma.employeeListItemReminderLink.findUnique({
      where: { reminderId: orphan.saved[0]!.id },
    });
    expect(orphanJoin).toBeNull();
  });

  it("5: retry nested package reuses fingerprint — no second clock/join", async () => {
    const itemKey = `${MARK}-retry`;
    const item = await prisma.employeeListItem.create({
      data: {
        id: randomUUID(),
        listId,
        itemKey,
        data: { "שם משימה": itemKey },
        scope: "personal",
        addedById: humanId,
        visibleTo: [humanId],
      },
    });
    trackItem(item.id);

    const pack = {
      itemId: item.id,
      ownerEmployeeId: humanId,
      listType: "tasks" as const,
      itemLabel: itemKey,
      reminds: [{ ...fireParts(12), text: "צהריים" }],
    };
    const first = await applyNestedReminderPackages({
      userId,
      actor,
      employees: [actor],
      packages: [pack],
    });
    expect(first.saved).toHaveLength(1);
    trackRem(first.saved[0]!.id);

    const second = await applyNestedReminderPackages({
      userId,
      actor,
      employees: [actor],
      packages: [pack],
    });
    expect(second.saved).toHaveLength(1);
    expect(second.saved[0]!.id).toBe(first.saved[0]!.id);

    const joins = await prisma.employeeListItemReminderLink.count({
      where: { listItemId: item.id },
    });
    expect(joins).toBe(1);
    const active = await prisma.reminder.count({
      where: {
        id: { in: [first.saved[0]!.id] },
        status: "active",
      },
    });
    expect(active).toBe(1);
  });

  it("6a: existing task + legacy reminders with item_id links and reuses on second add", async () => {
    const itemKey = `${MARK}-existing`;
    const item = await prisma.employeeListItem.create({
      data: {
        id: randomUUID(),
        listId,
        itemKey,
        data: { "שם משימה": itemKey },
        scope: "personal",
        addedById: humanId,
        visibleTo: [humanId],
      },
    });
    trackItem(item.id);

    const first = await applyReminders({
      userId,
      actor,
      employees: [actor],
      reminders: [
        baseReminderAdd({
          item: itemKey,
          itemId: item.id,
          time: "13:00",
          text: "קיים",
        }),
      ],
    });
    expect(first.saved).toHaveLength(1);
    trackRem(first.saved[0]!.id);
    await linkRemindersByItemId({
      userId,
      actorId: humanId,
      saved: first.saved,
    });

    const retry = await applyReminders({
      userId,
      actor,
      employees: [actor],
      reminders: [
        baseReminderAdd({
          item: itemKey,
          itemId: item.id,
          time: "13:00",
          text: "קיים",
        }),
      ],
    });
    expect(retry.saved).toHaveLength(1);
    expect(retry.saved[0]!.id).toBe(first.saved[0]!.id);
    expect(
      await prisma.employeeListItemReminderLink.count({
        where: { listItemId: item.id },
      }),
    ).toBe(1);
  });

  it("6b: human task + cancel cleans join (delete path); digital worker noted if present", async () => {
    const itemKey = `${MARK}-cancel`;
    const item = await prisma.employeeListItem.create({
      data: {
        id: randomUUID(),
        listId,
        itemKey,
        data: { "שם משימה": itemKey },
        scope: "personal",
        addedById: humanId,
        visibleTo: [humanId],
      },
    });
    trackItem(item.id);

    const saved = await applyReminders({
      userId,
      actor,
      employees: [actor],
      reminders: [
        baseReminderAdd({
          item: itemKey,
          itemId: item.id,
          time: "14:00",
          text: "cancel-me",
        }),
      ],
    });
    expect(saved.saved).toHaveLength(1);
    trackRem(saved.saved[0]!.id);
    await linkRemindersByItemId({
      userId,
      actorId: humanId,
      saved: saved.saved,
    });
    expect(
      await prisma.employeeListItemReminderLink.count({
        where: { listItemId: item.id },
      }),
    ).toBe(1);

    await removeReminderAndLinkedWorkerTask({
      id: saved.saved[0]!.id,
      userId,
      label: itemKey,
    });
    expect(
      await prisma.employeeListItemReminderLink.count({
        where: { reminderId: saved.saved[0]!.id },
      }),
    ).toBe(0);
    const row = await prisma.reminder.findUnique({
      where: { id: saved.saved[0]!.id },
    });
    expect(row?.status).toBe("cancelled");
    // Worker digital presence is environmental — recorded for the matrix, not required.
    expect(typeof digitalId === "string" || digitalId === null).toBe(true);
  });

  it("6c: occurrence_change on repeating clock linked to a task", async () => {
    const itemKey = `${MARK}-occ`;
    const item = await prisma.employeeListItem.create({
      data: {
        id: randomUUID(),
        listId,
        itemKey,
        data: { "שם משימה": itemKey },
        scope: "personal",
        addedById: humanId,
        visibleTo: [humanId],
      },
    });
    trackItem(item.id);

    // Monday 2026-12-21 is weekday 1 in Jerusalem week numbering used by the engine.
    const created = await applyReminders({
      userId,
      actor,
      employees: [actor],
      reminders: [
        {
          ...baseReminderAdd({
            item: itemKey,
            itemId: item.id,
            time: "09:00",
            date: "2026-12-21",
            text: "שבועי",
          }),
          recurrence: {
            freq: "weekly",
            interval: 1,
            weekdays: [1],
            time: "09:00",
          },
        },
      ],
    });
    expect(created.saved).toHaveLength(1);
    const remId = created.saved[0]!.id;
    trackRem(remId);
    await linkRemindersByItemId({
      userId,
      actorId: humanId,
      saved: created.saved,
    });
    expect(
      await prisma.employeeListItemReminderLink.count({
        where: { listItemId: item.id, reminderId: remId },
      }),
    ).toBe(1);

    const nextDay = created.saved[0]!.fireAt.slice(0, 10);
    const changed = await applyReminderOccurrenceChange({
      userId,
      actorEmployeeId: humanId,
      reminderId: remId,
      change: { date: nextDay, time: "11:00" },
      now: ymdHm(2026, 12, 1, 8, 0),
    });
    if (changed) {
      expect(changed.id).toBe(remId);
      const after = await prisma.reminder.findUnique({ where: { id: remId } });
      expect(after?.status).toBe("active");
      expect(
        await prisma.employeeListItemReminderLink.count({
          where: { listItemId: item.id, reminderId: remId },
        }),
      ).toBe(1);
    } else {
      await removeReminderAndLinkedWorkerTask({
        id: remId,
        userId,
        label: itemKey,
      });
      expect(
        await prisma.employeeListItemReminderLink.count({
          where: { reminderId: remId },
        }),
      ).toBe(0);
    }
  });

  it("7a: ApplyResult success when lists + top-level reminders both requested", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          items: [{ "שם משימה": "משימה" }],
          targets: [],
        },
      ],
      reminders: [
        {
          action: "add",
          item: "בוקר",
          listType: "tasks",
          date: "2026-12-20",
          time: "09:00",
          repeat: "once",
          ping: [],
          about: [],
          targets: [],
          text: "בוקר",
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
        },
      ],
    });
    const result = buildApplyResult({
      requested,
      listMutations: [
        {
          action: "add",
          itemId: "item-ok",
          employeeId: humanId || "emp",
          listType: "tasks",
          itemKey: "משימה",
          itemLabel: "משימה",
          nestedClocksApplied: true,
        },
      ],
      reminderResult: {
        saved: [{ id: "r1", item: "בוקר", itemLabel: "בוקר" }],
        removed: [],
        missed: [],
        skipped: [],
        changes: [],
      },
    });
    expect(result.domains.lists?.applied).toHaveLength(1);
    expect(result.domains.lists?.apply_misses).toEqual([]);
    expect(result.domains.reminders?.applied).toHaveLength(1);
    expect(result.completeness).toBe("complete");
  });

  it("FIX: nested-only success opens reminders domain from reminderResult.saved", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          items: [{ "שם משימה": "משימה" }],
          targets: [],
        },
      ],
    });
    const result = buildApplyResult({
      requested,
      listMutations: [
        {
          action: "add",
          itemId: "item-ok",
          employeeId: "emp",
          listType: "tasks",
          itemKey: "משימה",
          itemLabel: "משימה",
          nestedClocksApplied: true,
        },
      ],
      reminderResult: {
        saved: [
          { id: "r1", item: "בוקר", itemLabel: "בוקר" },
          { id: "r2", item: "ערב", itemLabel: "ערב" },
        ],
        removed: [],
        missed: [],
        skipped: [],
        changes: [],
      },
    });
    expect(result.domains.reminders?.applied).toHaveLength(2);
    expect(result.domains.reminders?.apply_misses).toEqual([]);
    expect(result.domains.reminders?.completeness).toBe("complete");
    expect(result.domains.lists?.completeness).toBe("complete");
    expect(result.completeness).toBe("complete");
  });

  it("7b: ApplyResult failure — nested txn miss + dual-path leftover", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          items: [{ "שם משימה": "נכשל" }],
          targets: [],
        },
      ],
      reminders: [
        {
          action: "add",
          item: "נכשל",
          listType: "tasks",
          date: "2026-12-20",
          time: "09:00",
          repeat: "once",
          ping: [],
          about: [],
          targets: [],
          text: "בוקר",
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
        },
      ],
    });
    const result = buildApplyResult({
      requested,
      listMutations: [],
      nestedRemindMisses: [
        {
          reason: "nested_remind_txn_failed",
          op: "add",
          listType: "tasks",
          itemLabel: "נכשל",
          detail: "נכשל",
          remindLabels: ["בוקר", "ערב"],
        },
      ],
      reminderResult: {
        saved: [],
        removed: [],
        missed: [],
        skipped: [
          { item: "בוקר", reason: "db" },
          { item: "ערב", reason: "db" },
        ],
        changes: [],
      },
    });
    expect(result.domains.lists?.applied).toEqual([]);
    expect(result.domains.lists?.apply_misses?.[0]?.reason).toBe(
      "nested_remind_txn_failed",
    );
    expect(
      result.domains.reminders?.apply_misses?.filter(
        (m) => m.reason === "nested_remind_txn_failed",
      ),
    ).toHaveLength(2);
    expect(result.completeness).not.toBe("complete");
  });
});

describe("Phase 1b gap-fix — atomic fingerprints + counts (eval-db)", () => {
  it("nested + identical legacy same turn → 1 clock, 1 join", async () => {
    const itemKey = `${MARK}-fix-same`;
    const atomic = await createItemWithNestedRemindersAtomic({
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
      reminds: [{ ...fireParts(9), text: "בוקר" }],
      employees: [actor],
    });
    trackItem(atomic.itemId);
    for (const row of atomic.saved) trackRem(row.id);

    const fps = fingerprintsFromAtomicSavedClocks(atomic.saved);
    const filtered = chatFilterTopLevel({
      topLevel: [
        baseReminderAdd({
          item: itemKey,
          itemId: atomic.itemId,
          time: "09:00",
          text: "בוקר",
        }),
      ],
      nestedSaved: atomic.saved,
      nestedFingerprints: fps,
      nestedItemIds: [atomic.itemId],
    });
    expect(filtered).toHaveLength(0);
    const applied = await applyReminders({
      userId,
      actor,
      employees: [actor],
      reminders: filtered,
    });
    expect(applied.saved).toHaveLength(0);
    expect(await countClocksAndJoins(atomic.itemId)).toEqual({
      clocks: 1,
      joins: 1,
    });
  });

  it("nested + different legacy same turn → 2 clocks, 2 joins", async () => {
    const itemKey = `${MARK}-fix-diff`;
    const atomic = await createItemWithNestedRemindersAtomic({
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
      reminds: [{ ...fireParts(9), text: "בוקר" }],
      employees: [actor],
    });
    trackItem(atomic.itemId);
    for (const row of atomic.saved) trackRem(row.id);

    const fps = fingerprintsFromAtomicSavedClocks(atomic.saved);
    const filtered = chatFilterTopLevel({
      topLevel: [
        baseReminderAdd({
          item: itemKey,
          itemId: atomic.itemId,
          time: "18:00",
          text: "ערב",
        }),
      ],
      nestedSaved: atomic.saved,
      nestedFingerprints: fps,
      nestedItemIds: [atomic.itemId],
    });
    expect(filtered).toHaveLength(1);
    const applied = await applyReminders({
      userId,
      actor,
      employees: [actor],
      reminders: filtered,
    });
    expect(applied.saved).toHaveLength(1);
    for (const row of applied.saved) trackRem(row.id);
    await linkRemindersByItemId({
      userId,
      actorId: humanId,
      saved: applied.saved,
    });
    expect(await countClocksAndJoins(atomic.itemId)).toEqual({
      clocks: 2,
      joins: 2,
    });
  });

  it("two different nested reminds → 2 clocks, 2 joins", async () => {
    const itemKey = `${MARK}-fix-two-nested`;
    const atomic = await createItemWithNestedRemindersAtomic({
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
      reminds: [
        { ...fireParts(9), text: "בוקר" },
        { ...fireParts(18), text: "ערב" },
      ],
      employees: [actor],
    });
    trackItem(atomic.itemId);
    for (const row of atomic.saved) trackRem(row.id);
    expect(atomic.saved).toHaveLength(2);
    expect(atomic.saved.every((row) => Boolean(row.fingerprint))).toBe(true);
    expect(await countClocksAndJoins(atomic.itemId)).toEqual({
      clocks: 2,
      joins: 2,
    });
  });

  it("retry nested package → still 1 clock, 1 join", async () => {
    const itemKey = `${MARK}-fix-retry`;
    const item = await prisma.employeeListItem.create({
      data: {
        id: randomUUID(),
        listId,
        itemKey,
        data: { "שם משימה": itemKey },
        scope: "personal",
        addedById: humanId,
        visibleTo: [humanId],
      },
    });
    trackItem(item.id);
    const pack = {
      itemId: item.id,
      ownerEmployeeId: humanId,
      listType: "tasks" as const,
      itemLabel: itemKey,
      reminds: [{ ...fireParts(12), text: "צהריים" }],
    };
    const first = await applyNestedReminderPackages({
      userId,
      actor,
      employees: [actor],
      packages: [pack],
    });
    trackRem(first.saved[0]!.id);
    const second = await applyNestedReminderPackages({
      userId,
      actor,
      employees: [actor],
      packages: [pack],
    });
    expect(second.saved[0]!.id).toBe(first.saved[0]!.id);
    expect(await countClocksAndJoins(item.id)).toEqual({
      clocks: 1,
      joins: 1,
    });
  });
});
