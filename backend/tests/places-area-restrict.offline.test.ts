/**
 * Stage B2a: Places geo_mode=area_restrict → locationRestriction rectangle.
 * Asserts Google Places request body (never bias+restrict together).
 * Geocoding is mocked — no live Google calls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizePlacesGeoMode,
  parsePlacesAction,
} from "@workee/shared";
import {
  getPendingLocation,
  resetPendingLocations,
  setPendingLocation,
} from "../src/services/pending-location.js";
import {
  fetchPlacesFacts,
  resolvePlacesReplyDetailed,
} from "../src/services/places.js";
import type { GeocodeViewportResult } from "../src/services/geocode-viewport.js";
import type { ResolvedViewport } from "../src/services/resolved-location.js";

const EMP = "emp-places-b2a";
const PIN = { lat: 32.087, lng: 34.887 };
const SHARON_VP: ResolvedViewport = {
  low: { lat: 32.05, lng: 34.75 },
  high: { lat: 32.35, lng: 35.05 },
  label: "השרון, ישראל",
  source: "geocode_viewport",
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
    },
  ],
) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ places: rows }),
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

function okViewport(): typeof resolveViewportOk {
  return resolveViewportOk;
}

async function resolveViewportOk(input: {
  place: string;
}): Promise<GeocodeViewportResult> {
  return {
    ok: true,
    viewport: { ...SHARON_VP, label: input.place || SHARON_VP.label },
  };
}

describe("normalizePlacesGeoMode / parsePlacesAction", () => {
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
      resolveViewport: okViewport(),
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
      resolveViewport: okViewport(),
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
      resolveViewport: okViewport(),
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
      resolveViewport: async () => ({
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
      resolveViewport: async () => ({
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
      resolveViewport: async () => ({
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
      // Real geocode helper — no resolveViewport stub.
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
});
