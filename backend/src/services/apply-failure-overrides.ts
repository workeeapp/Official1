/**
 * Reply contract: the model always answers. The engine replaces the model's
 * spoken reply ONLY when apply proves a failure — a requested save/remove/
 * share/attach that did not land. Never decided by reading the model's text.
 *
 * Inputs here are apply evidence only (ApplyResult, share misses, attachment
 * outcome, post-apply unshare snapshot). The replacement text is engine-built.
 */
import { parseLlmReply } from "@workee/shared";
import type { ApplyResult } from "./apply-result.js";
import type { AttachmentApplyOutcome } from "./attachment.service.js";
import {
  formatShareOutcomeReply,
  formatUnshareOutcomeReply,
  summarizeShareApply,
  SHARE_CLAIM_MISS,
  type ListItemMutation,
  type ShareApplyMiss,
  type UnshareApplySummary,
} from "./employee-records.service.js";

export const ATTACH_APPLY_MISS = "לא הצלחתי לצרף את הקובץ.";

/** True when any requested op in this turn failed or could not be confirmed. */
export function applyResultHasFailure(result: ApplyResult): boolean {
  if (result.completeness !== "complete") {
    return true;
  }
  return Object.values(result.domains).some(
    (domain) =>
      Boolean(domain) &&
      ((domain?.apply_misses.length ?? 0) > 0 ||
        (domain?.intent_misses.length ?? 0) > 0 ||
        (domain?.unclassified_drops?.length ?? 0) > 0),
  );
}

/**
 * Engine lines for failures outside ApplyResult domains (share / attach /
 * unshare). Empty when nothing failed.
 */
export function sideFailureLines(input: {
  listMutations: ListItemMutation[];
  shareMisses: ShareApplyMiss[];
  attachmentOutcome: AttachmentApplyOutcome;
  unshareSummary?: UnshareApplySummary | null;
}): string[] {
  const lines: string[] = [];
  if (input.shareMisses.length > 0) {
    lines.push(
      formatShareOutcomeReply(
        summarizeShareApply(input.listMutations, input.shareMisses),
      ) || SHARE_CLAIM_MISS,
    );
  }
  const attach = input.attachmentOutcome;
  if (
    attach.attachRequested &&
    attach.linked + attach.alreadyLinked === 0
  ) {
    lines.push(ATTACH_APPLY_MISS);
  }
  if (input.unshareSummary && input.unshareSummary.remainingSharedCount > 0) {
    const line = formatUnshareOutcomeReply(input.unshareSummary);
    if (line) {
      lines.push(line);
    }
  }
  return lines;
}

/**
 * Apply side failures to the reply. When Result-B already replaced the reply
 * (ApplyResult failure), the side lines are appended to the engine text;
 * otherwise they replace the model reply. No failure → reply unchanged.
 */
export function applySideFailureOverrides(input: {
  reply: string;
  resultBReplaced: boolean;
  lines: string[];
  setResponse: (reply: string, response: string) => string;
}): string {
  if (input.lines.length === 0) {
    return input.reply;
  }
  const base = input.resultBReplaced
    ? parseLlmReply(input.reply).response.trim()
    : "";
  return input.setResponse(
    input.reply,
    [base, ...input.lines].filter(Boolean).join("\n"),
  );
}
