/**
 * Result-B: decide spoken reply from ApplyResult.
 * Contract: the model always answers; the engine replaces the reply ONLY when
 * ApplyResult proves a failure (miss / drop / partial / unknown). The model's
 * text is never analyzed to decide this.
 */
import { parseLlmReply, type AddressGender } from "@workee/shared";
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

/** @deprecated Prefer unknownCautionForAddress(gender) — female legacy default. */
const UNKNOWN_CAUTION_FEMALE =
  "לא הצלחתי לאמת את כל הפעולות — נסי שוב או בדקי את הרשימה.";

/**
 * Engine caution when ApplyResult completeness is unknown.
 * Conjugate second-person to SPEAKER_ADDRESS gender (never hardcode נקבה).
 */
export function unknownCautionForAddress(
  gender?: AddressGender | null,
): string {
  if (gender === "male") {
    return "לא הצלחתי לאמת את כל הפעולות — נסה שוב או בדוק את הרשימה.";
  }
  if (gender === "female") {
    return UNKNOWN_CAUTION_FEMALE;
  }
  return "לא הצלחתי לאמת את כל הפעולות — נסו שוב או בדקו את הרשימה.";
}

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

function isRemoveOp(op: string | undefined): boolean {
  return op === "remove" || op === "remove_filing" || op === "delete_list";
}

/** Name a row a partial delete did not remove. Empty when nothing identifiable. */
function leftoverPhrase(input: {
  dumpLine?: number;
  label?: string;
}): string {
  const label = input.label?.trim() ?? "";
  const line = input.dumpLine;
  if (line && line > 0 && label) {
    return `${line}. «${label}»`;
  }
  if (label) {
    return `«${label}»`;
  }
  if (line && line > 0) {
    return `שורה ${line}`;
  }
  return "";
}

function reportableMissLines(result: ApplyResult): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const leftovers: string[] = [];
  const push = (line: string) => {
    if (!line || seen.has(line)) {
      return;
    }
    seen.add(line);
    lines.push(line);
  };
  const pushLeftover = (phrase: string) => {
    if (!phrase || leftovers.includes(phrase)) {
      return;
    }
    leftovers.push(phrase);
  };
  const appliedRemoves = flattenApplied(result).filter((row) =>
    isRemoveOp(row.op),
  );
  const nameLeftovers = appliedRemoves.length > 0;

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
        const phrase = leftoverPhrase({
          dumpLine: miss.dumpLine,
          label: miss.label,
        });
        const removeMiss =
          !miss.op || isRemoveOp(miss.op);
        if (nameLeftovers && removeMiss && phrase) {
          pushLeftover(phrase);
        } else {
          push(LIST_FIND_MISS);
        }
      }
    }
    for (const miss of domain.apply_misses as ApplyMiss[]) {
      if (miss.reason === "missing" || miss.reason === "forbidden") {
        const phrase = leftoverPhrase({
          dumpLine: miss.dumpLine,
          label: miss.detail,
        });
        const removeMiss = !miss.op || isRemoveOp(miss.op);
        if (nameLeftovers && removeMiss && phrase) {
          pushLeftover(phrase);
        } else {
          push(LIST_FIND_MISS);
        }
      } else if (miss.reason === "missed" || miss.reason === "skipped") {
        push(LIST_FIND_MISS);
      } else if (miss.op === "add" || miss.reason.includes("add")) {
        push(LIST_ADD_MISS);
      } else {
        push(PARTIAL_MISS_LINE);
      }
    }
  }
  if (leftovers.length === 1) {
    push(`לא הוסר: ${leftovers[0]}.`);
  } else if (leftovers.length > 1) {
    push(`לא הוסרו: ${leftovers.join(", ")}.`);
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

function formatUnknown(
  result: ApplyResult,
  gender?: AddressGender | null,
): string {
  const applied = flattenApplied(result);
  const appliedLines = formatAppliedLines(applied);
  const caution = unknownCautionForAddress(gender);
  if (appliedLines.length > 0) {
    return [...appliedLines, caution].join("\n");
  }
  return caution;
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
  gender?: AddressGender | null,
): string | null {
  if (!hasRequestedMutates(result)) {
    return null;
  }
  const applied = flattenApplied(result);
  if (result.completeness === "unknown") {
    return formatUnknown(result, gender);
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

/** Female legacy default — tests that assert the string without gender. */
export { UNKNOWN_CAUTION_FEMALE as APPLY_RESULT_UNKNOWN_CAUTION };

/**
 * Keep the model draft unless ApplyResult proves a failure; then replace it
 * with engine text built from ApplyResult (applied lines + miss lines).
 */
export function decideReplyFromApplyResult(input: {
  applyResult: ApplyResult;
  modelDraft: string;
  addressGender?: AddressGender | null;
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
        ? formatUnknown(result, input.addressGender)
        : formatFromResult(result),
  };
}
