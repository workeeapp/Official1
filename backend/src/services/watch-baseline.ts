import type { LlmComposeCondition } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { loadComposeFacts } from "./compose-facts.js";
import {
  baselineShaForWatch,
  conditionFromReminderJson,
} from "./compose-condition.js";
import { fetchBusEtaWatch } from "./routes.js";
import { enrichEvalFactsForExpr } from "./watch-expr.js";

/**
 * After creating/updating a conditional watch clock, sample current facts and
 * stamp last_report_sha so the first fire does not treat "current state" as new.
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
}): Promise<string | null> {
  const condition = conditionFromReminderJson(input.composeCondition);
  if (!condition) {
    return null;
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
    const sha = baselineShaForWatch({ condition, facts: evalFacts });
    if (!sha) {
      return null;
    }
    await prisma.reminder.update({
      where: { id: input.reminderId },
      data: { lastReportSha: sha.slice(0, 64) },
    });
    return sha.slice(0, 64);
  } catch {
    return null;
  }
}

export function conditionNeedsBaseline(
  condition: LlmComposeCondition | null | undefined,
): boolean {
  return Boolean(condition);
}
