/**
 * Result-A: ApplyResult builders — internal only, no reply renderer.
 */
import { describe, expect, it } from "vitest";
import type { LlmListAction, LlmReminderAction } from "@workee/shared";
import {
  buildApplyResult,
  captureRequestedFromMetadata,
  collectShowTurnStripDrops,
  computeDomainCompleteness,
  requestedOpsFromLists,
  requestedOpsFromReminders,
} from "../src/services/apply-result.js";
import { resolveIntentRefs } from "../src/services/list-intent-refs.js";
import {
  restrictListMutatesToLastNumberedDump,
  type LastNumberedDumpLine,
} from "../src/services/show-button-dump.js";
import { stripShowTurnMutates } from "../src/services/show-turn-guard.js";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import { buildThisTurnVisibleRefs } from "../src/services/list-intent-refs.js";
import { emptyLlmMetadata } from "@workee/shared";

/** Minimal reminder add — listType is soft-link wrapper only. */
function reminderAdd(
  listType: LlmReminderAction["listType"],
  overrides: Partial<LlmReminderAction> = {},
): LlmReminderAction {
  return {
    action: "add",
    item: "לשתות מיץ",
    listType,
    date: "",
    time: "",
    repeat: "once",
    ping: ["עמית"],
    targets: [],
    text: "",
    inSeconds: 300,
    everyCount: null,
    everyUnit: null,
    weekdays: null,
    confirmed: false,
    compose: false,
    composeSource: "",
    composeLookbackHours: 0,
    composePlace: "",
    reminderId: "",
    itemId: "2c8e09a5-4a3d-4a55-bfc7-50ab892e07d2",
    ...overrides,
  };
}

const shoppingId = "shop-1";
const taskId = "task-1";
const customDump: LastNumberedDumpLine[] = [
  {
    n: 1,
    id: "custom-1",
    kind: "custom",
    title_stem: "x",
    list_name: "רשימה",
  },
];

const snap: EmployeeRecordSnapshot = {
  lists: [
    {
      list_type: "shopping",
      owner: "טל",
      scope: "personal",
      items: [{ item_id: shoppingId, "שם פריט": "חלב" }],
    },
    {
      list_type: "tasks",
      owner: "טל",
      scope: "personal",
      items: [{ item_id: taskId, "שם משימה": "דיברתי עם yes" }],
    },
  ],
  filing: [],
};

function remove(listType: LlmListAction["listType"], items: Record<string, unknown>[]): LlmListAction {
  return {
    action: "remove",
    listType,
    listName: "",
    items,
    targets: [],
  };
}

describe("captureRequestedFromMetadata immutability", () => {
  it("keeps a deep copy that survives later metadata mutation", () => {
    const lists = [
      remove("shopping", [{ item_id: shoppingId }]),
    ];
    const captured = captureRequestedFromMetadata({ lists });
    lists[0]!.items = [];
    lists[0]!.listType = "tasks";
    expect(captured.lists[0]?.listType).toBe("shopping");
    expect(captured.lists[0]?.items).toEqual([{ item_id: shoppingId }]);
  });
});

describe("buildApplyResult accounting", () => {
  it("requested retains items dropped by resolve and H; applied only real mutations", () => {
    const requestedMeta = captureRequestedFromMetadata({
      lists: [
        remove("shopping", [
          { item_id: shoppingId },
          {
            mutate_source: "saved_data",
            item_id: "not-in-esd",
          },
        ]),
        remove("tasks", [
          {
            mutate_source: "saved_data",
            item_id: taskId,
          },
        ]),
      ],
    });

    const visibleRefs = buildThisTurnVisibleRefs(snap);
    const intent = resolveIntentRefs(requestedMeta.lists, {
      dump: customDump,
      visibleRefs,
    });
    // Legacy shopping id still in lists after intent (no mutate_source).
    expect(
      intent.lists.some((row) =>
        row.items.some((item) => item.item_id === shoppingId),
      ),
    ).toBe(true);
    expect(intent.misses.some((m) => m.reason === "not_in_this_turn_facts")).toBe(
      true,
    );

    const guarded = restrictListMutatesToLastNumberedDump(
      intent.lists,
      customDump,
      { passThroughIds: intent.passThroughIds },
    );
    // Shopping legacy dropped by H; task passThrough kept.
    expect(guarded.droppedItems.some((d) => d.itemId === shoppingId)).toBe(
      true,
    );
    expect(
      guarded.lists.some((row) =>
        row.items.some((item) => item.item_id === taskId),
      ),
    ).toBe(true);

    const result = buildApplyResult({
      requested: requestedMeta,
      intentMisses: intent.misses,
      dumpGuardDrops: guarded.droppedItems,
      listMutations: [
        {
          action: "remove",
          itemId: taskId,
          employeeId: "e1",
          listType: "tasks",
          itemKey: "k",
          itemLabel: "דיברתי עם yes",
        },
      ],
      shareMisses: [],
    });

    const lists = result.domains.lists!;
    expect(lists.requested.map((r) => r.id).sort()).toEqual(
      ["not-in-esd", shoppingId, taskId].sort(),
    );
    expect(lists.applied).toEqual([
      expect.objectContaining({ id: taskId, op: "remove" }),
    ]);
    expect(lists.applied.some((a) => a.id === shoppingId)).toBe(false);
    expect(lists.completeness).toBe("partial");
    expect(result.completeness).toBe("partial");
  });

  it("marks filing domain unknown without inventing apply_misses", () => {
    const requested = captureRequestedFromMetadata({
      filing: [
        {
          action: "remove_filing",
          filingId: "f1",
          itemName: "",
          itemInfo: "",
          itemDescription: "",
          targets: [],
        },
      ],
    });
    const result = buildApplyResult({
      requested,
      filingMutations: [],
    });
    expect(result.domains.filing?.completeness).toBe("unknown");
    expect(result.domains.filing?.apply_misses).toEqual([]);
    expect(result.completeness).toBe("unknown");
  });

  it("successful filing add is complete (not unknown) with add_filing applied op", () => {
    const requested = captureRequestedFromMetadata({
      filing: [
        {
          action: "add_filing",
          filingId: "",
          itemName: "בלו",
          itemInfo: "משקה אנרגיה",
          itemDescription: "",
          targets: [],
        },
      ],
    });
    const result = buildApplyResult({
      requested,
      filingMutations: [
        {
          action: "add",
          itemName: "בלו",
          itemInfo: "משקה אנרגיה",
          itemDescription: "",
          filingId: "f-blo-1",
        },
      ],
    });
    expect(result.domains.filing?.completeness).toBe("complete");
    expect(result.domains.filing?.applied).toEqual([
      {
        domain: "filing",
        op: "add_filing",
        id: "f-blo-1",
        label: "בלו",
        listType: "filing",
        listName: "תיוקים",
      },
    ]);
    expect(result.completeness).toBe("complete");
  });

  it("successful filing remove with filing_id is complete (not unknown)", () => {
    const filingId = "c39f123f-a813-417c-9b8a-97942baded6a";
    const requested = captureRequestedFromMetadata({
      filing: [
        {
          action: "remove_filing",
          filingId,
          itemName: "",
          itemInfo: "",
          itemDescription: "",
          targets: [],
        },
      ],
    });
    const result = buildApplyResult({
      requested,
      filingMutations: [
        {
          action: "remove",
          itemName: "בלו",
          itemInfo: "משקה אנרגיה",
          itemDescription: "",
          filingId,
        },
      ],
    });
    expect(result.domains.filing?.completeness).toBe("complete");
    expect(result.domains.filing?.applied[0]?.id).toBe(filingId);
    expect(result.completeness).toBe("complete");
  });

  it("omits domains with empty requested", () => {
    const result = buildApplyResult({
      requested: captureRequestedFromMetadata({}),
      listMutations: [
        {
          action: "add",
          itemId: "x",
          employeeId: "e",
          listType: "tasks",
          itemKey: "k",
          itemLabel: "x",
        },
      ],
    });
    expect(result.domains.lists).toBeUndefined();
    expect(result.completeness).toBe("complete");
  });

  it("directory with requests is unknown (no full miss channel)", () => {
    const requested = captureRequestedFromMetadata({
      directory: [
        {
          action: "remove",
          contactId: "c1",
          name: "",
          phone: "",
          targets: [],
        },
      ],
    });
    const result = buildApplyResult({
      requested,
      directoryResult: { saved: [], removed: [] },
    });
    expect(result.domains.directory?.completeness).toBe("unknown");
    expect(result.domains.directory?.apply_misses).toEqual([]);
  });
});

describe("computeDomainCompleteness", () => {
  it("complete when every id applied", () => {
    expect(
      computeDomainCompleteness({
        requested: [
          { domain: "lists", op: "remove", id: "a" },
          { domain: "lists", op: "remove", id: "b" },
        ],
        applied: [
          { domain: "lists", op: "remove", id: "a" },
          { domain: "lists", op: "remove", id: "b" },
        ],
        intent_misses: [],
        apply_misses: [],
      }),
    ).toBe("complete");
  });

  it("unknown when an id has neither applied nor miss", () => {
    expect(
      computeDomainCompleteness({
        requested: [
          { domain: "lists", op: "remove", id: "a" },
          { domain: "lists", op: "remove", id: "b" },
        ],
        applied: [{ domain: "lists", op: "remove", id: "a" }],
        intent_misses: [],
        apply_misses: [],
      }),
    ).toBe("unknown");
  });

  it("partial when applied and misses both present and all accounted", () => {
    expect(
      computeDomainCompleteness({
        requested: [
          { domain: "lists", op: "remove", id: "a" },
          { domain: "lists", op: "remove", id: "b" },
        ],
        applied: [{ domain: "lists", op: "remove", id: "a" }],
        intent_misses: [{ reason: "outside_dump", itemId: "b" }],
        apply_misses: [],
      }),
    ).toBe("partial");
  });

  it("id-less lists.add pairs to applied by op+listType (minted id)", () => {
    expect(
      computeDomainCompleteness({
        requested: [
          { domain: "lists", op: "add", listType: "shopping" },
        ],
        applied: [
          {
            domain: "lists",
            op: "add",
            id: "minted-1",
            listType: "shopping",
            label: "חלב",
          },
        ],
        intent_misses: [],
        apply_misses: [],
      }),
    ).toBe("complete");
  });

  it("two id-less adds pair 1:1 without double-counting one applied", () => {
    expect(
      computeDomainCompleteness({
        requested: [
          { domain: "lists", op: "add", listType: "shopping" },
          { domain: "lists", op: "add", listType: "shopping" },
        ],
        applied: [
          {
            domain: "lists",
            op: "add",
            id: "minted-1",
            listType: "shopping",
          },
        ],
        intent_misses: [],
        apply_misses: [],
      }),
    ).toBe("unknown");

    expect(
      computeDomainCompleteness({
        requested: [
          { domain: "lists", op: "add", listType: "shopping" },
          { domain: "lists", op: "add", listType: "shopping" },
        ],
        applied: [
          {
            domain: "lists",
            op: "add",
            id: "minted-1",
            listType: "shopping",
          },
          {
            domain: "lists",
            op: "add",
            id: "minted-2",
            listType: "shopping",
          },
        ],
        intent_misses: [],
        apply_misses: [],
      }),
    ).toBe("complete");
  });

  it("id-less add success + id-less add miss stays partial", () => {
    expect(
      computeDomainCompleteness({
        requested: [
          { domain: "lists", op: "add", listType: "shopping" },
          { domain: "lists", op: "add", listType: "shopping" },
        ],
        applied: [
          {
            domain: "lists",
            op: "add",
            id: "minted-1",
            listType: "shopping",
          },
        ],
        intent_misses: [],
        apply_misses: [
          {
            domain: "lists",
            reason: "apply_failed",
            op: "add",
            listType: "shopping",
          },
        ],
      }),
    ).toBe("partial");
  });

  it("prefers listName when pairing id-less adds across custom lists", () => {
    expect(
      computeDomainCompleteness({
        requested: [
          {
            domain: "lists",
            op: "add",
            listType: "custom",
            listName: "אירוע א",
          },
          {
            domain: "lists",
            op: "add",
            listType: "custom",
            listName: "אירוע ב",
          },
        ],
        applied: [
          {
            domain: "lists",
            op: "add",
            id: "a1",
            listType: "custom",
            listName: "אירוע א",
          },
          {
            domain: "lists",
            op: "add",
            id: "b1",
            listType: "custom",
            listName: "אירוע ב",
          },
        ],
        intent_misses: [],
        apply_misses: [],
      }),
    ).toBe("complete");
  });

  it("buildApplyResult: successful id-less add is complete (not unknown)", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "חלב חדש" }],
          targets: [],
        },
      ],
    });
    const result = buildApplyResult({
      requested,
      listMutations: [
        {
          action: "add",
          itemId: "minted-shop-9",
          employeeId: "e1",
          listType: "shopping",
          itemKey: "k",
          itemLabel: "חלב חדש",
        },
      ],
    });
    expect(result.domains.lists?.requested[0]?.id).toBeUndefined();
    expect(result.domains.lists?.applied).toHaveLength(1);
    expect(result.domains.lists?.completeness).toBe("complete");
    expect(result.completeness).toBe("complete");
  });

  it("reminder add with wrapper listType tasks: saved → complete (not unknown)", () => {
    const requested = captureRequestedFromMetadata({
      reminders: [reminderAdd("tasks")],
    });
    const result = buildApplyResult({
      requested,
      reminderResult: {
        saved: [
          {
            id: "b1a32a41-0bcb-4ea6-b99d-962f5442af88",
            item: "לשתות מיץ",
            itemLabel: "לשתות מיץ",
          },
        ],
        removed: [],
        missed: [],
        skipped: [],
        changes: [],
      },
    });
    expect(result.domains.reminders?.requested[0]?.listType).toBeUndefined();
    expect(result.domains.reminders?.applied).toEqual([
      expect.objectContaining({
        domain: "reminders",
        op: "add",
        id: "b1a32a41-0bcb-4ea6-b99d-962f5442af88",
      }),
    ]);
    expect(result.domains.reminders?.completeness).toBe("complete");
    expect(result.completeness).toBe("complete");
  });

  it("reminder add with wrapper listType shopping: saved → complete", () => {
    const requested = captureRequestedFromMetadata({
      reminders: [reminderAdd("shopping")],
    });
    const result = buildApplyResult({
      requested,
      reminderResult: {
        saved: [
          {
            id: "clock-shop-1",
            item: "לקנות חלב",
            itemLabel: "לקנות חלב",
          },
        ],
        removed: [],
        missed: [],
        skipped: [],
        changes: [],
      },
    });
    expect(result.domains.reminders?.requested[0]?.listType).toBeUndefined();
    expect(result.domains.reminders?.completeness).toBe("complete");
    expect(result.completeness).toBe("complete");
  });

  it("reminder add wrapper tasks: skip/miss → never counted as applied", () => {
    const requested = captureRequestedFromMetadata({
      reminders: [reminderAdd("tasks")],
    });
    const result = buildApplyResult({
      requested,
      reminderResult: {
        saved: [],
        removed: [],
        missed: [],
        skipped: [{ item: "לשתות מיץ", reason: "no_time" }],
        changes: [],
      },
    });
    expect(result.domains.reminders?.applied).toEqual([]);
    expect(result.domains.reminders?.apply_misses).toEqual([
      expect.objectContaining({
        domain: "reminders",
        reason: "no_time",
        detail: "לשתות מיץ",
      }),
    ]);
    // Real failure must not look like a successful apply.
    expect(result.domains.reminders?.applied).toHaveLength(0);
    expect(
      (result.domains.reminders?.applied ?? []).some((row) => row.op === "add"),
    ).toBe(false);
  });

  it("mixed lists.add + reminder tasks wrapper: both saved → complete", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          items: [
            {
              "שם משימה": "לשתות מיץ",
              item_id: "2c8e09a5-4a3d-4a55-bfc7-50ab892e07d2",
            },
          ],
          targets: [],
        },
      ],
      reminders: [reminderAdd("tasks")],
    });
    const result = buildApplyResult({
      requested,
      listMutations: [
        {
          action: "add",
          itemId: "2c8e09a5-4a3d-4a55-bfc7-50ab892e07d2",
          employeeId: "e1",
          listType: "tasks",
          itemKey: "k",
          itemLabel: "לשתות מיץ",
        },
      ],
      reminderResult: {
        saved: [
          {
            id: "b1a32a41-0bcb-4ea6-b99d-962f5442af88",
            item: "לשתות מיץ",
            itemLabel: "לשתות מיץ",
          },
        ],
        removed: [],
        missed: [],
        skipped: [],
        changes: [],
      },
    });
    expect(result.domains.lists?.completeness).toBe("complete");
    expect(result.domains.reminders?.completeness).toBe("complete");
    expect(result.completeness).toBe("complete");
  });

  it("mixed: list saved + reminder skip → reminder not applied; rollup not full success", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          items: [{ "שם משימה": "לשתות מיץ" }],
          targets: [],
        },
      ],
      reminders: [reminderAdd("tasks")],
    });
    const result = buildApplyResult({
      requested,
      listMutations: [
        {
          action: "add",
          itemId: "minted-juice",
          employeeId: "e1",
          listType: "tasks",
          itemKey: "k",
          itemLabel: "לשתות מיץ",
        },
      ],
      reminderResult: {
        saved: [],
        removed: [],
        missed: [],
        skipped: [{ item: "לשתות מיץ", reason: "no_time" }],
        changes: [],
      },
    });
    expect(result.domains.lists?.completeness).toBe("complete");
    expect(result.domains.reminders?.applied).toEqual([]);
    expect(result.domains.reminders?.apply_misses).toEqual([
      expect.objectContaining({
        domain: "reminders",
        reason: "no_time",
        detail: "לשתות מיץ",
      }),
    ]);
    expect(result.completeness).not.toBe("complete");
  });
});

describe("requestedOpsFromLists", () => {
  it("expands per-item ops", () => {
    expect(
      requestedOpsFromLists([
        remove("shopping", [
          { item_id: "1" },
          { item_id: "2", mutate_source: "saved_data" },
        ]),
      ]),
    ).toHaveLength(2);
  });
});

describe("requestedOpsFromReminders", () => {
  it("omits wrapper listType from pairing ops", () => {
    expect(requestedOpsFromReminders([reminderAdd("tasks")])).toEqual([
      { domain: "reminders", op: "add", id: undefined },
    ]);
    expect(requestedOpsFromReminders([reminderAdd("shopping")])).toEqual([
      { domain: "reminders", op: "add", id: undefined },
    ]);
  });
});

describe("stripShowTurnMutates accounting", () => {
  it("live strip with show_dump+mutates keeps mutates (policy unchanged)", () => {
    const lists = [remove("shopping", [{ item_id: shoppingId }])];
    const before = {
      ...emptyLlmMetadata(),
      showDump: "shopping",
      lists,
    };
    const after = stripShowTurnMutates(before);
    // delete wins: show dropped, mutates kept — no requested ops removed.
    expect(after.lists).toEqual(lists);
    expect(after.showDump).toBeUndefined();
  });

  it("classifies cleared mutates after show_dump display-only as intent_miss (not applied)", () => {
    // Accounting branch: requested had mutates, post-strip has none + show was set.
    // (Live strip only reaches empty mutates when hasMutates was already false;
    // collectShowTurnStripDrops still classifies a cleared-mutates diff.)
    const lists = [remove("shopping", [{ item_id: shoppingId }])];
    const requested = captureRequestedFromMetadata({ lists });
    const strip = collectShowTurnStripDrops({
      requested,
      showDumpBefore: "shopping",
      afterStrip: {
        lists: [],
        listOps: [],
        filing: [],
        reminders: [],
        directory: [],
      },
    });
    expect(strip.unclassified).toEqual([]);
    expect(strip.misses).toEqual([
      expect.objectContaining({
        reason: "show_dump_cleared_mutates",
        itemId: shoppingId,
        source: "show_turn_strip",
        domain: "lists",
        op: "remove",
      }),
    ]);

    const result = buildApplyResult({
      requested,
      stripMisses: strip.misses,
      unclassifiedStripDrops: strip.unclassified,
      listMutations: [],
    });
    expect(result.domains.lists?.applied).toEqual([]);
    expect(result.domains.lists?.intent_misses).toHaveLength(1);
    expect(result.domains.lists?.completeness).toBe("complete");
    expect(result.completeness).toBe("complete");
  });

  it("partial: stripped id + applied id — stripped never counted applied", () => {
    const lists = [
      remove("shopping", [
        { item_id: shoppingId },
        { item_id: taskId },
      ]),
    ];
    const requested = captureRequestedFromMetadata({ lists });
    const strip = collectShowTurnStripDrops({
      requested,
      showDumpBefore: "shopping",
      afterStrip: { lists: [], listOps: [], filing: [], reminders: [], directory: [] },
    });
    expect(strip.misses.map((m) => m.itemId).sort()).toEqual(
      [shoppingId, taskId].sort(),
    );
    const result = buildApplyResult({
      requested,
      stripMisses: strip.misses,
      // taskId also appears as applied (e.g. recovered path); shopping only as miss.
      listMutations: [
        {
          action: "remove",
          itemId: taskId,
          employeeId: "e1",
          listType: "shopping",
          itemKey: "k",
          itemLabel: "x",
        },
      ],
    });
    expect(result.domains.lists?.applied.map((a) => a.id)).toEqual([taskId]);
    expect(
      result.domains.lists?.intent_misses.some((m) => m.itemId === shoppingId),
    ).toBe(true);
    expect(
      result.domains.lists?.applied.some((a) => a.id === shoppingId),
    ).toBe(false);
    expect(result.domains.lists?.completeness).toBe("partial");
    expect(result.completeness).toBe("partial");
  });

  it("unclassified strip drop forces unknown (never complete)", () => {
    const lists = [remove("shopping", [{ item_id: shoppingId }])];
    const requested = captureRequestedFromMetadata({ lists });
    // showDump set but mutates still present after "strip" → policy anomaly path
    const strip = collectShowTurnStripDrops({
      requested,
      showDumpBefore: "shopping",
      afterStrip: {
        lists: [remove("tasks", [{ item_id: "other" }])],
        listOps: [],
        filing: [],
        reminders: [],
        directory: [],
      },
    });
    expect(strip.misses).toEqual([]);
    expect(strip.unclassified.map((o) => o.id)).toEqual([shoppingId]);

    const result = buildApplyResult({
      requested,
      stripMisses: strip.misses,
      unclassifiedStripDrops: strip.unclassified,
      listMutations: [],
    });
    expect(result.domains.lists?.completeness).toBe("unknown");
    expect(result.completeness).toBe("unknown");
    expect(result.domains.lists?.applied).toEqual([]);
  });

  it("show_dump + mutates keeps mutates — no strip misses", () => {
    const lists = [remove("shopping", [{ item_id: shoppingId }])];
    const requested = captureRequestedFromMetadata({ lists });
    const before = {
      ...emptyLlmMetadata(),
      showDump: "shopping",
      lists,
    };
    const after = stripShowTurnMutates(before);
    expect(after.lists).toEqual(lists);
    expect(after.showDump).toBeUndefined();
    const strip = collectShowTurnStripDrops({
      requested,
      showDumpBefore: before.showDump,
      afterStrip: after,
    });
    expect(strip.misses).toEqual([]);
    expect(strip.unclassified).toEqual([]);
  });
});
