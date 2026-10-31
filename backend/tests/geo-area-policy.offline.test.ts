/**
 * Geographic-area acceptance policy + index resolution — offline fixtures.
 */
import { describe, expect, it } from "vitest";
import {
  decideGoogleAreaCandidate,
  scoreNameAffinity,
  VIEWPORT_SPAN_SUSPICION_DEG,
} from "../src/services/geo-area-policy.js";
import { lookupGeoAreaIndex, loadGeoAreaIndex } from "../src/services/geo-area-index.js";
import { resolvePlaceViewport } from "../src/services/geocode-viewport.js";
import { resolveGeographicArea } from "../src/services/resolve-geographic-area.js";

describe("scoreNameAffinity", () => {
  it("exact / strong / contains_query_extra (רמת השרון vs השרון)", () => {
    expect(scoreNameAffinity("השרון", ["השרון"])).toBe("exact");
    expect(scoreNameAffinity("השרון", ["השרון, ישראל"])).toBe("exact");
    expect(scoreNameAffinity("הנגב", ["Negev Desert", "הנגב"])).toBe("exact");
    expect(scoreNameAffinity("Negev", ["Negev Desert"])).toBe("strong");
    expect(scoreNameAffinity("השרון", ["רמת השרון"])).toBe("contains_query_extra");
  });
});

describe("decideGoogleAreaCandidate", () => {
  const TINY_NEGEV_VP = {
    low: { lat: 30.7127, lng: 34.8744 },
    high: { lat: 30.7154, lng: 34.8771 },
  };

  it("rejects tiny viewport with types=[] (Negev empty-types failure class)", () => {
    const out = decideGoogleAreaCandidate({
      query: "הנגב",
      formattedAddress: "הנגב",
      types: [],
      viewport: TINY_NEGEV_VP,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("unreliable");
    expect(out.suspicion.some((s) => s.startsWith("small_viewport_span"))).toBe(
      true,
    );
    expect(VIEWPORT_SPAN_SUSPICION_DEG).toBe(0.15);
  });

  it("rejects tiny viewport with natural_feature", () => {
    const out = decideGoogleAreaCandidate({
      query: "הנגב",
      formattedAddress: "הנגב",
      types: ["natural_feature"],
      viewport: TINY_NEGEV_VP,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("unreliable");
  });

  it("rejects tiny viewport with establishment (point_like or unreliable)", () => {
    const out = decideGoogleAreaCandidate({
      query: "הנגב",
      formattedAddress: "הנגב",
      types: ["establishment"],
      viewport: TINY_NEGEV_VP,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(["point_like", "unreliable"]).toContain(out.reason);
  });

  it("accepts small legitimate locality with strong semantic match", () => {
    // Span under suspicion threshold, but typed locality + exact name.
    const out = decideGoogleAreaCandidate({
      query: "פתח תקווה",
      formattedAddress: "פתח תקווה, ישראל",
      types: ["locality", "political"],
      viewport: {
        low: { lat: 32.05, lng: 34.85 },
        high: { lat: 32.12, lng: 34.92 },
      },
    });
    expect(out.ok).toBe(true);
  });

  it("accepts adequate admin viewport with strong name match (השרון class)", () => {
    const out = decideGoogleAreaCandidate({
      query: "השרון",
      formattedAddress: "השרון, ישראל",
      types: ["administrative_area_level_2", "political"],
      viewport: {
        low: { lat: 32.19, lng: 34.81 },
        high: { lat: 32.41, lng: 35.05 },
      },
    });
    expect(out.ok).toBe(true);
  });

  it("rejects point_like / weak affinity / Drôme-style mismatch for דרום צרפת", () => {
    expect(
      decideGoogleAreaCandidate({
        query: "רחוב הרצל 1",
        formattedAddress: "רחוב הרצל 1, תל אביב",
        types: ["street_address"],
        viewport: {
          low: { lat: 32.06, lng: 34.77 },
          high: { lat: 32.07, lng: 34.78 },
        },
      }).ok,
    ).toBe(false);

    const south = decideGoogleAreaCandidate({
      query: "דרום צרפת",
      formattedAddress: "דרום, צרפת",
      types: ["administrative_area_level_2", "political"],
      viewport: {
        low: { lat: 44.11, lng: 4.64 },
        high: { lat: 45.34, lng: 5.83 },
      },
    });
    expect(south.ok).toBe(false);
  });
});

describe("geo-area index coverage (documented sources only)", () => {
  it("loads index and resolves הנגב / Northern District / Patagonia / PACA name", () => {
    const index = loadGeoAreaIndex({ reload: true });
    expect(index.features.length).toBeGreaterThanOrEqual(8);

    const negev = lookupGeoAreaIndex({ place: "הנגב", index });
    expect(negev.status).toBe("resolved");
    if (negev.status === "resolved") {
      expect(negev.area.source).toBe("geo_area_index");
      expect(negev.feature.kind).toBe("vernacular_region");
    }

    const north = lookupGeoAreaIndex({ place: "Northern District", index });
    expect(north.status).toBe("resolved");

    const patagonia = lookupGeoAreaIndex({ place: "פטגוניה", index });
    expect(patagonia.status).toBe("resolved");

    const paca = lookupGeoAreaIndex({
      place: "Provence-Alpes-Côte d'Azur",
      index,
    });
    expect(paca.status).toBe("resolved");
  });

  it("does not invent הגליל / השרון / דרום צרפת — unresolved from index", () => {
    const index = loadGeoAreaIndex();
    expect(lookupGeoAreaIndex({ place: "הגליל", index }).status).toBe(
      "unresolved",
    );
    expect(lookupGeoAreaIndex({ place: "השרון", index }).status).toBe(
      "unresolved",
    );
    expect(lookupGeoAreaIndex({ place: "דרום צרפת", index }).status).toBe(
      "unresolved",
    );
    // Hebrew district label not in geoBoundaries English names — no alias.
    expect(lookupGeoAreaIndex({ place: "מחוז הצפון", index }).status).toBe(
      "unresolved",
    );
  });
});

describe("resolvePlaceViewport / resolveGeographicArea end cases", () => {
  it("הגליל without Nominatim → unresolved (none)", async () => {
    const out = await resolvePlaceViewport({
      place: "הגליל",
      apiKey: "test-key",
      allowNominatimFallback: false,
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ status: "ZERO_RESULTS", results: [] }),
        }) as Response) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("none");
  });

  it("הנגב resolves from index before Google", async () => {
    const fetchImpl = async () => {
      throw new Error("Google must not be called when index resolves");
    };
    const out = await resolveGeographicArea({
      place: "הנגב",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      allowNominatimFallback: false,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.area.source).toBe("geo_area_index");
    expect(out.area.geometry.type).toMatch(/Polygon|MultiPolygon/);
  });

  it("tiny Google Negev rejected when index disabled", async () => {
    const out = await resolvePlaceViewport({
      place: "הנגב",
      apiKey: "test-key",
      allowIndexLookup: false,
      allowNominatimFallback: false,
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            status: "OK",
            results: [
              {
                formatted_address: "הנגב",
                types: ["establishment", "natural_feature"],
                geometry: {
                  viewport: {
                    southwest: { lat: 30.7127, lng: 34.8744 },
                    northeast: { lat: 30.7154, lng: 34.8771 },
                  },
                },
              },
            ],
          }),
        }) as Response) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("invalid");
  });

  it("city / address class Google hits fail closed for area_restrict path", async () => {
    const city = await resolvePlaceViewport({
      place: "פתח תקווה",
      apiKey: "k",
      allowIndexLookup: false,
      allowNominatimFallback: false,
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            status: "OK",
            results: [
              {
                formatted_address: "פתח תקווה, ישראל",
                types: ["locality", "political"],
                geometry: {
                  viewport: {
                    southwest: { lat: 32.05, lng: 34.85 },
                    northeast: { lat: 32.12, lng: 34.92 },
                  },
                },
              },
            ],
          }),
        }) as Response) as unknown as typeof fetch,
    });
    // locality + exact name may still accept as named admin_narrow —
    // for area_restrict, exact city name is intentional. Street address is not.
    expect(city.ok).toBe(true);

    const address = await resolvePlaceViewport({
      place: "רחוב הרצל 1 תל אביב",
      apiKey: "k",
      allowIndexLookup: false,
      allowNominatimFallback: false,
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            status: "OK",
            results: [
              {
                formatted_address: "רחוב הרצל 1, תל אביב-יפו",
                types: ["street_address"],
                geometry: {
                  viewport: {
                    southwest: { lat: 32.06, lng: 34.77 },
                    northeast: { lat: 32.07, lng: 34.78 },
                  },
                },
              },
            ],
          }),
        }) as Response) as unknown as typeof fetch,
    });
    expect(address.ok).toBe(false);
  });

  it("Nominatim stays off by default even after Google none", async () => {
    let nominatimHits = 0;
    const out = await resolvePlaceViewport({
      place: "xyzzy-region",
      apiKey: "k",
      allowIndexLookup: false,
      // default allowNominatimFallback = false
      fetchImpl: (async (url: string) => {
        if (String(url).includes("nominatim")) {
          nominatimHits += 1;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ZERO_RESULTS", results: [] }),
        } as Response;
      }) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    expect(nominatimHits).toBe(0);
  });
});
