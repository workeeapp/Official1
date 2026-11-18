/**
 * P0 Watch→Action — unit/offline coverage for package normalize, ledger
 * independence, static vs event_bound, and Watch-scoped duplicate skip.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  reminderUpdate,
  employeeFindFirst,
  employeeListFindFirst,
  employeeListItemFindFirst,
  employeeListItemFindMany,
} = vi.hoisted(() => ({
  reminderUpdate: vi.fn(),
  employeeFindFirst: vi.fn(),
  employeeListFindFirst: vi.fn(),
  employeeListItemFindFirst: vi.fn(),
  employeeListItemFindMany: vi.fn(),
}));

const applyEmployeeRecords = vi.hoisted(() => vi.fn());

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: { update: reminderUpdate },
    employee: { findFirst: employeeFindFirst },
    employeeList: { findFirst: employeeListFindFirst },
    employeeListItem: {
      findFirst: employeeListItemFindFirst,
      findMany: employeeListItemFindMany,
    },
  },
}));

vi.mock("../src/services/employee-records.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/employee-records.service.js")>();
  return {
    ...actual,
    applyEmployeeRecords: (...args: unknown[]) => applyEmployeeRecords(...args),
  };
});

vi.mock("../src/services/whatsapp-log.js", () => ({
  recordWhatsAppEvent: vi.fn(),
}));

import {
  executeWatchTriggerActions,
  markWatchTriggerNotified,
  normalizeWatchTriggerPackage,
  parseWatchTriggerExecLedger,
  parseWatchTriggerPackage,
  watchTriggerNeedsActionRecovery,
  watchTriggerNeedsNotifyRecovery,
  type WatchTriggerPackage,
} from "../src/services/watch-trigger-actions.service.js";

function okApply(label: string) {
  return {
    events: [],
    mutations: [
      {
        action: "add" as const,
        listType: "shopping" as const,
        listName: "",
        itemLabel: label,
      },
    ],
    filingMutations: [],
    cancelledReminders: [],
    cancelledReminderIds: [],
    shareMisses: [],
    nestedRemindMisses: [],
    attachmentOutcome: {
      linked: [],
      detached: [],
      missing: [],
      forbidden: [],
    },
  };
}

function basePackage(
  overrides?: Partial<WatchTriggerPackage>,
): WatchTriggerPackage {
  return {
    version: 1,
    authorizedAt: new Date().toISOString(),
    actorEmployeeId: "owner-1",
    ownerEmployeeId: "owner-1",
    actions: [
      {
        key: "lists.add:aaaa",
        kind: "lists.add",
        mode: "static",
        list: {
          action: "add",
          listType: "shopping",
          listName: "",
          listId: "list-1",
          items: [{ "שם פריט": "חלב" }],
          targets: [],
        },
      },
    ],
    ...overrides,
  };
}

describe("watch-trigger-actions package", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    employeeListFindFirst.mockResolvedValue({ id: "list-1", titleField: "" });
    employeeListItemFindFirst.mockResolvedValue({ id: "item-1" });
    employeeListItemFindMany.mockResolvedValue([]);
    reminderUpdate.mockImplementation(async ({ data }: { data: unknown }) => ({
      id: "rem-1",
      ...(data as object),
    }));
    employeeFindFirst.mockResolvedValue({
      id: "owner-1",
      isGuest: false,
      user: { consentPending: false },
    });
    applyEmployeeRecords.mockResolvedValue(okApply("חלב"));
  });

  it("rejects share targets and non-add/update at normalize", async () => {
    const rejected = await normalizeWatchTriggerPackage({
      raw: {
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "חלב" }],
            targets: ["עמית"],
          },
        ],
      },
      actorEmployeeId: "owner-1",
      ownerEmployeeId: "owner-1",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.reason).toBe("targets_not_owner_only");
    }
  });

  it("normalizes static owner-only lists.add with resolved listId", async () => {
    const ok = await normalizeWatchTriggerPackage({
      raw: {
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "חלב" }],
            targets: [],
            mode: "static",
          },
        ],
      },
      actorEmployeeId: "owner-1",
      ownerEmployeeId: "owner-1",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.package.actions).toHaveLength(1);
      expect(ok.package.actions[0]!.list.listId).toBe("list-1");
      expect(ok.package.actions[0]!.mode).toBe("static");
    }
  });

  it("event_bound fails closed when declared fact is missing", async () => {
    const pkg = basePackage({
      actions: [
        {
          key: "lists.add:bound",
          kind: "lists.add",
          mode: "event_bound",
          binds: { "items.0.מחיר": "market.price" },
          list: {
            action: "add",
            listType: "shopping",
            listName: "",
            listId: "list-1",
            items: [{ "שם פריט": "מוצר" }],
            targets: [],
          },
        },
      ],
    });
    const ran = await executeWatchTriggerActions({
      reminderId: "rem-1",
      userId: "user-1",
      package: pkg,
      ledger: { version: 1, events: {} },
      fingerprint: "market:below",
      facts: { marketPrice: null },
    });
    expect(ran.actionResults[0]!.status).toBe("failed");
    expect(ran.actionResults[0]!.error).toMatch(/missing_fact/);
    expect(applyEmployeeRecords).not.toHaveBeenCalled();
  });

  it("does not re-run a done Action when notification later fails", async () => {
    const pkg = basePackage();
    const first = await executeWatchTriggerActions({
      reminderId: "rem-1",
      userId: "user-1",
      package: pkg,
      ledger: { version: 1, events: {} },
      fingerprint: "market:below",
      facts: { marketPrice: 90 },
    });
    expect(first.actionResults[0]!.status).toBe("done");
    expect(applyEmployeeRecords).toHaveBeenCalledTimes(1);

    const afterNotifyFail = await markWatchTriggerNotified({
      reminderId: "rem-1",
      ledger: first.ledger,
      package: pkg,
      fingerprint: "market:below",
      notified: false,
    });
    expect(afterNotifyFail.events["market:below"]!.notified).toBe(false);
    expect(
      afterNotifyFail.events["market:below"]!.actions["lists.add:aaaa"]!.status,
    ).toBe("done");

    applyEmployeeRecords.mockClear();
    const retry = await executeWatchTriggerActions({
      reminderId: "rem-1",
      userId: "user-1",
      package: pkg,
      ledger: afterNotifyFail,
      fingerprint: "market:below",
      facts: { marketPrice: 90 },
    });
    expect(retry.actionResults[0]!.status).toBe("done");
    expect(applyEmployeeRecords).not.toHaveBeenCalled();
    expect(
      watchTriggerNeedsActionRecovery(retry.ledger, pkg, "market:below"),
    ).toBe(false);
    expect(watchTriggerNeedsNotifyRecovery(retry.ledger, "market:below")).toBe(
      true,
    );
  });

  it("keeps incomplete older fingerprint when a new one arrives", async () => {
    const pkg = basePackage({
      actions: [
        {
          key: "lists.add:a",
          kind: "lists.add",
          mode: "static",
          list: {
            action: "add",
            listType: "shopping",
            listName: "",
            listId: "list-1",
            items: [{ "שם פריט": "A" }],
            targets: [],
          },
        },
      ],
    });
    applyEmployeeRecords.mockRejectedValueOnce(new Error("boom"));
    const first = await executeWatchTriggerActions({
      reminderId: "rem-1",
      userId: "user-1",
      package: pkg,
      ledger: { version: 1, events: {} },
      fingerprint: "fp-old",
      facts: {},
    });
    expect(first.actionResults[0]!.status).toBe("failed");

    applyEmployeeRecords.mockResolvedValueOnce(okApply("A"));
    const second = await executeWatchTriggerActions({
      reminderId: "rem-1",
      userId: "user-1",
      package: pkg,
      ledger: first.ledger,
      fingerprint: "fp-new",
      facts: {},
    });
    expect(second.ledger.events["fp-old"]!.actions["lists.add:a"]!.status).toBe(
      "failed",
    );
    expect(second.ledger.events["fp-new"]!.actions["lists.add:a"]!.status).toBe(
      "done",
    );
    expect(second.ledger.events["fp-old"]!.notified).toBeNull();
    expect(Object.keys(second.ledger.events)).toEqual(
      expect.arrayContaining(["fp-old", "fp-new"]),
    );
  });

  it("two fingerprints can be incomplete simultaneously", async () => {
    const pkg = basePackage({
      actions: [
        {
          key: "lists.add:a",
          kind: "lists.add",
          mode: "static",
          list: {
            action: "add",
            listType: "shopping",
            listName: "",
            listId: "list-1",
            items: [{ "שם פריט": "A" }],
            targets: [],
          },
        },
      ],
    });
    applyEmployeeRecords.mockRejectedValue(new Error("down"));
    const a = await executeWatchTriggerActions({
      reminderId: "rem-1",
      userId: "user-1",
      package: pkg,
      ledger: { version: 1, events: {} },
      fingerprint: "fp-1",
      facts: {},
    });
    const b = await executeWatchTriggerActions({
      reminderId: "rem-1",
      userId: "user-1",
      package: pkg,
      ledger: a.ledger,
      fingerprint: "fp-2",
      facts: {},
    });
    expect(b.ledger.events["fp-1"]!.actions["lists.add:a"]!.status).toBe(
      "failed",
    );
    expect(b.ledger.events["fp-2"]!.actions["lists.add:a"]!.status).toBe(
      "failed",
    );
    expect(Object.keys(b.ledger.events).sort()).toEqual(["fp-1", "fp-2"]);
  });

  it("partial success retries only the failed Action", async () => {
    const pkg = basePackage({
      actions: [
        {
          key: "lists.add:ok",
          kind: "lists.add",
          mode: "static",
          list: {
            action: "add",
            listType: "shopping",
            listName: "",
            listId: "list-1",
            items: [{ "שם פריט": "OK" }],
            targets: [],
          },
        },
        {
          key: "lists.add:bad",
          kind: "lists.add",
          mode: "static",
          list: {
            action: "add",
            listType: "shopping",
            listName: "",
            listId: "list-1",
            items: [{ "שם פריט": "BAD" }],
            targets: [],
          },
        },
      ],
    });
    applyEmployeeRecords
      .mockResolvedValueOnce(okApply("OK"))
      .mockRejectedValueOnce(new Error("second failed"))
      .mockResolvedValueOnce(okApply("BAD"));

    const first = await executeWatchTriggerActions({
      reminderId: "rem-1",
      userId: "user-1",
      package: pkg,
      ledger: { version: 1, events: {} },
      fingerprint: "fp-partial",
      facts: {},
    });
    expect(first.actionResults.map((r) => r.status)).toEqual([
      "done",
      "failed",
    ]);
    expect(applyEmployeeRecords).toHaveBeenCalledTimes(2);

    applyEmployeeRecords.mockClear();
    const retry = await executeWatchTriggerActions({
      reminderId: "rem-1",
      userId: "user-1",
      package: pkg,
      ledger: first.ledger,
      fingerprint: "fp-partial",
      facts: {},
    });
    expect(retry.actionResults.map((r) => `${r.key}:${r.status}`)).toEqual([
      "lists.add:ok:done",
      "lists.add:bad:done",
    ]);
    expect(applyEmployeeRecords).toHaveBeenCalledTimes(1);
    const appliedList = applyEmployeeRecords.mock.calls[0]![1] as {
      lists: Array<{ items: Array<Record<string, unknown>> }>;
    };
    expect(String(appliedList.lists[0]!.items[0]!["שם פריט"])).toBe("BAD");
  });

  it("Watch-scoped duplicate title skip marks done without apply", async () => {
    employeeListItemFindMany.mockResolvedValue([
      { itemKey: "חלב", data: { "שם פריט": "חלב" } },
    ]);
    const pkg = basePackage();
    const ran = await executeWatchTriggerActions({
      reminderId: "rem-1",
      userId: "user-1",
      package: pkg,
      ledger: { version: 1, events: {} },
      fingerprint: "market:below",
      facts: {},
    });
    expect(ran.actionResults[0]!.status).toBe("done");
    expect(
      ran.ledger.events["market:below"]!.actions["lists.add:aaaa"]!.resultHint,
    ).toBe("skipped_duplicate_title");
    expect(applyEmployeeRecords).not.toHaveBeenCalled();
  });

  it("parseWatchTriggerPackage round-trips", () => {
    const pkg = basePackage();
    const parsed = parseWatchTriggerPackage(pkg);
    expect(parsed?.actions[0]?.key).toBe("lists.add:aaaa");
    expect(parseWatchTriggerExecLedger(null).events).toEqual({});
  });
});
