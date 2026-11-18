/**
 * Stage 6 — legacy foreign clock suppress + auth marker helpers.
 * Personal / Lucy-owned product clocks fire without a marker.
 * Human-actor clocks that ping other humans require highRiskAuthorizedAt.
 */
import type { PublicEmployee } from "@workee/shared";
import { phonesMatch } from "../utils/phone.js";

function pingDests(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(String).map((s) => s.trim()).filter(Boolean);
}

function destIsActor(
  dest: string,
  actor: PublicEmployee,
): boolean {
  if (dest === actor.id) {
    return true;
  }
  if (actor.phone && phonesMatch(actor.phone, dest)) {
    return true;
  }
  return false;
}

/**
 * True when a human actor created a clock that pings at least one other human
 * (or an external phone). Digital-actor (Lucy) clocks are product follow-ups.
 */
export function isHumanActorForeignPingClock(input: {
  actorId: string;
  pingIds: unknown;
  employees: PublicEmployee[];
}): boolean {
  const actor = input.employees.find((row) => row.id === input.actorId);
  if (!actor || actor.kind !== "human") {
    return false;
  }
  const dests = pingDests(input.pingIds);
  for (const dest of dests) {
    if (destIsActor(dest, actor)) {
      continue;
    }
    const emp = input.employees.find(
      (row) =>
        row.id === dest ||
        (row.phone != null && phonesMatch(row.phone, dest)),
    );
    if (!emp) {
      // External phone / unknown dest — treat as foreign P-Out.
      return true;
    }
    if (emp.kind === "human") {
      return true;
    }
    // Digital worker dest only — not foreign human ping.
  }
  return false;
}

/** Fire-time gate: suppress legacy foreign clocks that lack Class V auth marker. */
export function shouldSuppressLegacyForeignClock(input: {
  actorId: string;
  pingIds: unknown;
  highRiskAuthorizedAt: Date | string | null | undefined;
  employees: PublicEmployee[];
}): boolean {
  if (!isHumanActorForeignPingClock(input)) {
    return false;
  }
  return input.highRiskAuthorizedAt == null;
}
