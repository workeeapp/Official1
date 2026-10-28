/**
 * Stage B1: Places geographic intent — pending pin must not bias named city/area.
 * Asserts Google Places request body (locationBias), not only Hebrew replies.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePlacesAction } from "@workee/shared";
import {
  getPendingLocation,
  resetPendingLocations,
  setPendingLocation,
} from "../src/services/pending-location.js";
import { resolvePlacesReplyDetailed } from "../src/services/places.js";
import {
  PLACES_DEFAULT_BIAS_RADIUS_METERS,
} from "../src/services/places.js";

const EMP = "emp-places-b1";
const PIN = { lat: 32.087, lng: 34.887 };

afterEach(() => {
  resetPendingLocations();
  vi.restoreAllMocks();
});

function placesSearchFetchImpl(
  rows: Array<Record<string, unknown>> = [
    {
      id: "places/1",
      displayName: { text: "קפה", languageCode: "he" },
      nationalPhoneNumber: "03-1",
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

function readBody(fetchImpl: ReturnType<typeof placesSearchFetchImpl>) {
  const init = fetchImpl.mock.calls[0]![1] as RequestInit;
  return JSON.parse(String(init.body ?? "{}")) as {
    textQuery?: string;
    locationBias?: {
      circle?: {
        center?: { latitude?: number; longitude?: number };
        radius?: number;
      };
    };
    rankPreference?: string;
  };
}

describe("places Stage B1 pin intent", () => {
  it("explicit city + pending pin: textQuery has city, no locationBias from pin", async () => {
    setPendingLocation(EMP, {
      lat: PIN.lat,
      lng: PIN.lng,
      name: "פינ ישן",
      address: "",
    });
    expect(getPendingLocation(EMP)).not.toBeNull();

    const action = parsePlacesAction({
      places: {
        query: "מסעדה",
        place: "חיפה",
        near: "",
        aspects: ["summary"],
      },
    });
    expect(action?.near).toBe("");
    expect(action?.place).toBe("חיפה");

    // Chat B1 contract: do not pass pending when near !== speaker.
    const fetchImpl = placesSearchFetchImpl();
    const result = await resolvePlacesReplyDetailed({
      query: action!.query,
      place: action!.place,
      nearSpeaker: false,
      lat: null,
      lng: null,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.usedPendingPin).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = readBody(fetchImpl);
    expect(body.textQuery).toBe("מסעדה חיפה");
    expect(body.locationBias).toBeUndefined();
    expect(body.rankPreference).toBeUndefined();
    // Defense: even if a caller wrongly passes stale pin coords with a city…
    const leak = placesSearchFetchImpl();
    await resolvePlacesReplyDetailed({
      query: "מסעדה",
      place: "חיפה",
      nearSpeaker: false,
      lat: PIN.lat,
      lng: PIN.lng,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: leak as unknown as typeof fetch,
    });
    const leakBody = readBody(leak);
    expect(leakBody.textQuery).toBe("מסעדה חיפה");
    expect(leakBody.locationBias).toBeUndefined();
  });

  it("near=speaker + pending pin: locationBias uses pin coords", async () => {
    setPendingLocation(EMP, {
      lat: PIN.lat,
      lng: PIN.lng,
      name: "",
      address: "",
    });
    const action = parsePlacesAction({
      places: {
        query: "בית קפה",
        place: "",
        near: "speaker",
        aspects: ["summary"],
      },
    });
    expect(action?.near).toBe("speaker");

    const pin = getPendingLocation(EMP)!;
    const fetchImpl = placesSearchFetchImpl();
    const result = await resolvePlacesReplyDetailed({
      query: action!.query,
      place: "",
      nearSpeaker: true,
      lat: pin.lat,
      lng: pin.lng,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.usedPendingPin).toBe(true);
    const body = readBody(fetchImpl);
    expect(body.textQuery).toBe("בית קפה");
    expect(body.locationBias?.circle?.center).toEqual({
      latitude: PIN.lat,
      longitude: PIN.lng,
    });
    expect(body.locationBias?.circle?.radius).toBe(
      PLACES_DEFAULT_BIAS_RADIUS_METERS,
    );
    expect(body.rankPreference).toBe("DISTANCE");
  });

  it("named area without speaker: area in textQuery, no pin circle", async () => {
    const fetchImpl = placesSearchFetchImpl();
    await resolvePlacesReplyDetailed({
      query: "בית קפה",
      place: "השרון",
      nearSpeaker: false,
      lat: null,
      lng: null,
      includedType: "cafe",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = readBody(fetchImpl);
    expect(body.textQuery).toBe("בית קפה השרון");
    expect(body.locationBias).toBeUndefined();
  });

  it("explicit ACTION coordinates (empty place) get locationBias", async () => {
    const fetchImpl = placesSearchFetchImpl();
    const result = await resolvePlacesReplyDetailed({
      query: "פיצה",
      place: "",
      nearSpeaker: false,
      lat: 31.5,
      lng: 34.75,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // Empty place + coords → treated as pin-style nearSpeaker inside adapter.
    expect(result.usedPendingPin).toBe(false);
    const body = readBody(fetchImpl);
    expect(body.textQuery).toBe("פיצה");
    expect(body.locationBias?.circle?.center).toEqual({
      latitude: 31.5,
      longitude: 34.75,
    });
  });

  it("rejects out-of-range ACTION coords (no provider locationBias)", async () => {
    const fetchImpl = placesSearchFetchImpl();
    const result = await resolvePlacesReplyDetailed({
      query: "פיצה",
      place: "",
      nearSpeaker: true,
      lat: 999,
      lng: 34,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.needsLocation).toBe(true);
    expect(result.usedPendingPin).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clear deixis reuse: near=speaker after intervening turn still biases pin", async () => {
    setPendingLocation(EMP, {
      lat: PIN.lat,
      lng: PIN.lng,
      name: "מיקום ששלחתי",
      address: "",
    });
    // Intervening Lucy turn does not clear pending.
    expect(getPendingLocation(EMP)).not.toBeNull();

    const action = parsePlacesAction({
      places: {
        query: "מסעדה",
        place: "",
        near: "speaker",
        aspects: ["summary"],
      },
    });
    expect(action?.near).toBe("speaker");
    const pin = getPendingLocation(EMP)!;
    const fetchImpl = placesSearchFetchImpl();
    const result = await resolvePlacesReplyDetailed({
      query: action!.query,
      place: "",
      nearSpeaker: true,
      lat: pin.lat,
      lng: pin.lng,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.usedPendingPin).toBe(true);
    const body = readBody(fetchImpl);
    expect(body.locationBias?.circle?.center).toEqual({
      latitude: PIN.lat,
      longitude: PIN.lng,
    });
  });
});
