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

/**
 * Drop model-written inventory fragments before combining with an engine dump.
 * Keeps short conversational prose (including digits like «הוספתי 3» / «ב־14:30»).
 * Does NOT require ≥2 numbered lines — a single «1. …» item is enough to strip.
 * Returns "" when nothing reliable remains (caller may use an engine ack fallback).
 */
export function stripInventedListContentForShowDump(confirm: string): string {
  const raw = confirm.replace(/\r\n/g, "\n").trim();
  if (!raw) {
    return "";
  }

  const keptLines: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    // Engine dump headers / emoji list shells — never keep from the model.
    if (/^[🛒✅📋👤🗂️]\s*/u.test(trimmed)) {
      continue;
    }
    if (
      /^(?:רשימת\s+)?(?:קניות|משימות|מטלות|תיוקים|אנשי\s*קשר|תזכורות)\s*:/u.test(
        trimmed,
      )
    ) {
      continue;
    }
    // Whole line is a numbered / bullet inventory row.
    if (/^\d+\.\s+\S/u.test(trimmed)) {
      continue;
    }
    if (/^[-•*]\s+\S/u.test(trimmed) && !/[.!?…]$/u.test(trimmed)) {
      continue;
    }

    const cleaned = stripInlineNumberedInventoryTail(trimmed);
    if (cleaned) {
      keptLines.push(cleaned);
    }
  }

  return keptLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove trailing «1. item …» inventory from an otherwise conversational line. */
function stripInlineNumberedInventoryTail(line: string): string {
  const match = /\d+\.\s+\S/u.exec(line);
  if (!match || match.index == null) {
    return line;
  }
  let prefix = line.slice(0, match.index).trim();
  prefix = prefix.replace(/[:：]\s*$/u, "").trim();
  // Drop list-intro tails: «הנה הרשימה» / «הרשימה המלאה שהמצאתי»
  prefix = prefix
    .replace(
      /(?:הנה\s+)?(?:את\s+)?הרשימה(?:\s+המלאה)?(?:\s+שהמצאתי)?\.?$/iu,
      "",
    )
    .trim();
  prefix = prefix
    .replace(/(?:הנה\s+)?(?:את\s+)?(?:הקניות|המשימות|המטלות)\.?$/iu, "")
    .trim();
  prefix = prefix.replace(/[,:：]\s*$/u, "").trim();
  if (
    !prefix ||
    /^(?:הנה\s+)?(?:את\s+)?(?:הרשימה(?:\s+המלאה)?|הקניות|המשימות|המטלות)\.?$/iu.test(
      prefix,
    )
  ) {
    return "";
  }
  return prefix;
}

export type CombineConfirmAndDumpOptions = {
  /**
   * Used only when the model confirm is empty after inventory strip but a
   * successful apply still deserves a short engine ack beside the dump.
   */
  engineConfirmFallback?: string;
};

/**
 * Prepend mutate confirm before dump REPLACE text (two intents, one turn).
 * When dump is present, strips model inventory from the confirm first so the
 * authoritative list body comes only from the engine dump.
 */
export function combineConfirmAndDump(
  confirmSpoken: string,
  dumpSpoken: string,
  options?: CombineConfirmAndDumpOptions,
): string {
  const dump = dumpSpoken.trim();
  let confirm = dump
    ? stripInventedListContentForShowDump(confirmSpoken)
    : confirmSpoken.trim();
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
