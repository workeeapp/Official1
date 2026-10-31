/**
 * Nominatim geographic-area resolver — fixtures only (no live Nominatim).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePlaceViewport } from "../src/services/geocode-viewport.js";
import {
  clearNominatimAreaCache,
  resolveAreaFromNominatim,
} from "../src/services/nominatim-area.js";
import type { GeoMultiPolygon, GeoPolygon } from "../src/services/geo-area.js";

afterEach(() => {
  clearNominatimAreaCache();
  vi.restoreAllMocks();
});

const GALIL_POLY: GeoPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [35.0, 32.6],
      [35.6, 32.6],
      [35.6, 33.2],
      [35.0, 33.2],
      [35.0, 32.6],
    ],
  ],
};

const SHARON_POLY: GeoPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [34.75, 32.05],
      [35.05, 32.05],
      [35.05, 32.35],
      [34.75, 32.35],
      [34.75, 32.05],
    ],
  ],
};

const NEGEV_MULTI: GeoMultiPolygon = {
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [34.5, 29.5],
        [35.2, 29.5],
        [35.2, 31.2],
        [34.5, 31.2],
        [34.5, 29.5],
      ],
    ],
  ],
};

const PROVENCE_POLY: GeoPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [4.5, 43.2],
      [6.5, 43.2],
      [6.5, 44.5],
      [4.5, 44.5],
      [4.5, 43.2],
    ],
  ],
};

function nominatimFetch(rows: unknown[]) {
  return vi.fn(async (url: string) => {
    expect(String(url)).toContain("nominatim.openstreetmap.org/search");
    expect(String(url)).toContain("polygon_geojson=1");
    return {
      ok: true,
      status: 200,
      json: async () => rows,
    } as Response;
  });
}

describe("resolveAreaFromNominatim (fixtures)", () => {
  it("הגליל — single Polygon → ok with tight bbox", async () => {
    const fetchImpl = nominatimFetch([
      {
        display_name: "הגליל, ישראל",
        osm_type: "relation",
        osm_id: 1001,
        geojson: GALIL_POLY,
      },
    ]);
    const out = await resolveAreaFromNominatim({
      place: "הגליל",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      useCache: false,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.area.source).toBe("osm_nominatim");
    expect(out.area.geometry.type).toBe("Polygon");
    expect(out.area.bbox.low).toEqual({ lat: 32.6, lng: 35.0 });
    expect(out.area.bbox.high).toEqual({ lat: 33.2, lng: 35.6 });
    expect(out.area.providerRef).toBe("osm:relation/1001");
  });

  it("השרון — single Polygon → ok", async () => {
    const out = await resolveAreaFromNominatim({
      place: "השרון",
      fetchImpl: nominatimFetch([
        {
          display_name: "השרון, ישראל",
          osm_type: "relation",
          osm_id: 2002,
          geojson: SHARON_POLY,
        },
      ]) as unknown as typeof fetch,
      useCache: false,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.area.label).toContain("השרון");
  });

  it("הנגב — MultiPolygon → ok", async () => {
    const out = await resolveAreaFromNominatim({
      place: "הנגב",
      fetchImpl: nominatimFetch([
        {
          display_name: "הנגב, ישראל",
          osm_type: "relation",
          osm_id: 3003,
          geojson: NEGEV_MULTI,
        },
      ]) as unknown as typeof fetch,
      useCache: false,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.area.geometry.type).toBe("MultiPolygon");
  });

  it("אזור מחוץ לישראל (דרום צרפת) — Polygon → ok", async () => {
    const out = await resolveAreaFromNominatim({
      place: "דרום צרפת",
      fetchImpl: nominatimFetch([
        {
          display_name: "Provence-Alpes-Côte d'Azur, France",
          osm_type: "relation",
          osm_id: 4004,
          geojson: PROVENCE_POLY,
        },
      ]) as unknown as typeof fetch,
      useCache: false,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.area.bbox.low.lat).toBe(43.2);
  });

  it("אזור לא מוכר → none", async () => {
    const out = await resolveAreaFromNominatim({
      place: "xyzzy-no-such-region",
      fetchImpl: nominatimFetch([]) as unknown as typeof fetch,
      useCache: false,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("none");
  });

  it("שם עמום (ריבוי פוליגונים) → ambiguous fail closed", async () => {
    const out = await resolveAreaFromNominatim({
      place: "שרון",
      fetchImpl: nominatimFetch([
        {
          display_name: "השרון, ישראל",
          geojson: SHARON_POLY,
        },
        {
          display_name: "Sharon, USA",
          geojson: {
            type: "Polygon",
            coordinates: [
              [
                [-80.4, 41.2],
                [-80.3, 41.2],
                [-80.3, 41.3],
                [-80.4, 41.3],
                [-80.4, 41.2],
              ],
            ],
          },
        },
      ]) as unknown as typeof fetch,
      useCache: false,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("ambiguous");
  });

  it("Point-only / invalid geometry → invalid", async () => {
    const pointOnly = await resolveAreaFromNominatim({
      place: "נקודה",
      fetchImpl: nominatimFetch([
        {
          display_name: "נקודה",
          geojson: { type: "Point", coordinates: [34.8, 32.1] },
        },
      ]) as unknown as typeof fetch,
      useCache: false,
    });
    expect(pointOnly.ok).toBe(false);
    if (pointOnly.ok) return;
    expect(pointOnly.kind).toBe("invalid");

    const broken = await resolveAreaFromNominatim({
      place: "שבור",
      fetchImpl: nominatimFetch([
        {
          display_name: "שבור",
          geojson: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
              ],
            ],
          },
        },
      ]) as unknown as typeof fetch,
      useCache: false,
    });
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.kind).toBe("invalid");
  });

  it("positive cache avoids a second Nominatim fetch", async () => {
    const fetchImpl = nominatimFetch([
      {
        display_name: "הגליל, ישראל",
        osm_type: "relation",
        osm_id: 1001,
        geojson: GALIL_POLY,
      },
    ]);
    const a = await resolveAreaFromNominatim({
      place: "הגליל",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const b = await resolveAreaFromNominatim({
      place: "הגליל",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(a.ok && b.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("resolvePlaceViewport Nominatim fallback (offline)", () => {
  it("Google ZERO_RESULTS → Nominatim Polygon succeeds (הגליל)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes("maps.googleapis.com/maps/api/geocode")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ZERO_RESULTS", results: [] }),
        } as Response;
      }
      if (href.includes("nominatim.openstreetmap.org")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              display_name: "הגליל, ישראל",
              osm_type: "relation",
              osm_id: 1001,
              geojson: GALIL_POLY,
            },
          ],
        } as Response;
      }
      throw new Error(`unexpected url ${href}`);
    });
    const out = await resolvePlaceViewport({
      place: "הגליל",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      allowNominatimFallback: true,
      allowIndexLookup: false,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.viewport.source).toBe("osm_nominatim");
    expect(out.viewport.geometry?.type).toBe("Polygon");
    expect(out.viewport.low.lat).toBe(32.6);
  });

  it("Google ambiguous → no Nominatim; fail closed", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes("geocode")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "OK",
            results: [
              {
                formatted_address: "A",
                geometry: {
                  viewport: {
                    southwest: { lat: 32, lng: 34 },
                    northeast: { lat: 33, lng: 35 },
                  },
                },
              },
              {
                formatted_address: "B",
                geometry: {
                  viewport: {
                    southwest: { lat: 40, lng: -80 },
                    northeast: { lat: 41, lng: -79 },
                  },
                },
              },
            ],
          }),
        } as Response;
      }
      throw new Error(`Nominatim must not run: ${href}`);
    });
    const out = await resolvePlaceViewport({
      place: "שרון",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      allowNominatimFallback: true,
      allowIndexLookup: false,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("ambiguous");
    expect(
      fetchImpl.mock.calls.filter((c) =>
        String(c[0]).includes("nominatim"),
      ),
    ).toHaveLength(0);
  });
});
