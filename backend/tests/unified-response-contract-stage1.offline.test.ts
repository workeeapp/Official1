/**
 * Unified Response Contract — Stage 1: override classes + gated correctors.
 * Exercises the production decision path (decideReply + applyGatedClaimCorrectors).
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
import { applyGatedClaimCorrectors } from "../src/services/apply-gated-claim-correctors.js";
import {
  catalogByOverrideClass,
  mayRunReplyCorrector,
  REPLY_CORRECTOR_CATALOG,
} from "../src/services/reply-override-policy.js";
import {
  LIST_ADD_MISS,
  LIST_FIND_MISS,
  REMINDER_ONLY_PARTIAL,
  SHARE_CLAIM_MISS,
  correctExecutionTruthReply,
} from "../src/services/employee-records.service.js";
import { emptyAttachmentOutcome } from "../src/services/attachment.service.js";
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
  gated?: Partial<Parameters<typeof applyGatedClaimCorrectors>[0]>;
}) {
  const decided = decideReplyFromApplyResult({
    applyResult: input.applyResult,
    modelDraft: input.modelDraft,
  });
  let reply = input.modelDraft;
  if (!decided.keepDraft) {
    reply = setEngineResponse(reply, decided.spoken);
  }
  const listsDomain = input.applyResult.domains.lists;
  const requestedRemove = (listsDomain?.requested ?? []).some(
    (r) => r.op === "remove",
  );
  const requestedAdd = (listsDomain?.requested ?? []).some(
    (r) => r.op === "add",
  );
  const appliedRemove = (listsDomain?.applied ?? []).some(
    (r) => r.op === "remove",
  );
  const appliedAdd = (listsDomain?.applied ?? []).some((r) => r.op === "add");
  const gated = applyGatedClaimCorrectors({
    reply,
    resultB: decided,
    setResponse: setEngineResponse,
    requestedRemove,
    requestedUpdate: false,
    requestedAdd,
    appliedRemove,
    appliedUpdate: false,
    appliedAdd,
    appliedSpeakerListAdd: appliedAdd,
    appliedListOps: false,
    appliedFilingRemove: false,
    appliedFilingUpdate: false,
    appliedFallback: "",
    listMutations: [],
    shareMisses: [],
    filingShareApplied: false,
    unshareSummary: null,
    attachmentOutcome: emptyAttachmentOutcome(false),
    requestedFilingAdd: false,
    requestedFilingUpdate: false,
    appliedFilingAdd: false,
    requestedDirectory: false,
    appliedDirectory: false,
    appliedReminderAdd: false,
    reminderAddFallback: "",
    ...input.gated,
  });
  return {
    decided,
    reply: gated.reply,
    spoken: parseLlmReply(gated.reply).response,
    ran: gated.ran,
    skipped: gated.skipped,
  };
}

describe("Stage-1 override catalog", () => {
  it("classifies every catalog entry into one of four classes", () => {
    const by = catalogByOverrideClass();
    expect(by["operational-claim"]).toEqual(
      expect.arrayContaining(["resultB", "listMutationClaim", "durableSaveClaim"]),
    );
    expect(by["engine-display"]).toEqual(
      expect.arrayContaining([
        "showDumpReplace",
        "combineConfirmAndDump",
        "liveDomainFill",
      ]),
    );
    expect(by["delivery-notice"]).toContain("deliveryCompose");
    expect(by["narrow-post-apply"]).toEqual(
      expect.arrayContaining([
        "shareClaim",
        "attachmentClaim",
        "executionTruth",
      ]),
    );
    expect(REPLY_CORRECTOR_CATALOG.length).toBeGreaterThanOrEqual(15);
  });

  it("skips only Result-B-overlapped operational-claim correctors when resolved", () => {
    const resolved = {
      keepDraft: false,
      operationalClaimResolved: true,
      draftClaims: {
        anySuccess: true,
        deleteClaim: true,
        addClaim: false,
        updateClaim: false,
        shareClaim: false,
        reminderClaim: false,
        durableClaim: false,
      },
    };
    expect(mayRunReplyCorrector("listMutationClaim", resolved)).toBe(false);
    expect(mayRunReplyCorrector("durableSaveClaim", resolved)).toBe(false);
    expect(mayRunReplyCorrector("shareClaim", resolved)).toBe(true);
    expect(mayRunReplyCorrector("attachmentClaim", resolved)).toBe(true);
    // Delete-only resolve: executionTruth still eligible (no add/reminder in draft).
    expect(mayRunReplyCorrector("executionTruth", resolved)).toBe(true);
    expect(mayRunReplyCorrector("showDumpReplace", resolved)).toBe(true);
    expect(mayRunReplyCorrector("deliveryCompose", resolved)).toBe(true);
  });

  it("skips executionTruth when Result-B resolved an add/reminder claim", () => {
    const resolvedAdd = {
      keepDraft: false,
      operationalClaimResolved: true,
      draftClaims: {
        anySuccess: true,
        deleteClaim: false,
        addClaim: true,
        updateClaim: false,
        shareClaim: false,
        reminderClaim: false,
        durableClaim: false,
      },
    };
    expect(mayRunReplyCorrector("executionTruth", resolvedAdd)).toBe(false);
    expect(mayRunReplyCorrector("shareClaim", resolvedAdd)).toBe(true);
  });

  it("does not use keepDraft alone — uncovered correctors run after keep", () => {
    const kept = {
      keepDraft: true,
      operationalClaimResolved: false,
      draftClaims: {
        anySuccess: true,
        deleteClaim: false,
        addClaim: true,
        updateClaim: false,
        shareClaim: false,
        reminderClaim: false,
        durableClaim: false,
      },
    };
    expect(mayRunReplyCorrector("listMutationClaim", kept)).toBe(true);
    expect(mayRunReplyCorrector("shareClaim", kept)).toBe(true);
    expect(mayRunReplyCorrector("executionTruth", kept)).toBe(true);
  });
});

describe("Stage-1 production path (Result-B + gated correctors)", () => {
  it("no ACTION + non-empty response is preserved", () => {
    const applyResult = buildApplyResult({
      requested: captureRequestedFromMetadata({ lists: [] }),
    });
    const out = runProductionPath({
      modelDraft: draftJson("היי טל, איך אפשר לעזור?"),
      applyResult,
    });
    expect(out.decided.keepDraft).toBe(true);
    expect(out.decided.operationalClaimResolved).toBe(false);
    expect(out.spoken).toBe("היי טל, איך אפשר לעזור?");
  });

  it("complete successful ACTION + accurate response is preserved", () => {
    const out = runProductionPath({
      modelDraft: draftJson("הסרתי את «דיברתי עם yes» מהמטלות."),
      applyResult: resultCompleteRemove(),
    });
    expect(out.decided.keepDraft).toBe(true);
    expect(out.decided.operationalClaimResolved).toBe(false);
    expect(out.spoken).toContain("הסרתי");
    expect(out.skipped).not.toContain("shareClaim");
  });

  it("Result-B operational correction is not duplicated by listMutationClaim", () => {
    const out = runProductionPath({
      modelDraft: draftJson("מחקתי את החלב."),
      applyResult: resultCompleteMiss(),
    });
    expect(out.decided.keepDraft).toBe(false);
    expect(out.decided.operationalClaimResolved).toBe(true);
    expect(out.spoken).toBe(LIST_FIND_MISS);
    expect(out.skipped).toContain("listMutationClaim");
    expect(out.skipped).toContain("durableSaveClaim");
    expect(out.ran).toContain("shareClaim");
    expect(out.ran).toContain("attachmentClaim");
    expect(out.ran).toContain("executionTruth");
  });

  it("partial still prevents false full-success claim", () => {
    const out = runProductionPath({
      modelDraft: draftJson("מחקתי את שני הפריטים."),
      applyResult: resultPartial(),
    });
    expect(out.decided.keepDraft).toBe(false);
    expect(out.decided.operationalClaimResolved).toBe(true);
    expect(out.spoken).toContain("דיברתי עם yes");
    expect(out.spoken).toContain(LIST_FIND_MISS);
    expect(out.skipped).toContain("listMutationClaim");
  });

  it("unknown still blocks unverified success claim", () => {
    const out = runProductionPath({
      modelDraft: draftJson("מחקתי את התיוק."),
      applyResult: resultUnknownFiling(),
    });
    expect(resultUnknownFiling().completeness).toBe("unknown");
    expect(out.decided.keepDraft).toBe(false);
    expect(out.spoken).toMatch(/לא הצלחתי לאמת/);
    expect(out.skipped).toContain("listMutationClaim");
  });

  it("uncovered share claim still corrects when Result-B kept draft", () => {
    // No list requested mutates in ApplyResult → Result-B keeps draft; share
    // corrector (narrow-post-apply) must still rewrite false שיתפתי.
    const applyResult = buildApplyResult({
      requested: captureRequestedFromMetadata({ lists: [] }),
    });
    const out = runProductionPath({
      modelDraft: draftJson("שיתפתי את החלב עם דני."),
      applyResult,
      gated: {
        listMutations: [],
        shareMisses: [],
      },
    });
    expect(out.decided.keepDraft).toBe(true);
    expect(out.decided.operationalClaimResolved).toBe(false);
    expect(out.ran).toContain("shareClaim");
    expect(out.spoken).toBe(SHARE_CLAIM_MISS);
  });

  it("uncovered attachment claim still corrects when Result-B kept draft", () => {
    const applyResult = buildApplyResult({
      requested: captureRequestedFromMetadata({ lists: [] }),
    });
    const out = runProductionPath({
      modelDraft: draftJson("צרפתי את הקובץ למטלה."),
      applyResult,
      gated: {
        attachmentOutcome: {
          linked: 0,
          alreadyLinked: 0,
          detached: 0,
          attachRequested: true,
        },
      },
    });
    expect(out.decided.keepDraft).toBe(true);
    expect(out.ran).toContain("attachmentClaim");
    expect(out.spoken).toBe("לא הצלחתי לצרף את הקובץ.");
  });
});

describe("Stage-1 executionTruth vs Result-B (residual risk)", () => {
  it("proves ungated executionTruth can rewrite Result-B text that contains הוספתי", () => {
    // Result-B-shaped spoken after replace (applied add line + caution/miss).
    const resultBSpoken =
      "הוספתי את «לקנות חלב» לרשימת «הרשימה».\nלא הצלחתי לאמת את כל הפעולות — נסי שוב או בדקי את הרשימה.";
    const reply = draftJson(resultBSpoken);
    const interfered = correctExecutionTruthReply({
      reply,
      spoken: resultBSpoken,
      appliedListAdd: true,
      appliedSpeakerListAdd: false,
      appliedReminderAdd: false,
      setResponse: setEngineResponse,
    });
    // Without the gate, speaker-vs-worker logic treats B's «הוספתי» as a fresh
    // claim and collapses the caution into LIST_ADD_MISS.
    expect(parseLlmReply(interfered).response).toBe(LIST_ADD_MISS);
    expect(parseLlmReply(interfered).response).not.toContain("לא הצלחתי לאמת");
  });

  it("Result-B resolved add claim → production path skips executionTruth; B text preserved", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          items: [{ "שם מטלה": "לקנות חלב" }],
          targets: [],
        },
      ],
    });
    // Requested add, nothing applied → complete miss / success claim replaced.
    const applyResult = buildApplyResult({
      requested,
      listMutations: [],
    });
    expect(applyResult.completeness).toBe("unknown");

    const out = runProductionPath({
      modelDraft: draftJson("הוספתי את המטלה לרשימה."),
      applyResult,
      gated: {
        appliedAdd: false,
        appliedSpeakerListAdd: false,
        // Worker add evidence false — would interfere if executionTruth ran on
        // a B line that still said הוספתי; here B should emit miss/caution.
      },
    });
    expect(out.decided.operationalClaimResolved).toBe(true);
    expect(out.decided.draftClaims.addClaim).toBe(true);
    expect(out.skipped).toContain("executionTruth");
    expect(out.ran).not.toContain("executionTruth");
    // Whatever Result-B chose must stand after the gated chain.
    expect(out.spoken).toBe(out.decided.spoken);
    expect(out.spoken).not.toBe(REMINDER_ONLY_PARTIAL);
  });

  it("Result-B kept draft + worker-only add → executionTruth still corrects", () => {
    // ApplyResult sees an add applied (any book) so Result-B keeps «הוספתי».
    // Speaker-book did not get the row — executionTruth must still rewrite.
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          items: [{ "שם מטלה": "לקנות חלב" }],
          targets: [],
        },
      ],
    });
    const applyResult = buildApplyResult({
      requested,
      listMutations: [
        {
          action: "add",
          itemId: "worker-1",
          employeeId: "lucy-worker",
          listType: "tasks",
          itemKey: "k",
          itemLabel: "לקנות חלב",
        },
      ],
    });
    expect(applyResult.completeness).toBe("complete");

    const out = runProductionPath({
      modelDraft: draftJson("הוספתי את המטלה לרשימה."),
      applyResult,
      gated: {
        appliedAdd: true,
        appliedSpeakerListAdd: false,
        appliedReminderAdd: true,
        reminderAddFallback: "שמרתי תזכורת «לקנות חלב».",
      },
    });
    expect(out.decided.keepDraft).toBe(true);
    expect(out.decided.operationalClaimResolved).toBe(false);
    expect(out.ran).toContain("executionTruth");
    expect(out.spoken).toBe(REMINDER_ONLY_PARTIAL);
  });

  it("Result-B resolved delete-only → executionTruth may run but does not change LIST_FIND_MISS", () => {
    const out = runProductionPath({
      modelDraft: draftJson("מחקתי את החלב."),
      applyResult: resultCompleteMiss(),
      gated: {
        appliedSpeakerListAdd: false,
        appliedReminderAdd: false,
      },
    });
    expect(out.decided.operationalClaimResolved).toBe(true);
    expect(out.decided.draftClaims.deleteClaim).toBe(true);
    expect(out.decided.draftClaims.addClaim).toBe(false);
    // Delete-only: gate still allows executionTruth; spoken has no add claim.
    expect(out.ran).toContain("executionTruth");
    expect(out.spoken).toBe(LIST_FIND_MISS);
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
    // Gate always allows engine-display even after operational resolve
    expect(
      mayRunReplyCorrector("showDumpReplace", {
        keepDraft: false,
        operationalClaimResolved: true,
      }),
    ).toBe(true);
    expect(
      mayRunReplyCorrector("combineConfirmAndDump", {
        keepDraft: false,
        operationalClaimResolved: true,
      }),
    ).toBe(true);
    expect(
      mayRunReplyCorrector("liveDomainFill", {
        keepDraft: false,
        operationalClaimResolved: true,
      }),
    ).toBe(true);
    expect(
      mayRunReplyCorrector("deliveryCompose", {
        keepDraft: false,
        operationalClaimResolved: true,
      }),
    ).toBe(true);
  });
});
