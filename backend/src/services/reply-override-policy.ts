/**
 * Unified Response Contract — Stage 1: override classes + correction gate.
 * Stage 2B: when an execution override fires, replace the entire `responses`
 * array (see replaceSpokenForExecutionOverride) — never preserve model bubbles.
 *
 * Model owns conversational response / ACTION decision (always non-empty text).
 * Engine owns execution, DB truth, permissions, and authoritative displays.
 * Engine may override model text only for a classified reason below.
 *
 * Stage 2A empty recovery stays separate (defense against empty model output).
 */
import type { DecideReplyFromApplyResult } from "./apply-result-reply.js";

/** Why the engine may replace or amend model spoken text. */
export type ReplyOverrideClass =
  | "operational-claim"
  | "engine-display"
  | "delivery-notice"
  | "narrow-post-apply";

/**
 * Named post-Result-B steps in chat.service (and tests that mirror that path).
 * Classification is by responsibility — not merely because text changes.
 */
export type ReplyCorrectorId =
  | "alignListType"
  | "resultB"
  | "misaddressedJob"
  | "askWhichJobs"
  | "emptySpokenFallback"
  | "listMutationClaim"
  | "shareClaim"
  | "unshareClaim"
  | "attachmentClaim"
  | "durableSaveClaim"
  | "executionTruth"
  | "appliedRemoveEmptyFallback"
  | "reminderDeleteFallback"
  | "listOpRefusal"
  | "subHourlyOrComposeRefuse"
  | "showDumpReplace"
  | "combineConfirmAndDump"
  | "liveDomainFill"
  | "deliveryCompose";

export type CorrectorPolicyEntry = {
  id: ReplyCorrectorId;
  class: ReplyOverrideClass;
  /**
   * When Result-B already replaced the draft for an operational claim, skip
   * this corrector to avoid a second rewrite of the same claim class.
   * Uncovered / partial domains stay false (always eligible).
   */
  skipWhenResultBResolvedOperational: boolean;
  /** One-line responsibility (for audits / Stage-1 report). */
  responsibility: string;
};

/**
 * Catalog of every Stage-1 correction/replacement between Result-B and final reply.
 * engine-display and delivery-notice are never gated by Result-B claim resolution.
 */
export const REPLY_CORRECTOR_CATALOG: readonly CorrectorPolicyEntry[] = [
  {
    id: "alignListType",
    class: "narrow-post-apply",
    skipWhenResultBResolvedOperational: false,
    responsibility:
      "Normalize shopping/tasks wording in model bubbles after list mutates (not claim truth).",
  },
  {
    id: "resultB",
    class: "operational-claim",
    skipWhenResultBResolvedOperational: false,
    responsibility:
      "Gate optimistic success / free inventory vs ApplyResult (complete/partial/unknown).",
  },
  {
    id: "misaddressedJob",
    class: "narrow-post-apply",
    skipWhenResultBResolvedOperational: false,
    responsibility:
      "Speaker must not see relay/report copy meant for another recipient.",
  },
  {
    id: "askWhichJobs",
    class: "narrow-post-apply",
    skipWhenResultBResolvedOperational: false,
    responsibility: "Disambiguate when several open jobs match.",
  },
  {
    id: "emptySpokenFallback",
    class: "narrow-post-apply",
    skipWhenResultBResolvedOperational: false,
    responsibility:
      "Stage 2A empty-response-policy: recover blank spoken via ApplyResult or defer to engine-display; never invent detailed confirms.",
  },
  {
    id: "listMutationClaim",
    class: "operational-claim",
    skipWhenResultBResolvedOperational: true,
    responsibility:
      "List add/remove/update false claims vs apply; overlapped by Result-B when it replaced.",
  },
  {
    id: "shareClaim",
    class: "narrow-post-apply",
    skipWhenResultBResolvedOperational: false,
    responsibility:
      "Share outcome details (already-shared / partial / miss) not fully in ApplyResult.",
  },
  {
    id: "unshareClaim",
    class: "narrow-post-apply",
    skipWhenResultBResolvedOperational: false,
    responsibility: "Unshare claim vs post-apply visibility evidence.",
  },
  {
    id: "attachmentClaim",
    class: "narrow-post-apply",
    skipWhenResultBResolvedOperational: false,
    responsibility: "Attach claim vs attachmentOutcome (link/alreadyLinked).",
  },
  {
    id: "durableSaveClaim",
    class: "operational-claim",
    skipWhenResultBResolvedOperational: true,
    responsibility:
      "תייקתי/שמרתי vs list/filing/directory apply; overlapped by Result-B durable claims.",
  },
  {
    id: "executionTruth",
    class: "narrow-post-apply",
    skipWhenResultBResolvedOperational: false,
    responsibility:
      "Speaker-book vs worker-only add / reminder dual claims — not covered by ApplyResult counts alone. Skipped when Result-B already resolved an add/reminder/durable operational claim (avoid rewriting B's corrected text that contains הוספתי, including filing-format lines).",
  },
  {
    id: "appliedRemoveEmptyFallback",
    class: "narrow-post-apply",
    skipWhenResultBResolvedOperational: false,
    responsibility: "Empty spoken after successful remove — Stage 1 leaves behavior.",
  },
  {
    id: "reminderDeleteFallback",
    class: "narrow-post-apply",
    skipWhenResultBResolvedOperational: false,
    responsibility: "Clock-only delete confirm when spoken empty or LIST_FIND_MISS.",
  },
  {
    id: "listOpRefusal",
    class: "narrow-post-apply",
    skipWhenResultBResolvedOperational: false,
    responsibility: "List-op policy refusal wording when engine refused alter/delete_list.",
  },
  {
    id: "subHourlyOrComposeRefuse",
    class: "narrow-post-apply",
    skipWhenResultBResolvedOperational: false,
    responsibility: "Sub-hourly repeat / incomplete compose clock refusal.",
  },
  {
    id: "showDumpReplace",
    class: "engine-display",
    skipWhenResultBResolvedOperational: false,
    responsibility: "Authoritative DB show_dump REPLACE (Result-C restore/combine).",
  },
  {
    id: "combineConfirmAndDump",
    class: "engine-display",
    skipWhenResultBResolvedOperational: false,
    responsibility: "Prepend mutate confirm before dump on mutate+show turns.",
  },
  {
    id: "liveDomainFill",
    class: "engine-display",
    skipWhenResultBResolvedOperational: false,
    responsibility: "Weather/market/places/… server facts fill or replace.",
  },
  {
    id: "deliveryCompose",
    class: "delivery-notice",
    skipWhenResultBResolvedOperational: false,
    responsibility: "WhatsApp delivery failure / invite / schedule skip notices.",
  },
] as const;

const CATALOG_BY_ID: Record<ReplyCorrectorId, CorrectorPolicyEntry> =
  Object.fromEntries(
    REPLY_CORRECTOR_CATALOG.map((row) => [row.id, row]),
  ) as Record<ReplyCorrectorId, CorrectorPolicyEntry>;

export function correctorPolicy(id: ReplyCorrectorId): CorrectorPolicyEntry {
  return CATALOG_BY_ID[id];
}

/**
 * Central gate: may this post-Result-B corrector run?
 *
 * - engine-display / delivery-notice: always (outside claim gate).
 * - narrow-post-apply: usually always; executionTruth has a narrow extra skip
 *   when Result-B already resolved add/reminder claims (see below).
 * - operational-claim with skipWhenResultBResolvedOperational: skipped when
 *   Result-B already replaced the draft for an operational reason.
 *
 * Not a global keepDraft gate — uncovered correctors still run after keepDraft.
 */
export function mayRunReplyCorrector(
  id: ReplyCorrectorId,
  resultB: Pick<
    DecideReplyFromApplyResult,
    "keepDraft" | "operationalClaimResolved" | "draftClaims"
  >,
): boolean {
  const entry = CATALOG_BY_ID[id];
  if (!entry) {
    return true;
  }
  if (
    entry.class === "engine-display" ||
    entry.class === "delivery-notice"
  ) {
    return true;
  }

  // Narrow residual: Result-B formatFromResult / formatUnknown often contains
  // «הוספתי…». correctExecutionTruthReply would treat that as a fresh model
  // add claim and can wipe B's miss/caution lines when speaker-book add is false
  // (same wipe hit filing durable claims after B rewrote תייקתי → הוספתי).
  // Skip when B already resolved add/reminder/durable — keep running when B
  // kept the draft (speaker-vs-worker still needed).
  if (id === "executionTruth") {
    if (
      resultB.operationalClaimResolved &&
      (resultB.draftClaims?.addClaim ||
        resultB.draftClaims?.reminderClaim ||
        resultB.draftClaims?.durableClaim)
    ) {
      return false;
    }
    return true;
  }

  if (entry.class === "narrow-post-apply") {
    return true;
  }
  // operational-claim
  if (
    entry.skipWhenResultBResolvedOperational &&
    resultB.operationalClaimResolved
  ) {
    return false;
  }
  return true;
}

/** Group catalog rows by override class (report / tests). */
export function catalogByOverrideClass(): Record<
  ReplyOverrideClass,
  ReplyCorrectorId[]
> {
  const out: Record<ReplyOverrideClass, ReplyCorrectorId[]> = {
    "operational-claim": [],
    "engine-display": [],
    "delivery-notice": [],
    "narrow-post-apply": [],
  };
  for (const row of REPLY_CORRECTOR_CATALOG) {
    out[row.class].push(row.id);
  }
  return out;
}
