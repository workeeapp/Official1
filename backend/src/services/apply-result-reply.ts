/**
 * Result-B: decide spoken reply from ApplyResult.
 * Contract: the model always answers; the engine replaces the reply ONLY when
 * ApplyResult proves a failure (miss / drop / partial / unknown). The model's
 * text is never analyzed to decide this.
 */
import { parseLlmReply } from "@workee/shared";
import { LIST_ADD_MISS, LIST_FIND_MISS } from "./employee-records.service.js";
import type {
  ApplyResult,
  AppliedOp,
  ApplyMiss,
  ResultIntentMiss,
} from "./apply-result.js";
import { applyResultHasFailure } from "./apply-failure-overrides.js";

export type DecideReplyFromApplyResult = {
  keepDraft: boolean;
  /** Engine Hebrew when keepDraft is false; otherwise the model draft spoken. */
  spoken: string;
};

const PARTIAL_MISS_LINE = "חלק מהפריטים לא עודכנו.";
const UNKNOWN_CAUTION =
  "לא הצלחתי לאמת את כל הפעולות — נסי שוב או בדקי את הרשימה.";

function flattenApplied(result: ApplyResult): AppliedOp[] {
  const out: AppliedOp[] = [];
  for (const domain of Object.values(result.domains)) {
    if (!domain) {
      continue;
    }
    out.push(...domain.applied);
  }
  return out;
}

function hasRequestedMutates(result: ApplyResult): boolean {
  return Object.values(result.domains).some(
    (domain) => domain && domain.requested.length > 0,
  );
}

function reportableMissLines(result: ApplyResult): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (line: string) => {
    if (!line || seen.has(line)) {
      return;
    }
    seen.add(line);
    lines.push(line);
  };

  for (const domain of Object.values(result.domains)) {
    if (!domain) {
      continue;
    }
    for (const miss of domain.intent_misses as ResultIntentMiss[]) {
      if (
        miss.reason === "not_in_this_turn_facts" ||
        miss.reason === "outside_dump" ||
        miss.reason === "outside_dump_scope" ||
        miss.reason === "dump_line_invalid" ||
        miss.reason === "dump_empty" ||
        miss.reason === "missing_id" ||
        miss.reason === "list_id_mismatch" ||
        miss.reason === "invalid_source" ||
        miss.reason === "show_dump_cleared_mutates"
      ) {
        push(LIST_FIND_MISS);
      }
    }
    for (const miss of domain.apply_misses as ApplyMiss[]) {
      if (miss.reason === "missing" || miss.reason === "forbidden") {
        push(LIST_FIND_MISS);
      } else if (miss.reason === "missed" || miss.reason === "skipped") {
        push(LIST_FIND_MISS);
      } else if (miss.op === "add" || miss.reason.includes("add")) {
        push(LIST_ADD_MISS);
      } else {
        push(PARTIAL_MISS_LINE);
      }
    }
  }
  return lines;
}

function formatAppliedLines(applied: AppliedOp[]): string[] {
  const lines: string[] = [];
  const removes = applied.filter(
    (row) =>
      row.op === "remove" ||
      row.op === "remove_filing" ||
      row.op === "delete_list",
  );
  const adds = applied.filter(
    (row) => row.op === "add" || row.op === "add_filing",
  );
  const updates = applied.filter(
    (row) =>
      row.op === "update" ||
      row.op === "update_filing" ||
      row.op === "alter_list",
  );

  if (removes.length === 1 && removes[0]?.label) {
    if (removes[0].listType === "filing" || removes[0].op === "remove_filing") {
      lines.push(`הסרתי את התיוק «${removes[0].label}».`);
    } else {
      const list =
        removes[0].listName?.trim() ||
        (removes[0].listType === "shopping"
          ? "קניות"
          : removes[0].listType === "tasks"
            ? "משימות"
            : "הרשימה");
      lines.push(`הסרתי את «${removes[0].label}» מרשימת «${list}».`);
    }
  } else if (removes.length > 1) {
    lines.push(`הסרתי ${removes.length} פריטים.`);
  }

  if (adds.length === 1 && adds[0]?.label) {
    if (adds[0].listType === "filing" || adds[0].op === "add_filing") {
      lines.push(`תייקתי את «${adds[0].label}».`);
    } else {
      const list = adds[0].listName?.trim() || "הרשימה";
      lines.push(`הוספתי את «${adds[0].label}» לרשימת «${list}».`);
    }
  } else if (adds.length > 1) {
    lines.push(`הוספתי ${adds.length} פריטים.`);
  }

  if (updates.length === 1 && updates[0]?.label) {
    if (
      updates[0].listType === "filing" ||
      updates[0].op === "update_filing"
    ) {
      lines.push(`עדכנתי את התיוק «${updates[0].label}».`);
    } else {
      const list = updates[0].listName?.trim() || "הרשימה";
      lines.push(`עדכנתי את «${updates[0].label}» ברשימת «${list}».`);
    }
  } else if (updates.length > 1) {
    lines.push(`עדכנתי ${updates.length} פריטים.`);
  }

  if (lines.length === 0 && applied.length > 0) {
    lines.push("בוצע.");
  }
  return lines;
}

function formatFromResult(result: ApplyResult): string {
  const applied = flattenApplied(result);
  const parts = [
    ...formatAppliedLines(applied),
    ...reportableMissLines(result),
  ];
  if (parts.length === 0) {
    return LIST_FIND_MISS;
  }
  // Partial with applied + misses: ensure a miss line exists when completeness partial
  if (
    result.completeness === "partial" &&
    applied.length > 0 &&
    reportableMissLines(result).length === 0
  ) {
    parts.push(PARTIAL_MISS_LINE);
  }
  return parts.join("\n");
}

function formatUnknown(result: ApplyResult): string {
  const applied = flattenApplied(result);
  const appliedLines = formatAppliedLines(applied);
  if (appliedLines.length > 0) {
    return [...appliedLines, UNKNOWN_CAUTION].join("\n");
  }
  return UNKNOWN_CAUTION;
}

/** Narrow confirmed ack when model left spoken empty after complete apply. */
export const ORDINARY_MUTATION_EMPTY_ACK = "בוצע.";

/**
 * Stage 2A: spoken fill when the model left responses empty but ApplyResult
 * has requested mutates. Never invents unverified success.
 * - complete + applied → short confirmed ack (not a detailed model-style confirm)
 * - complete + no applied → miss line
 * - partial → applied lines + miss lines
 * - unknown → caution (+ applied lines if any)
 * Returns null when there were no requested mutates.
 */
export function formatEmptySpokenFromApplyResult(
  result: ApplyResult,
): string | null {
  if (!hasRequestedMutates(result)) {
    return null;
  }
  const applied = flattenApplied(result);
  if (result.completeness === "unknown") {
    return formatUnknown(result);
  }
  if (result.completeness === "partial") {
    return formatFromResult(result);
  }
  // complete
  if (applied.length === 0) {
    const misses = reportableMissLines(result);
    return misses[0] ?? LIST_FIND_MISS;
  }
  return ORDINARY_MUTATION_EMPTY_ACK;
}

export { UNKNOWN_CAUTION as APPLY_RESULT_UNKNOWN_CAUTION };

/**
 * Keep the model draft unless ApplyResult proves a failure; then replace it
 * with engine text built from ApplyResult (applied lines + miss lines).
 */
export function decideReplyFromApplyResult(input: {
  applyResult: ApplyResult;
  modelDraft: string;
}): DecideReplyFromApplyResult {
  const draftSpoken = parseLlmReply(input.modelDraft).response.trim();
  const result = input.applyResult;
  if (!applyResultHasFailure(result)) {
    return { keepDraft: true, spoken: draftSpoken };
  }
  return {
    keepDraft: false,
    spoken:
      result.completeness === "unknown"
        ? formatUnknown(result)
        : formatFromResult(result),
  };
}
