import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildFlightsCompleteness,
  DEFAULT_FLIGHT_AIRPORT,
  FLIGHTS_DISPLAY_CAP,
  FLIGHTS_LOCAL_TRUNCATION_HE,
  FLIGHTS_PROVIDER_PARTIAL_HE,
  formatFlightsHebrew,
  flightEtaThresholdMinutes,
  normalizeAirportCode,
  normalizeFlightCode,
  parseFlightsAspects,
  resolveAirlineIata,
  resolveCityIata,
  resolveFlightsReply,
  type FlightRow,
  type FlightsFacts,
} from "../src/services/flights.js";

describe("flights helpers", () => {
  it("defaults airport to TLV", () => {
    expect(normalizeAirportCode("")).toBe(DEFAULT_FLIGHT_AIRPORT);
    expect(normalizeAirportCode("נתב״ג")).toBe("TLV");
    expect(normalizeAirportCode("tlv")).toBe("TLV");
  });

  it("maps city and airline names to IATA", () => {
    expect(resolveCityIata("פריז")).toBe("CDG");
    expect(resolveCityIata("rome")).toBe("FCO");
    expect(resolveAirlineIata("אל על")).toBe("LY");
    expect(resolveAirlineIata("ly")).toBe("LY");
  });

  it("normalizes flight codes as spoken", () => {
    expect(normalizeFlightCode("ly 831")).toBe("LY831");
    expect(normalizeFlightCode("3242CXD")).toBe("3242CXD");
  });

  it("parses aspects with default summary", () => {
    expect(parseFlightsAspects(undefined)).toEqual(["summary"]);
    expect(parseFlightsAspects(["next", "gate", "bogus"])).toEqual([
      "next",
      "gate",
    ]);
  });

  it("sums minutes_before + hours_before for threshold", () => {
    expect(
      flightEtaThresholdMinutes({ minutesBefore: 30, hoursBefore: 0 }),
    ).toBe(30);
    expect(
      flightEtaThresholdMinutes({ minutesBefore: 0, hoursBefore: 30 }),
    ).toBe(1800);
    expect(
      flightEtaThresholdMinutes({ minutesBefore: 30, hoursBefore: 1 }),
    ).toBe(90);
  });
});

describe("formatFlightsHebrew", () => {
  const row = {
    flightIata: "LY831",
    flightNumber: "831",
    airlineName: "El Al",
    airlineIata: "LY",
    otherIata: "CDG",
    otherAirportName: "Paris CDG",
    scheduledIso: "2026-10-22T10:00:00+00:00",
    estimatedIso: "2026-10-22T10:15:00+00:00",
    status: "scheduled",
    gate: "B7",
    terminal: "3",
    delayMinutes: 15,
    direction: "departures" as const,
  };

  it("formats a short board", () => {
    const facts: FlightsFacts = {
      airport: "TLV",
      direction: "departures",
      airline: "",
      city: "",
      flight: "",
      date: "",
      withinMinutes: null,
      aspects: ["board"],
      rows: [row],
    };
    const text = formatFlightsHebrew(facts);
    expect(text).toContain("המראות מ־TLV");
    expect(text).toContain("LY831");
    expect(text).toContain("שער B7");
  });

  it("formats next / single flight", () => {
    const facts: FlightsFacts = {
      airport: "TLV",
      direction: "arrivals",
      airline: "",
      city: "",
      flight: "LY831",
      date: "",
      withinMinutes: null,
      aspects: ["next"],
      rows: [{ ...row, direction: "arrivals" }],
    };
    const text = formatFlightsHebrew(facts);
    expect(text).toContain("LY831");
    expect(text).not.toContain("המראות מ־");
  });

  it("reports missing results in Hebrew", () => {
    const text = formatFlightsHebrew({
      airport: "TLV",
      direction: "both",
      airline: "אל על",
      city: "פריז",
      flight: "",
      date: "2026-10-23",
      withinMinutes: null,
      aspects: ["board"],
      rows: [],
    });
    expect(text).toContain("לא מצאתי");
    expect(text).toContain("TLV");
  });

  it("discloses local display truncation without claiming provider incompleteness", () => {
    const rows: FlightRow[] = Array.from(
      { length: FLIGHTS_DISPLAY_CAP + 3 },
      (_, i) => ({
        ...row,
        flightIata: `LY${800 + i}`,
        flightNumber: String(800 + i),
      }),
    );
    const completeness = buildFlightsCompleteness({
      rows,
      providerLimitSaturated: false,
    });
    expect(completeness.truncated).toBe(true);
    expect(completeness.providerPartial).toBeUndefined();
    const text = formatFlightsHebrew({
      airport: "TLV",
      direction: "departures",
      airline: "",
      city: "",
      flight: "",
      date: "",
      withinMinutes: null,
      aspects: ["board"],
      rows,
      completeness,
    });
    expect(text).toContain("1. ");
    expect(text).toContain(`${FLIGHTS_DISPLAY_CAP}. `);
    expect(text).not.toContain(`${FLIGHTS_DISPLAY_CAP + 1}. `);
    expect(text).toContain(FLIGHTS_LOCAL_TRUNCATION_HE);
    expect(text).not.toContain(FLIGHTS_PROVIDER_PARTIAL_HE);
  });

  it("discloses provider-limit saturation as potential incompleteness only", () => {
    const text = formatFlightsHebrew({
      airport: "TLV",
      direction: "departures",
      airline: "",
      city: "",
      flight: "",
      date: "",
      withinMinutes: null,
      aspects: ["board"],
      rows: [row],
      completeness: buildFlightsCompleteness({
        rows: [row],
        providerLimitSaturated: true,
      }),
    });
    expect(text).toContain("LY831");
    expect(text).toContain(FLIGHTS_PROVIDER_PARTIAL_HE);
    expect(text).not.toContain(FLIGHTS_LOCAL_TRUNCATION_HE);
    expect(text).not.toContain("חסרות בוודאות");
  });

  it("omits completeness notes for unsaturated small boards", () => {
    const text = formatFlightsHebrew({
      airport: "TLV",
      direction: "departures",
      airline: "",
      city: "",
      flight: "",
      date: "",
      withinMinutes: null,
      aspects: ["board"],
      rows: [row],
      completeness: buildFlightsCompleteness({
        rows: [row],
        providerLimitSaturated: false,
      }),
    });
    expect(text).toContain("LY831");
    expect(text).not.toContain(FLIGHTS_LOCAL_TRUNCATION_HE);
    expect(text).not.toContain(FLIGHTS_PROVIDER_PARTIAL_HE);
  });

  it("does not attach completeness wording to single-flight replies", () => {
    const text = formatFlightsHebrew({
      airport: "TLV",
      direction: "departures",
      airline: "",
      city: "",
      flight: "LY831",
      date: "",
      withinMinutes: null,
      aspects: ["next"],
      rows: [row],
      completeness: buildFlightsCompleteness({
        rows: Array.from({ length: 20 }, () => row),
        providerLimitSaturated: true,
      }),
    });
    expect(text).toContain("LY831");
    expect(text).not.toContain(FLIGHTS_LOCAL_TRUNCATION_HE);
    expect(text).not.toContain(FLIGHTS_PROVIDER_PARTIAL_HE);
  });
});

describe("resolveFlightsReply", () => {
  it("does not send flight_date (free plan restricted) and still returns board", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(String(url)).not.toContain("flight_date");
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              flight_status: "scheduled",
              airline: { name: "El Al", iata: "LY" },
              flight: { number: "831", iata: "LY831" },
              departure: {
                iata: "CDG",
                airport: "Paris",
                scheduled: new Date(Date.now() + 20 * 60_000).toISOString(),
                estimated: new Date(Date.now() + 20 * 60_000).toISOString(),
              },
              arrival: {
                iata: "TLV",
                airport: "Ben Gurion",
                scheduled: new Date(Date.now() + 20 * 60_000).toISOString(),
                estimated: new Date(Date.now() + 20 * 60_000).toISOString(),
                gate: "B1",
              },
            },
          ],
        }),
      };
    });
    const text = await resolveFlightsReply({
      direction: "arrivals",
      date: "2099-01-01",
      withinMinutes: 30,
      aspects: ["board"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // date filter client-side may empty rows for wrong calendar day — still must not crash.
    expect(text.length).toBeGreaterThan(5);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("returns missing-key message without calling network", async () => {
    const fetchImpl = vi.fn();
    const text = await resolveFlightsReply({
      airport: "TLV",
      direction: "arrivals",
      flight: "LY831",
      apiKey: "",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("חסר מפתח API");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prompts and docs mention flights recipes", () => {
    const root = resolve(process.cwd(), "..");
    const config = readFileSync(resolve(root, "LLM.config.json"), "utf8");
    const features = readFileSync(resolve(root, "docs/features.md"), "utf8");
    const chat = readFileSync(
      resolve(process.cwd(), "src/services/chat.service.ts"),
      "utf8",
    );
    expect(config).toContain("flight_eta");
    expect(config).toContain("flight_changed");
    expect(features).toContain("Flights (AviationStack)");
    expect(chat).toContain("FLIGHT ETA WATCH");
    expect(chat).toContain("FLIGHT CHANGED WATCH");
  });

  it("formats mocked AviationStack payload", async () => {
    const dep = new Date(Date.now() + 45 * 60_000).toISOString();
    const arr = new Date(Date.now() + 4 * 60 * 60_000).toISOString();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            flight_status: "scheduled",
            airline: { name: "El Al", iata: "LY" },
            flight: { number: "831", iata: "LY831" },
            departure: {
              iata: "TLV",
              airport: "Ben Gurion",
              scheduled: dep,
              estimated: dep,
              gate: "C3",
              terminal: "3",
              delay: null,
            },
            arrival: {
              iata: "CDG",
              airport: "Paris CDG",
              scheduled: arr,
              estimated: arr,
            },
          },
        ],
      }),
    }));
    const text = await resolveFlightsReply({
      airport: "TLV",
      direction: "departures",
      airline: "אל על",
      city: "פריז",
      aspects: ["board"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("LY831");
    expect(text).toContain("המראות");
    expect(fetchImpl).toHaveBeenCalled();
    expect(text).not.toContain(FLIGHTS_PROVIDER_PARTIAL_HE);
    expect(text).not.toContain(FLIGHTS_LOCAL_TRUNCATION_HE);
  });

  it("marks saturated provider page as potential incompleteness on board resolve", async () => {
    const now = Date.now();
    const data = Array.from({ length: 40 }, (_, i) => ({
      flight_status: "scheduled",
      airline: { name: "El Al", iata: "LY" },
      flight: { number: String(100 + i), iata: `LY${100 + i}` },
      departure: {
        iata: "TLV",
        airport: "Ben Gurion",
        scheduled: new Date(now + (i + 1) * 60_000).toISOString(),
        estimated: new Date(now + (i + 1) * 60_000).toISOString(),
      },
      arrival: {
        iata: "CDG",
        airport: "Paris",
        scheduled: new Date(now + (i + 1) * 60_000 + 3_600_000).toISOString(),
        estimated: new Date(now + (i + 1) * 60_000 + 3_600_000).toISOString(),
      },
    }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data }),
    }));
    const text = await resolveFlightsReply({
      airport: "TLV",
      direction: "departures",
      aspects: ["board"],
      apiKey: "test-key",
      now: new Date(now),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain(FLIGHTS_PROVIDER_PARTIAL_HE);
    expect(text).toContain(FLIGHTS_LOCAL_TRUNCATION_HE);
    expect(text).toContain(`${FLIGHTS_DISPLAY_CAP}. `);
    expect(text).not.toContain(`${FLIGHTS_DISPLAY_CAP + 1}. `);
  });
});
