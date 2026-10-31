/**
 * Stage B2a: Places geo_mode=area_restrict → locationRestriction rectangle.
 * Asserts Google Places request body (never bias+restrict together).
 * Geocoding is mocked — no live Google calls.
 *
 * Galil: parse + constraint regression for «באזור הגליל» expected ACTION shape.
 * Does NOT prove live Lucy emits area_restrict (needs separate model-eval).
 * Does NOT prove Google Geocoding returns a unique viewport for «הגליל»
 * (live Geocoding follow-up; no alias until recorded).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizePlacesGeoMode,
  parsePlacesAction,
} from "@workee/shared";
import { evaluateConstraints } from "../src/eval/constraints.js";
import {
  getPendingLocation,
  resetPendingLocations,
  setPendingLocation,
} from "../src/services/pending-location.js";
import {
  buildPlacesFieldMask,
  fetchPlacesFacts,
  PLACES_LOCATION_FIELD,
  resolvePlacesReplyDetailed,
} from "../src/services/places.js";
import type { ResolvedViewport } from "../src/services/resolved-location.js";
import type {
  GeoPolygon,
  ResolveGeographicAreaResult,
  ResolvedGeographicArea,
} from "../src/services/geo-area.js";

const EMP = "emp-places-b2a";
const PIN = { lat: 32.087, lng: 34.887 };
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

const SHARON_AREA: ResolvedGeographicArea = {
  label: "השרון, ישראל",
  geometry: SHARON_POLY,
  bbox: {
    low: { lat: 32.05, lng: 34.75 },
    high: { lat: 32.35, lng: 35.05 },
  },
  source: "geocode_viewport",
};

/** Same region as SHARON_AREA — used when injecting areaViewport into fetchPlacesFacts. */
const SHARON_VP: ResolvedViewport = {
  low: SHARON_AREA.bbox.low,
  high: SHARON_AREA.bbox.high,
  label: SHARON_AREA.label,
  source: SHARON_AREA.source,
  geometry: SHARON_AREA.geometry,
};

afterEach(() => {
  resetPendingLocations();
  vi.restoreAllMocks();
});

function placesSearchFetchImpl(
  rows: Array<Record<string, unknown>> = [
    {
      id: "places/1",
      displayName: { text: "קפה שרון", languageCode: "he" },
      nationalPhoneNumber: "09-1",
      formattedAddress: "רחוב 1",
      // Inside SHARON_VP — required for area_restrict polygon filter.
      location: { latitude: 32.2, longitude: 34.9 },
    },
  ],
  opts?: { nextPageToken?: string },
) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        places: rows,
        ...(opts?.nextPageToken
          ? { nextPageToken: opts.nextPageToken }
          : {}),
      }),
    } as Response;
  });
}

type PlacesBody = {
  textQuery?: string;
  locationBias?: unknown;
  locationRestriction?: {
    rectangle?: {
      low?: { latitude?: number; longitude?: number };
      high?: { latitude?: number; longitude?: number };
    };
  };
  rankPreference?: string;
};

function readPlacesBody(fetchImpl: ReturnType<typeof placesSearchFetchImpl>) {
  const init = fetchImpl.mock.calls[0]![1] as RequestInit;
  return JSON.parse(String(init.body ?? "{}")) as PlacesBody;
}

function okArea(): typeof resolveAreaOk {
  return resolveAreaOk;
}

async function resolveAreaOk(input: {
  place: string;
}): Promise<ResolveGeographicAreaResult> {
  return {
    ok: true,
    area: { ...SHARON_AREA, label: input.place || SHARON_AREA.label },
  };
}

describe("normalizePlacesGeoMode / parsePlacesAction", () => {
  it("Galil area ask: parse → area_restrict + place הגליל; near cleared (expected ACTION shape)", () => {
    const action = parsePlacesAction({
      places: {
        query: "מסעדות",
        place: "הגליל",
        near: "speaker",
        geo_mode: "area_restrict",
        aspects: ["summary"],
        intent: "business",
      },
    });
    expect(action).not.toBeNull();
    expect(action!.geoMode).toBe("area_restrict");
    expect(action!.place).toBe("הגליל");
    expect(action!.query).toContain("מסעד");
    expect(action!.near).toBe("");
    expect(action!.lat).toBeNull();
    expect(action!.lng).toBeNull();

    const scored = evaluateConstraints(
      [
        { type: "live_domain_only", domain: "places" },
        {
          type: "places_action",
          queryIncludes: "מסעד",
          placeIncludes: "גליל",
          geoMode: "area_restrict",
          nearEmpty: true,
          intent: "business",
        },
      ],
      {
        lists: [],
        listOps: [],
        filing: [],
        messages: [],
        reminders: [],
        directory: [],
        jobs: [],
        confirm: null,
        handoff: null,
        places: {
          query: "מסעדות",
          place: "הגליל",
          near: "speaker",
          geo_mode: "area_restrict",
          aspects: ["summary"],
          intent: "business",
        },
      } as never,
      "",
    );
    expect(scored.ok).toBe(true);
  });

  it("defaults soft_place; area_restrict clears near/lat/lng and requires place", () => {
    expect(normalizePlacesGeoMode(undefined)).toBe("soft_place");
    expect(normalizePlacesGeoMode(null)).toBe("soft_place");
    expect(normalizePlacesGeoMode("area_restrict")).toBe("area_restrict");
    // Undocumented aliases must not upgrade to area_restrict.
    expect(normalizePlacesGeoMode("restrict")).toBe("soft_place");
    expect(normalizePlacesGeoMode("hard")).toBe("soft_place");
    expect(normalizePlacesGeoMode("inside")).toBe("soft_place");
    expect(normalizePlacesGeoMode("within")).toBe("soft_place");

    const soft = parsePlacesAction({
      places: {
        query: "בית קפה",
        place: "פתח תקווה",
        near: "",
        aspects: ["summary"],
      },
    });
    expect(soft?.geoMode).toBe("soft_place");
    expect(soft?.place).toBe("פתח תקווה");

    const hard = parsePlacesAction({
      places: {
        query: "בית קפה",
        place: "השרון",
        near: "speaker",
        lat: 32.1,
        lng: 34.8,
        geo_mode: "area_restrict",
        aspects: ["summary"],
      },
    });
    expect(hard?.geoMode).toBe("area_restrict");
    expect(hard?.near).toBe("");
    expect(hard?.lat).toBeNull();
    expect(hard?.lng).toBeNull();
    expect(hard?.place).toBe("השרון");

    expect(
      parsePlacesAction({
        places: {
          query: "בית קפה",
          place: "",
          geo_mode: "area_restrict",
          aspects: ["summary"],
        },
      }),
    ).toBeNull();
  });
});

describe("places Stage B2a area_restrict", () => {
  it("happy path: locationRestriction rectangle, no locationBias, no DISTANCE, query without region stuffing", async () => {
    const action = parsePlacesAction({
      places: {
        query: "בית קפה",
        place: "השרון",
        near: "",
        geo_mode: "area_restrict",
        included_type: "cafe",
        aspects: ["summary"],
      },
    });
    expect(action?.geoMode).toBe("area_restrict");

    const fetchImpl = placesSearchFetchImpl();
    const result = await resolvePlacesReplyDetailed({
      query: action!.query,
      place: action!.place,
      nearSpeaker: false,
      areaRestrict: true,
      includedType: action!.includedType,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveArea: okArea(),
    });
    expect(result.needsLocation).toBe(false);
    expect(result.usedPendingPin).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = readPlacesBody(fetchImpl);
    expect(body.textQuery).toBe("בית קפה");
    expect(body.locationRestriction?.rectangle?.low).toEqual({
      latitude: SHARON_VP.low.lat,
      longitude: SHARON_VP.low.lng,
    });
    expect(body.locationRestriction?.rectangle?.high).toEqual({
      latitude: SHARON_VP.high.lat,
      longitude: SHARON_VP.high.lng,
    });
    expect(body.locationBias).toBeUndefined();
    expect(body.rankPreference).toBeUndefined();
  });

  it("soft_place vs area_restrict for the same place string", async () => {
    const softFetch = placesSearchFetchImpl();
    await resolvePlacesReplyDetailed({
      query: "בית קפה",
      place: "השרון",
      nearSpeaker: false,
      areaRestrict: false,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: softFetch as unknown as typeof fetch,
    });
    const softBody = readPlacesBody(softFetch);
    expect(softBody.textQuery).toBe("בית קפה השרון");
    expect(softBody.locationRestriction).toBeUndefined();
    expect(softBody.locationBias).toBeUndefined();

    const hardFetch = placesSearchFetchImpl();
    await resolvePlacesReplyDetailed({
      query: "בית קפה",
      place: "השרון",
      nearSpeaker: false,
      areaRestrict: true,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: hardFetch as unknown as typeof fetch,
      resolveArea: okArea(),
    });
    const hardBody = readPlacesBody(hardFetch);
    expect(hardBody.textQuery).toBe("בית קפה");
    expect(hardBody.locationRestriction).toBeDefined();
    expect(hardBody.locationBias).toBeUndefined();
  });

  it("stale pending pin + area_restrict: no pin circle / no bias", async () => {
    setPendingLocation(EMP, {
      lat: PIN.lat,
      lng: PIN.lng,
      name: "פינ ישן",
      address: "",
    });
    expect(getPendingLocation(EMP)).not.toBeNull();

    const fetchImpl = placesSearchFetchImpl();
    // Defense: even if caller wrongly passes stale pin coords…
    await resolvePlacesReplyDetailed({
      query: "מסעדה",
      place: "השרון",
      nearSpeaker: true,
      areaRestrict: true,
      lat: PIN.lat,
      lng: PIN.lng,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveArea: okArea(),
    });
    const body = readPlacesBody(fetchImpl);
    expect(body.locationBias).toBeUndefined();
    expect(body.rankPreference).toBeUndefined();
    expect(body.locationRestriction).toBeDefined();
    expect(getPendingLocation(EMP)).not.toBeNull();
  });

  it("unresolved / ambiguous geocode → no searchText; clarify; pin uncleared", async () => {
    setPendingLocation(EMP, {
      lat: PIN.lat,
      lng: PIN.lng,
      name: "פינ",
      address: "",
    });
    const fetchImpl = placesSearchFetchImpl();
    const ambiguous = await resolvePlacesReplyDetailed({
      query: "בית קפה",
      place: "שרון",
      areaRestrict: true,
      lat: PIN.lat,
      lng: PIN.lng,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveArea: async () => ({
        ok: false,
        kind: "ambiguous",
        messageHe: "מצאתי כמה אזורים. לאיזה התכוונת?",
      }),
    });
    expect(ambiguous.needsLocation).toBe(true);
    expect(ambiguous.usedPendingPin).toBe(false);
    expect(ambiguous.text).toContain("לאיזה");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getPendingLocation(EMP)).not.toBeNull();

    const none = await resolvePlacesReplyDetailed({
      query: "בית קפה",
      place: "xyzzy",
      areaRestrict: true,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveArea: async () => ({
        ok: false,
        kind: "none",
        messageHe: "לא זיהיתי את האזור.",
      }),
    });
    expect(none.needsLocation).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("invalid viewport from geocode → no Places call", async () => {
    const fetchImpl = placesSearchFetchImpl();
    const result = await resolvePlacesReplyDetailed({
      query: "בית קפה",
      place: "השרון",
      areaRestrict: true,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveArea: async () => ({
        ok: false,
        kind: "invalid",
        messageHe: "לא הצלחתי לקבוע גבולות.",
      }),
    });
    expect(result.needsLocation).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("geocode HTTP/network failure → fail closed with zero searchText calls", async () => {
    const httpFail = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes("maps.googleapis.com/maps/api/geocode")) {
        return {
          ok: false,
          status: 503,
          json: async () => ({}),
        } as Response;
      }
      throw new Error(`Places searchText must not run: ${href}`);
    });
    const httpResult = await resolvePlacesReplyDetailed({
      query: "בית קפה",
      place: "השרון",
      areaRestrict: true,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: httpFail as unknown as typeof fetch,
      // Real resolveGeographicArea → geocode path — no resolveArea stub.
    });
    expect(httpResult.needsLocation).toBe(true);
    expect(httpResult.usedPendingPin).toBe(false);
    expect(
      httpFail.mock.calls.filter((c) =>
        String(c[0]).includes("places.googleapis.com"),
      ),
    ).toHaveLength(0);

    const netFail = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes("maps.googleapis.com/maps/api/geocode")) {
        throw new Error("network down");
      }
      throw new Error(`Places searchText must not run: ${href}`);
    });
    const netResult = await resolvePlacesReplyDetailed({
      query: "בית קפה",
      place: "השרון",
      areaRestrict: true,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: netFail as unknown as typeof fetch,
    });
    expect(netResult.needsLocation).toBe(true);
    expect(
      netFail.mock.calls.filter((c) =>
        String(c[0]).includes("places.googleapis.com"),
      ),
    ).toHaveLength(0);
  });

  it("fetchPlacesFacts never sends locationBias with locationRestriction", async () => {
    const fetchImpl = placesSearchFetchImpl();
    await fetchPlacesFacts({
      query: "בית קפה",
      place: "השרון",
      nearSpeaker: true,
      lat: PIN.lat,
      lng: PIN.lng,
      areaRestrict: true,
      areaViewport: SHARON_VP,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = readPlacesBody(fetchImpl);
    expect(body.locationRestriction).toBeDefined();
    expect(body.locationBias).toBeUndefined();
    expect(body.rankPreference).toBeUndefined();
    expect(body.textQuery).toBe("בית קפה");
  });

  it("area_restrict FieldMask includes places.location; soft_place does not", () => {
    expect(buildPlacesFieldMask(["summary"], "business")).not.toContain(
      PLACES_LOCATION_FIELD,
    );
    expect(
      buildPlacesFieldMask(["summary"], "business", { areaRestrict: true }),
    ).toContain(PLACES_LOCATION_FIELD);
  });

  it("polygon filter drops outside / missing coords; keeps inside only", async () => {
    const fetchImpl = placesSearchFetchImpl([
      {
        id: "places/in",
        displayName: { text: "בתוך" },
        location: { latitude: 32.2, longitude: 34.9 },
      },
      {
        id: "places/out",
        displayName: { text: "מחוץ" },
        // Inside bbox-ish but outside SHARON_POLY if we used a tighter poly —
        // use clearly outside the rectangle.
        location: { latitude: 31.0, longitude: 34.9 },
      },
      {
        id: "places/nocoords",
        displayName: { text: "בלי מיקום" },
      },
    ]);
    const facts = await fetchPlacesFacts({
      query: "בית קפה",
      place: "השרון",
      areaRestrict: true,
      areaViewport: SHARON_VP,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(facts.results.map((r) => r.name)).toEqual(["בתוך"]);
    expect(facts.areaPolygonFiltered).toBe(true);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(String(headers["X-Goog-FieldMask"] ?? "")).toContain(
      PLACES_LOCATION_FIELD,
    );
  });

  /**
   * PIP regression on the Places product path (fetchPlacesFacts), not helper-only.
   * Controlled fixtures — no live Geocoding / Places API.
   */
  describe("PIP regression via fetchPlacesFacts", () => {
    it("Polygon: keeps interior, rejects exterior", async () => {
      const fetchImpl = placesSearchFetchImpl([
        {
          id: "places/in",
          displayName: { text: "בתוך" },
          location: { latitude: 32.2, longitude: 34.9 },
        },
        {
          id: "places/out",
          displayName: { text: "מחוץ" },
          location: { latitude: 31.0, longitude: 34.9 },
        },
      ]);
      const facts = await fetchPlacesFacts({
        query: "בית קפה",
        place: "השרון",
        areaRestrict: true,
        areaViewport: SHARON_VP,
        aspects: ["summary"],
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(facts.results.map((r) => r.name)).toEqual(["בתוך"]);
      expect(facts.areaPolygonFiltered).toBe(true);
    });

    it("MultiPolygon: keeps island hits, rejects gap between parts", async () => {
      const multiVp: ResolvedViewport = {
        low: { lat: 0, lng: 0 },
        high: { lat: 11, lng: 11 },
        label: "two-islands",
        source: "geo_area_index",
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
              ],
            ],
            [
              [
                [10, 10],
                [11, 10],
                [11, 11],
                [10, 11],
                [10, 10],
              ],
            ],
          ],
        },
      };
      const fetchImpl = placesSearchFetchImpl([
        {
          id: "places/a",
          displayName: { text: "באי א" },
          location: { latitude: 0.5, longitude: 0.5 },
        },
        {
          id: "places/gap",
          displayName: { text: "בין האיים" },
          location: { latitude: 5, longitude: 5 },
        },
        {
          id: "places/b",
          displayName: { text: "באי ב" },
          location: { latitude: 10.5, longitude: 10.5 },
        },
      ]);
      const facts = await fetchPlacesFacts({
        query: "מסעדה",
        place: "two-islands",
        areaRestrict: true,
        areaViewport: multiVp,
        aspects: ["summary"],
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(facts.results.map((r) => r.name).sort()).toEqual([
        "באי א",
        "באי ב",
      ]);
      expect(facts.areaPolygonFiltered).toBe(true);
      const body = readPlacesBody(fetchImpl);
      expect(body.locationRestriction).toBeDefined();
      expect(body.locationBias).toBeUndefined();
    });

    it("boundary of Polygon kept (closed region policy)", async () => {
      // SHARON_POLY SW corner (lng 34.75, lat 32.05) and a clear exterior.
      const fetchImpl = placesSearchFetchImpl([
        {
          id: "places/corner",
          displayName: { text: "על הגבול" },
          location: { latitude: 32.05, longitude: 34.75 },
        },
        {
          id: "places/out",
          displayName: { text: "מחוץ" },
          location: { latitude: 31.0, longitude: 34.9 },
        },
      ]);
      const facts = await fetchPlacesFacts({
        query: "בית קפה",
        place: "השרון",
        areaRestrict: true,
        areaViewport: SHARON_VP,
        aspects: ["summary"],
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(facts.results.map((r) => r.name)).toEqual(["על הגבול"]);
      expect(facts.areaPolygonFiltered).toBe(true);
    });
  });

  it("saturated page + outside drops → one optional follow-up page (capped)", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        pageToken?: string;
      };
      if (!body.pageToken) {
        // Full first page: all outside polygon → force follow-up.
        const rows = Array.from({ length: 10 }, (_, i) => ({
          id: `places/out-${i}`,
          displayName: { text: `מחוץ ${i}` },
          location: { latitude: 31.0, longitude: 34.9 },
        }));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: rows,
            nextPageToken: "page-2",
          }),
        } as Response;
      }
      expect(body.pageToken).toBe("page-2");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: "places/in-p2",
              displayName: { text: "בתוך בדף 2" },
              location: { latitude: 32.2, longitude: 34.9 },
            },
          ],
        }),
      } as Response;
    });

    const facts = await fetchPlacesFacts({
      query: "בית קפה",
      place: "השרון",
      areaRestrict: true,
      areaViewport: SHARON_VP,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(calls).toBe(2);
    expect(facts.results.map((r) => r.name)).toEqual(["בתוך בדף 2"]);
    expect(facts.providerPartial).toBe(true);
    expect(facts.areaPolygonFiltered).toBe(true);
  });

  it("soft_place still stuffs place into textQuery and skips polygon path", async () => {
    const fetchImpl = placesSearchFetchImpl([
      {
        id: "places/soft",
        displayName: { text: "קפה" },
        // No location — soft_place must still keep the row.
      },
    ]);
    const facts = await fetchPlacesFacts({
      query: "בית קפה",
      place: "פתח תקווה",
      areaRestrict: false,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(facts.results).toHaveLength(1);
    expect(facts.areaPolygonFiltered).toBeUndefined();
    const body = readPlacesBody(fetchImpl);
    expect(body.textQuery).toBe("בית קפה פתח תקווה");
    expect(body.locationRestriction).toBeUndefined();
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const mask = String(
      (init.headers as Record<string, string>)["X-Goog-FieldMask"] ?? "",
    );
    expect(mask).not.toContain(PLACES_LOCATION_FIELD);
  });
});
