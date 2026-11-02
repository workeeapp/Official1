/**
 * Offline unit coverage for createItemWithNestedRemindersAtomic (mocked Prisma txn)
 * + ApplyResult regression after atomic rollback.
 * Real DB rollback proof lives in nested-remind-atomic.eval-db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  transaction,
  itemCreate,
  reminderCreate,
  linkCreate,
} = vi.hoisted(() => ({
  transaction: vi.fn(),
  itemCreate: vi.fn(),
  reminderCreate: vi.fn(),
  linkCreate: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    $transaction: transaction,
  },
}));

vi.mock("../src/services/reminder-fire.js", () => ({
  scheduleSoon: vi.fn(),
}));

vi.mock("../src/services/audit.service.js", () => ({
  recordAuditEvent: vi.fn(async () => undefined),
}));

import { createItemWithNestedRemindersAtomic } from "../src/services/reminder.service.js";
import { ymdHm } from "../src/services/reminder-soft-link.js";
import {
  buildApplyResult,
  captureRequestedFromMetadata,
} from "../src/services/apply-result.js";
import type { NestedRemindTxnMiss } from "../src/services/employee-records.service.js";
import type { ListItemMutation } from "../src/services/employee-records.service.js";

const ACTOR = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "טל",
  surname: "",
  nickname: null,
  email: null,
  phone: null,
  kind: "human" as const,
  isOwner: true,
};
const ITEM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REM = "11111111-1111-4111-8111-111111111111";
const LIST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("createItemWithNestedRemindersAtomic (offline mock)", () => {
  beforeEach(() => {
    transaction.mockReset();
    itemCreate.mockReset();
    reminderCreate.mockReset();
    linkCreate.mockReset();
    delete process.env.WORKEE_TEST_NESTED_FAIL_AFTER;
  });

  it("runs item + reminder + join inside one $transaction", async () => {
    itemCreate.mockResolvedValue({ id: ITEM });
    reminderCreate.mockResolvedValue({
      id: REM,
      fireAt: ymdHm(2026, 12, 15, 9, 0),
    });
    linkCreate.mockResolvedValue({});
    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        employeeListItem: { create: itemCreate },
        reminder: { create: reminderCreate },
        employeeListItemReminderLink: { create: linkCreate },
      }),
    );

    const result = await createItemWithNestedRemindersAtomic({
      userId: "user",
      actorId: ACTOR.id,
      ownerEmployeeId: ACTOR.id,
      listId: LIST,
      listType: "tasks",
      itemKey: "משימה",
      itemLabel: "משימה",
      itemCreateData: {
        data: { "שם משימה": "משימה" },
        scope: "personal",
        addedById: ACTOR.id,
        visibleTo: [ACTOR.id],
      },
      reminds: [{ date: "2026-12-15", time: "09:00", text: "תזכורת" }],
      employees: [ACTOR],
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(itemCreate).toHaveBeenCalled();
    expect(reminderCreate).toHaveBeenCalled();
    expect(linkCreate).toHaveBeenCalledWith({
      data: { listItemId: ITEM, reminderId: REM },
    });
    expect(result.itemId).toBe(ITEM);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0]?.fingerprint).toBeTruthy();
  });

  it("creates two reminders + two joins for remind[]", async () => {
    itemCreate.mockResolvedValue({ id: ITEM });
    reminderCreate
      .mockResolvedValueOnce({ id: "r1", fireAt: ymdHm(2026, 12, 15, 9, 0) })
      .mockResolvedValueOnce({ id: "r2", fireAt: ymdHm(2026, 12, 15, 18, 0) });
    linkCreate.mockResolvedValue({});
    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        employeeListItem: { create: itemCreate },
        reminder: { create: reminderCreate },
        employeeListItemReminderLink: { create: linkCreate },
      }),
    );

    const result = await createItemWithNestedRemindersAtomic({
      userId: "user",
      actorId: ACTOR.id,
      ownerEmployeeId: ACTOR.id,
      listId: LIST,
      listType: "tasks",
      itemKey: "משימה",
      itemLabel: "משימה",
      itemCreateData: {
        data: { "שם משימה": "משימה" },
        scope: "personal",
        addedById: ACTOR.id,
        visibleTo: [ACTOR.id],
      },
      reminds: [
        { date: "2026-12-15", time: "09:00", text: "בוקר" },
        { date: "2026-12-15", time: "18:00", text: "ערב" },
      ],
      employees: [ACTOR],
    });

    expect(result.saved).toHaveLength(2);
    expect(linkCreate).toHaveBeenCalledTimes(2);
  });

  it("rejects when $transaction fails (no saved clocks)", async () => {
    transaction.mockRejectedValue(new Error("nested_remind_forced_reminder_fail"));
    await expect(
      createItemWithNestedRemindersAtomic({
        userId: "user",
        actorId: ACTOR.id,
        ownerEmployeeId: ACTOR.id,
        listId: LIST,
        listType: "tasks",
        itemKey: "משימה",
        itemLabel: "משימה",
        itemCreateData: {
          data: { "שם משימה": "משימה" },
          scope: "personal",
          addedById: ACTOR.id,
          visibleTo: [ACTOR.id],
        },
        reminds: [
          { date: "2026-12-15", time: "09:00", text: "בוקר" },
          { date: "2026-12-15", time: "18:00", text: "ערב" },
        ],
        employees: [ACTOR],
      }),
    ).rejects.toThrow(/nested_remind_forced_reminder_fail/);
    expect(itemCreate).not.toHaveBeenCalled();
  });
});

/**
 * Simulates chat.service ApplyResult assembly after createItemWithNestedRemindersAtomic
 * throws (employee-records catch → nestedRemindMisses, no list mutation pushed).
 * Contract: mutations.push only happens after atomic success; catch pushes miss only.
 */
function applyResultAfterAtomicRollback(input: {
  listMutations: ListItemMutation[];
  nestedRemindMisses: NestedRemindTxnMiss[];
  reminderSaved?: Array<{ id: string; item: string; itemLabel: string }>;
}) {
  // Mirror chat.service: one skipped clock per remindLabels entry.
  const skipped: Array<{ item: string; reason: "db" }> = [];
  for (const miss of input.nestedRemindMisses) {
    const labels =
      miss.remindLabels.length > 0 ? miss.remindLabels : [miss.itemLabel];
    for (const label of labels) {
      skipped.push({ item: label, reason: "db" });
    }
  }
  const requested = captureRequestedFromMetadata({
    lists: [
      {
        action: "add",
        listType: "tasks",
        listName: "",
        items: [{ "שם משימה": "תור לווטרינר" }],
        targets: [],
      },
    ],
  });
  return buildApplyResult({
    requested,
    listMutations: input.listMutations,
    nestedRemindMisses: input.nestedRemindMisses,
    reminderResult: {
      saved: input.reminderSaved ?? [],
      removed: [],
      missed: [],
      skipped,
      changes: [],
    },
  });
}

describe("ApplyResult after atomic nested rollback (regression)", () => {
  it("task is apply_miss not applied; both reminds fail; completeness not complete; no sneak applied", () => {
    // employee-records on catch: mutations NOT pushed; nestedRemindMisses pushed.
    const listMutations: ListItemMutation[] = [];
    const nestedRemindMisses: NestedRemindTxnMiss[] = [
      {
        reason: "nested_remind_txn_failed",
        op: "add",
        listType: "tasks",
        itemLabel: "תור לווטרינר",
        detail: "תור לווטרינר",
        remindLabels: ["בוקר", "ערב"],
      },
    ];

    const result = applyResultAfterAtomicRollback({
      listMutations,
      nestedRemindMisses,
    });

    // 1) Task create → apply_miss, not applied
    expect(result.domains.lists?.applied).toEqual([]);
    expect(result.domains.lists?.apply_misses).toEqual([
      expect.objectContaining({
        reason: "nested_remind_txn_failed",
        op: "add",
        listType: "tasks",
      }),
    ]);

    // 2) Every remind in the package marked failed
    expect(result.domains.reminders?.applied).toEqual([]);
    expect(result.domains.reminders?.apply_misses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "nested_remind_txn_failed",
          detail: "בוקר",
        }),
        expect.objectContaining({
          reason: "nested_remind_txn_failed",
          detail: "ערב",
        }),
        expect.objectContaining({ reason: "db", detail: "בוקר" }),
        expect.objectContaining({ reason: "db", detail: "ערב" }),
      ]),
    );
    expect(
      result.domains.reminders?.apply_misses?.filter(
        (m) => m.reason === "nested_remind_txn_failed",
      ),
    ).toHaveLength(2);

    // 3) completeness !== complete
    expect(result.domains.lists?.completeness).not.toBe("complete");
    expect(result.domains.reminders?.completeness).not.toBe("complete");
    expect(result.completeness).not.toBe("complete");

    // 4) No alternate path: empty listMutations ⇒ nothing in applied
    expect(
      (result.domains.lists?.applied ?? []).some((row) => row.op === "add"),
    ).toBe(false);
  });

  it("does not mark task applied when a sibling mutation exists but failed package was omitted", () => {
    // Other successful mutation must not "cover" the rolled-back nested add.
    const result = applyResultAfterAtomicRollback({
      listMutations: [
        {
          action: "add",
          itemId: "other-item",
          employeeId: ACTOR.id,
          listType: "shopping",
          itemKey: "חלב",
          itemLabel: "חלב",
        },
      ],
      nestedRemindMisses: [
        {
          reason: "nested_remind_txn_failed",
          op: "add",
          listType: "tasks",
          itemLabel: "תור לווטרינר",
          detail: "תור לווטרינר",
          remindLabels: ["תזכורת"],
        },
      ],
    });
    expect(result.domains.lists?.applied).toEqual([
      expect.objectContaining({ id: "other-item", listType: "shopping" }),
    ]);
    expect(
      result.domains.lists?.applied.some(
        (row) => row.listType === "tasks" && row.label === "תור לווטרינר",
      ),
    ).toBe(false);
    expect(result.domains.lists?.apply_misses).toEqual([
      expect.objectContaining({
        reason: "nested_remind_txn_failed",
        listType: "tasks",
      }),
    ]);
    expect(result.completeness).not.toBe("complete");
  });
});

describe("ApplyResult nested-only success/failure (gap-fix)", () => {
  it("success: reminderResult.saved opens reminders domain without requested.reminders", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          items: [{ "שם משימה": "תור" }],
          targets: [],
        },
      ],
    });
    const result = buildApplyResult({
      requested,
      listMutations: [
        {
          action: "add",
          itemId: ITEM,
          employeeId: ACTOR.id,
          listType: "tasks",
          itemKey: "תור",
          itemLabel: "תור",
          nestedClocksApplied: true,
        },
      ],
      reminderResult: {
        saved: [
          { id: REM, item: "בוקר", itemLabel: "בוקר" },
          { id: "22222222-2222-4222-8222-222222222222", item: "ערב", itemLabel: "ערב" },
        ],
        removed: [],
        missed: [],
        skipped: [],
        changes: [],
      },
    });
    expect(result.domains.reminders?.requested).toEqual([]);
    expect(result.domains.reminders?.applied).toHaveLength(2);
    expect(result.domains.reminders?.completeness).toBe("complete");
    expect(result.completeness).toBe("complete");
  });

  it("failure: nested miss keeps completeness not complete", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          items: [{ "שם משימה": "תור" }],
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
          itemLabel: "תור",
          detail: "תור",
          remindLabels: ["בוקר"],
        },
      ],
      reminderResult: {
        saved: [],
        removed: [],
        missed: [],
        skipped: [{ item: "בוקר", reason: "db" }],
        changes: [],
      },
    });
    expect(result.domains.reminders?.applied).toEqual([]);
    expect(result.domains.reminders?.apply_misses.length).toBeGreaterThan(0);
    expect(result.domains.reminders?.completeness).not.toBe("complete");
    expect(result.completeness).not.toBe("complete");
  });
});
