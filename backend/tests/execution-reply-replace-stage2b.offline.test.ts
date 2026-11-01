/**
 * Stage 2B — when execution override fires, replace the entire responses array.
 * Stage 2A empty recovery is separate and unchanged.
 */
import { describe, expect, it } from "vitest";
import { parseLlmReply } from "@workee/shared";
import {
  buildApplyResult,
  captureRequestedFromMetadata,
} from "../src/services/apply-result.js";
import { decideReplyFromApplyResult } from "../src/services/apply-result-reply.js";
import { applyGatedClaimCorrectors } from "../src/services/apply-gated-claim-correctors.js";
import { emptyAttachmentOutcome } from "../src/services/attachment.service.js";
import {
  LIST_FIND_MISS,
  SHARE_CLAIM_MISS,
} from "../src/services/employee-records.service.js";
import {
  replaceSpokenForExecutionOverride,
  setEngineResponse,
} from "../src/services/whatsapp-send.js";
import { decideEmptySpokenFallback } from "../src/services/empty-response-policy.js";
import { emptyLlmMetadata } from "@workee/shared";

const shoppingId = "shop-miss";

function multiBubbleDraft(bubbles: string[], metadata: Record<string, unknown> = {}): string {
  return JSON.stringify({
    responses: bubbles.map((text) => ({ text })),
    metadata: { lists: [], ...metadata },
  });
}

function resultCompleteMiss() {
  const requested = captureRequestedFromMetadata({
    lists: [
      {
        action: "remove",
        listType: "shopping",
        listName: "",
        items: [{ item_id: shoppingId }],
        targets: [],
      },
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
    listMutations: [],
  });
}

function resultCompleteSuccess() {
  const requested = captureRequestedFromMetadata({
    lists: [
      {
        action: "remove",
        listType: "tasks",
        listName: "",
        items: [{ item_id: "task-1" }],
        targets: [],
      },
    ],
  });
  return buildApplyResult({
    requested,
    listMutations: [
      {
        action: "remove",
        itemId: "task-1",
        employeeId: "e1",
        listType: "tasks",
        itemKey: "k",
        itemLabel: "דיברתי עם yes",
      },
    ],
  });
}

describe("replaceSpokenForExecutionOverride", () => {
  it("drops every prior bubble and keeps only engine text", () => {
    const draft = multiBubbleDraft([
      "מחקתי את החלב.",
      "עוד משהו שלא קשור.",
      "בועה שלישית",
    ]);
    const next = replaceSpokenForExecutionOverride(draft, LIST_FIND_MISS);
    const parsed = parseLlmReply(next);
    expect(parsed.responses).toEqual([LIST_FIND_MISS]);
    expect(parsed.responseBubbles).toHaveLength(1);
    expect(parsed.response).not.toContain("עוד משהו");
    expect(parsed.response).not.toContain("בועה שלישית");
    expect(parsed.response).not.toContain("מחקתי");
  });

  it("matches setEngineResponse wholesale behavior", () => {
    const draft = multiBubbleDraft(["א", "ב"]);
    expect(replaceSpokenForExecutionOverride(draft, "ג")).toBe(
      setEngineResponse(draft, "ג"),
    );
  });
});

describe("Stage 2B production path — Result-B + gated correctors", () => {
  it("Result-B replace wipes multi-bubble model draft entirely", () => {
    const draft = multiBubbleDraft([
      "מחקתי את החלב מהקניות.",
      "וגם עדכנתי משהו אחר.",
    ]);
    const applyResult = resultCompleteMiss();
    const decided = decideReplyFromApplyResult({
      applyResult,
      modelDraft: draft,
    });
    expect(decided.keepDraft).toBe(false);
    expect(decided.operationalClaimResolved).toBe(true);

    let reply = replaceSpokenForExecutionOverride(draft, decided.spoken);
    const gated = applyGatedClaimCorrectors({
      reply,
      resultB: decided,
      setResponse: replaceSpokenForExecutionOverride,
      requestedRemove: true,
      requestedUpdate: false,
      requestedAdd: false,
      appliedRemove: false,
      appliedUpdate: false,
      appliedAdd: false,
      appliedSpeakerListAdd: false,
      appliedListOps: false,
      appliedFilingRemove: false,
      appliedFilingUpdate: false,
      appliedFallback: "",
      listMutations: [],
      shareMisses: [],
      filingShareApplied: false,
      attachmentOutcome: emptyAttachmentOutcome(false),
      requestedFilingAdd: false,
      requestedFilingUpdate: false,
      appliedFilingAdd: false,
      requestedDirectory: false,
      appliedDirectory: false,
      appliedReminderAdd: false,
      reminderAddFallback: "",
    });
    const parsed = parseLlmReply(gated.reply);
    expect(parsed.responses).toHaveLength(1);
    expect(parsed.responses[0]).toBe(LIST_FIND_MISS);
    expect(parsed.response).not.toContain("וגם עדכנתי");
    expect(parsed.response).not.toContain("מחקתי את החלב");
  });

  it("Result-B keepDraft preserves all model bubbles", () => {
    const draft = multiBubbleDraft([
      "הסרתי את המטלה.",
      "עוד משפט למשתמש.",
    ]);
    const decided = decideReplyFromApplyResult({
      applyResult: resultCompleteSuccess(),
      modelDraft: draft,
    });
    expect(decided.keepDraft).toBe(true);
    const parsed = parseLlmReply(draft);
    expect(parsed.responses).toEqual([
      "הסרתי את המטלה.",
      "עוד משפט למשתמש.",
    ]);
  });

  it("narrow-post-apply share correction also replaces all bubbles", () => {
    const draft = multiBubbleDraft([
      "שיתפתי את החלב עם דני.",
      "תודה ולהתראות.",
    ]);
    const applyResult = buildApplyResult({
      requested: captureRequestedFromMetadata({ lists: [] }),
    });
    const decided = decideReplyFromApplyResult({
      applyResult,
      modelDraft: draft,
    });
    expect(decided.keepDraft).toBe(true);

    const gated = applyGatedClaimCorrectors({
      reply: draft,
      resultB: decided,
      setResponse: replaceSpokenForExecutionOverride,
      requestedRemove: false,
      requestedUpdate: false,
      requestedAdd: false,
      appliedRemove: false,
      appliedUpdate: false,
      appliedAdd: false,
      appliedSpeakerListAdd: false,
      appliedListOps: false,
      appliedFilingRemove: false,
      appliedFilingUpdate: false,
      appliedFallback: "",
      listMutations: [],
      shareMisses: [],
      filingShareApplied: false,
      attachmentOutcome: emptyAttachmentOutcome(false),
      requestedFilingAdd: false,
      requestedFilingUpdate: false,
      appliedFilingAdd: false,
      requestedDirectory: false,
      appliedDirectory: false,
      appliedReminderAdd: false,
      reminderAddFallback: "",
    });
    const parsed = parseLlmReply(gated.reply);
    expect(parsed.responses).toEqual([SHARE_CLAIM_MISS]);
    expect(parsed.response).not.toContain("תודה ולהתראות");
  });
});

describe("Stage 2A empty recovery remains separate", () => {
  it("empty responses still go through Stage 2A policy (not Stage 2B bubble merge)", () => {
    const empty = JSON.stringify({
      responses: [],
      metadata: emptyLlmMetadata(),
    });
    const applyResult = resultCompleteMiss();
    const decision = decideEmptySpokenFallback({
      reply: empty,
      applyResult,
      metadata: emptyLlmMetadata(),
    });
    expect(decision.reason).toBe("apply_result");
    expect(decision.fallback).toBe(LIST_FIND_MISS);
    // Recovery uses setEngineResponse / single bubble — contract violation fill.
    const recovered = setEngineResponse(empty, decision.fallback!);
    expect(parseLlmReply(recovered).responses).toEqual([LIST_FIND_MISS]);
  });
});
