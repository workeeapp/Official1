/**
 * Unified Response Contract — Stage 2A: empty spoken policy.
 *
 * Product rule: every turn must have meaningful user-facing text. Empty /
 * whitespace / missing `responses` is never a valid intentional model outcome
 * (including show_dump and live-domain turns). The engine recovers:
 *
 * - show_dump / live ACTION present → defer early invent; authoritative
 *   display fills spoken (dump REPLACE / applyLiveDomainReply). Final
 *   EMPTY_REPLY_RETRY if still blank.
 * - mutate+show (pending dump + requested mutates) → still allow ApplyResult
 *   ack so combineConfirmAndDump has a short confirm beside the dump.
 * - ordinary complete apply + empty → narrow confirmed «בוצע.» (not detailed
 *   formatAppliedMutationFallback inventing a full model-style confirm).
 * - failed / partial / unknown → ApplyResult-truthful lines only.
 * - no ACTION + empty → leave for final EMPTY_REPLY_RETRY.
 *
 * Does not invent ACTIONs. Does not change multi-bubble behavior. Prompt/schema
 * teaching of mandatory responses is out of Stage 2A scope.
 */
import type { AddressGender, LlmMetadata } from "@workee/shared";
import { parseLlmReply } from "@workee/shared";
import type { ApplyResult } from "./apply-result.js";
import { formatEmptySpokenFromApplyResult } from "./apply-result-reply.js";
import type { PendingShowDump } from "./apply-result-display.js";

/** How empty spoken was shaped in the model JSON (best-effort). */
export type SpokenEmptinessKind =
  | "nonempty"
  | "explicit_empty_responses"
  | "whitespace_only"
  | "missing_responses"
  | "empty_other";

export type EmptySpokenDecision = {
  /** null = leave spoken empty (defer to display / final EMPTY_REPLY_RETRY). */
  fallback: string | null;
  reason:
    | "nonempty"
    | "defer_engine_display"
    | "confirm_or_guest"
    | "list_op"
    | "apply_result"
    | "reminder_delete"
    | "none";
  emptiness: SpokenEmptinessKind;
};

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasRequestedMutates(result: ApplyResult): boolean {
  return Object.values(result.domains).some(
    (domain) => domain && domain.requested.length > 0,
  );
}

/**
 * Classify empty vs nonempty spoken. Missing `responses` vs `responses:[]`
 * are distinguishable only from raw JSON; both yield empty parseLlmReply.response.
 * Neither is a valid intentional product outcome.
 */
export function classifySpokenEmptiness(reply: string): SpokenEmptinessKind {
  const spoken = parseLlmReply(reply).response;
  if (spoken.trim()) {
    return "nonempty";
  }
  const parsed = tryParseJsonObject(reply);
  if (!parsed) {
    return "empty_other";
  }
  if (Array.isArray(parsed.responses)) {
    if (parsed.responses.length === 0) {
      return "explicit_empty_responses";
    }
    return "whitespace_only";
  }
  if ("metadata" in parsed || "lists" in parsed || "actions" in parsed) {
    return "missing_responses";
  }
  return "empty_other";
}

/** Live capability ACTION present → server will fill spoken. */
export function hasLiveDomainAction(
  metadata: Pick<
    LlmMetadata,
    | "weather"
    | "market"
    | "mashov"
    | "smartschool"
    | "places"
    | "jewish"
    | "routes"
    | "flights"
  >,
): boolean {
  return Boolean(
    metadata.weather ||
      metadata.market ||
      metadata.mashov ||
      metadata.smartschool ||
      metadata.places ||
      metadata.jewish ||
      metadata.routes ||
      metadata.flights,
  );
}

function hasShowDumpDisplay(input: {
  metadata: LlmMetadata;
  pendingShowDump?: PendingShowDump | null;
}): boolean {
  if (input.pendingShowDump?.kind?.trim()) {
    return true;
  }
  return Boolean(input.metadata.showDump?.trim());
}

/**
 * True when an authoritative engine display will supply user-facing content
 * next (recovery for empty model spoken — not validation of intentional silence).
 */
export function shouldDeferEmptyToEngineDisplay(input: {
  metadata: LlmMetadata;
  pendingShowDump?: PendingShowDump | null;
  applyResult: ApplyResult;
}): boolean {
  if (hasLiveDomainAction(input.metadata)) {
    return true;
  }
  if (!hasShowDumpDisplay(input)) {
    return false;
  }
  // Show-only dump: defer to REPLACE.
  // Mutate+show: do not defer — allow ApplyResult ack for combineConfirmAndDump.
  return !hasRequestedMutates(input.applyResult);
}

/**
 * Decide empty-spoken fill after Result-B, before gated claim correctors and
 * before show_dump / live REPLACE.
 */
export function decideEmptySpokenFallback(input: {
  reply: string;
  applyResult: ApplyResult;
  metadata: LlmMetadata;
  pendingShowDump?: PendingShowDump | null;
  guestMutationNotice?: string;
  listOpFallback?: string;
  reminderDeleteFallback?: string;
  addressGender?: AddressGender | null;
}): EmptySpokenDecision {
  const emptiness = classifySpokenEmptiness(input.reply);
  if (emptiness === "nonempty") {
    return { fallback: null, reason: "nonempty", emptiness };
  }

  if (
    shouldDeferEmptyToEngineDisplay({
      metadata: input.metadata,
      pendingShowDump: input.pendingShowDump,
      applyResult: input.applyResult,
    })
  ) {
    return { fallback: null, reason: "defer_engine_display", emptiness };
  }

  const guest = input.guestMutationNotice?.trim() ?? "";
  if (guest) {
    return { fallback: guest, reason: "confirm_or_guest", emptiness };
  }
  if (input.metadata.confirm === false) {
    return {
      fallback: "ביטלתי.",
      reason: "confirm_or_guest",
      emptiness,
    };
  }
  if (input.metadata.confirm === true) {
    return { fallback: "אושר.", reason: "confirm_or_guest", emptiness };
  }

  const listOp = input.listOpFallback?.trim() ?? "";
  if (listOp) {
    return { fallback: listOp, reason: "list_op", emptiness };
  }

  const fromApply = formatEmptySpokenFromApplyResult(
    input.applyResult,
    input.addressGender,
  );
  if (fromApply) {
    return { fallback: fromApply, reason: "apply_result", emptiness };
  }

  const reminderDelete = input.reminderDeleteFallback?.trim() ?? "";
  if (reminderDelete) {
    return { fallback: reminderDelete, reason: "reminder_delete", emptiness };
  }

  // No ACTION / nothing confirmed — leave empty for post-live EMPTY_REPLY_RETRY.
  return { fallback: null, reason: "none", emptiness };
}

/** @deprecated alias — empty is never intentional; use shouldDeferEmptyToEngineDisplay */
export function hasIntentionalEngineDisplay(input: {
  metadata: LlmMetadata;
  pendingShowDump?: PendingShowDump | null;
}): boolean {
  return (
    hasShowDumpDisplay(input) || hasLiveDomainAction(input.metadata)
  );
}
