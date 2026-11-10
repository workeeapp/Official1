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
    const summary = summarizeShareApply(
      input.listMutations,
      input.shareMisses,
    );
    // Remove misses are already named from ApplyResult. A share-outcome line
    // would add the generic «לא מצאתי» on top of that partial report.
    const removeLookupOnly =
      summary.shareIntentCount === 0 &&
      input.shareMisses.every((miss) => miss.op === "remove");
    if (!removeLookupOnly) {
      lines.push(formatShareOutcomeReply(summary) || SHARE_CLAIM_MISS);
    }
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
  // One failure → one line. The same miss can reach the engine twice
  // (shareMisses also feed ApplyResult apply_misses, so Result-B already wrote
  // «לא מצאתי את הפריט ברשימה.»); never repeat an engine line already there.
  const seen = new Set(
    base
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const extra: string[] = [];
  for (const line of input.lines) {
    const trimmed = line.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      extra.push(trimmed);
    }
  }
  if (input.resultBReplaced && extra.length === 0) {
    return input.reply;
  }
  return input.setResponse(
    input.reply,
    [base, ...extra].filter(Boolean).join("\n"),
  );
}
