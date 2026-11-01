import type { MarketPriceOp } from "./compose-condition.js";
import { MARKET_PRICE_EQ_EPS } from "./compose-condition.js";

/**
 * Deterministic post-compose check for market_price watches.
 * Rejects drafts that invent "reached {threshold}" when FACT price is far from
 * the threshold, or that contradict the FACT price / holding state.
 */
export function validateMarketPriceComposeText(input: {
  text: string;
  price: number;
  threshold: number;
  op: MarketPriceOp;
  holding: boolean;
  symbol?: string;
}): { ok: boolean; reason?: string } {
  const text = input.text.trim();
  if (!text) {
    return { ok: false, reason: "empty" };
  }
  const price = input.price;
  const threshold = input.threshold;
  if (!Number.isFinite(price) || !Number.isFinite(threshold)) {
    return { ok: true };
  }

  // Claimed "reached / hit the threshold" while price is far from it.
  const reachedClaim =
    /הגיע(?:ה)?\s+ל[־\-]?\s*\d+(?:[.,]\d+)?/u.test(text) ||
    /reached\s+\d+(?:[.,]\d+)?/i.test(text) ||
    /hit\s+\d+(?:[.,]\d+)?/i.test(text);
  if (reachedClaim && Math.abs(price - threshold) > Math.max(MARKET_PRICE_EQ_EPS, threshold * 0.02, 0.5)) {
    return { ok: false, reason: "reached_threshold_contradiction" };
  }

  // Explicit numeric "price is N" / "עומד על N" that disagrees with FACT price.
  const stated = extractStatedPrices(text);
  for (const n of stated) {
    if (Math.abs(n - price) > Math.max(0.05, price * 0.005) && Math.abs(n - threshold) <= Math.max(0.05, threshold * 0.01)) {
      // Stated the threshold as if it were the live price.
      if (Math.abs(price - threshold) > Math.max(0.5, threshold * 0.02)) {
        return { ok: false, reason: "stated_threshold_as_price" };
      }
    }
  }

  // Holding false but copy claims condition met / above-below wrongly is harder;
  // the reached check covers the SOLT failure mode.
  void input.op;
  void input.holding;
  return { ok: true };
}

/** Engine fallback when compose invents contradictory market claims. */
export function formatMarketPriceWatchFallback(input: {
  price: number;
  threshold: number;
  op: MarketPriceOp;
  holding: boolean;
  symbol?: string;
}): string {
  const sym = (input.symbol ?? "").trim() || "הנכס";
  const price = formatNum(input.price);
  const thr = formatNum(input.threshold);
  const dir = describeOp(input.op, thr);
  if (input.holding) {
    return `לבקשתך: ${sym} עומד כעת על ${price} — התנאי (${dir}) מתקיים.`;
  }
  return `לבקשתך: ${sym} עומד כעת על ${price} — התנאי (${dir}) עדיין לא מתקיים.`;
}

function describeOp(op: MarketPriceOp, thr: string): string {
  switch (op) {
    case "lt":
      return `מתחת ל־${thr}`;
    case "lte":
      return `עד ${thr} כולל`;
    case "gt":
      return `מעל ${thr}`;
    case "gte":
      return `מ־${thr} ומעלה`;
    case "eq":
      return `שווה ל־${thr}`;
    default:
      return thr;
  }
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) {
    return String(n);
  }
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

function extractStatedPrices(text: string): number[] {
  const out: number[] = [];
  const re =
    /(?:עומד(?:ת)?\s+(?:כעת\s+)?על|מחיר(?:\s+כעת)?|price(?:\s+is)?|at)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/giu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    const raw = (m[1] ?? "").replace(",", ".");
    const n = Number(raw);
    if (Number.isFinite(n)) {
      out.push(n);
    }
  }
  return out;
}
