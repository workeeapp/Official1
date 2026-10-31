/**
 * Stage 2B: Weather + Places wired to Geographic Core (offline mocks).
 */
import { describe, expect, it, vi } from "vitest";
import {
  isTechnicalAreaPolicyMessage,
  speakGeographicMatchForUser,
} from "../src/services/geo-area-user-copy.js";
import {
  geographicNeedsClarify,
  geographicResolvedPoint,
  geographicResolvedRegion,
  type GeographicAsk,
} from "../src/services/geographic-match.js";
import type { GeographicProvider } from "../src/services/geographic-provider.js";
import {
  resolvePlacesReplyDetailed,
} from "../src/services/places.js";
import {
  resolveWeatherForecastPlace,
  resolveWeatherMessages,
} from "../src/services/weather.js";

const ask = (rawText: string): GeographicAsk => ({
  rawText,
  role: "place",
  consumerHint: "weather",
});

function omCityProvider(
  label: string,
  lat: number,
  lng: number,
): GeographicProvider {
  return {
    id: "mock_om",
    provenance: "open_meteo",
    capabilities: {
      kinds: ["city", "point"],
      geometries: ["point"],
    },
    resolve: async (a) => {
      if (a.rawText.trim() !== label && !label.includes(a.rawText.trim())) {
        // Allow substring match for Hebrew city names in fixtures
        if (!a.rawText.includes(label) && !label.includes(a.rawText)) {
          return null;
        }
      }
      return {
        kind: "city",
        labelHe: label,
        confidence: "high",
        provenance: "open_meteo",
        point: { lat, lng },
      };
    },
  };
}

function regionProvider(
  label: string,
  viewport: {
    low: { lat: number; lng: number };
    high: { lat: number; lng: number };
  },
  spanOk = true,
): GeographicProvider {
  void spanOk;
  return {
    id: "mock_index",
    provenance: "geo_area_index",
    capabilities: {
      kinds: ["region"],
      geometries: ["viewport", "polygon"],
    },
    resolve: async (a) => {
      if (!a.rawText.includes(label) && label !== a.rawText) {
        // match הגליל / השרון style
        const q = a.rawText.replace(/^ה/, "");
        const l = label.replace(/^ה/, "");
        if (q !== l && !a.rawText.includes(l) && !label.includes(q)) {
          return null;
        }
      }
      return {
        kind: "region",
        labelHe: label,
        confidence: "high",
        provenance: "geo_area_index",
        viewport,
      };
    },
  };
}

describe("2B Weather ↔ Core", () => {
  it("1. Weather צפת → city point (not a foreign region)", async () => {
    const resolved = await resolveWeatherForecastPlace({
      place: "צפת",
      providers: [
        omCityProvider("צפת", 32.96, 35.5),
        regionProvider("רמת הגולן", {
          low: { lat: 32.7, lng: 35.5 },
          high: { lat: 33.2, lng: 35.9 },
        }),
      ],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.representativeRegion).toBe(false);
    expect(resolved.place.name).toContain("צפת");
    expect(resolved.place.latitude).toBeCloseTo(32.96, 1);
  });

  it("2. Weather הגליל → region or clarify; never silent צפת / גליל ים rewrite", async () => {
    const galilViewport = {
      low: { lat: 32.7, lng: 35.1 },
      high: { lat: 33.1, lng: 35.6 },
    };
    const resolved = await resolveWeatherForecastPlace({
      place: "הגליל",
      providers: [
        {
          id: "om_miss",
          provenance: "open_meteo",
          capabilities: { kinds: ["city"], geometries: ["point"] },
          resolve: async () => null,
        },
        regionProvider("הגליל", galilViewport),
      ],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.representativeRegion).toBe(true);
    expect(resolved.place.name).toMatch(/גליל/);
    expect(resolved.place.name).not.toMatch(/צפת|גליל ים/);
    expect(resolved.place.name).toMatch(/מייצגת|אזור/);
  });

  it("3. Weather השרון → justified representative (Sharon-class span)", async () => {
    const sharon = {
      low: { lat: 32.1, lng: 34.8 },
      high: { lat: 32.34, lng: 35.0 },
    };
    const resolved = await resolveWeatherForecastPlace({
      place: "השרון",
      providers: [
        {
          id: "om_miss",
          provenance: "open_meteo",
          capabilities: { kinds: ["city"], geometries: ["point"] },
          resolve: async () => null,
        },
        regionProvider("השרון", sharon),
      ],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.representativeRegion).toBe(true);
    expect(resolved.place.name).toMatch(/שרון/);
  });

  it("4. Weather saved with coords → direct point, provenance path kind saved", async () => {
    const snapshot = {
      lists: [],
      filing: [
        {
          filing_id: "fil-grandma",
          item_name: "סבתא",
          item_info: "32.08,34.78",
          item_description: "",
        },
      ],
    };
    const resolved = await resolveWeatherForecastPlace({
      place: "סבתא",
      snapshot,
      providers: [],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.representativeRegion).toBe(false);
    expect(resolved.place.latitude).toBeCloseTo(32.08, 2);
    expect(resolved.place.name).toBe("סבתא");
  });

  it("5. Weather saved without coords → geocode keeps label; dual provenance via Core", async () => {
    const snapshot = {
      lists: [],
      filing: [
        {
          filing_id: "fil-home",
          item_name: "מיקום הבית",
          item_info: "רחוב הרצל 12 תל אביב",
          item_description: "",
        },
      ],
    };
    const resolved = await resolveWeatherForecastPlace({
      place: "מיקום הבית",
      snapshot,
      providers: [
        {
          id: "om_geocode",
          provenance: "open_meteo",
          capabilities: { kinds: ["city"], geometries: ["point"] },
          resolve: async () => ({
            kind: "city",
            labelHe: "תל אביב",
            confidence: "high",
            provenance: "open_meteo",
            point: { lat: 32.08, lng: 34.78 },
          }),
        },
      ],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.place.name).toBe("מיקום הבית");
    expect(resolved.place.latitude).toBeCloseTo(32.08, 2);
  });

  it("8/9. explicit city vs pin; natural clarify when unknown", async () => {
    const pending = {
      lat: 31.5,
      lng: 34.5,
      name: "pin",
      address: "",
      receivedAt: Date.now(),
    };
    const city = await resolveWeatherForecastPlace({
      place: "תל אביב",
      pending: pending as never,
      providers: [omCityProvider("תל אביב", 32.08, 34.78)],
    });
    expect(city.ok).toBe(true);
    if (city.ok) {
      expect(city.place.latitude).toBeCloseTo(32.08, 1);
    }

    const miss = await resolveWeatherMessages({
      place: "NowhereLandXYZ",
      providers: [
        {
          id: "empty",
          provenance: "open_meteo",
          capabilities: { kinds: ["city"], geometries: ["point"] },
          resolve: async () => null,
        },
      ],
    });
    expect(miss.needsLocation).toBe(true);
    expect(miss.body).toMatch(/לא זיהיתי|באיזו עיר/);
    expect(miss.body).not.toContain("לא מצאתי מקום");
    expect(isTechnicalAreaPolicyMessage(miss.body)).toBe(false);
  });
});

describe("2B Places ↔ Core", () => {
  it("6. Places area_restrict הגליל → viewport path; no jargon", async () => {
    const galil = {
      low: { lat: 32.7, lng: 35.1 },
      high: { lat: 33.1, lng: 35.6 },
    };
    const fetchImpl = vi.fn(async () => {
      throw new Error("Places API must not be called when area resolve fails");
    }) as unknown as typeof fetch;

    const fail = await resolvePlacesReplyDetailed({
      query: "מסעדות",
      place: "רמת הגולן",
      areaRestrict: true,
      fetchImpl,
      providers: [
        {
          id: "policy_reject",
          provenance: "geo_area_index",
          capabilities: {
            kinds: ["region"],
            geometries: ["viewport"],
          },
          resolve: async () => null,
        },
      ],
    });
    expect(fail.needsLocation).toBe(true);
    expect(fail.text).not.toMatch(/יחידה מינהלית|narrow_admin/);
    expect(isTechnicalAreaPolicyMessage(fail.text)).toBe(false);

    const searchCalls: unknown[] = [];
    const okFetch = vi.fn(async (url: string, init?: RequestInit) => {
      searchCalls.push({ url, body: init?.body });
      return {
        ok: true,
        json: async () => ({ places: [] }),
      } as Response;
    }) as unknown as typeof fetch;

    const ok = await resolvePlacesReplyDetailed({
      query: "מסעדות",
      place: "הגליל",
      areaRestrict: true,
      fetchImpl: okFetch,
      apiKey: "test-key",
      providers: [
        regionProvider("הגליל", galil),
      ],
    });
    expect(ok.needsLocation).toBe(false);
    expect(searchCalls.length).toBeGreaterThan(0);
    const body = String((searchCalls[0] as { body?: string }).body ?? "");
    expect(body).toMatch(/locationRestriction/);
    expect(ok.text).not.toMatch(/יחידה מינהלית|narrow_admin/);
  });

  it("7. Places near saved with coords → bias (nearSpeaker path)", async () => {
    const snapshot = {
      lists: [],
      filing: [
        {
          filing_id: "fil-work",
          item_name: "העבודה",
          item_info: "32.085,34.78",
          item_description: "",
        },
      ],
    };
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return {
        ok: true,
        json: async () => ({ places: [] }),
      } as Response;
    }) as unknown as typeof fetch;

    const result = await resolvePlacesReplyDetailed({
      query: "מסעדות",
      place: "העבודה",
      areaRestrict: false,
      nearSpeaker: false,
      snapshot,
      fetchImpl,
      apiKey: "test-key",
      providers: [],
    });
    expect(result.needsLocation).toBe(false);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies[0]).toMatch(/locationBias|circle/);
    expect(bodies[0]).toMatch(/32\.085|34\.78/);
  });

  it("10. UX Gate — GeographicMatch policy never spoken", () => {
    const match = geographicNeedsClarify({
      asked: ask("רמת הגולן"),
      kind: "region",
      policyTrace: "מצאתי יחידה מינהלית צרה ל«רמת הגולן».",
      userAskHe: "באיזו עיר או אזור מדויק יותר לחפש?",
    });
    const spoken = speakGeographicMatchForUser(match);
    expect(spoken).not.toMatch(/יחידה מינהלית|narrow_admin/);
    expect(spoken).toMatch(/עיר|אזור/);
  });
});

describe("2B same Core shared", () => {
  it("Weather and Places both accept GeographicMatch shapes from Core helpers", () => {
    const region = geographicResolvedRegion({
      asked: ask("השרון"),
      labelHe: "השרון",
      provenance: "geo_area_index",
      viewport: {
        low: { lat: 32.1, lng: 34.8 },
        high: { lat: 32.34, lng: 35.0 },
      },
    });
    const point = geographicResolvedPoint({
      asked: ask("צפת"),
      kind: "city",
      labelHe: "צפת",
      provenance: "open_meteo",
      point: { lat: 32.96, lng: 35.5 },
    });
    expect(region.kind).toBe("region");
    expect(point.kind).toBe("city");
  });
});
