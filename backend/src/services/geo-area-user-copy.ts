/**
 * Shared Geographic UX Gate (Stage 1).
 *
 * Policy / provider reject strings (messageHe, policyTrace) may contain internal
 * jargon — they stay in logs/telemetry only. Domains must call these helpers
 * before any user-facing reply for area-resolution failures.
 *
 * Does not change geographic acceptance rules (geo-area-policy).
 */

import type { ResolveGeographicAreaFailureKind } from "./geo-area.js";
import type { GeographicMatch } from "./geographic-match.js";

export type AreaResolveUserCopyInput = {
  place: string;
  kind: ResolveGeographicAreaFailureKind | string;
  /** Original policy / provider Hebrew — log only, never show as-is when technical. */
  policyMessageHe?: string;
};

const TECHNICAL_POLICY_MARKERS = [
  "יחידה מינהלית",
  "מינהלית",
  "narrow_admin",
  "point_like",
  "weak_affinity",
  "locationRestriction",
  "viewport",
  "colloquial_area",
  "administrative_area",
  "admin_narrow",
  "admin_broad",
  "geo_area",
];

export function isTechnicalAreaPolicyMessage(messageHe: string): boolean {
  const t = String(messageHe ?? "");
  return TECHNICAL_POLICY_MARKERS.some((m) => t.includes(m));
}

/** Natural Hebrew ask / clarify for Places (and similar) area failures. */
export function formatGeographicAreaFailureForUser(
  input: AreaResolveUserCopyInput,
): string {
  const place = String(input.place ?? "").trim() || "האזור";
  const kind = String(input.kind ?? "none");

  switch (kind) {
    case "ambiguous":
      return `מצאתי כמה אפשרויות ל«${place}». לאיזה אזור או עיר התכוונת?`;
    case "missing_key":
      return "חיפוש לפי אזור לא מוגדר כרגע. אפשר לציין עיר במקום?";
    case "error":
      return "לא הצלחתי לזהות את האזור עכשיו. נסה שוב או ציין עיר.";
    case "invalid":
      return `לא הצלחתי לקבוע גבולות ברורים ל«${place}». באיזו עיר או אזור מדויק יותר לחפש?`;
    case "none":
    default:
      break;
  }

  const policy = String(input.policyMessageHe ?? "").trim();
  if (policy && !isTechnicalAreaPolicyMessage(policy)) {
    return policy;
  }
  return `לא זיהיתי בוודאות את «${place}». באיזו עיר או אזור מדויק יותר לחפש?`;
}

function logPolicyTrace(payload: Record<string, unknown>): void {
  console.info("[geo-area] user_copy", JSON.stringify(payload));
}

/** Log policy copy; return user-facing text. */
export function speakGeographicAreaFailure(
  input: AreaResolveUserCopyInput,
): string {
  const userText = formatGeographicAreaFailureForUser(input);
  if (input.policyMessageHe?.trim()) {
    logPolicyTrace({
      place: input.place,
      kind: input.kind,
      policyMessageHe: input.policyMessageHe,
      userMessageHe: userText,
    });
  }
  return userText;
}

/**
 * UX Gate for a GeographicMatch: prefer match.userAskHe when safe;
 * never leak policyTrace / technical markers to the speaker.
 */
export function speakGeographicMatchForUser(match: GeographicMatch): string {
  const place = match.labelHe || match.asked.rawText || "המקום";
  const preferred = String(match.userAskHe ?? "").trim();
  if (preferred && !isTechnicalAreaPolicyMessage(preferred)) {
    if (match.policyTrace?.trim()) {
      logPolicyTrace({
        place,
        status: match.status,
        policyTrace: match.policyTrace,
        userMessageHe: preferred,
      });
    }
    return preferred;
  }

  const statusKind =
    match.status === "ambiguous"
      ? "ambiguous"
      : match.status === "needs_clarify" ||
          match.status === "unsupported_for_consumer"
        ? "none"
        : "none";

  return speakGeographicAreaFailure({
    place,
    kind: statusKind,
    policyMessageHe: match.policyTrace,
  });
}
