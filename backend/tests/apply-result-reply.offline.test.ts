/**
 * Result-B: decideReplyFromApplyResult — the model draft stands unless
 * ApplyResult proves a failure. The model's text is never analyzed.
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
      modelDraft: draftJson("הסרתי את «דיברתי עם yes» מהמשימות."),
    });
    expect(decided.keepDraft).toBe(true);
    expect(decided.spoken).toContain("הסרתי");
  });

  it("full success: model wording is never second-guessed (no text analysis)", () => {
    const decided = decideReplyFromApplyResult({
      applyResult: resultFullSuccess(),
      modelDraft: draftJson("הוספתי את המשימה לרשימה."),
    });
    expect(decided.keepDraft).toBe(true);
    expect(decided.spoken).toBe("הוספתי את המשימה לרשימה.");
  });

  it("no requested mutates: soft-offer «כן» → model asks for a time; reply stands", () => {
    // Regression (Tal, 2026-11-04): task without a time, «רוצה שאוסיף גם תזכורת?» →
    // «כן» → model correctly asks when. Engine replaced it with «לא הצלחתי
    // לשמור את התזכורת.» because a text heuristic saw «אזכיר» + «תזכורת».
    const question =
      "באיזו שעה תרצה שאזכיר לך? אפשר גם לומר „בעוד שעה” או לקבוע תזכורת חוזרת.";
    const result = buildApplyResult({
      requested: captureRequestedFromMetadata(emptyLlmMetadata()),
    });
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson(question),
    });
    expect(decided.keepDraft).toBe(true);
    expect(decided.spoken).toBe(question);
  });

  it("no requested mutates: even a past-tense claim is the model's to own", () => {
    const result = buildApplyResult({
      requested: captureRequestedFromMetadata(emptyLlmMetadata()),
    });
    for (const text of [
      "קבעתי תזכורת למחר ב־9.",
      "הוספתי את החלב לקניות.",
      "מחקתי את המשימה.",
      "שיתפתי את הרשימה עם דני.",
      "תייקתי את הקוד.",
    ]) {
      const decided = decideReplyFromApplyResult({
        applyResult: result,
        modelDraft: draftJson(text),
      });
      expect(decided.keepDraft).toBe(true);
      expect(decided.spoken).toBe(text);
    }
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

  it("partial range delete names the row that was not removed", () => {
    const kept = "task-kept";
    const missed = "task-missed";
    const requested = captureRequestedFromMetadata({
      lists: [
        remove("tasks", [
          { item_id: kept },
          { item_id: missed },
          { item_id: "task-2" },
          { item_id: "task-3" },
        ]),
      ],
    });
    const result = buildApplyResult({
      requested,
      listMutations: [
        {
          action: "remove",
          itemId: kept,
          employeeId: "e1",
          listType: "tasks",
          itemKey: "k1",
          itemLabel: "משימה 7",
        },
        {
          action: "remove",
          itemId: "task-2",
          employeeId: "e1",
          listType: "tasks",
          itemKey: "k2",
          itemLabel: "משימה 9",
        },
        {
          action: "remove",
          itemId: "task-3",
          employeeId: "e1",
          listType: "tasks",
          itemKey: "k3",
          itemLabel: "משימה 10",
        },
      ],
      shareMisses: [
        {
          itemId: missed,
          reason: "missing",
          label: "להזכיר לטל",
          dumpLine: 8,
        },
      ],
    });
    expect(result.completeness).toBe("partial");
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson("הסרתי 4 פריטים."),
    });
    expect(decided.keepDraft).toBe(false);
    expect(decided.spoken).toContain("הסרתי 3 פריטים.");
    expect(decided.spoken).toContain("לא הוסר: 8. «להזכיר לטל».");
    expect(decided.spoken).not.toContain(LIST_FIND_MISS);
    expect(decided.spoken).not.toContain("הסרתי 4");
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

  it("successful filing add: keeps תייקתי draft (not list-add / unknown)", () => {
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
        },
      ],
    });
    expect(result.completeness).toBe("complete");
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson("תייקתי את *בלו* כמשקה אנרגיה."),
    });
    expect(decided.keepDraft).toBe(true);
    expect(decided.spoken).toBe("תייקתי את *בלו* כמשקה אנרגיה.");
    expect(decided.spoken).not.toMatch(/לא הצלחתי/);
    expect(decided.spoken).not.toContain("הוספתי");
  });

  it("unverified filing remove: blocks תייקתי/מחקתי success claim", () => {
    const requested = captureRequestedFromMetadata({
      filing: [
        {
          action: "remove_filing",
          filingId: "f-missing",
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
    expect(result.completeness).toBe("unknown");
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson("מחקתי את התיוק."),
    });
    expect(decided.keepDraft).toBe(false);
    expect(decided.spoken).toMatch(/לא הצלחתי לאמת/);
  });

  it("regression מחק 2: successful filing remove keeps success, no unknown caution", () => {
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
    expect(result.completeness).toBe("complete");
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson("מחקתי את בלו מהתיוקים."),
    });
    expect(decided.keepDraft).toBe(true);
    expect(decided.spoken).toBe("מחקתי את בלו מהתיוקים.");
    expect(decided.spoken).not.toMatch(/לא הצלחתי לאמת/);

    // Any wording stands on a complete apply — the engine does not read it.
    const other = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson("הוספתי את בלו לרשימה."),
    });
    expect(other.keepDraft).toBe(true);
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

  it("complete apply: a numbered draft stands (model owns the reply)", () => {
    const decided = decideReplyFromApplyResult({
      applyResult: resultFullSuccess(),
      modelDraft: draftJson("מחקתי.\nקניות:\n1. חלב\n2. לחם"),
    });
    expect(decided.keepDraft).toBe(true);
  });

  it("one cancelled clock is complete and keeps the model's confirmation", () => {
    const clockId = "172b39e1-4d56-4b84-9707-bc4baa0a0c89";
    const requested = captureRequestedFromMetadata({
      reminders: [
        {
          ...reminderAdd("shopping"),
          action: "remove",
          item: "לשתות מים",
          reminderId: clockId,
        },
      ],
    });
    const result = buildApplyResult({
      requested,
      reminderResult: {
        saved: [],
        removed: ["לשתות מים"],
        missed: [],
        skipped: [],
        changes: [
          { action: "remove", id: clockId, label: "לשתות מים" },
        ],
      },
    });
    expect(result.completeness).toBe("complete");
    expect(result.domains.reminders?.applied).toEqual([
      expect.objectContaining({
        op: "remove",
        id: clockId,
        label: "לשתות מים",
      }),
    ]);
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson("הפסקתי את התזכורת היומית לשתות מים."),
    });
    expect(decided.keepDraft).toBe(true);
    expect(decided.spoken).toBe("הפסקתי את התזכורת היומית לשתות מים.");
    expect(decided.spoken).not.toContain("הסרתי 2");
    expect(decided.spoken).not.toContain(APPLY_RESULT_UNKNOWN_CAUTION);
  });

  it("a label-only cascade cancel still pairs to the requested clock id", () => {
    const clockId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const requested = captureRequestedFromMetadata({
      reminders: [
        {
          ...reminderAdd("tasks"),
          action: "remove",
          item: "לשתות מים",
          reminderId: clockId,
        },
      ],
    });
    const result = buildApplyResult({
      requested,
      reminderResult: {
        saved: [],
        removed: ["לשתות מים"],
        missed: [],
        skipped: [],
        changes: [],
      },
    });
    expect(result.completeness).toBe("complete");
    expect(result.domains.reminders?.applied).toHaveLength(1);
    expect(result.domains.reminders?.applied[0]).toEqual(
      expect.objectContaining({ op: "remove", id: clockId, label: "לשתות מים" }),
    );
  });

  it("one applied cancel and one known miss stays a partial failure", () => {
    const kept = "172b39e1-4d56-4b84-9707-bc4baa0a0c89";
    const missing = "99999999-8888-4777-8666-555555555555";
    const requested = captureRequestedFromMetadata({
      reminders: [
        {
          ...reminderAdd("shopping"),
          action: "remove",
          item: "לשתות מים",
          reminderId: kept,
        },
        {
          ...reminderAdd("shopping"),
          action: "remove",
          item: "להוריד את הכלב",
          reminderId: missing,
        },
      ],
    });
    const result = buildApplyResult({
      requested,
      reminderResult: {
        saved: [],
        removed: ["לשתות מים"],
        missed: ["להוריד את הכלב"],
        skipped: [],
        changes: [{ action: "remove", id: kept, label: "לשתות מים" }],
      },
    });
    expect(result.completeness).toBe("partial");
    expect(result.domains.reminders?.applied).toHaveLength(1);
    expect(result.domains.reminders?.apply_misses).toEqual([
      expect.objectContaining({
        reason: "missed",
        id: missing,
        detail: "להוריד את הכלב",
      }),
    ]);
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson("הפסקתי את שתי התזכורות."),
    });
    expect(decided.keepDraft).toBe(false);
    expect(decided.spoken).toContain("לשתות מים");
    expect(decided.spoken).toContain(LIST_FIND_MISS);
    expect(decided.spoken).not.toContain("הסרתי 2");
    expect(decided.spoken).not.toContain(APPLY_RESULT_UNKNOWN_CAUTION);
    expect(decided.spoken).not.toContain("שתי התזכורות");
  });

  it("two applied cancels and one miss still names both removals", () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const missing = "33333333-3333-4333-8333-333333333333";
    const requested = captureRequestedFromMetadata({
      reminders: [first, second, missing].map((id) => ({
        ...reminderAdd("tasks"),
        action: "remove" as const,
        item: "",
        reminderId: id,
      })),
    });
    const result = buildApplyResult({
      requested,
      reminderResult: {
        saved: [],
        removed: ["מים", "כלב"],
        missed: [missing],
        skipped: [],
        changes: [
          { action: "remove", id: first, label: "מים" },
          { action: "remove", id: second, label: "כלב" },
        ],
      },
    });
    expect(result.completeness).toBe("partial");
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: draftJson("הפסקתי הכל."),
    });
    expect(decided.keepDraft).toBe(false);
    expect(decided.spoken).toContain("הסרתי 2 פריטים.");
    expect(decided.spoken).toContain(LIST_FIND_MISS);
    expect(decided.spoken).not.toContain(APPLY_RESULT_UNKNOWN_CAUTION);
  });

  it("failure replacement text comes from ApplyResult, not from the draft", () => {
    const a = decideReplyFromApplyResult({
      applyResult: resultFullFailure(),
      modelDraft: draftJson("מחקתי את החלב."),
    });
    const b = decideReplyFromApplyResult({
      applyResult: resultFullFailure(),
      modelDraft: draftJson("שאלה כלשהי?"),
    });
    expect(a.keepDraft).toBe(false);
    expect(b.keepDraft).toBe(false);
    expect(a.spoken).toBe(b.spoken);
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
