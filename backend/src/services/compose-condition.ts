import { createHash } from "node:crypto";
import type { LlmComposeCondition } from "@workee/shared";
import { parseComposeCondition } from "@workee/shared";
import {
  compareWatchExpr,
  encodeFieldValueSha,
  evalWatchExprNode,
  watchFieldKey,
} from "./watch-expr.js";

/** Structured signals from compose facts for condition evaluation. */
export type ComposeEvalFacts = {
  marketPrice?: number | null;
  weatherIsRain?: boolean;
  /** Stable hash of weather body content (sha256 hex). */
  weatherFingerprint?: string;
  /** Stable hash of mashov body content (sha256 hex). */
  mashovFingerprint?: string;
  /** Stable hash of smartschool body content (sha256 hex). */
  smartschoolFingerprint?: string;
  /** Left/right daily change % for market_change_compare. */
  marketLeftChangePct?: number | null;
  marketRightChangePct?: number | null;
  /** Minutes until next matching bus departure (Google Routes). */
  busEtaMinutes?: number | null;
  /** Fingerprint of the departure being watched (sha / stable id). */
  busEtaFingerprint?: string;
  /** Minutes until flight arrival/departure (AviationStack). */
  flightEtaMinutes?: number | null;
  /** Fingerprint of the flight ETA sample (sha). */
  flightEtaFingerprint?: string;
  /** Fingerprint of flight status (status/delay/gate/times). */
  flightChangedFingerprint?: string;
  /** Resolved catalog field values for expr / field_changed. */
  exprFieldValues?: Record<string, number | null>;
};

export type ComposeConditionFireGate = {
  /** When true, skip WhatsApp (clock still advances via settle). */
  skipSend: boolean;
  /** Write to lastReportSha immediately (market edge state), even on skip. */
  immediateSha?: string;
  /** Write to lastReportSha only after a successful WhatsApp send (mashov/weather). */
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

/** Fingerprint mashov/weather (or any) fixed body for change watches. */
export function mashovContentFingerprint(body: string): string {
  return createHash("sha256").update(body.trim(), "utf8").digest("hex");
}

export const weatherContentFingerprint = mashovContentFingerprint;

/** Edge sha tokens that mean the condition is currently holding (true). */
export function isHoldingEdgeSha(sha: string | null | undefined): boolean {
  const token = String(sha ?? "").trim();
  return (
    token === "market:below" ||
    token === "expr:hold" ||
    token === "weather:wet"
  );
}

/**
 * Holding conditions: edge = false→true only; level (alertWhileHolding) = send
 * whenever currently true (recurring watch_once:false).
 */
function shouldSendHolding(
  holding: boolean,
  prevHolding: boolean,
  alertWhileHolding: boolean,
): boolean {
  return alertWhileHolding ? holding : holding && !prevHolding;
}

/**
 * Evaluate a structured compose_condition against fire-time facts.
 * Market/expr/rain/compare: edge by default; level when alertWhileHolding.
 */
export function evaluateComposeCondition(input: {
  condition: LlmComposeCondition;
  facts: ComposeEvalFacts;
  lastReportSha?: string | null;
  /** Recurring watch: alert every poll while condition holds. */
  alertWhileHolding?: boolean;
}): ComposeConditionFireGate {
  const last = String(input.lastReportSha ?? "").trim();
  const alertWhileHolding = input.alertWhileHolding === true;

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
    const shouldSend = shouldSendHolding(
      holding,
      prevHolding,
      alertWhileHolding,
    );
    return {
      skipSend: !shouldSend,
      immediateSha,
    };
  }

  if (input.condition.type === "market_change_compare") {
    const left = input.facts.marketLeftChangePct;
    const right = input.facts.marketRightChangePct;
    if (
      left == null ||
      right == null ||
      !Number.isFinite(left) ||
      !Number.isFinite(right)
    ) {
      return { skipSend: true };
    }
    const holding = comparePrice(left, input.condition.op, right);
    const prevHolding = last === "market:below";
    const immediateSha = holding ? "market:below" : "market:above";
    const shouldSend = shouldSendHolding(
      holding,
      prevHolding,
      alertWhileHolding,
    );
    return {
      skipSend: !shouldSend,
      immediateSha,
    };
  }

  if (input.condition.type === "weather_rain") {
    const raining = input.facts.weatherIsRain === true;
    const prevHolding = last === "weather:wet";
    const immediateSha = raining ? "weather:wet" : "weather:dry";
    const shouldSend = shouldSendHolding(
      raining,
      prevHolding,
      alertWhileHolding,
    );
    return {
      skipSend: !shouldSend,
      immediateSha,
    };
  }

  if (input.condition.type === "weather_changed") {
    const fp = String(input.facts.weatherFingerprint ?? "").trim();
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

  if (input.condition.type === "smartschool_new") {
    const fp = String(input.facts.smartschoolFingerprint ?? "").trim();
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

  if (input.condition.type === "bus_eta") {
    const minutes = input.facts.busEtaMinutes;
    const fp = String(input.facts.busEtaFingerprint ?? "").trim();
    if (minutes == null || !Number.isFinite(minutes) || !fp) {
      return { skipSend: true };
    }
    if (minutes > input.condition.minutesBefore) {
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

  if (input.condition.type === "flight_eta") {
    const minutes = input.facts.flightEtaMinutes;
    const fp = String(input.facts.flightEtaFingerprint ?? "").trim();
    const threshold =
      Math.abs(Math.round(input.condition.minutesBefore || 0)) +
      Math.abs(Math.round(input.condition.hoursBefore || 0)) * 60;
    if (
      minutes == null ||
      !Number.isFinite(minutes) ||
      !fp ||
      threshold <= 0
    ) {
      return { skipSend: true };
    }
    if (minutes > threshold) {
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

  if (input.condition.type === "flight_changed") {
    const fp = String(input.facts.flightChangedFingerprint ?? "").trim();
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

  if (input.condition.type === "expr") {
    const values = input.facts.exprFieldValues ?? {};
    const left = evalWatchExprNode(input.condition.left, values);
    const right = evalWatchExprNode(input.condition.right, values);
    if (left == null || right == null) {
      return { skipSend: true };
    }
    const holding = compareWatchExpr(
      left,
      input.condition.compare,
      right,
      input.condition.tol ?? 0.5,
    );
    const prevHolding = last === "expr:hold";
    const immediateSha = holding ? "expr:hold" : "expr:idle";
    const shouldSend = shouldSendHolding(
      holding,
      prevHolding,
      alertWhileHolding,
    );
    return {
      skipSend: !shouldSend,
      immediateSha,
    };
  }

  if (input.condition.type === "field_changed") {
    const values = input.facts.exprFieldValues ?? {};
    const key = watchFieldKey({
      field: input.condition.field,
      place: input.condition.place,
      symbol: input.condition.symbol,
      dayOffset: input.condition.dayOffset,
    });
    const current = values[key];
    if (current == null || !Number.isFinite(current)) {
      return { skipSend: true };
    }
    const encoded = encodeFieldValueSha(current);
    if (!last) {
      // No baseline yet — treat as unchanged until seeded; skip send.
      return { skipSend: true, immediateSha: encoded };
    }
    if (encoded === last) {
      return { skipSend: true, immediateSha: encoded };
    }
    return {
      skipSend: false,
      shaAfterSend: encoded,
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

/**
 * Baseline sha to stamp on watch create (current state, no WhatsApp).
 * Fingerprint watches: current fp. Edge watches: current holding token.
 */
export function baselineShaForWatch(input: {
  condition: LlmComposeCondition;
  facts: ComposeEvalFacts;
}): string | null {
  const gate = evaluateComposeCondition({
    condition: input.condition,
    facts: input.facts,
    lastReportSha: "",
  });
  if (gate.immediateSha) {
    return gate.immediateSha;
  }
  if (input.condition.type === "weather_changed") {
    const fp = String(input.facts.weatherFingerprint ?? "").trim();
    return fp || null;
  }
  if (input.condition.type === "mashov_new") {
    const fp = String(input.facts.mashovFingerprint ?? "").trim();
    return fp || null;
  }
  if (input.condition.type === "smartschool_new") {
    const fp = String(input.facts.smartschoolFingerprint ?? "").trim();
    return fp || null;
  }
  if (input.condition.type === "bus_eta") {
    const fp = String(input.facts.busEtaFingerprint ?? "").trim();
    return fp || null;
  }
  if (input.condition.type === "flight_eta") {
    const fp = String(input.facts.flightEtaFingerprint ?? "").trim();
    return fp || null;
  }
  if (input.condition.type === "flight_changed") {
    const fp = String(input.facts.flightChangedFingerprint ?? "").trim();
    return fp || null;
  }
  if (input.condition.type === "expr") {
    // Prefer idle/hold from evaluate with empty last (immediateSha).
    return gate.immediateSha ?? null;
  }
  if (input.condition.type === "field_changed") {
    const values = input.facts.exprFieldValues ?? {};
    const key = watchFieldKey({
      field: input.condition.field,
      place: input.condition.place,
      symbol: input.condition.symbol,
      dayOffset: input.condition.dayOffset,
    });
    const current = values[key];
    if (current == null || !Number.isFinite(current)) {
      return null;
    }
    return encodeFieldValueSha(current);
  }
  return null;
}
