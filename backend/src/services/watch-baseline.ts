import type { LlmComposeCondition } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { loadComposeFacts } from "./compose-facts.js";
import {
  baselineShaForWatch,
  conditionFromReminderJson,
  isHoldingEdgeSha,
} from "./compose-condition.js";
import { fetchBusEtaWatch } from "./routes.js";
import {
  fetchFlightChangedWatch,
  fetchFlightEtaWatch,
} from "./flights.js";
import { enrichEvalFactsForExpr } from "./watch-expr.js";

export type WatchBaselineSeedResult = {
  sha: string | null;
  /** Condition already true at create (informational; caller must not fire now). */
  alreadyHolding: boolean;
};

/**
 * After creating/updating a conditional watch clock, sample current facts and
 * stamp last_report_sha so the first fire does not treat "current state" as new.
 *
 * Always stamps the raw baseline from baselineShaForWatch (current holding or
 * not). Edge (watch_once): if already holding, stay holding — quiet until leave
 * then re-enter; never fire on the next poll merely because create sampled true.
 * Level (alertWhileHolding / watch_once:false): same stamp; next poll sends
 * while true via evaluateComposeCondition. Never bump fireAt to now.
 */
export async function seedWatchBaseline(input: {
  reminderId: string;
  composeSource: string;
  composePlace: string;
  composeCondition: unknown;
  composeAspects?: unknown;
  subjectEmployeeId: string;
  repeat: string;
  /** Kept for callers; sha stamp is always raw baseline (edge and level). */
  alertWhileHolding?: boolean;
  now?: Date;
}): Promise<WatchBaselineSeedResult> {
  const condition = conditionFromReminderJson(input.composeCondition);
  if (!condition) {
    return { sha: null, alreadyHolding: false };
  }
  const now = input.now ?? new Date();
  try {
    let factsBundle = await loadComposeFacts({
      composeSource: input.composeSource,
      subjectEmployeeId: input.subjectEmployeeId,
      repeat: input.repeat,
      composePlace: input.composePlace,
      composeAspects: input.composeAspects,
      composeCondition: condition,
      now,
    });
    let evalFacts = { ...(factsBundle.eval ?? {}) };
    if (condition.type === "bus_eta") {
      const eta = await fetchBusEtaWatch({
        origin: condition.origin,
        destination: condition.destination,
        line: condition.line,
        headsign: condition.headsign,
        now,
      });
      evalFacts = {
        ...evalFacts,
        busEtaMinutes: eta.minutes,
        busEtaFingerprint: eta.fingerprint,
      };
    }
    if (condition.type === "flight_eta") {
      const eta = await fetchFlightEtaWatch({
        airport: condition.airport,
        direction: condition.direction,
        flight: condition.flight,
        airline: condition.airline,
        city: condition.city,
        now,
      });
      evalFacts = {
        ...evalFacts,
        flightEtaMinutes: eta.minutesUntil,
        flightEtaFingerprint: eta.fingerprint,
      };
    }
    if (condition.type === "flight_changed") {
      const changed = await fetchFlightChangedWatch({
        airport: condition.airport,
        direction: condition.direction,
        flight: condition.flight,
      });
      evalFacts = {
        ...evalFacts,
        flightChangedFingerprint: changed.fingerprint,
      };
    }
    if (condition.type === "expr" || condition.type === "field_changed") {
      const enriched = await enrichEvalFactsForExpr({
        condition,
        evalFacts,
        factsBundle,
        composeSource: input.composeSource,
        composePlace: input.composePlace,
        now,
      });
      evalFacts = enriched.evalFacts;
      factsBundle = enriched.factsBundle;
    }
    const rawSha = baselineShaForWatch({ condition, facts: evalFacts });
    if (!rawSha) {
      return { sha: null, alreadyHolding: false };
    }
    const alreadyHolding = isHoldingEdgeSha(rawSha);
    const sha = rawSha.slice(0, 64);
    await prisma.reminder.update({
      where: { id: input.reminderId },
      data: { lastReportSha: sha },
    });
    return { sha, alreadyHolding };
  } catch {
    return { sha: null, alreadyHolding: false };
  }
}

export function conditionNeedsBaseline(
  condition: LlmComposeCondition | null | undefined,
): boolean {
  return Boolean(condition);
}
