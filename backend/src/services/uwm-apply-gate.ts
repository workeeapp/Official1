/**
 * UWM Phase 5 — evidence gate before P0 Apply.
 * Model confidence alone never unlocks Actions.
 */
import type { ComposeEvalFacts } from "./compose-condition.js";

/** Max age of retrievedAt for Apply (fail-closed when older). */
export const UWM_APPLY_FRESH_MS = 6 * 60 * 60_000;

export type UwmApplyGateResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "no_match"
        | "unverified"
        | "disputed"
        | "stale"
        | "need_corroborated"
        | "missing_evidence"
        | "no_fingerprint";
    };

/**
 * Fail-closed gate: only verified, fresh, matching web_monitor facts may Apply.
 */
export function uwmApplyGate(
  facts: ComposeEvalFacts,
  now: Date = new Date(),
): UwmApplyGateResult {
  const wm = facts.webMonitor;
  if (!wm) return { ok: false, reason: "no_match" };
  if (!wm.shouldNotify) return { ok: false, reason: "no_match" };
  const fp = String(wm.fingerprint ?? "").trim();
  if (!fp) return { ok: false, reason: "no_fingerprint" };

  const grade = wm.evidenceGrade;
  if (!grade) return { ok: false, reason: "missing_evidence" };
  if (grade === "unverified") return { ok: false, reason: "unverified" };
  if (grade === "disputed") return { ok: false, reason: "disputed" };
  if (wm.stale === true) return { ok: false, reason: "stale" };

  const min = wm.evidenceMin ?? "observed";
  if (min === "corroborated" && grade !== "corroborated") {
    return { ok: false, reason: "need_corroborated" };
  }
  if (grade !== "observed" && grade !== "corroborated") {
    return { ok: false, reason: "missing_evidence" };
  }

  if (wm.fresh === false) return { ok: false, reason: "stale" };
  if (wm.retrievedAt) {
    const retrievedMs = Date.parse(wm.retrievedAt);
    if (
      !Number.isFinite(retrievedMs) ||
      now.getTime() - retrievedMs > UWM_APPLY_FRESH_MS
    ) {
      return { ok: false, reason: "stale" };
    }
  }

  return { ok: true };
}
