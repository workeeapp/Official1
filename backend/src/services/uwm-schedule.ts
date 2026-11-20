/**
 * UWM Phase 4 — precise arming + dual schedule helpers.
 * Reuses fireAtFromExternalEvent; does not add a new scheduler.
 * eventAt / eventAtIso must be absolute UTC (see isAbsoluteUtcTimestamp).
 */
import { fireAtFromExternalEvent } from "./fact-followup.service.js";
import { isAbsoluteUtcTimestamp } from "./uwm-event-at.js";
import type {
  UwmMonitorItemState,
  UwmMonitorState,
  UwmNextPrecise,
} from "./uwm-types.js";

/** Catch-up window after eventAt; later → mark missed (no late notify). */
export const UWM_PRECISE_GRACE_MS = 30 * 60_000;

/** Material eventAt shift that re-arms an unmet pre-phase. */
export const UWM_REARM_SLACK_MS = 15 * 60_000;

/** Claim/skew tolerance when deciding if this fire is the precise arm. */
export const UWM_PRECISE_CLAIM_SKEW_MS = 90_000;

export function phasePre(objectiveId: string, minutesBefore: number): string {
  return `${objectiveId}:pre:${minutesBefore}`;
}

export function phaseMissed(objectiveId: string, minutesBefore: number): string {
  return `${objectiveId}:missed:${minutesBefore}`;
}

export function computePreciseFireAt(
  eventAtIso: string,
  minutesBefore: number,
): Date | null {
  if (!isAbsoluteUtcTimestamp(eventAtIso)) return null;
  return fireAtFromExternalEvent(eventAtIso, -Math.abs(minutesBefore));
}

export function isWithinPreciseCatchUp(input: {
  now: Date;
  preciseFireAt: Date;
  eventAtIso: string;
  graceMs?: number;
}): boolean {
  if (!isAbsoluteUtcTimestamp(input.eventAtIso)) return false;
  const eventMs = Date.parse(input.eventAtIso);
  if (!Number.isFinite(eventMs)) return false;
  const grace = input.graceMs ?? UWM_PRECISE_GRACE_MS;
  const nowMs = input.now.getTime();
  return (
    nowMs >= input.preciseFireAt.getTime() - UWM_PRECISE_CLAIM_SKEW_MS &&
    nowMs < eventMs + grace
  );
}

export function isPastPreciseGrace(input: {
  now: Date;
  eventAtIso: string;
  graceMs?: number;
}): boolean {
  if (!isAbsoluteUtcTimestamp(input.eventAtIso)) return false;
  const eventMs = Date.parse(input.eventAtIso);
  if (!Number.isFinite(eventMs)) return false;
  const grace = input.graceMs ?? UWM_PRECISE_GRACE_MS;
  return input.now.getTime() >= eventMs + grace;
}

/**
 * Earliest unmet time_before_event arm across active items.
 */
export function computeNextPrecise(input: {
  items: Record<string, UwmMonitorItemState>;
  objectives: Array<{ id: string; kind: string; minutesBefore?: number }>;
  now: Date;
}): UwmNextPrecise | null {
  let best: UwmNextPrecise | null = null;
  let bestMs = Number.POSITIVE_INFINITY;

  for (const obj of input.objectives) {
    if (obj.kind !== "time_before_event") continue;
    const mins = obj.minutesBefore ?? 60;
    const phase = phasePre(obj.id, mins);
    const missed = phaseMissed(obj.id, mins);

    for (const [itemId, st] of Object.entries(input.items)) {
      if (st.status === "cancelled" || st.status === "expired") continue;
      // Reject date-only / timezone-less local — only absolute UTC eventAt arms.
      if (!isAbsoluteUtcTimestamp(st.eventAt)) continue;
      if (st.notified[phase] || st.notified[missed]) continue;
      if (
        st.evidenceGrade === "unverified" ||
        st.evidenceGrade === "disputed"
      ) {
        continue;
      }
      const fireAt = computePreciseFireAt(st.eventAt!, mins);
      if (!fireAt) continue;
      // Already past grace → leave for missed marker elsewhere
      if (isPastPreciseGrace({ now: input.now, eventAtIso: st.eventAt! })) {
        continue;
      }
      const ms = fireAt.getTime();
      if (ms < bestMs) {
        bestMs = ms;
        best = {
          itemId,
          objectiveId: obj.id,
          minutesBefore: mins,
          fireAtIso: fireAt.toISOString(),
          eventAtIso: new Date(Date.parse(st.eventAt!)).toISOString(),
        };
      }
    }
  }
  return best;
}

/** min(discoveryNext, preciseFire) — whichever sooner; null if neither. */
export function dualFireAt(
  discoveryNext: Date | null,
  precise: UwmNextPrecise | null,
  now: Date,
): Date | null {
  const candidates: Date[] = [];
  if (discoveryNext && discoveryNext.getTime() > now.getTime() - 5_000) {
    candidates.push(discoveryNext);
  }
  if (precise) {
    const p = new Date(precise.fireAtIso);
    if (Number.isFinite(p.getTime())) {
      // If precise is already due (catch-up), arm ASAP (+2s) so claim can pick it up
      if (p.getTime() <= now.getTime()) {
        candidates.push(new Date(now.getTime() + 2_000));
      } else {
        candidates.push(p);
      }
    }
  }
  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates.map((d) => d.getTime())));
}

export function isPreciseArmDue(input: {
  state: UwmMonitorState;
  now: Date;
}): boolean {
  const p = input.state.nextPrecise;
  if (!p) return false;
  const fireAt = new Date(p.fireAtIso);
  if (!Number.isFinite(fireAt.getTime())) return false;
  if (isPastPreciseGrace({ now: input.now, eventAtIso: p.eventAtIso })) {
    return true; // still "precise path" so we can mark missed
  }
  return isWithinPreciseCatchUp({
    now: input.now,
    preciseFireAt: fireAt,
    eventAtIso: p.eventAtIso,
  });
}
