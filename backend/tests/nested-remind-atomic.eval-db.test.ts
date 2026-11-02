/**
 * NEW task + nested remind(s) — real PostgreSQL (workee_test) rollback proof.
 *
 * Run: npm run test:eval-db -- tests/nested-remind-atomic.eval-db.test.ts
 *
 * No OpenAI / WhatsApp / LIVE messages. Cleans its own rows.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertApprovedEvalDatabaseUrl,
  evalDatabaseNameFromUrl,
} from "../src/eval/studio-db-guard.js";
import { prisma } from "../src/database/prisma.js";
import { createItemWithNestedRemindersAtomic } from "../src/services/reminder.service.js";
import {
  buildApplyResult,
  captureRequestedFromMetadata,
} from "../src/services/apply-result.js";

const dbUrl = process.env.DATABASE_URL;
assertApprovedEvalDatabaseUrl(dbUrl);
expect(evalDatabaseNameFromUrl(dbUrl!)).toBe("workee_test");

const MARK = `atomic-nested-${Date.now()}`;
let userId = "";
let humanId = "";
let listId = "";
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
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
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
  const list =
    (await prisma.employeeList.findFirst({
      where: {
        employeeId: humanId,
        listType: "tasks",
        deletedAt: null,
      },
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
    date: "2026-12-15",
    time: `${String(hour).padStart(2, "0")}:00`,
  };
}

describe("nested remind atomic create (eval-db / PostgreSQL)", () => {
  it("creates task + one reminder + join in one txn", async () => {
    const itemKey = `${MARK}-one`;
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
      reminds: [{ ...fireParts(9), text: "תזכורת אחת" }],
      employees: [actor],
    });
    createdItemIds.push(result.itemId);
    createdReminderIds.push(...result.saved.map((r) => r.id));

    expect(result.saved).toHaveLength(1);
    const item = await prisma.employeeListItem.findUnique({
      where: { id: result.itemId },
    });
    expect(item?.deletedAt).toBeNull();
    const links = await prisma.employeeListItemReminderLink.findMany({
      where: { listItemId: result.itemId },
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.reminderId).toBe(result.saved[0]?.id);
    const clock = await prisma.reminder.findUnique({
      where: { id: result.saved[0]!.id },
    });
    expect(clock?.status).toBe("active");
  });

  it("creates task + two reminders + two joins", async () => {
    const itemKey = `${MARK}-two`;
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
        { ...fireParts(9), text: "בוקר" },
        { ...fireParts(18), text: "ערב" },
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
  });

  it("rolls back item when reminder create fails (forced)", async () => {
    const itemKey = `${MARK}-fail-rem`;
    const beforeItems = await prisma.employeeListItem.count({
      where: { itemKey },
    });
    const beforeClocks = await prisma.reminder.count({
      where: { itemKey: { startsWith: MARK } },
    });
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
        reminds: [{ ...fireParts(10), text: "ייכשל" }],
        employees: [actor],
      }),
    ).rejects.toThrow(/nested_remind_forced_reminder_fail/);
    delete process.env.WORKEE_TEST_NESTED_FAIL_AFTER;

    expect(
      await prisma.employeeListItem.count({ where: { itemKey } }),
    ).toBe(beforeItems);
    expect(
      await prisma.reminder.count({
        where: { itemKey: { startsWith: MARK }, itemLabel: "ייכשל" },
      }),
    ).toBe(0);
    expect(
      await prisma.employeeListItemReminderLink.count({
        where: { listItem: { itemKey } },
      }),
    ).toBe(0);
    void beforeClocks;
  });

  it("rolls back item+reminder when join FK fails", async () => {
    const itemKey = `${MARK}-fail-join`;
    const presetId = randomUUID();
    process.env.WORKEE_TEST_NESTED_FAIL_AFTER = "join";
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
          id: presetId,
          data: { "שם משימה": itemKey },
          scope: "personal",
          addedById: humanId,
          visibleTo: [humanId],
        },
        reminds: [{ ...fireParts(11), text: "join-fail" }],
        employees: [actor],
      }),
    ).rejects.toThrow();
    delete process.env.WORKEE_TEST_NESTED_FAIL_AFTER;

    expect(
      await prisma.employeeListItem.findUnique({ where: { id: presetId } }),
    ).toBeNull();
    expect(
      await prisma.reminder.count({
        where: { itemLabel: "join-fail", itemKey: { startsWith: MARK } },
      }),
    ).toBe(0);
    expect(
      await prisma.employeeListItemReminderLink.count({
        where: { listItemId: presetId },
      }),
    ).toBe(0);
  });

  it("ApplyResult: nested txn miss → not applied, all reminds fail, completeness not complete", () => {
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
      listMutations: [],
      nestedRemindMisses: [
        {
          reason: "nested_remind_txn_failed",
          op: "add",
          listType: "tasks",
          itemLabel: "משימה",
          detail: "משימה",
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
    expect(result.domains.lists?.apply_misses).toEqual([
      expect.objectContaining({
        reason: "nested_remind_txn_failed",
        op: "add",
        listType: "tasks",
      }),
    ]);
    expect(
      result.domains.reminders?.apply_misses?.filter(
        (m) => m.reason === "nested_remind_txn_failed",
      ),
    ).toHaveLength(2);
    expect(result.domains.lists?.completeness).not.toBe("complete");
    expect(result.domains.reminders?.completeness).not.toBe("complete");
    expect(result.completeness).not.toBe("complete");
  });
});
