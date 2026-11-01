/**
 * Result-B: decide spoken reply from ApplyResult (not a new corrector chain).
 * List/inventory display stays engine-owned (show_dump REPLACE); this only
 * gates optimistic success claims against applied / misses.
 */
import { parseLlmReply } from "@workee/shared";
import {
  LIST_ADD_MISS,
  LIST_FIND_MISS,
  looksLikeDurableSaveClaim,
  looksLikeListAddClaim,
  looksLikeListDeleteClaim,
  looksLikeReminderSaveClaim,
  looksLikeShareClaim,
} from "./employee-records.service.js";
import type {
  ApplyResult,
  AppliedOp,
  ApplyMiss,
  ResultIntentMiss,
} from "./apply-result.js";
import { looksLikeFreeWrittenNumberedInventory } from "./show-button-dump.js";

export type DecideReplyFromApplyResult = {
  keepDraft: boolean;
  /** Spoken Hebrew when keepDraft is false; otherwise mirrors draft spoken. */
  spoken: string;
};

type ClaimFlags = {
  anySuccess: boolean;
  deleteClaim: boolean;
  addClaim: boolean;
  updateClaim: boolean;
  shareClaim: boolean;
  reminderClaim: boolean;
  durableClaim: boolean;
};

type AppliedCounts = {
  total: number;
  removes: number;
  adds: number;
  updates: number;
};

const UPDATE_CLAIM_RE = /עדכנתי/;
const PARTIAL_MISS_LINE = "חלק מהפריטים לא עודכנו.";
const UNKNOWN_CAUTION =
  "לא הצלחתי לאמת את כל הפעולות — נסי שוב או בדקי את הרשימה.";

function analyzeClaims(spoken: string): ClaimFlags {
  const deleteClaim = looksLikeListDeleteClaim(spoken);
  const addClaim = looksLikeListAddClaim(spoken);
  const updateClaim = UPDATE_CLAIM_RE.test(spoken);
  const shareClaim = looksLikeShareClaim(spoken);
  const reminderClaim = looksLikeReminderSaveClaim(spoken);
  const durableClaim = looksLikeDurableSaveClaim(spoken);
  return {
    deleteClaim,
    addClaim,
    updateClaim,
    shareClaim,
    reminderClaim,
    durableClaim,
    anySuccess:
      deleteClaim ||
      addClaim ||
      updateClaim ||
      shareClaim ||
      reminderClaim ||
      durableClaim,
  };
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

function countApplied(applied: AppliedOp[]): AppliedCounts {
  let removes = 0;
  let adds = 0;
  let updates = 0;
  for (const row of applied) {
    const op = row.op;
    if (
      op === "remove" ||
      op === "remove_filing" ||
      op === "delete_list"
    ) {
      removes += 1;
    } else if (op === "add" || op === "add_filing") {
      adds += 1;
    } else if (op === "update" || op === "update_filing" || op === "alter_list") {
      updates += 1;
    }
  }
  return {
    total: applied.length,
    removes,
    adds,
    updates,
  };
}

function hasRequestedMutates(result: ApplyResult): boolean {
  return Object.values(result.domains).some(
    (domain) => domain && domain.requested.length > 0,
  );
}

/** Draft may stay only when its success claims are covered by applied counts. */
export function draftMatchesApplied(
  claims: ClaimFlags,
  counts: AppliedCounts,
): boolean {
  if (!claims.anySuccess) {
    return true;
  }
  if (claims.deleteClaim && counts.removes === 0) {
    return false;
  }
  if (claims.addClaim && counts.adds === 0) {
    return false;
  }
  if (claims.updateClaim && counts.updates === 0) {
    return false;
  }
  if (claims.shareClaim && counts.updates === 0 && counts.adds === 0) {
    return false;
  }
  if (claims.reminderClaim) {
    // Reminder applied ops use domain reminders; counted in adds/updates/removes.
    if (counts.total === 0) {
      return false;
    }
  }
  if (claims.durableClaim && counts.adds === 0 && counts.updates === 0) {
    return false;
  }
  if (counts.total === 0) {
    return false;
  }
  return true;
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
    const list =
      removes[0].listName?.trim() ||
      (removes[0].listType === "shopping"
        ? "קניות"
        : removes[0].listType === "tasks"
          ? "מטלות"
          : "הרשימה");
    lines.push(`הסרתי את «${removes[0].label}» מרשימת «${list}».`);
  } else if (removes.length > 1) {
    lines.push(`הסרתי ${removes.length} פריטים.`);
  }

  if (adds.length === 1 && adds[0]?.label) {
    const list = adds[0].listName?.trim() || "הרשימה";
    lines.push(`הוספתי את «${adds[0].label}» לרשימת «${list}».`);
  } else if (adds.length > 1) {
    lines.push(`הוספתי ${adds.length} פריטים.`);
  }

  if (updates.length === 1 && updates[0]?.label) {
    const list = updates[0].listName?.trim() || "הרשימה";
    lines.push(`עדכנתי את «${updates[0].label}» ברשימת «${list}».`);
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

/**
 * Decide whether modelDraft spoken may stand, or replace with Result-based text.
 * Does not emit list inventories — show_dump REPLACE remains the display path.
 */
export function decideReplyFromApplyResult(input: {
  applyResult: ApplyResult;
  modelDraft: string;
}): DecideReplyFromApplyResult {
  const draftSpoken = parseLlmReply(input.modelDraft).response.trim();
  const result = input.applyResult;

  if (!hasRequestedMutates(result)) {
    return { keepDraft: true, spoken: draftSpoken };
  }

  const claims = analyzeClaims(draftSpoken);
  const applied = flattenApplied(result);
  const counts = countApplied(applied);
  const looksLikeInventory = looksLikeFreeWrittenNumberedInventory(draftSpoken);

  // Never let mutate-turn draft present a free-written numbered inventory.
  if (looksLikeInventory && claims.anySuccess) {
    return { keepDraft: false, spoken: formatFromResult(result) };
  }
  if (looksLikeInventory && counts.total > 0) {
    return { keepDraft: false, spoken: formatFromResult(result) };
  }

  if (result.completeness === "unknown") {
    if (claims.anySuccess || looksLikeInventory) {
      return { keepDraft: false, spoken: formatUnknown(result) };
    }
    return { keepDraft: true, spoken: draftSpoken };
  }

  if (result.completeness === "partial") {
    if (claims.anySuccess || looksLikeInventory) {
      return { keepDraft: false, spoken: formatFromResult(result) };
    }
    return { keepDraft: true, spoken: draftSpoken };
  }

  // complete
  if (counts.total === 0) {
    if (claims.anySuccess) {
      const misses = reportableMissLines(result);
      return {
        keepDraft: false,
        spoken: misses[0] ?? LIST_FIND_MISS,
      };
    }
    return { keepDraft: true, spoken: draftSpoken };
  }

  if (claims.anySuccess && !draftMatchesApplied(claims, counts)) {
    return { keepDraft: false, spoken: formatFromResult(result) };
  }

  return { keepDraft: true, spoken: draftSpoken };
}
