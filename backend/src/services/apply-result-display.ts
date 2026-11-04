/**
 * Result-C: pending show_dump after strip (mutate+show) → restore for
 * post-apply engine dump from a fresh DB snapshot (existing dump format).
 */
import type { LlmMetadata } from "@workee/shared";
import type { ApplyResult } from "./apply-result.js";
import type { LastNumberedDumpLine } from "./show-button-dump.js";

export type PendingShowDump = {
  kind: string;
  section?: LlmMetadata["showDumpSection"];
  partner?: LlmMetadata["showDumpPartner"];
  assignee?: LlmMetadata["showDumpAssignee"];
  about?: LlmMetadata["showDumpAbout"];
  from?: LlmMetadata["showDumpFrom"];
  to?: LlmMetadata["showDumpTo"];
  urgency?: LlmMetadata["showDumpUrgency"];
  ids?: LlmMetadata["showDumpIds"];
};

function hasMutates(metadata: Pick<
  LlmMetadata,
  "lists" | "listOps" | "filing" | "reminders" | "directory"
>): boolean {
  return (
    (metadata.lists?.length ?? 0) > 0 ||
    (metadata.listOps?.length ?? 0) > 0 ||
    (metadata.filing?.length ?? 0) > 0 ||
    (metadata.reminders?.length ?? 0) > 0 ||
    (metadata.directory?.length ?? 0) > 0
  );
}

/**
 * When strip drops show_dump because mutates win, keep display intent for
 * post-apply restore. Does not change strip policy.
 */
export function capturePendingShowDump(input: {
  showDumpBefore: string | null | undefined;
  before: LlmMetadata;
  afterStrip: LlmMetadata;
}): PendingShowDump | null {
  const beforeKind = input.showDumpBefore?.trim() ?? "";
  const afterKind = input.afterStrip.showDump?.trim() ?? "";
  if (!beforeKind || afterKind) {
    return null;
  }
  // Mutate+show: show cleared, mutates kept.
  if (!hasMutates(input.afterStrip)) {
    return null;
  }
  return {
    kind: beforeKind,
    section: input.before.showDumpSection ?? null,
    partner: input.before.showDumpPartner ?? null,
    assignee: input.before.showDumpAssignee ?? null,
    about: input.before.showDumpAbout ?? null,
    from: input.before.showDumpFrom ?? null,
    to: input.before.showDumpTo ?? null,
    urgency: input.before.showDumpUrgency ?? null,
    ids: input.before.showDumpIds ?? null,
  };
}

/** Restore pending show onto metadata so the existing dump REPLACE path runs. */
export function restorePendingShowDump(
  metadata: LlmMetadata,
  pending: PendingShowDump | null,
): LlmMetadata {
  if (!pending?.kind.trim()) {
    return metadata;
  }
  const next: LlmMetadata = {
    ...metadata,
    showDump: pending.kind,
  };
  if (pending.section !== undefined) {
    next.showDumpSection = pending.section;
  }
  if (pending.partner !== undefined) {
    next.showDumpPartner = pending.partner;
  }
  if (pending.assignee !== undefined) {
    next.showDumpAssignee = pending.assignee;
  }
  if (pending.about !== undefined) {
    next.showDumpAbout = pending.about;
  }
  if (pending.from !== undefined) {
    next.showDumpFrom = pending.from;
  }
  if (pending.to !== undefined) {
    next.showDumpTo = pending.to;
  }
  if (pending.urgency !== undefined) {
    next.showDumpUrgency = pending.urgency;
  }
  if (pending.ids !== undefined) {
    next.showDumpIds = pending.ids;
  }
  return next;
}

export type CombineConfirmAndDumpOptions = {
  /**
   * Used only when the model confirm is empty but a successful apply still
   * deserves a short engine ack beside the dump.
   */
  engineConfirmFallback?: string;
};

/**
 * Prepend the model's mutate confirm (verbatim) before the engine dump text
 * (two intents, one turn). The engine never edits the model's words.
 */
export function combineConfirmAndDump(
  confirmSpoken: string,
  dumpSpoken: string,
  options?: CombineConfirmAndDumpOptions,
): string {
  const dump = dumpSpoken.trim();
  // The model's confirm is kept verbatim — the engine never edits model text.
  let confirm = confirmSpoken.trim();
  if (!confirm && dump) {
    confirm = options?.engineConfirmFallback?.trim() ?? "";
  }
  if (!confirm) {
    return dump;
  }
  if (!dump) {
    return confirm;
  }
  if (dump === confirm || dump.startsWith(confirm)) {
    return dump;
  }
  return `${confirm}\n\n${dump}`;
}

export function withApplyResultDisplay(
  result: ApplyResult,
  display: {
    kind: string;
    snapshot_text: string;
    lines?: LastNumberedDumpLine[];
  },
): ApplyResult {
  return {
    ...result,
    display: {
      kind: display.kind,
      snapshot_text: display.snapshot_text,
      ...(display.lines ? { lines: display.lines } : {}),
    },
  };
}
