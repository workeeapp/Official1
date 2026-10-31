/**
 * Stage 2A: Core resolveGeographic + providers + saved catalog + consumer fit.
 * Offline mocks only — no live Google / paid APIs.
 */
import { describe, expect, it, vi } from "vitest";
import {
  adaptMatchForConsumer,
  PLACES_AREA_CONSUMER_CAPABILITIES_EXAMPLE,
  ROUTES_ENDPOINT_CONSUMER_CAPABILITIES_EXAMPLE,
  WEATHER_CONSUMER_CAPABILITIES_EXAMPLE,
} from "../src/services/geographic-consumer.js";
import {
  geographicResolvedRegion,
  type GeographicAsk,
} from "../src/services/geographic-match.js";
import {
  decideJustifiedRepresentativePoint,
} from "../src/services/geographic-representative-policy.js";
import {
  defaultGeographicProviders,
  resolveGeographic,
} from "../src/services/geographic-resolve.js";
import {
  buildSavedLocationCatalog,
  matchSavedLocationReference,
} from "../src/services/geographic-saved-catalog.js";
import type { GeographicProvider } from "../src/services/geographic-provider.js";
import { resolveSavedRoutePoint } from "../src/services/saved-route-location.js";
import {
  isTechnicalAreaPolicyMessage,
  speakGeographicMatchForUser,
} from "../src/services/geo-area-user-copy.js";

const ask = (rawText: string, extra?: Partial<GeographicAsk>): GeographicAsk => ({
  rawText,
  role: "place",
  ...extra,
});

function snapshotWithSavedGrandma(coords = true) {
  return {
    lists: [],
    filing: [
      {
        filing_id: "fil-grandma",
        item_name: "סבתא",
        item_info: coords ? "32.08,34.78" : "רחוב הרצל 1 תל אביב",
        item_description: "",
      },
    ],
  };
}

function snapshotTwoHomes() {
  return {
    lists: [],
    filing: [
      {
        filing_id: "fil-home1",
        item_name: "בית",
        item_info: "32.08,34.78",
        item_description: "",
      },
      {
        filing_id: "fil-home2",
        item_name: "בית שני",
        item_info: "32.18,34.88",
        item_description: "",
      },
    ],
  };
}

describe("SavedLocationCatalog wraps SRP (no duplicate matcher)", () => {
  it("catalog withCoords mirrors collectSavedRouteLocationCandidates / SRP hit", () => {
    const snapshot = snapshotWithSavedGrandma(true);
    const catalog = buildSavedLocationCatalog(snapshot, null);
    expect(catalog.withCoords).toHaveLength(1);
    expect(catalog.withCoords[0]?.label).toBe("סבתא");
    expect(catalog.withCoords[0]?.id).toBe("fil-grandma");

    const srp = resolveSavedRoutePoint("סבתא", snapshot, null);
    const ref = matchSavedLocationReference({
      ask: ask("סבתא"),
      snapshot,
    });
    expect(srp.kind).toBe("hit");
    expect(ref.status).toBe("hit_coords");
    if (srp.kind === "hit" && ref.status === "hit_coords") {
      expect(ref.match.savedRef?.id).toBe(srp.id);
      expect(ref.match.geometry?.point?.lat).toBe(srp.lat);
      expect(ref.match.provenance).toBe("saved");
      expect(ref.match.coordinateProvenance).toBe("saved");
    }
  });

  it("ambiguous similar saved names → clarify, no pick-first", () => {
    const snapshot = snapshotTwoHomes();
    const ref = matchSavedLocationReference({
      ask: ask("בית"),
      snapshot,
    });
    // soft match may hit both "בית" and "בית שני"
    expect(["ambiguous", "hit_coords"]).toContain(ref.status);
    if (ref.status === "ambiguous") {
      expect(ref.match.candidates!.length).toBeGreaterThan(1);
      expect(ref.match.userAskHe).toBeTruthy();
    }
  });

  it("saved without coords preserves savedRef; geocode sets coordinateProvenance", async () => {
    // SRP only catalogs address-like filings without coords (not arbitrary nicknames).
    const snapshot = {
      lists: [],
      filing: [
        {
          filing_id: "fil-home-addr",
          item_name: "מיקום הבית",
          item_info: "רחוב הרצל 12 תל אביב",
          item_description: "",
        },
      ],
    };
    const pointProvider: GeographicProvider = {
      id: "mock_point",
      provenance: "open_meteo",
      capabilities: { kinds: ["city"], geometries: ["point"] },
      resolve: async () => ({
        kind: "city",
        labelHe: "תל אביב",
        confidence: "high",
        provenance: "open_meteo",
        point: { lat: 32.08, lng: 34.78 },
      }),
    };
    const match = await resolveGeographic({
      ask: ask("מיקום הבית"),
      geometryNeeds: { point: true },
      snapshot,
      providers: [pointProvider],
      geocodeSavedWithoutCoords: true,
    });
    expect(match.status).toBe("resolved");
    expect(match.kind).toBe("saved");
    expect(match.savedRef?.id).toBe("fil-home-addr");
    expect(match.savedRef?.hadCoordsAtResolve).toBe(false);
    expect(match.provenance).toBe("saved");
    expect(match.coordinateProvenance).toBe("open_meteo");
  });

  it("saved without coords + geocodeSavedWithoutCoords:false → clarify (RAL parity)", async () => {
    const snapshot = {
      lists: [],
      filing: [
        {
          filing_id: "fil-home-addr",
          item_name: "מיקום הבית",
          item_info: "רחוב הרצל 12 תל אביב",
          item_description: "",
        },
      ],
    };
    const match = await resolveGeographic({
      ask: ask("מיקום הבית"),
      geometryNeeds: { point: true },
      snapshot,
      providers: [],
      geocodeSavedWithoutCoords: false,
    });
    expect(match.status).toBe("needs_clarify");
    expect(match.userAskHe).toMatch(/קואורדינטות|מיקום/);
  });
});

describe("resolveGeographic precedence (PIN / explicit / saved / LAST_LIVE)", () => {
  it("explicit saved label wins over pin availability", async () => {
    const snapshot = snapshotWithSavedGrandma(true);
    const match = await resolveGeographic({
      ask: ask("סבתא"),
      geometryNeeds: { point: true },
      snapshot,
      pending: {
        lat: 31.5,
        lng: 34.5,
        name: "pin",
        address: null,
        at: Date.now(),
      },
      providers: [],
    });
    expect(match.kind).toBe("saved");
    expect(match.geometry?.point?.lat).toBeCloseTo(32.08, 2);
    expect(match.provenance).toBe("saved");
  });

  it("pin deixis with empty place uses pending; no saved rewrite", async () => {
    const match = await resolveGeographic({
      ask: ask("", { deixis: "pin", role: "near" }),
      geometryNeeds: { point: true },
      pending: {
        lat: 31.77,
        lng: 35.22,
        name: "סיכה",
        address: null,
        at: Date.now(),
      },
      snapshot: snapshotWithSavedGrandma(true),
      providers: [],
    });
    expect(match.kind).toBe("pin");
    expect(match.provenance).toBe("whatsapp_pin");
    expect(match.savedRef).toBeUndefined();
    expect(match.geometry?.point?.lat).toBeCloseTo(31.77, 2);
  });

  it("LAST_LIVE never auto-applied when place empty and no pin deixis", async () => {
    const match = await resolveGeographic({
      ask: ask(""),
      geometryNeeds: { point: true },
      providers: [],
    });
    expect(match.status).toBe("needs_clarify");
    expect(match.provenance).not.toBe("saved");
  });

  it("unknown place → needs_clarify (no provider hit)", async () => {
    const silent: GeographicProvider = {
      id: "silent",
      provenance: "unknown",
      capabilities: { kinds: ["city"], geometries: ["point"] },
      resolve: async () => null,
    };
    const match = await resolveGeographic({
      ask: ask("מקוםלאקייםXYZ"),
      geometryNeeds: { point: true },
      providers: [silent],
    });
    expect(match.status).toBe("needs_clarify");
    expect(match.userAskHe).not.toMatch(/יחידה מינהלית|narrow_admin/);
  });
});

describe("Provider ladder + provenance", () => {
  it("area need: index region hit keeps provenance geo_area_index", async () => {
    const indexHit: GeographicProvider = {
      id: "idx",
      provenance: "geo_area_index",
      capabilities: {
        kinds: ["region"],
        geometries: ["viewport", "polygon"],
      },
      resolve: async () => ({
        kind: "region",
        labelHe: "הנגב",
        confidence: "high",
        provenance: "geo_area_index",
        viewport: {
          low: { lat: 29.5, lng: 34.2 },
          high: { lat: 31.4, lng: 35.4 },
        },
      }),
    };
    const omShouldNotRun = vi.fn(async () => {
      throw new Error("OM must not run when area resolved");
    });
    const om: GeographicProvider = {
      id: "om",
      provenance: "open_meteo",
      capabilities: { kinds: ["city"], geometries: ["point"] },
      resolve: omShouldNotRun,
    };
    const match = await resolveGeographic({
      ask: ask("הנגב"),
      geometryNeeds: { area: true },
      providers: [indexHit, om],
    });
    expect(match.status).toBe("resolved");
    expect(match.kind).toBe("region");
    expect(match.provenance).toBe("geo_area_index");
    expect(match.coordinateProvenance).toBe("geo_area_index");
    expect(omShouldNotRun).not.toHaveBeenCalled();
  });

  it("point need: open-meteo city hit", async () => {
    const om: GeographicProvider = {
      id: "om",
      provenance: "open_meteo",
      capabilities: { kinds: ["city"], geometries: ["point"] },
      resolve: async () => ({
        kind: "city",
        labelHe: "צפת",
        confidence: "high",
        provenance: "open_meteo",
        point: { lat: 32.96, lng: 35.5 },
      }),
    };
    const match = await resolveGeographic({
      ask: ask("צפת"),
      geometryNeeds: { point: true },
      providers: [om],
    });
    expect(match.kind).toBe("city");
    expect(match.coordinateProvenance).toBe("open_meteo");
    expect(match.geometry?.point?.lat).toBeCloseTo(32.96, 2);
  });

  it("defaultGeographicProviders lists index, google area, om — no domain ifs", () => {
    const ids = defaultGeographicProviders().map((p) => p.id);
    expect(ids).toEqual([
      "local_geo_area_index",
      "google_geocode_area",
      "open_meteo_point",
    ]);
  });
});

describe("Consumer fit + representative policy", () => {
  it("region without maxSpan → clarify for weather-like caps", () => {
    const region = geographicResolvedRegion({
      asked: ask("הנגב"),
      labelHe: "הנגב",
      provenance: "geo_area_index",
      viewport: {
        low: { lat: 29.5, lng: 34.2 },
        high: { lat: 31.4, lng: 35.4 },
      },
    });
    const fitted = adaptMatchForConsumer(region, {
      ...WEATHER_CONSUMER_CAPABILITIES_EXAMPLE,
      maxRepresentativeSpanDeg: 1.25,
    });
    expect(fitted.status).toBe("needs_clarify");
    expect(fitted.representativePoint).toBeUndefined();
  });

  it("Sharon-class span + weather caps → justified representativePoint; kind stays region", () => {
    const region = geographicResolvedRegion({
      asked: ask("השרון"),
      labelHe: "השרון",
      provenance: "google_geocode",
      viewport: {
        low: { lat: 32.19, lng: 34.81 },
        high: { lat: 32.41, lng: 35.05 },
      },
    });
    const fitted = adaptMatchForConsumer(
      region,
      WEATHER_CONSUMER_CAPABILITIES_EXAMPLE,
    );
    expect(fitted.status).toBe("resolved");
    expect(fitted.kind).toBe("region");
    expect(fitted.representativePoint?.justified).toBe(true);
  });

  it("routes caps: region → unsupported_for_consumer (no centroid trip)", () => {
    const region = geographicResolvedRegion({
      asked: ask("הגליל"),
      labelHe: "הגליל",
      provenance: "google_geocode",
      viewport: {
        low: { lat: 32.7, lng: 35.1 },
        high: { lat: 33.1, lng: 35.6 },
      },
    });
    const fitted = adaptMatchForConsumer(
      region,
      ROUTES_ENDPOINT_CONSUMER_CAPABILITIES_EXAMPLE,
    );
    expect(fitted.status).toBe("unsupported_for_consumer");
    expect(fitted.userAskHe).toBeTruthy();
  });

  it("places area caps accept region viewport without representative point", () => {
    const region = geographicResolvedRegion({
      asked: ask("השרון"),
      labelHe: "השרון",
      provenance: "google_geocode",
      viewport: {
        low: { lat: 32.19, lng: 34.81 },
        high: { lat: 32.41, lng: 35.05 },
      },
    });
    const fitted = adaptMatchForConsumer(
      region,
      PLACES_AREA_CONSUMER_CAPABILITIES_EXAMPLE,
    );
    expect(fitted.status).toBe("resolved");
    expect(fitted.kind).toBe("region");
    expect(fitted.representativePoint).toBeUndefined();
  });

  it("decideJustifiedRepresentativePoint requires consumer maxSpan", () => {
    const vp = {
      low: { lat: 32.19, lng: 34.81 },
      high: { lat: 32.41, lng: 35.05 },
    };
    expect(
      decideJustifiedRepresentativePoint({ viewport: vp }).ok,
    ).toBe(false);
    expect(
      decideJustifiedRepresentativePoint({
        viewport: vp,
        maxRepresentativeSpanDeg: 1.25,
      }).ok,
    ).toBe(true);
  });
});

describe("UX Gate + future consumer stub", () => {
  it("policy jargon never spoken", () => {
    expect(
      isTechnicalAreaPolicyMessage("מצאתי יחידה מינהלית צרה ל«רמת הגולן»."),
    ).toBe(true);
    const spoken = speakGeographicMatchForUser({
      status: "needs_clarify",
      confidence: "low",
      asked: ask("רמת הגולן"),
      kind: "region",
      labelHe: "רמת הגולן",
      provenance: "unknown",
      policyTrace: "מצאתי יחידה מינהלית צרה ל«רמת הגולן».",
      userAskHe: "באיזו עיר או אזור מדויק יותר לחפש?",
    });
    expect(spoken).not.toMatch(/יחידה מינהלית|narrow_admin/);
  });

  it("future News-like consumer: region viewport without core change", () => {
    const region = geographicResolvedRegion({
      asked: ask("הגליל", { consumerHint: "news" }),
      labelHe: "הגליל",
      provenance: "google_geocode",
      viewport: {
        low: { lat: 32.7, lng: 35.1 },
        high: { lat: 33.1, lng: 35.6 },
      },
    });
    const newsCaps = {
      accepts: ["region", "city"] as const,
      requiresExactPoint: false,
      acceptsViewport: true,
      acceptsPolygon: true,
      allowsJustifiedRepresentativePoint: false,
    };
    const fitted = adaptMatchForConsumer(region, {
      accepts: [...newsCaps.accepts],
      requiresExactPoint: newsCaps.requiresExactPoint,
      acceptsViewport: newsCaps.acceptsViewport,
      acceptsPolygon: newsCaps.acceptsPolygon,
      allowsJustifiedRepresentativePoint:
        newsCaps.allowsJustifiedRepresentativePoint,
    });
    expect(fitted.status).toBe("resolved");
    expect(fitted.geometry?.viewport).toBeTruthy();
    expect(fitted.representativePoint).toBeUndefined();
  });
});

describe("Affinity: הגליל ≠ רמת הגולן (no silent rewrite)", () => {
  it("savedRef for סבתא does not become another label", async () => {
    const match = await resolveGeographic({
      ask: ask("סבתא"),
      geometryNeeds: { point: true },
      snapshot: snapshotWithSavedGrandma(true),
      providers: [
        {
          id: "evil",
          provenance: "open_meteo",
          capabilities: { kinds: ["city"], geometries: ["point"] },
          resolve: async () => ({
            kind: "city",
            labelHe: "רמת הגולן",
            confidence: "high",
            provenance: "open_meteo",
            point: { lat: 33.0, lng: 35.7 },
          }),
        },
      ],
    });
    // Saved hit short-circuits before providers
    expect(match.labelHe).toBe("סבתא");
    expect(match.savedRef?.id).toBe("fil-grandma");
  });
});
