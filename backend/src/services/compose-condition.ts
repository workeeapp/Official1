import { createHash } from "node:crypto";
import type { LlmComposeCondition } from "@workee/shared";
import { parseComposeCondition } from "@workee/shared";

/** Structured signals from compose facts for condition evaluation. */
export type ComposeEvalFacts = {
  marketPrice?: number | null;
  weatherIsRain?: boolean;
  /** Stable hash of mashov body content (sha256 hex). */
  mashovFingerprint?: string;
};

export type ComposeConditionFireGate = {
  /** When true, skip WhatsApp (clock still advances via settle). */
  skipSend: boolean;
  /** Write to lastReportSha immediately (market edge state), even on skip. */
  immediateSha?: string;
  /** Write to lastReportSha only after a successful WhatsApp send (mashov). */
  shaAfterSend?: string;
};

function comparePrice(
  price: number,
  op: "lt" | "lte" | "gt" | "gte" | "eq",
  value: number,
): boolean {
  switch (op) {
    case "lt":
      return price < value;
    case "lte":
      return price <= value;
    case "gt":
      return price > value;
    case "gte":
      return price >= value;
    case "eq":
      return Math.abs(price - value) < 1e-9;
    default:
      return false;
  }
}

/** Fingerprint mashov (or any) fixed body for mashov_new watches. */
export function mashovContentFingerprint(body: string): string {
  return createHash("sha256").update(body.trim(), "utf8").digest("hex");
}

/**
 * Evaluate a structured compose_condition against fire-time facts.
 * Market uses edge trigger (false→true) via lastReportSha market:below/above.
 */
export function evaluateComposeCondition(input: {
  condition: LlmComposeCondition;
  facts: ComposeEvalFacts;
  lastReportSha?: string | null;
}): ComposeConditionFireGate {
  const last = String(input.lastReportSha ?? "").trim();

  if (input.condition.type === "market_price") {
    const price = input.facts.marketPrice;
    if (price == null || !Number.isFinite(price)) {
      // Cannot evaluate — skip quietly; leave edge state unchanged.
      return { skipSend: true };
    }
    const holding = comparePrice(
      price,
      input.condition.op,
      input.condition.value,
    );
    const prevHolding = last === "market:below";
    const immediateSha = holding ? "market:below" : "market:above";
    // Edge: send only on transition into holding (including first fire from empty).
    const shouldSend = holding && !prevHolding;
    return {
      skipSend: !shouldSend,
      immediateSha,
    };
  }

  if (input.condition.type === "weather_rain") {
    return {
      skipSend: input.facts.weatherIsRain !== true,
    };
  }

  if (input.condition.type === "mashov_new") {
    const fp = String(input.facts.mashovFingerprint ?? "").trim();
    if (!fp) {
      return { skipSend: true };
    }
    if (fp === last) {
      return { skipSend: true };
    }
    return {
      skipSend: false,
      shaAfterSend: fp,
    };
  }

  return { skipSend: false };
}

/** Parse DB/JSON compose_condition into a typed condition (or null). */
export function conditionFromReminderJson(
  raw: unknown,
): LlmComposeCondition | null {
  return parseComposeCondition(raw);
}
