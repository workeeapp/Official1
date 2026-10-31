/**
 * Stage 2C: Routes + Jewish wired to Geographic Core (offline mocks).
 */
import { describe, expect, it, vi } from "vitest";
import {
  resolveJewishPlaceInput,
} from "../src/services/jewish.js";
import {
  resolveRoutesEndpoint,
} from "../src/services/routes.js";
import { createNamedPlacePointProvider } from "../src/services/providers/named-place-point.provider.js";
import type { GeographicProvider } from "../src/services/geographic-provider.js";

const speakerAsk = "שלח מיקום בוואטסאפ.";

const cityProvider = (
  label: string,
  lat: number,
  lng: number,
): GeographicProvider =>
  createNamedPlacePointProvider(async ({ query }) => {
    if (!query.includes(label) && label !== query) {
      return { ok: false, kind: "empty", messageHe: "none" };
    }
    return { ok: true, lat, lng, label };
  });

describe("2C Routes ↔ Core", () => {
  it("explicit city/point → coords via named-place provider", async () => {
    const result = await resolveRoutesEndpoint({
      label: "תל אביב",
      speakerMissingPinAsk: speakerAsk,
      onGeocodeEmpty: "ask",
      providers: [cityProvider("תל אביב", 32.08, 34.78)],
    });
    expect(result.kind).toBe("coords");
    if (result.kind === "coords") {
      expect(result.source).toBe("geocode");
      expect(result.lat).toBeCloseTo(32.08);
    }
  });

  it("saved with coords → no provider call", async () => {
    const resolve = vi.fn();
    const result = await resolveRoutesEndpoint({
      label: "בית",
      snapshot: {
        filing: [
          {
            filing_id: "f-home",
            item_name: "בית",
            item_info: "32.1, 34.8",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
        ],
        lists: [],
      },
      speakerMissingPinAsk: speakerAsk,
      onGeocodeEmpty: "ask",
      providers: [
        {
          id: "must_not_run",
          provenance: "open_meteo",
          capabilities: { kinds: ["city"], geometries: ["point"] },
          resolve,
        },
      ],
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(result.kind).toBe("coords");
    if (result.kind === "coords") {
      expect(result.source).toBe("saved");
    }
  });

  it("saved without coords → geocode addressText; source saved", async () => {
    const queries: string[] = [];
    const result = await resolveRoutesEndpoint({
      label: "סבתא",
      snapshot: {
        filing: [
          {
            filing_id: "f-g",
            item_name: "סבתא",
            item_info: "הרצל 5 רמת גן",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
        ],
        lists: [],
      },
      speakerMissingPinAsk: speakerAsk,
      onGeocodeEmpty: "ask",
      providers: [
        createNamedPlacePointProvider(async ({ query }) => {
          queries.push(query);
          return { ok: true, lat: 32.08, lng: 34.81, label: "רמת גן" };
        }),
      ],
    });
    expect(queries[0]).toBe("הרצל 5 רמת גן");
    expect(result.kind).toBe("coords");
    if (result.kind === "coords") {
      expect(result.source).toBe("saved");
      expect(result.label).toBe("סבתא");
    }
  });

  it("ambiguous saved → ask", async () => {
    const result = await resolveRoutesEndpoint({
      label: "בית",
      snapshot: {
        filing: [
          {
            filing_id: "a",
            item_name: "בית אמא",
            item_info: "32.1, 34.8",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
          {
            filing_id: "b",
            item_name: "בית אבא",
            item_info: "32.2, 34.9",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
        ],
        lists: [],
      },
      speakerMissingPinAsk: speakerAsk,
      onGeocodeEmpty: "ask",
      providers: [],
    });
    expect(result.kind).toBe("ask");
  });

  it("region → clarify (no invented point)", async () => {
    const result = await resolveRoutesEndpoint({
      label: "הנגב",
      speakerMissingPinAsk: speakerAsk,
      onGeocodeEmpty: "ask",
      providers: [
        {
          id: "region",
          provenance: "geo_area_index",
          capabilities: {
            kinds: ["region"],
            geometries: ["viewport"],
          },
          resolve: async () => ({
            kind: "region",
            labelHe: "הנגב",
            confidence: "high",
            provenance: "geo_area_index",
            viewport: {
              low: { lat: 29.5, lng: 34.2 },
              high: { lat: 31.3, lng: 35.5 },
            },
          }),
        },
      ],
    });
    expect(result.kind).toBe("ask");
    if (result.kind === "ask") {
      expect(result.text).not.toMatch(/יחידה מינהלית/);
    }
  });
});

describe("2C Jewish ↔ Core", () => {
  it("explicit city → named (Hebcal geonameid path)", async () => {
    const result = await resolveJewishPlaceInput({ place: "חיפה" });
    expect(result).toEqual({ kind: "named", place: "חיפה" });
  });

  it("saved with coords → location + Asia/Jerusalem", async () => {
    const result = await resolveJewishPlaceInput({
      place: "בית",
      snapshot: {
        filing: [
          {
            filing_id: "f",
            item_name: "בית",
            item_info: "32.08, 34.78",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
        ],
        lists: [],
      },
    });
    expect(result.kind).toBe("location");
    if (result.kind === "location") {
      expect(result.source).toBe("saved");
      expect(result.loc.tzid).toBe("Asia/Jerusalem");
    }
  });

  it("saved without coords → geocoded location; label preserved", async () => {
    const result = await resolveJewishPlaceInput({
      place: "סבתא",
      snapshot: {
        filing: [
          {
            filing_id: "f-g",
            item_name: "סבתא",
            item_info: "הרצל 5 רמת גן",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
        ],
        lists: [],
      },
      providers: [
        {
          id: "mock",
          provenance: "open_meteo",
          capabilities: { kinds: ["city"], geometries: ["point"] },
          resolve: async (ask) => ({
            kind: "city",
            labelHe: "רמת גן",
            confidence: "high",
            provenance: "open_meteo",
            point: { lat: 32.08, lng: 34.81 },
            policyTrace: ask.rawText,
          }),
        },
      ],
    });
    expect(result.kind).toBe("location");
    if (result.kind === "location") {
      expect(result.loc.label).toBe("סבתא");
      expect(result.source).toBe("saved");
    }
  });

  it("ambiguous / unsupported → ask", async () => {
    const amb = await resolveJewishPlaceInput({
      place: "בית",
      snapshot: {
        filing: [
          {
            filing_id: "1",
            item_name: "בית א",
            item_info: "32.1, 34.8",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
          {
            filing_id: "2",
            item_name: "בית ב",
            item_info: "32.2, 34.9",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
        ],
        lists: [],
      },
    });
    expect(amb.kind).toBe("ask");
  });
});
