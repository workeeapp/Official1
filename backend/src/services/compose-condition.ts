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
  /** Minutes until sports kickoff. */
  sportsMatchEtaMinutes?: number | null;
  /** Fingerprint of sports match (matchId+kickoff) for dedupe. */
  sportsMatchFingerprint?: string;
  /** Resolved catalog field values for expr / field_changed. */
  exprFieldValues?: Record<string, number | null>;
  /** UWM Phase 3–5 gate payload from pollWebMonitor. */
  webMonitor?: {
    shouldNotify: boolean;
    fingerprint: string;
    bodyHe?: string;
    reason?: string;
    /** Phase 5 Apply gate */
    evidenceGrade?: "unverified" | "observed" | "corroborated" | "disputed";
    evidenceMin?: "observed" | "corroborated";
    retrievedAt?: string;
    itemId?: string;
    phase?: string;
    stale?: boolean;
    fresh?: boolean;
  };
};

export type ComposeConditionFireGate = {
  /** When true, skip WhatsApp (clock still advances via settle). */
  skipSend: boolean;
  /** Write to lastReportSha immediately (market edge state), even on skip. */
  immediateSha?: string;
  /** Write to lastReportSha only after a successful WhatsApp send (mashov/weather). */
  shaAfterSend?: string;
};

export type MarketPriceOp = "lt" | "lte" | "gt" | "gte" | "eq";

/** Absolute tolerance for "price is X" near-equality (not float bit-equality). */
export const MARKET_PRICE_EQ_EPS = 1e-6;

export function comparePrice(
  price: number,
  op: MarketPriceOp,
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
      return Math.abs(price - value) <= MARKET_PRICE_EQ_EPS;
    default:
      return false;
  }
}

/**
 * Intent from ACTION op only (not user utterance).
 * - eq → target arrival ("when price is/reaches X"); engine picks lte/gte from live quote.
 * - directional → explicit condition; preserve op (and caller's watch_once/recurrence).
 */
export type MarketPriceIntent = "target_arrival" | "explicit";

export function classifyMarketPriceIntent(op: MarketPriceOp): MarketPriceIntent {
  return op === "eq" ? "target_arrival" : "explicit";
}

export type NormalizeMarketPriceResult = {
  condition: Extract<LlmComposeCondition, { type: "market_price" }>;
  intent: MarketPriceIntent;
  changed: boolean;
  /** True when live price already satisfies the (possibly rewritten) op. */
  alreadyHolding: boolean;
};

/**
 * Normalize market_price against a live quote at create/update.
 *
 * Rules (documented):
 * 1. target_arrival (op eq): live > value → lte; live < value → gte;
 *    near-equal → lte (reach semantics) + alreadyHolding.
 * 2. explicit (lt|lte|gt|gte): always preserve op — never rewrite from live
 *    price (level vs edge stays on watch_once / recurrence).
 */
export function normalizeMarketPriceForLiveQuote(input: {
  condition: Extract<LlmComposeCondition, { type: "market_price" }>;
  livePrice: number;
  /** Kept for callers; does not rewrite explicit ops. */
  alertWhileHolding?: boolean;
}): NormalizeMarketPriceResult {
  const live = input.livePrice;
  const value = input.condition.value;
  const intent = classifyMarketPriceIntent(input.condition.op);

  if (!Number.isFinite(live) || !Number.isFinite(value)) {
    return {
      condition: input.condition,
      intent,
      changed: false,
      alreadyHolding: false,
    };
  }

  if (intent === "target_arrival") {
    let op: MarketPriceOp;
    if (Math.abs(live - value) <= MARKET_PRICE_EQ_EPS) {
      op = "lte";
    } else if (live > value) {
      op = "lte";
    } else {
      op = "gte";
    }
    const next = {
      type: "market_price" as const,
      op: op as "lt" | "lte" | "gt" | "gte" | "eq",
      value,
    };
    return {
      condition: next,
      intent,
      changed: true,
      alreadyHolding: comparePrice(live, op, value),
    };
  }

  // Explicit directional op — preserve.
  void input.alertWhileHolding;
  return {
    condition: input.condition,
    intent,
    changed: false,
    alreadyHolding: comparePrice(live, input.condition.op, value),
  };
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

  if (input.condition.type === "sports_match") {
    const minutes = input.facts.sportsMatchEtaMinutes;
    const fp = String(input.facts.sportsMatchFingerprint ?? "").trim();
    const threshold = Math.abs(Math.round(input.condition.minutesBefore || 0));
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
      shaAfterSend: fp.slice(0, 64),
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

  // UWM Phase 3+: gate from pollWebMonitor facts (fail-closed when missing).
  if (input.condition.type === "web_monitor") {
    const wm = input.facts.webMonitor;
    if (!wm || !wm.shouldNotify || !wm.fingerprint) {
      return { skipSend: true };
    }
    const fp = String(wm.fingerprint).slice(0, 64);
    if (fp && fp === last) {
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

/**
 * Baseline sha to stamp on watch create (current state, no WhatsApp).
 * Fingerprint watches: current fp. Edge watches: current holding token.
 *
 * Threshold / ETA watches (`bus_eta`, `flight_eta`, `sports_match`, and any
 * future “notify when within N minutes of event X” condition) use a **stable
 * event identity** as fingerprint. Stamping that identity while still outside
 * the window would permanently suppress the first notify (`fp === last`).
 * For those types, baseline only when evaluate(empty last) already yields
 * `shaAfterSend` (already inside the window → suppress create-time fire).
 * Outside the window → null so the first entry into the window can notify.
 *
 * State-delta watches (`flight_changed`, `weather_changed`, …) still stamp the
 * current fingerprint so “current state” is not treated as new on first poll.
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
  // Threshold/ETA family — see docstring above.
  if (
    input.condition.type === "bus_eta" ||
    input.condition.type === "flight_eta" ||
    input.condition.type === "sports_match"
  ) {
    const sha = String(gate.shaAfterSend ?? "").trim();
    return sha ? sha.slice(0, 64) : null;
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
  if (input.condition.type === "web_monitor") {
    return null;
  }
  return null;
}
