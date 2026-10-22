import type {
  LlmComposeCondition,
  WatchExprCompare,
  WatchExprNode,
  WatchExprOp,
} from "@workee/shared";
import {
  fetchMarketFacts,
  fetchQuote,
  formatMarketHebrew,
  parseMarketQueries,
} from "./market.js";
import {
  fetchWeatherFacts,
  formatWeatherHebrew,
} from "./weather.js";
import { formatSessionClockContext } from "../utils/relative-date.js";

/** Minimal facts shape (avoids circular import with compose-condition). */
type ExprEvalFacts = {
  exprFieldValues?: Record<string, number | null>;
  [key: string]: unknown;
};

type ExprFactsBundle = {
  facts: string;
  factsLabel: string;
  fixedBody?: string;
  sessionClock?: string;
  [key: string]: unknown;
};

export type WatchFieldRef = {
  field: string;
  place?: string;
  symbol?: string;
  dayOffset?: number;
};

/** Stable map key for a field leaf. */
export function watchFieldKey(ref: WatchFieldRef): string {
  const place = (ref.place ?? "").trim().toLowerCase();
  const symbol = (ref.symbol ?? "").trim().toLowerCase();
  const day =
    typeof ref.dayOffset === "number" && Number.isFinite(ref.dayOffset)
      ? String(Math.round(ref.dayOffset))
      : "0";
  return `${ref.field}|${place}|${symbol}|${day}`;
}

/** Collect all field leaves from an expr node. */
export function collectWatchFieldRefs(node: WatchExprNode): WatchFieldRef[] {
  if ("const" in node) {
    return [];
  }
  if ("field" in node) {
    return [
      {
        field: node.field,
        ...(node.place ? { place: node.place } : {}),
        ...(node.symbol ? { symbol: node.symbol } : {}),
        ...(node.dayOffset != null ? { dayOffset: node.dayOffset } : {}),
      },
    ];
  }
  if ("op" in node && Array.isArray(node.args)) {
    return node.args.flatMap(collectWatchFieldRefs);
  }
  return [];
}

/** Field refs needed to evaluate a compose_condition (expr / field_changed). */
export function collectConditionFieldRefs(
  condition: LlmComposeCondition,
): WatchFieldRef[] {
  if (condition.type === "expr") {
    return [
      ...collectWatchFieldRefs(condition.left),
      ...collectWatchFieldRefs(condition.right),
    ];
  }
  if (condition.type === "field_changed") {
    return [
      {
        field: condition.field,
        ...(condition.place ? { place: condition.place } : {}),
        ...(condition.symbol ? { symbol: condition.symbol } : {}),
        ...(condition.dayOffset != null
          ? { dayOffset: condition.dayOffset }
          : {}),
      },
    ];
  }
  return [];
}

export function sourcesNeededForRefs(refs: WatchFieldRef[]): {
  weather: boolean;
  market: boolean;
} {
  let weather = false;
  let market = false;
  for (const ref of refs) {
    if (ref.field.startsWith("weather.")) {
      weather = true;
    }
    if (ref.field.startsWith("market.")) {
      market = true;
    }
  }
  return { weather, market };
}

async function resolveOneField(
  ref: WatchFieldRef,
  now: Date,
  fetchImpl: typeof fetch,
): Promise<number | null> {
  if (ref.field.startsWith("weather.")) {
    const place = (ref.place ?? "").trim();
    if (!place) {
      return null;
    }
    const weather = await fetchWeatherFacts({
      place,
      aspects: ["temp", "summary"],
      now,
      fetchImpl,
    });
    if (!weather) {
      return null;
    }
    const dayOffset =
      typeof ref.dayOffset === "number" && Number.isFinite(ref.dayOffset)
        ? Math.max(0, Math.round(ref.dayOffset))
        : 0;
    const day = weather.days[dayOffset] ?? weather.days[0];
    if (!day) {
      return null;
    }
    if (ref.field === "weather.temp_now") {
      return day.tempNowC;
    }
    if (ref.field === "weather.temp_max") {
      return day.tempMaxC;
    }
    if (ref.field === "weather.temp_min") {
      return day.tempMinC;
    }
    if (ref.field === "weather.is_rain") {
      return day.isRain ? 1 : 0;
    }
    return null;
  }
  if (ref.field.startsWith("market.")) {
    const symbol = (ref.symbol ?? "").trim();
    if (!symbol) {
      return null;
    }
    const quote = await fetchQuote(symbol, fetchImpl);
    if (!quote) {
      return null;
    }
    if (ref.field === "market.price") {
      return quote.price;
    }
    if (ref.field === "market.change_pct") {
      return quote.changePct;
    }
    if (ref.field === "market.change_abs") {
      return quote.changeAbs;
    }
    return null;
  }
  return null;
}

/** Resolve all unique field refs to numbers (null when unavailable). */
export async function resolveWatchFieldValues(
  refs: WatchFieldRef[],
  input?: { now?: Date; fetchImpl?: typeof fetch },
): Promise<Record<string, number | null>> {
  const now = input?.now ?? new Date();
  const fetchImpl = input?.fetchImpl ?? fetch;
  const out: Record<string, number | null> = {};
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = watchFieldKey(ref);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    try {
      out[key] = await resolveOneField(ref, now, fetchImpl);
    } catch {
      out[key] = null;
    }
  }
  return out;
}

function applyOp(op: WatchExprOp, values: number[]): number | null {
  if (values.length < 2 || values.some((n) => !Number.isFinite(n))) {
    return null;
  }
  switch (op) {
    case "add":
      return values.reduce((a, b) => a + b, 0);
    case "sub": {
      let acc = values[0]!;
      for (let i = 1; i < values.length; i++) {
        acc -= values[i]!;
      }
      return acc;
    }
    case "mul":
      return values.reduce((a, b) => a * b, 1);
    case "div": {
      let acc = values[0]!;
      for (let i = 1; i < values.length; i++) {
        const d = values[i]!;
        if (d === 0) {
          return null;
        }
        acc /= d;
      }
      return acc;
    }
    case "pct": {
      const a = values[0]!;
      const b = values[1]!;
      if (b === 0) {
        return null;
      }
      return (100 * a) / b;
    }
    default:
      return null;
  }
}

/** Evaluate an AST node against a resolved field map. */
export function evalWatchExprNode(
  node: WatchExprNode,
  values: Record<string, number | null>,
): number | null {
  if ("const" in node) {
    return Number.isFinite(node.const) ? node.const : null;
  }
  if ("field" in node) {
    const key = watchFieldKey({
      field: node.field,
      place: node.place,
      symbol: node.symbol,
      dayOffset: node.dayOffset,
    });
    const v = values[key];
    return v != null && Number.isFinite(v) ? v : null;
  }
  if ("op" in node && Array.isArray(node.args)) {
    const args = node.args.map((arg) => evalWatchExprNode(arg, values));
    if (args.some((n) => n == null)) {
      return null;
    }
    return applyOp(node.op, args as number[]);
  }
  return null;
}

export function compareWatchExpr(
  left: number,
  compare: WatchExprCompare,
  right: number,
  tol = 0.5,
): boolean {
  switch (compare) {
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "eq":
      return Math.abs(left - right) < 1e-9;
    case "approx":
      return Math.abs(left - right) <= Math.max(0, tol);
    default:
      return false;
  }
}

/** Encode a numeric baseline for field_changed (fits last_report_sha). */
export function encodeFieldValueSha(value: number): string {
  const text = `n:${value}`;
  return text.length <= 64 ? text : `n:${value.toPrecision(12)}`.slice(0, 64);
}

export function decodeFieldValueSha(sha: string): number | null {
  const raw = String(sha ?? "").trim();
  if (!raw.startsWith("n:")) {
    return null;
  }
  const n = Number(raw.slice(2));
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve expr/field_changed catalog fields into evalFacts, and merge extra
 * weather/market FACTS into the compose bundle when the AST needs them.
 */
export async function enrichEvalFactsForExpr<
  TEval extends ExprEvalFacts,
  TBundle extends ExprFactsBundle,
>(input: {
  condition: LlmComposeCondition;
  evalFacts: TEval;
  factsBundle: TBundle;
  composeSource: string;
  composePlace: string;
  now: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ evalFacts: TEval; factsBundle: TBundle }> {
  if (
    input.condition.type !== "expr" &&
    input.condition.type !== "field_changed"
  ) {
    return { evalFacts: input.evalFacts, factsBundle: input.factsBundle };
  }
  const refs = collectConditionFieldRefs(input.condition);
  const values = await resolveWatchFieldValues(refs, {
    now: input.now,
    fetchImpl: input.fetchImpl,
  });
  const evalFacts = {
    ...input.evalFacts,
    exprFieldValues: {
      ...(input.evalFacts.exprFieldValues ?? {}),
      ...values,
    },
  } as TEval;

  const needed = sourcesNeededForRefs(refs);
  const source = input.composeSource.trim();
  const extraBlocks: string[] = [];
  const fetchImpl = input.fetchImpl ?? fetch;

  if (needed.weather && source !== "weather") {
    const place =
      refs.find((r) => r.field.startsWith("weather.") && r.place)?.place ||
      input.composePlace.trim();
    if (place) {
      try {
        const weather = await fetchWeatherFacts({
          place,
          aspects: ["temp", "summary"],
          now: input.now,
          fetchImpl,
        });
        if (weather) {
          extraBlocks.push(formatWeatherHebrew(weather, input.now));
        }
      } catch {
        // ignore — eval still has field values when resolvable
      }
    }
  }
  if (needed.market && source !== "market") {
    const symbols = [
      ...new Set(
        refs
          .filter((r) => r.field.startsWith("market.") && r.symbol)
          .map((r) => String(r.symbol).trim())
          .filter(Boolean),
      ),
    ];
    const queries =
      symbols.length > 0
        ? symbols
        : parseMarketQueries(input.composePlace);
    if (queries.length > 0) {
      try {
        const facts = await fetchMarketFacts({
          queries,
          aspects: ["summary"],
          fetchImpl,
        });
        extraBlocks.push(formatMarketHebrew(facts));
      } catch {
        // ignore
      }
    }
  }

  if (extraBlocks.length === 0) {
    return { evalFacts, factsBundle: input.factsBundle };
  }
  const mergedFacts = [input.factsBundle.facts, ...extraBlocks]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
  return {
    evalFacts,
    factsBundle: {
      ...input.factsBundle,
      facts: mergedFacts,
      fixedBody: mergedFacts || input.factsBundle.fixedBody,
      sessionClock:
        input.factsBundle.sessionClock ??
        formatSessionClockContext(input.now),
      factsLabel: input.factsBundle.factsLabel || "Watch facts",
    } as TBundle,
  };
}
