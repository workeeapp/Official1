export type MarketAspect = "summary" | "price" | "change" | "range";

export type MarketQuote = {
  symbol: string;
  name: string;
  price: number | null;
  changePct: number | null;
  changeAbs: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  currency: string;
  query: string;
};

export type MarketFacts = {
  quotes: MarketQuote[];
  aspects: MarketAspect[];
  missing: string[];
};

const SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search";
const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

const ASPECT_SET = new Set<MarketAspect>([
  "summary",
  "price",
  "change",
  "range",
]);

const MARKET_DISCLAIMER = "לא ייעוץ השקעות.";

const YAHOO_HEADERS: HeadersInit = {
  "User-Agent": "Mozilla/5.0 (compatible; Workee/1.0)",
  Accept: "application/json",
};

/** Common Hebrew / aliases → Yahoo symbol (model often emits these). */
const ALIAS_SYMBOLS: Record<string, string> = {
  ביטקוין: "BTC-USD",
  bitcoin: "BTC-USD",
  btc: "BTC-USD",
  אתריום: "ETH-USD",
  ethereum: "ETH-USD",
  eth: "ETH-USD",
  סולנה: "SOL-USD",
  solana: "SOL-USD",
  אפל: "AAPL",
  apple: "AAPL",
  נווידיה: "NVDA",
  nvidia: "NVDA",
  טבע: "TEVA",
  teva: "TEVA",
  "s&p": "^GSPC",
  "s&p500": "^GSPC",
  sp500: "^GSPC",
  "s&p 500": "^GSPC",
  /** ILS FX (שער הדולר / היורו). */
  דולר: "USDILS=X",
  dollar: "USDILS=X",
  usd: "USDILS=X",
  "שער הדולר": "USDILS=X",
  יורו: "EURILS=X",
  euro: "EURILS=X",
  eur: "EURILS=X",
  "שער היורו": "EURILS=X",
};

export function parseMarketAspects(raw: unknown): MarketAspect[] {
  if (!Array.isArray(raw)) {
    return ["summary"];
  }
  const out: MarketAspect[] = [];
  for (const entry of raw) {
    const key = String(entry ?? "")
      .trim()
      .toLowerCase() as MarketAspect;
    if (ASPECT_SET.has(key) && !out.includes(key)) {
      out.push(key);
    }
  }
  return out.length > 0 ? out : ["summary"];
}

/** Split compose_place / free text into up to 5 query strings. */
export function parseMarketQueries(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean)
      .slice(0, 5);
  }
  const text = String(raw ?? "").trim();
  if (!text) {
    return [];
  }
  return text
    .split(/[,;|]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function looksLikeTicker(q: string): boolean {
  // AAPL, BTC-USD, ^GSPC, TEVA.TA, BRK-B
  return /^[\^]?[A-Za-z0-9][A-Za-z0-9._^=-]{0,14}$/.test(q.trim());
}

function aliasSymbol(query: string): string | null {
  const key = query.trim().toLowerCase();
  return ALIAS_SYMBOLS[key] ?? null;
}

type SearchResponse = {
  quotes?: Array<{
    symbol?: string;
    shortname?: string;
    longname?: string;
    quoteType?: string;
    exchDisp?: string;
  }>;
};

type ChartResponse = {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string;
        shortName?: string;
        longName?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketDayHigh?: number;
        regularMarketDayLow?: number;
        currency?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: Array<number | null>;
        }>;
      };
    }>;
    error?: { description?: string } | null;
  };
};

export async function resolveSymbol(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ symbol: string; name: string } | null> {
  const q = query.trim();
  if (!q) {
    return null;
  }
  const aliased = aliasSymbol(q);
  if (aliased) {
    return { symbol: aliased, name: q };
  }
  if (looksLikeTicker(q)) {
    return { symbol: q.toUpperCase(), name: q };
  }

  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("quotesCount", "5");
  url.searchParams.set("newsCount", "0");
  const res = await fetchImpl(url.toString(), { headers: YAHOO_HEADERS });
  if (!res.ok) {
    throw new Error(`market search HTTP ${res.status}`);
  }
  const body = (await res.json()) as SearchResponse;
  const rows = body.quotes ?? [];
  const preferred =
    rows.find((row) =>
      ["EQUITY", "CRYPTOCURRENCY", "INDEX", "ETF"].includes(
        String(row.quoteType ?? "").toUpperCase(),
      ),
    ) ?? rows[0];
  const symbol = preferred?.symbol?.trim();
  if (!symbol) {
    return null;
  }
  const name =
    preferred.longname?.trim() ||
    preferred.shortname?.trim() ||
    symbol;
  return { symbol, name };
}

function roundMoney(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return null;
  }
  if (Math.abs(n) >= 1000) {
    return Math.round(n * 100) / 100;
  }
  if (Math.abs(n) >= 1) {
    return Math.round(n * 100) / 100;
  }
  return Math.round(n * 1_000_000) / 1_000_000;
}

export async function fetchQuote(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MarketQuote | null> {
  const resolved = await resolveSymbol(query, fetchImpl);
  if (!resolved) {
    return null;
  }
  const url = `${CHART_URL}/${encodeURIComponent(resolved.symbol)}?interval=1d&range=1d`;
  const res = await fetchImpl(url, { headers: YAHOO_HEADERS });
  if (!res.ok) {
    throw new Error(`market chart HTTP ${res.status}`);
  }
  const body = (await res.json()) as ChartResponse;
  const meta = body.chart?.result?.[0]?.meta;
  if (!meta) {
    return null;
  }
  const price = roundMoney(meta.regularMarketPrice);
  const prev = roundMoney(meta.chartPreviousClose ?? meta.previousClose);
  let changeAbs: number | null = null;
  let changePct: number | null = null;
  if (price !== null && prev !== null && prev !== 0) {
    changeAbs = roundMoney(price - prev);
    changePct = roundMoney(((price - prev) / prev) * 100);
  }
  return {
    symbol: meta.symbol?.trim() || resolved.symbol,
    name: meta.longName?.trim() || meta.shortName?.trim() || resolved.name,
    price,
    changePct,
    changeAbs,
    dayHigh: roundMoney(meta.regularMarketDayHigh),
    dayLow: roundMoney(meta.regularMarketDayLow),
    currency: meta.currency?.trim() || "USD",
    query,
  };
}

/**
 * Daily percent change for a ticker.
 * dayOffset 0 = today's change vs previous close (same as quote.changePct).
 * dayOffset -1 = previous trading day's close vs the day before that.
 */
export async function fetchDailyChangePct(
  query: string,
  dayOffset = 0,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  const resolved = await resolveSymbol(query, fetchImpl);
  if (!resolved) {
    return null;
  }
  if (dayOffset === 0) {
    const quote = await fetchQuote(query, fetchImpl);
    return quote?.changePct ?? null;
  }
  const rangeDays = Math.min(30, Math.max(5, Math.abs(dayOffset) + 5));
  const url = `${CHART_URL}/${encodeURIComponent(resolved.symbol)}?interval=1d&range=${rangeDays}d`;
  const res = await fetchImpl(url, { headers: YAHOO_HEADERS });
  if (!res.ok) {
    throw new Error(`market chart HTTP ${res.status}`);
  }
  const body = (await res.json()) as ChartResponse;
  const closes = (body.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [])
    .map((n) => (typeof n === "number" && Number.isFinite(n) ? n : null))
    .filter((n): n is number => n != null && n !== 0);
  // closes[end] = most recent; for offset -1 use closes[end-1] vs closes[end-2]
  const end = closes.length - 1;
  const newerIdx = end + dayOffset;
  const olderIdx = newerIdx - 1;
  if (newerIdx < 1 || olderIdx < 0 || newerIdx >= closes.length) {
    return null;
  }
  const newer = closes[newerIdx];
  const older = closes[olderIdx];
  if (!newer || !older) {
    return null;
  }
  return roundMoney(((newer - older) / older) * 100);
}

export async function fetchMarketFacts(input: {
  queries: string[] | unknown;
  aspects?: MarketAspect[] | unknown;
  fetchImpl?: typeof fetch;
}): Promise<MarketFacts> {
  const queries = parseMarketQueries(input.queries);
  const aspects = parseMarketAspects(input.aspects);
  const fetchImpl = input.fetchImpl ?? fetch;
  const quotes: MarketQuote[] = [];
  const missing: string[] = [];
  for (const query of queries) {
    try {
      const quote = await fetchQuote(query, fetchImpl);
      if (quote) {
        quotes.push(quote);
      } else {
        missing.push(query);
      }
    } catch {
      missing.push(query);
    }
  }
  return { quotes, aspects, missing };
}

function fmtPrice(n: number | null, currency: string): string | null {
  if (n === null) {
    return null;
  }
  const text =
    Math.abs(n) >= 1
      ? n.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : n.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 6,
        });
  return `${text} ${currency}`;
}

function fmtPct(n: number | null): string | null {
  if (n === null) {
    return null;
  }
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function wants(aspects: MarketAspect[], key: MarketAspect): boolean {
  if (aspects.includes("summary")) {
    return true;
  }
  return aspects.includes(key);
}

function formatOneQuote(quote: MarketQuote, aspects: MarketAspect[]): string {
  const label = quote.name && quote.name !== quote.symbol
    ? `${quote.name} (${quote.symbol})`
    : quote.symbol;
  const priceOnly =
    aspects.includes("price") &&
    !aspects.includes("summary") &&
    aspects.length === 1;
  const changeOnly =
    aspects.includes("change") &&
    !aspects.includes("summary") &&
    aspects.length === 1;
  const rangeOnly =
    aspects.includes("range") &&
    !aspects.includes("summary") &&
    aspects.length === 1;

  if (priceOnly) {
    const p = fmtPrice(quote.price, quote.currency);
    return p
      ? `${label}: ${p}.`
      : `${label}: אין מחיר זמין.`;
  }
  if (changeOnly) {
    const pct = fmtPct(quote.changePct);
    const abs = fmtPrice(quote.changeAbs, quote.currency);
    if (pct && abs) {
      return `${label}: ${pct} (${abs}).`;
    }
    if (pct) {
      return `${label}: ${pct}.`;
    }
    return `${label}: אין נתון שינוי זמין.`;
  }
  if (rangeOnly) {
    const hi = fmtPrice(quote.dayHigh, quote.currency);
    const lo = fmtPrice(quote.dayLow, quote.currency);
    if (hi && lo) {
      return `${label}: טווח יומי ${lo}–${hi}.`;
    }
    return `${label}: אין טווח יומי זמין.`;
  }

  const parts: string[] = [`${label}:`];
  if (wants(aspects, "price")) {
    const p = fmtPrice(quote.price, quote.currency);
    if (p) {
      parts.push(p);
    }
  }
  if (wants(aspects, "change")) {
    const pct = fmtPct(quote.changePct);
    if (pct) {
      parts.push(`שינוי ${pct}`);
    }
  }
  if (wants(aspects, "range")) {
    const hi = fmtPrice(quote.dayHigh, quote.currency);
    const lo = fmtPrice(quote.dayLow, quote.currency);
    if (hi && lo) {
      parts.push(`טווח ${lo}–${hi}`);
    }
  }
  return `${parts.join(" — ")}.`;
}

/** Deterministic Hebrew reply from quotes (engine replaces model response). */
export function formatMarketHebrew(facts: MarketFacts): string {
  const lines: string[] = [];
  for (const quote of facts.quotes) {
    lines.push(formatOneQuote(quote, facts.aspects));
  }
  for (const miss of facts.missing) {
    lines.push(`לא מצאתי ציטוט עבור «${miss}».`);
  }
  if (lines.length === 0) {
    return `לא מצאתי נתוני שוק. ${MARKET_DISCLAIMER}`;
  }
  return `${lines.join("\n")}\n${MARKET_DISCLAIMER}`;
}

export async function resolveMarketReply(input: {
  queries: string[] | unknown;
  aspects?: MarketAspect[] | unknown;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const queries = parseMarketQueries(input.queries);
  if (queries.length === 0) {
    return "לאיזה מניה, מדד או מטבע קריפטו לבדוק?";
  }
  try {
    const facts = await fetchMarketFacts(input);
    return formatMarketHebrew(facts);
  } catch {
    return "לא הצלחתי לשלוף עכשיו נתוני שוק. נסה שוב בעוד רגע.";
  }
}
