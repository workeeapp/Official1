import type { LlmComposeCondition } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { loadComposeFacts } from "./compose-facts.js";
import {
  baselineShaForWatch,
  conditionFromReminderJson,
  idleEdgeShaForHolding,
  isHoldingEdgeSha,
} from "./compose-condition.js";
import { fetchBusEtaWatch } from "./routes.js";
import { enrichEvalFactsForExpr } from "./watch-expr.js";

export type WatchBaselineSeedResult = {
  sha: string | null;
  /** Condition already true at create — sha stamped as idle so next fire alerts. */
  alreadyHolding: boolean;
};

/**
 * After creating/updating a conditional watch clock, sample current facts and
 * stamp last_report_sha so the first fire does not treat "current state" as new.
 *
 * Edge watches (market / expr): if already holding at create, stamp the idle
 * token instead so the next fire can send once (caller may bump fireAt to now).
 */
export async function seedWatchBaseline(input: {
  reminderId: string;
  composeSource: string;
  composePlace: string;
  composeCondition: unknown;
  composeAspects?: unknown;
  subjectEmployeeId: string;
  repeat: string;
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
    const sha = (
      alreadyHolding ? idleEdgeShaForHolding(rawSha) : rawSha
    ).slice(0, 64);
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
