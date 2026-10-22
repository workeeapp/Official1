import { describe, expect, it, vi } from "vitest";
import {
  fetchMarketFacts,
  formatMarketHebrew,
  parseMarketAspects,
  parseMarketQueries,
  resolveMarketReply,
  resolveSymbol,
  type MarketFacts,
} from "../src/services/market.js";

describe("parseMarketQueries / aspects", () => {
  it("aliases דולר / יורו to ILS FX tickers", async () => {
    expect(await resolveSymbol("דולר")).toEqual({
      symbol: "USDILS=X",
      name: "דולר",
    });
    expect(await resolveSymbol("יורו")).toEqual({
      symbol: "EURILS=X",
      name: "יורו",
    });
  });

  it("splits comma-separated compose_place", () => {
    expect(parseMarketQueries("AAPL, BTC-USD")).toEqual(["AAPL", "BTC-USD"]);
  });

  it("keeps array queries capped at 5", () => {
    expect(parseMarketQueries(["a", "b", "c", "d", "e", "f"])).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("defaults aspects to summary", () => {
    expect(parseMarketAspects(undefined)).toEqual(["summary"]);
    expect(parseMarketAspects(["change", "nope"])).toEqual(["change"]);
  });
});

describe("formatMarketHebrew", () => {
  const facts: MarketFacts = {
    aspects: ["summary"],
    missing: [],
    quotes: [
      {
        symbol: "AAPL",
        name: "Apple Inc.",
        price: 190.5,
        changePct: 1.25,
        changeAbs: 2.35,
        dayHigh: 191,
        dayLow: 188,
        currency: "USD",
        query: "AAPL",
      },
    ],
  };

  it("formats summary with disclaimer", () => {
    const text = formatMarketHebrew(facts);
    expect(text).toContain("AAPL");
    expect(text).toContain("190.50");
    expect(text).toContain("+1.25%");
    expect(text).toContain("לא ייעוץ השקעות");
  });

  it("formats change-only", () => {
    const text = formatMarketHebrew({
      ...facts,
      aspects: ["change"],
    });
    expect(text).toMatch(/\+1\.25%/);
  });

  it("lists missing queries", () => {
    const text = formatMarketHebrew({
      quotes: [],
      aspects: ["summary"],
      missing: ["ZZZ"],
    });
    expect(text).toContain("ZZZ");
  });
});

describe("fetchMarketFacts / resolveMarketReply", () => {
  it("resolves alias and chart JSON", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes("/chart/")) {
        return {
          ok: true,
          json: async () => ({
            chart: {
              result: [
                {
                  meta: {
                    symbol: "BTC-USD",
                    shortName: "Bitcoin USD",
                    regularMarketPrice: 65000.12,
                    chartPreviousClose: 64000,
                    regularMarketDayHigh: 65500,
                    regularMarketDayLow: 64500,
                    currency: "USD",
                  },
                },
              ],
            },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ quotes: [] }),
      } as Response;
    });

    const facts = await fetchMarketFacts({
      queries: ["ביטקוין"],
      aspects: ["summary"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(facts.quotes[0]?.symbol).toBe("BTC-USD");
    expect(facts.quotes[0]?.price).toBeCloseTo(65000.12, 2);

    const reply = await resolveMarketReply({
      queries: ["ביטקוין"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply).toContain("BTC-USD");
    expect(reply).toContain("לא ייעוץ השקעות");
  });

  it("asks when queries empty", async () => {
    const reply = await resolveMarketReply({ queries: [] });
    expect(reply).toContain("לאיזה");
  });

  it("reports missing when chart empty", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ chart: { result: [] } }),
    })) as unknown as typeof fetch;

    const reply = await resolveMarketReply({
      queries: ["NOTREALTICKERXYZ"],
      fetchImpl,
    });
    expect(reply).toContain("לא מצאתי");
  });
});
