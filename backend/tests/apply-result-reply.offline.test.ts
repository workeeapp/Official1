/**
 * Result-B: decideReplyFromApplyResult — gates optimistic drafts vs ApplyResult.
 */
import { describe, expect, it } from "vitest";
import {
  buildApplyResult,
  captureRequestedFromMetadata,
  computeDomainCompleteness,
  type ApplyResult,
} from "../src/services/apply-result.js";
import {
  APPLY_RESULT_UNKNOWN_CAUTION,
  decideReplyFromApplyResult,
  draftMatchesApplied,
} from "../src/services/apply-result-reply.js";
import { LIST_FIND_MISS } from "../src/services/employee-records.service.js";
import { stripShowTurnMutates } from "../src/services/show-turn-guard.js";
import {
  emptyLlmMetadata,
  type LlmListAction,
  type LlmReminderAction,
} from "@workee/shared";

const shoppingId = "shop-1";
const taskId = "task-1";

function reminderAdd(
  listType: LlmReminderAction["listType"],
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
  };
}

function remove(
  listType: LlmListAction["listType"],
  items: Record<string, unknown>[],
): LlmListAction {
  return {
    action: "remove",
    listType,
    listName: "",
    items,
    targets: [],
  };
}

function draftJson(text: string): string {
  return JSON.stringify({
    responses: [{ text }],
    metadata: { lists: [] },
  });
}

function resultFullSuccess(): ApplyResult {
  const requested = captureRequestedFromMetadata({
    lists: [remove("tasks", [{ item_id: taskId }])],
  });
  return buildApplyResult({
    requested,
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
  });
}

function resultPartial(): ApplyResult {
  const requested = captureRequestedFromMetadata({
    lists: [
      remove("shopping", [
        { item_id: shoppingId },
        { item_id: taskId },
      ]),
    ],
  });
  return buildApplyResult({
    requested,
    dumpGuardDrops: [
      {
        itemId: shoppingId,
        listType: "shopping",
        op: "remove",
        reason: "outside_dump",
      },
    ],
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
  });
}

function resultFullFailure(): ApplyResult {
  const requested = captureRequestedFromMetadata({
    lists: [remove("shopping", [{ item_id: shoppingId }])],
  });
  return buildApplyResult({
    requested,
    dumpGuardDrops: [
      {
        itemId: shoppingId,
        listType: "shopping",
        op: "remove",
        reason: "outside_dump",
      },
    ],
    listMutations: [],
  });
}

function resultUnknown(): ApplyResult {
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
  return buildApplyResult({ requested, filingMutations: [] });
}

describe("decideReplyFromApplyResult", () => {
  it("full success: keeps matching model draft", () => {
    const decided = decideReplyFromApplyResult({
      applyResult: resultFullSuccess(),
      modelDraft: draftJson("הסרתי את «דיברתי עם yes» מהמטלות."),
    });
    expect(decided.keepDraft).toBe(true);
    expect(decided.spoken).toContain("הסרתי");
  });

  it("full success: rejects draft that claims add when only remove applied", () => {
    const decided = decideReplyFromApplyResult({
      applyResult: resultFullSuccess(),
      modelDraft: draftJson("הוספתי את המטלה לרשימה."),
    });
    expect(decided.keepDraft).toBe(false);
    expect(decided.spoken).toContain("הסרתי");
    expect(decided.spoken).not.toContain("הוספתי");
  });

  it("partial: replaces optimistic full-success draft; reports applied only + miss", () => {
    const result = resultPartial();
    expect(result.completeness).toBe("partial");
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson("מחקתי את שני הפריטים."),
    });
    expect(decided.keepDraft).toBe(false);
    expect(decided.spoken).toContain("דיברתי עם yes");
    expect(decided.spoken).toContain(LIST_FIND_MISS);
    // Must not present a free-form full inventory.
    expect(decided.spoken).not.toMatch(/^\s*1\.\s/m);
  });

  it("full failure: blocks success claim", () => {
    const decided = decideReplyFromApplyResult({
      applyResult: resultFullFailure(),
      modelDraft: draftJson("מחקתי את החלב."),
    });
    expect(decided.keepDraft).toBe(false);
    expect(decided.spoken).toBe(LIST_FIND_MISS);
  });

  it("unknown: blocks optimistic full success", () => {
    const result = resultUnknown();
    expect(result.completeness).toBe("unknown");
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson("מחקתי את התיוק."),
    });
    expect(decided.keepDraft).toBe(false);
    expect(decided.spoken).toMatch(/לא הצלחתי לאמת/);
  });

  it("successful id-less lists.add: complete — no unknown caution", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "אורז" }],
          targets: [],
        },
      ],
    });
    const result = buildApplyResult({
      requested,
      listMutations: [
        {
          action: "add",
          itemId: "minted-rice",
          employeeId: "e1",
          listType: "shopping",
          itemKey: "k",
          itemLabel: "אורז",
        },
      ],
    });
    expect(result.completeness).toBe("complete");
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson("הוספתי את «אורז» לרשימת הקניות."),
    });
    expect(decided.keepDraft).toBe(true);
    expect(decided.spoken).not.toMatch(/לא הצלחתי לאמת/);
  });

  it("self-nudge reminder with wrapper listType tasks: keeps model confirm (no verify caution)", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          items: [
            {
              "שם מטלה": "לשתות מיץ",
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
    expect(result.completeness).toBe("complete");
    const modelText =
      "הוספתי *לשתות מיץ* למשימות, ותזכורת לעוד חמש דקות.";
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson(modelText),
    });
    expect(decided.keepDraft).toBe(true);
    expect(decided.spoken).toBe(modelText);
    expect(decided.spoken).not.toContain(APPLY_RESULT_UNKNOWN_CAUTION);
    expect(decided.spoken).not.toMatch(/לא הצלחתי לאמת/);
  });

  it("reminder wrapper shopping save fail: does not keep optimistic success as verified", () => {
    const requested = captureRequestedFromMetadata({
      reminders: [reminderAdd("shopping")],
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
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson("שמרתי תזכורת לשתות מיץ."),
    });
    expect(decided.keepDraft).toBe(false);
    expect(result.domains.reminders?.applied).toHaveLength(0);
  });

  it("id-less add success + sibling add miss: partial, not complete/unknown", () => {
    const requested = [
      { domain: "lists" as const, op: "add", listType: "shopping" },
      { domain: "lists" as const, op: "add", listType: "shopping" },
    ];
    const applied = [
      {
        domain: "lists" as const,
        op: "add",
        id: "minted-ok",
        listType: "shopping",
        label: "אורז",
      },
    ];
    const apply_misses = [
      {
        domain: "lists" as const,
        reason: "apply_failed",
        op: "add",
        listType: "shopping",
      },
    ];
    const completeness = computeDomainCompleteness({
      requested,
      applied,
      intent_misses: [],
      apply_misses,
    });
    expect(completeness).toBe("partial");
    const result: ApplyResult = {
      domains: {
        lists: {
          requested,
          applied,
          intent_misses: [],
          apply_misses,
          completeness,
        },
      },
      completeness,
    };
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson("הוספתי את שני הפריטים לקניות."),
    });
    expect(decided.keepDraft).toBe(false);
    expect(decided.spoken).not.toMatch(/לא הצלחתי לאמת/);
    expect(decided.spoken).toMatch(/אורז|הוספתי/);
  });

  it("does not emit numbered list inventory (engine display path remains)", () => {
    const decided = decideReplyFromApplyResult({
      applyResult: resultFullSuccess(),
      modelDraft: draftJson("מחקתי.\nקניות:\n1. חלב\n2. לחם"),
    });
    expect(decided.keepDraft).toBe(false);
    expect(decided.spoken).not.toMatch(/\n1\.\s/);
    expect(decided.spoken).not.toContain("קניות:");
  });
});

describe("draftMatchesApplied", () => {
  it("rejects delete claim without removes", () => {
    expect(
      draftMatchesApplied(
        {
          anySuccess: true,
          deleteClaim: true,
          addClaim: false,
          updateClaim: false,
          shareClaim: false,
          reminderClaim: false,
          durableClaim: false,
        },
        { total: 1, removes: 0, adds: 1, updates: 0 },
      ),
    ).toBe(false);
  });
});

describe("show_dump + mutates uses real stripShowTurnMutates", () => {
  it("invokes stripShowTurnMutates and keeps mutates", () => {
    const lists = [remove("shopping", [{ item_id: shoppingId }])];
    const before = {
      ...emptyLlmMetadata(),
      showDump: "shopping" as string | undefined,
      lists,
    };
    const after = stripShowTurnMutates(before);
    expect(after).not.toBe(before);
    expect(after.lists).toEqual(lists);
    expect(after.showDump).toBeUndefined();
  });
});
