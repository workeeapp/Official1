/**
 * Reply contract (production path): the model always answers. The engine
 * replaces the reply ONLY when apply proves a failure — ApplyResult misses /
 * partial / unknown, share misses, failed attach, incomplete unshare. The
 * model's text is never analyzed; replacement text is engine-built.
 */
import { describe, expect, it } from "vitest";
import { parseLlmReply } from "@workee/shared";
import {
  buildApplyResult,
  captureRequestedFromMetadata,
  type ApplyResult,
} from "../src/services/apply-result.js";
import {
  combineConfirmAndDump,
  capturePendingShowDump,
  restorePendingShowDump,
} from "../src/services/apply-result-display.js";
import { decideReplyFromApplyResult } from "../src/services/apply-result-reply.js";
import {
  ATTACH_APPLY_MISS,
  applySideFailureOverrides,
  sideFailureLines,
} from "../src/services/apply-failure-overrides.js";
import {
  LIST_ADD_MISS,
  LIST_FIND_MISS,
  type ShareApplyMiss,
} from "../src/services/employee-records.service.js";
import {
  emptyAttachmentOutcome,
  type AttachmentApplyOutcome,
} from "../src/services/attachment.service.js";
import { setEngineResponse } from "../src/services/whatsapp-send.js";
import { stripShowTurnMutates } from "../src/services/show-turn-guard.js";
import { emptyLlmMetadata, type LlmListAction } from "@workee/shared";

const shoppingId = "shop-1";
const taskId = "task-1";

function draftJson(text: string): string {
  return JSON.stringify({
    responses: [{ text }],
    metadata: { lists: [] },
  });
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

function resultCompleteRemove(): ApplyResult {
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

function resultCompleteMiss(): ApplyResult {
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

function resultUnknownFiling(): ApplyResult {
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
  return buildApplyResult({
    requested,
    filingMutations: [],
  });
}

function runProductionPath(input: {
  modelDraft: string;
  applyResult: ApplyResult;
  shareMisses?: ShareApplyMiss[];
  attachmentOutcome?: AttachmentApplyOutcome;
}) {
  const decided = decideReplyFromApplyResult({
    applyResult: input.applyResult,
    modelDraft: input.modelDraft,
  });
  let reply = input.modelDraft;
  if (!decided.keepDraft) {
    reply = setEngineResponse(reply, decided.spoken);
  }
  reply = applySideFailureOverrides({
    reply,
    resultBReplaced: !decided.keepDraft,
    lines: sideFailureLines({
      listMutations: [],
      shareMisses: input.shareMisses ?? [],
      attachmentOutcome: input.attachmentOutcome ?? emptyAttachmentOutcome(false),
      unshareSummary: null,
    }),
    setResponse: setEngineResponse,
  });
  return { decided, reply, spoken: parseLlmReply(reply).response };
}

const noActions = () =>
  buildApplyResult({ requested: captureRequestedFromMetadata({ lists: [] }) });

describe("reply contract — no failure: the model's reply always stands", () => {
  it("no ACTION + non-empty response is preserved", () => {
    const out = runProductionPath({
      modelDraft: draftJson("היי טל, איך אפשר לעזור?"),
      applyResult: noActions(),
    });
    expect(out.decided.keepDraft).toBe(true);
    expect(out.spoken).toBe("היי טל, איך אפשר לעזור?");
  });

  it("regression (Tal): soft-offer «כן» → model asks for a time; never «לא הצלחתי לשמור»", () => {
    const question =
      "באיזו שעה תרצה שאזכיר לך? אפשר גם לומר „בעוד שעה” או לקבוע תזכורת חוזרת.";
    const out = runProductionPath({
      modelDraft: draftJson(question),
      applyResult: noActions(),
    });
    expect(out.reply).toBe(draftJson(question));
    expect(out.spoken).toBe(question);
    expect(out.spoken).not.toMatch(/לא הצלחתי/);
  });

  it("claims without actions are not policed by the engine (prompt/eval concern)", () => {
    for (const text of [
      "הוספתי את הקולה לקניות.",
      "שיתפתי את החלב עם דני.",
      "צרפתי את הקובץ למשימה.",
      "שמרתי תזכורת למחר.",
      "תייקתי את *בלו* כמשקה אנרגיה.",
    ]) {
      const out = runProductionPath({
        modelDraft: draftJson(text),
        applyResult: noActions(),
      });
      expect(out.spoken).toBe(text);
    }
  });

  it("complete successful ACTION keeps the model's wording verbatim", () => {
    const out = runProductionPath({
      modelDraft: draftJson("סיימתי, מחקתי לך את זה 🙂"),
      applyResult: resultCompleteRemove(),
    });
    expect(out.decided.keepDraft).toBe(true);
    expect(out.spoken).toBe("סיימתי, מחקתי לך את זה 🙂");
  });

  it("saved filing keeps תייקתי (complete apply)", () => {
    const applyResult = buildApplyResult({
      requested: captureRequestedFromMetadata({
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
      }),
      filingMutations: [
        {
          action: "add",
          itemName: "בלו",
          itemInfo: "משקה אנרגיה",
          itemDescription: "",
        },
      ],
    });
    expect(applyResult.completeness).toBe("complete");
    const out = runProductionPath({
      modelDraft: draftJson("תייקתי את *בלו* כמשקה אנרגיה."),
      applyResult,
    });
    expect(out.spoken).toBe("תייקתי את *בלו* כמשקה אנרגיה.");
  });

  it("attachment that linked (or was already linked) is not a failure", () => {
    const out = runProductionPath({
      modelDraft: draftJson("צירפתי."),
      applyResult: noActions(),
      attachmentOutcome: {
        linked: 0,
        alreadyLinked: 1,
        detached: 0,
        attachRequested: true,
      },
    });
    expect(out.spoken).toBe("צירפתי.");
  });
});

describe("reply contract — proven failure: engine text replaces the reply", () => {
  it("complete miss → LIST_FIND_MISS regardless of what the model wrote", () => {
    for (const draft of ["מחקתי את החלב.", "רוצה שאמחק עוד משהו?"]) {
      const out = runProductionPath({
        modelDraft: draftJson(draft),
        applyResult: resultCompleteMiss(),
      });
      expect(out.decided.keepDraft).toBe(false);
      expect(out.spoken).toBe(LIST_FIND_MISS);
    }
  });

  it("partial → applied lines + miss line", () => {
    const out = runProductionPath({
      modelDraft: draftJson("מחקתי את שני הפריטים."),
      applyResult: resultPartial(),
    });
    expect(out.decided.keepDraft).toBe(false);
    expect(out.spoken).toContain("דיברתי עם yes");
    expect(out.spoken).toContain(LIST_FIND_MISS);
  });

  it("unknown → verify caution", () => {
    const out = runProductionPath({
      modelDraft: draftJson("מחקתי את התיוק."),
      applyResult: resultUnknownFiling(),
    });
    expect(out.decided.keepDraft).toBe(false);
    expect(out.spoken).toMatch(/לא הצלחתי לאמת/);
  });

  it("failed lists.add (apply miss) → engine add-miss text", () => {
    const applyResult = buildApplyResult({
      requested: captureRequestedFromMetadata({
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "קולה" }],
            targets: [],
          },
        ],
      }),
      nestedRemindMisses: [
        {
          reason: "nested_remind_txn_failed",
          op: "add",
          listType: "shopping",
          itemLabel: "קולה",
        },
      ],
      listMutations: [],
    });
    const out = runProductionPath({
      modelDraft: draftJson("הוספתי את הקולה לקניות."),
      applyResult,
    });
    expect(out.decided.keepDraft).toBe(false);
    expect(out.spoken).not.toBe("הוספתי את הקולה לקניות.");
    expect(out.spoken).toMatch(/לא הצלחתי/);
  });

  it("successful filing + unverified lists.add → not a full-success reply", () => {
    const applyResult = buildApplyResult({
      requested: captureRequestedFromMetadata({
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "קולה" }],
            targets: [],
          },
        ],
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
      }),
      filingMutations: [
        {
          action: "add",
          itemName: "בלו",
          itemInfo: "משקה אנרגיה",
          itemDescription: "",
        },
      ],
      listMutations: [],
    });
    expect(applyResult.domains.lists?.completeness).toBe("unknown");
    const out = runProductionPath({
      modelDraft: draftJson("תייקתי את בלו והוספתי קולה."),
      applyResult,
    });
    expect(out.decided.keepDraft).toBe(false);
    expect(out.spoken).toContain("בלו");
    expect(out.spoken).toMatch(/לא הצלחתי לאמת/);
  });

  it("share miss → engine share text replaces the reply", () => {
    const out = runProductionPath({
      modelDraft: draftJson("שיתפתי את החלב עם דני."),
      applyResult: noActions(),
      shareMisses: [{ itemId: "x", reason: "forbidden" }],
    });
    expect(out.spoken).toBe("אין הרשאה לשתף את הפריטים האלה.");
  });

  it("attach requested but nothing linked → engine attach-miss text", () => {
    const out = runProductionPath({
      modelDraft: draftJson("צרפתי את הקובץ למשימה."),
      applyResult: noActions(),
      attachmentOutcome: {
        linked: 0,
        alreadyLinked: 0,
        detached: 0,
        attachRequested: true,
      },
    });
    expect(out.spoken).toBe(ATTACH_APPLY_MISS);
  });

  it("ApplyResult failure + side failure → both engine lines, no model text", () => {
    const out = runProductionPath({
      modelDraft: draftJson("מחקתי ושיתפתי."),
      applyResult: resultCompleteMiss(),
      shareMisses: [{ itemId: "x", reason: "missing" }],
    });
    expect(out.spoken).toContain(LIST_FIND_MISS);
    expect(out.spoken).not.toContain("מחקתי ושיתפתי");
  });
});

describe("Stage-1 engine-display exceptions remain", () => {
  it("show_dump capture/restore + combineConfirmAndDump still work", () => {
    const before = {
      ...emptyLlmMetadata(),
      showDump: "shopping",
      lists: [
        {
          action: "add" as const,
          listType: "shopping" as const,
          listName: "",
          items: [{ "שם פריט": "חלב" }],
          targets: [] as string[],
        },
      ],
    };
    const afterStrip = stripShowTurnMutates(before);
    const pending = capturePendingShowDump({
      showDumpBefore: before.showDump,
      before,
      afterStrip,
    });
    expect(pending?.kind).toBe("shopping");
    const restored = restorePendingShowDump(afterStrip, pending);
    expect(restored.showDump).toBe("shopping");

    const combined = combineConfirmAndDump(
      "הוספתי חלב לקניות.",
      "🛒 קניות:\n1. חלב - 1",
    );
    expect(combined).toContain("הוספתי חלב");
    expect(combined).toContain("🛒 קניות:");
  });
});
