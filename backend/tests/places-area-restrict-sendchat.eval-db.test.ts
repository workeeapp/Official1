/**
 * Mocked Geocoding + Places sendChat E2E for B2a area_restrict (eval-db).
 * Stubbed LLM + stubbed global fetch — no live Google requests.
 * Non-destructive; leaves GTFS generation untouched.
 *
 * Run: npm run test:eval-db -w backend -- tests/places-area-restrict-sendchat.eval-db.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { resetEnvCache } from "../src/config/env.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import {
  getPendingLocation,
  resetPendingLocations,
  setPendingLocation,
} from "../src/services/pending-location.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  stubLlmReply,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

/** Recorded live Geocoding OK for השרון (validated viewport). */
const SHARON_GEOCODE = {
  status: "OK",
  results: [
    {
      formatted_address: "השרון, ישראל",
      partial_match: false,
      types: ["administrative_area_level_2", "political"],
      geometry: {
        location_type: "APPROXIMATE",
        location: { lat: 32.3235643, lng: 34.9286096 },
        viewport: {
          northeast: { lat: 32.4126018, lng: 35.051422 },
          southwest: { lat: 32.1909859, lng: 34.809082 },
        },
        bounds: {
          northeast: { lat: 32.4126018, lng: 35.051422 },
          southwest: { lat: 32.1909859, lng: 34.809082 },
        },
      },
    },
  ],
};

/** Recorded live Geocoding for גוש דן — partial_match fail-closed. */
const GUSH_DAN_GEOCODE = {
  status: "OK",
  results: [
    {
      formatted_address: "",
      partial_match: true,
      types: ["political"],
      geometry: {
        viewport: {
          northeast: { lat: 32.2095311, lng: 34.9287191 },
          southwest: { lat: 31.85245, lng: 34.7126462 },
        },
        bounds: {
          northeast: { lat: 32.2095311, lng: 34.9287191 },
          southwest: { lat: 31.85245, lng: 34.7126462 },
        },
      },
    },
  ],
};

const SHARON_RECT = {
  low: { latitude: 32.1909859, longitude: 34.809082 },
  high: { latitude: 32.4126018, longitude: 35.051422 },
};

const STALE_PIN = {
  lat: 32.087,
  lng: 34.887,
  name: "פינ ישן",
  address: "",
};

type PlacesBody = {
  textQuery?: string;
  locationBias?: unknown;
  rankPreference?: string;
  locationRestriction?: {
    rectangle?: {
      low?: { latitude?: number; longitude?: number };
      high?: { latitude?: number; longitude?: number };
    };
  };
};

function installMockGoogleFetch(geocodePayload: unknown): {
  placesBodies: PlacesBody[];
  placesCallCount: () => number;
  geocodeCallCount: () => number;
  restore: () => void;
} {
  const placesBodies: PlacesBody[] = [];
  let placesCalls = 0;
  let geocodeCalls = 0;
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = String(input);
    if (href.includes("maps.googleapis.com/maps/api/geocode")) {
      geocodeCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => geocodePayload,
      } as Response;
    }
    if (href.includes("places.googleapis.com")) {
      placesCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as PlacesBody;
      placesBodies.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: "places/sharon-1",
              displayName: { text: "קפה בשרון", languageCode: "he" },
              nationalPhoneNumber: "09-1112222",
              formattedAddress: "השרון",
            },
          ],
        }),
      } as Response;
    }
    throw new Error(
      `Unexpected fetch escaped Google mock (no live calls allowed): ${href}`,
    );
  });
  vi.stubGlobal("fetch", spy);
  return {
    placesBodies,
    placesCallCount: () => placesCalls,
    geocodeCallCount: () => geocodeCalls,
    restore() {
      vi.unstubAllGlobals();
    },
  };
}

describe("Places area_restrict sendChat E2E (eval-db, mocked Google)", () => {
  let account: HarnessAccount | null = null;
  let whatsappTextSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fireDueSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scheduleSoonSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
    // Dummy key only — fetch is fully stubbed; never hit real Google.
    process.env.GOOGLE_PLACES_API_KEY = "test-dummy-places-key-not-live";
    resetEnvCache();
  });

  beforeEach(async () => {
    await assertEvalDbAndGtfsUntouched();
    resetPendingLocations();
  });

  afterEach(async () => {
    setLlmClientForTests(null);
    vi.unstubAllGlobals();
    resetPendingLocations();
    whatsappTextSpy?.mockRestore();
    fireDueSpy?.mockRestore();
    scheduleSoonSpy?.mockRestore();
    whatsappTextSpy = null;
    fireDueSpy = null;
    scheduleSoonSpy = null;
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  function installOutboundGuards() {
    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");
  }

  function assertNoOutbound() {
    expect(whatsappTextSpy).not.toHaveBeenCalled();
    expect(fireDueSpy).not.toHaveBeenCalled();
    expect(scheduleSoonSpy).not.toHaveBeenCalled();
  }

  it("area_restrict השרון: sendChat → locationRestriction rectangle; pin ignored/retained", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const mock = installMockGoogleFetch(SHARON_GEOCODE);

    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(
      account,
      "You answer local business questions in Hebrew.",
    );
    setPendingLocation(account.employeeId, STALE_PIN);
    expect(getPendingLocation(account.employeeId)).toMatchObject({
      lat: STALE_PIN.lat,
      lng: STALE_PIN.lng,
    });

    installOutboundGuards();
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "מחפשת בשרון.", buttons: [] }],
        metadata: {
          places: {
            query: "בית קפה",
            place: "השרון",
            near: "",
            geo_mode: "area_restrict",
            aspects: ["summary"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תמצאי בתי קפה באזור השרון",
    });

    assertNoOutbound();
    expect(mock.geocodeCallCount()).toBe(1);
    expect(mock.placesCallCount()).toBe(1);
    expect(mock.placesBodies).toHaveLength(1);
    const body = mock.placesBodies[0]!;
    expect(body.textQuery).toBe("בית קפה");
    expect(body.locationBias).toBeUndefined();
    expect(body.rankPreference).toBeUndefined();
    expect(body.locationRestriction?.rectangle).toEqual(SHARON_RECT);

    const pinAfter = getPendingLocation(account.employeeId);
    expect(pinAfter).not.toBeNull();
    expect(pinAfter?.lat).toBe(STALE_PIN.lat);
    expect(pinAfter?.lng).toBe(STALE_PIN.lng);

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken).not.toMatch(/שלח מיקום בוואטסאפ/);

    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
    mock.restore();
  });

  it("area_restrict גוש דן partial_match: no Places searchText; clarify; pin retained", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const mock = installMockGoogleFetch(GUSH_DAN_GEOCODE);

    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(
      account,
      "You answer local business questions in Hebrew.",
    );
    setPendingLocation(account.employeeId, STALE_PIN);
    expect(getPendingLocation(account.employeeId)).not.toBeNull();

    installOutboundGuards();
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת אזור.", buttons: [] }],
        metadata: {
          places: {
            query: "בית קפה",
            place: "גוש דן",
            near: "",
            geo_mode: "area_restrict",
            aspects: ["summary"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תמצאי בתי קפה בגוש דן",
    });

    assertNoOutbound();
    expect(mock.geocodeCallCount()).toBe(1);
    expect(mock.placesCallCount()).toBe(0);
    expect(mock.placesBodies).toHaveLength(0);

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/גוש דן|אזור|לאיזה|בטוח|מדויק/);
    expect(spoken).not.toMatch(/09-1112222|קפה בשרון/);

    const pinAfter = getPendingLocation(account.employeeId);
    expect(pinAfter).not.toBeNull();
    expect(pinAfter?.lat).toBe(STALE_PIN.lat);
    expect(pinAfter?.lng).toBe(STALE_PIN.lng);

    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
    mock.restore();
  });
});
