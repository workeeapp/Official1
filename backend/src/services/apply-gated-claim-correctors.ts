/**
 * Post-Result-B claim correctors under Unified Response Contract Stage 1.
 * Same order and gates as chat.service — production path + offline tests.
 */
import { parseLlmReply } from "@workee/shared";
import type { DecideReplyFromApplyResult } from "./apply-result-reply.js";
import { mayRunReplyCorrector } from "./reply-override-policy.js";
import type { AttachmentApplyOutcome } from "./attachment.service.js";
import {
  correctAttachmentClaimReply,
  correctDurableSaveClaimReply,
  correctExecutionTruthReply,
  correctListMutationClaimReply,
  correctShareClaimReply,
  correctUnshareClaimReply,
  type ListItemMutation,
  type ShareApplyMiss,
  type UnshareApplySummary,
} from "./employee-records.service.js";

export type GatedClaimCorrectorsInput = {
  reply: string;
  resultB: Pick<
    DecideReplyFromApplyResult,
    "keepDraft" | "operationalClaimResolved" | "draftClaims"
  >;
  setResponse: (reply: string, response: string) => string;
  requestedRemove: boolean;
  requestedUpdate: boolean;
  requestedAdd: boolean;
  appliedRemove: boolean;
  appliedUpdate: boolean;
  appliedAdd: boolean;
  appliedSpeakerListAdd: boolean;
  /**
   * ACTION requested a speaker-book list add (not worker-only tracking).
   * When omitted, executionTruth keeps legacy PARTIAL behavior.
   */
  requestedSpeakerListAdd?: boolean;
  appliedListOps: boolean;
  appliedFilingRemove: boolean;
  appliedFilingUpdate: boolean;
  appliedFallback: string;
  listMutations: ListItemMutation[];
  shareMisses: ShareApplyMiss[];
  filingShareApplied: boolean;
  /** When set, unshare corrector may run. */
  unshareSummary?: UnshareApplySummary | null;
  attachmentOutcome: AttachmentApplyOutcome;
  requestedFilingAdd: boolean;
  requestedFilingUpdate: boolean;
  appliedFilingAdd: boolean;
  requestedDirectory: boolean;
  appliedDirectory: boolean;
  appliedReminderAdd: boolean;
  reminderAddFallback: string;
};

export type GatedClaimCorrectorsTrace = {
  ran: string[];
  skipped: string[];
  reply: string;
};

/**
 * Run gated legacy claim correctors. Skips operational-claim helpers when
 * Result-B already resolved; always runs narrow-post-apply share/attach/…
 */
export function applyGatedClaimCorrectors(
  input: GatedClaimCorrectorsInput,
): GatedClaimCorrectorsTrace {
  let reply = input.reply;
  const ran: string[] = [];
  const skipped: string[] = [];
  const gate = input.resultB;

  const spoken = () => parseLlmReply(reply).response;

  const tryRun = (
    id: Parameters<typeof mayRunReplyCorrector>[0],
    fn: () => void,
  ) => {
    if (!mayRunReplyCorrector(id, gate)) {
      skipped.push(id);
      return;
    }
    ran.push(id);
    fn();
  };

  tryRun("listMutationClaim", () => {
    reply = correctListMutationClaimReply({
      reply,
      requestedRemove: input.requestedRemove,
      requestedUpdate: input.requestedUpdate,
      requestedAdd: input.requestedAdd,
      appliedRemove: input.appliedRemove,
      appliedUpdate: input.appliedUpdate,
      appliedAdd: input.appliedAdd,
      appliedFallback: input.appliedFallback,
      setResponse: input.setResponse,
      spoken: spoken(),
      appliedListOps: input.appliedListOps,
      appliedFilingRemove: input.appliedFilingRemove,
      appliedFilingUpdate: input.appliedFilingUpdate,
    });
  });

  tryRun("shareClaim", () => {
    reply = correctShareClaimReply({
      reply,
      spoken: spoken(),
      mutations: input.listMutations,
      misses: input.shareMisses,
      filingShareApplied: input.filingShareApplied,
      setResponse: input.setResponse,
    });
  });

  tryRun("unshareClaim", () => {
    if (!input.unshareSummary) {
      return;
    }
    reply = correctUnshareClaimReply({
      reply,
      spoken: spoken(),
      summary: input.unshareSummary,
      setResponse: input.setResponse,
    });
  });

  tryRun("attachmentClaim", () => {
    reply = correctAttachmentClaimReply({
      reply,
      spoken: spoken(),
      outcome: input.attachmentOutcome,
      setResponse: input.setResponse,
    });
  });

  tryRun("durableSaveClaim", () => {
    reply = correctDurableSaveClaimReply({
      reply,
      spoken: spoken(),
      requestedListAdd: input.requestedAdd,
      requestedListUpdate: input.requestedUpdate,
      requestedFilingAdd: input.requestedFilingAdd,
      requestedFilingUpdate: input.requestedFilingUpdate,
      appliedListAdd: input.appliedAdd,
      appliedListUpdate: input.appliedUpdate,
      appliedFilingAdd: input.appliedFilingAdd,
      appliedFilingUpdate: input.appliedFilingUpdate,
      requestedDirectory: input.requestedDirectory,
      appliedDirectory: input.appliedDirectory,
      setResponse: input.setResponse,
    });
  });

  tryRun("executionTruth", () => {
    reply = correctExecutionTruthReply({
      reply,
      spoken: spoken(),
      appliedListAdd: input.appliedAdd,
      appliedSpeakerListAdd: input.appliedSpeakerListAdd,
      ...(typeof input.requestedSpeakerListAdd === "boolean"
        ? { requestedSpeakerListAdd: input.requestedSpeakerListAdd }
        : {}),
      appliedReminderAdd: input.appliedReminderAdd,
      appliedFilingAdd: input.appliedFilingAdd,
      listAddFallback: input.appliedFallback,
      reminderAddFallback: input.reminderAddFallback,
      setResponse: input.setResponse,
    });
  });

  return { ran, skipped, reply };
}
