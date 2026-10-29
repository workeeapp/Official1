/**
 * Shared ACTION-location resolve via sendChatMessage (eval-db harness).
 * Stubbed LLM + stubbed Open-Meteo / Places fetch — no live provider calls.
 *
 * Asserts exact downstream coords and that geocoding is skipped only for
 * resolved coordinate sources. Does not verify live-model behavior.
 *
 * Run: npm run test:eval-db -w backend -- tests/live-location-sendchat.eval-db.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { resetEnvCache } from "../src/config/env.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import {
  clearPendingLocation,
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

const HOME_LAT = 32.099279;
const HOME_LNG = 34.8923104;
const PIN_LAT = 31.501;
const PIN_LNG = 34.501;
const CITY_GEO_LAT = 32.08;
const CITY_GEO_LNG = 34.78;

type FetchProbe = {
  url: string;
  body: string | null;
};

function installStubbedProviderFetch(): {
  probes: FetchProbe[];
  restore: () => void;
} {
  const probes: FetchProbe[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body != null
          ? String(init.body)
          : null;
    probes.push({ url, body });

    if (url.includes("geocoding-api.open-meteo.com")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              name: "Tel Aviv",
              latitude: CITY_GEO_LAT,
              longitude: CITY_GEO_LNG,
              country: "Israel",
              timezone: "Asia/Jerusalem",
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (
      url.includes("api.open-meteo.com/v1/forecast") ||
      url.includes("marine-api.open-meteo.com")
    ) {
      return new Response(
        JSON.stringify({
          timezone: "Asia/Jerusalem",
          current: {
            time: "2026-10-20T10:00",
            temperature_2m: 25,
            relative_humidity_2m: 50,
            weather_code: 0,
            wind_speed_10m: 12,
            wind_gusts_10m: 18,
            precipitation: 0,
          },
          daily: {
            time: ["2026-10-20"],
            weather_code: [0],
            temperature_2m_max: [28],
            temperature_2m_min: [18],
            precipitation_sum: [0],
            wind_speed_10m_max: [20],
          },
          hourly: {
            time: ["2026-10-20T10:00"],
            temperature_2m: [25],
            relative_humidity_2m: [50],
            weather_code: [0],
            wind_speed_10m: [12],
            wind_gusts_10m: [18],
            precipitation: [0],
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes("places.googleapis.com")) {
      return new Response(
        JSON.stringify({
          places: [
            {
              displayName: { text: "קפה בדיקה" },
              formattedAddress: "כתובת",
              location: { latitude: HOME_LAT, longitude: HOME_LNG },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("maps.googleapis.com") || url.includes("geocode")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              formatted_address: "תל אביב",
              geometry: {
                location: { lat: CITY_GEO_LAT, lng: CITY_GEO_LNG },
                viewport: {
                  southwest: { lat: 32.0, lng: 34.7 },
                  northeast: { lat: 32.2, lng: 34.9 },
                },
              },
            },
          ],
          status: "OK",
        }),
        { status: 200 },
      );
    }
    return new Response("unexpected host", { status: 500 });
  });
  vi.stubGlobal("fetch", spy);
  return {
    probes,
    restore() {
      vi.unstubAllGlobals();
    },
  };
}

function forecastUrls(probes: FetchProbe[]): string[] {
  return probes
    .map((p) => p.url)
    .filter((u) => u.includes("api.open-meteo.com/v1/forecast"));
}

function geocodeUrls(probes: FetchProbe[]): string[] {
  return probes
    .map((p) => p.url)
    .filter((u) => u.includes("geocoding-api.open-meteo.com"));
}

function placesBodies(probes: FetchProbe[]): string[] {
  return probes
    .filter((p) => p.url.includes("places.googleapis.com"))
    .map((p) => p.body ?? "");
}

async function seedHomeFiling(
  employeeId: string,
  itemInfo: string,
  itemName = "מיקום הבית",
) {
  return prisma.employeeFiling.create({
    data: {
      employeeId,
      itemName,
      itemInfo,
      itemDescription: "harness",
      scope: "personal",
      visibleTo: [],
    },
  });
}

describe("live location sendChat (eval-db, stubbed providers)", () => {
  let account: HarnessAccount | null = null;
  let whatsappTextSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fireDueSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scheduleSoonSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fetchProbe: ReturnType<typeof installStubbedProviderFetch> | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  beforeEach(async () => {
    await assertEvalDbAndGtfsUntouched();
    resetPendingLocations();
  });

  afterEach(async () => {
    setLlmClientForTests(null);
    fetchProbe?.restore();
    fetchProbe = null;
    whatsappTextSpy?.mockRestore();
    fireDueSpy?.mockRestore();
    scheduleSoonSpy?.mockRestore();
    whatsappTextSpy = null;
    fireDueSpy = null;
    scheduleSoonSpy = null;
    resetPendingLocations();
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  async function boot() {
    // Stubbed Places path still requires a non-empty key in getEnv.
    if (!process.env.GOOGLE_PLACES_API_KEY?.trim()) {
      process.env.GOOGLE_PLACES_API_KEY = "eval-stub-places-key";
      resetEnvCache();
    }
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account, "You answer live location asks.");
    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");
    fetchProbe = installStubbedProviderFetch();
    return lucyId;
  }

  it("1 weather saved home → exact home coords; no geocode", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    await seedHomeFiling(account!.employeeId, `${HOME_LAT}, ${HOME_LNG}`);
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          weather: {
            place: "מיקום הבית",
            near: "",
            aspects: ["temp"],
          },
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מה מזג האוויר ליד הבית?",
    });
    expect(whatsappTextSpy).not.toHaveBeenCalled();
    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/מיקום הבית|°|טמפ/);
    expect(geocodeUrls(fetchProbe!.probes)).toHaveLength(0);
    const forecast = forecastUrls(fetchProbe!.probes);
    expect(forecast.length).toBeGreaterThan(0);
    expect(forecast[0]).toContain(`latitude=${HOME_LAT}`);
    expect(forecast[0]).toContain(`longitude=${HOME_LNG}`);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("2 places saved home → bias at home coords", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    await seedHomeFiling(account!.employeeId, `${HOME_LAT}, ${HOME_LNG}`);
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "מחפשת.", buttons: [] }],
        metadata: {
          places: {
            query: "סופר",
            place: "מיקום הבית",
            near: "",
            aspects: ["summary"],
          },
        },
      }),
    );
    await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "סופר ליד הבית",
    });
    expect(whatsappTextSpy).not.toHaveBeenCalled();
    const bodies = placesBodies(fetchProbe!.probes);
    expect(bodies.length).toBeGreaterThan(0);
    const parsed = JSON.parse(bodies[0]!);
    expect(parsed.locationBias?.circle?.center?.latitude).toBeCloseTo(HOME_LAT);
    expect(parsed.locationBias?.circle?.center?.longitude).toBeCloseTo(
      HOME_LNG,
    );
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("3 weather home while pending pin exists → home coords; pin preserved", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    await seedHomeFiling(account!.employeeId, `${HOME_LAT}, ${HOME_LNG}`);
    setPendingLocation(account!.employeeId, {
      lat: PIN_LAT,
      lng: PIN_LNG,
      name: "סיכה ישנה",
      address: "",
    });
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          weather: {
            place: "מיקום הבית",
            near: "speaker",
            aspects: ["temp"],
          },
        },
      }),
    );
    await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מזג אוויר ליד הבית",
    });
    const forecast = forecastUrls(fetchProbe!.probes);
    expect(forecast[0]).toContain(`latitude=${HOME_LAT}`);
    expect(forecast[0]).not.toContain(`latitude=${PIN_LAT}`);
    expect(geocodeUrls(fetchProbe!.probes)).toHaveLength(0);
    const still = getPendingLocation(account!.employeeId);
    expect(still?.lat).toBeCloseTo(PIN_LAT);
    expect(still?.lng).toBeCloseTo(PIN_LNG);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("4 weather near=speaker uses pending pin coords and clears under existing guard", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    setPendingLocation(account!.employeeId, {
      lat: PIN_LAT,
      lng: PIN_LNG,
      name: "כאן",
      address: "",
    });
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          weather: {
            place: "",
            near: "speaker",
            aspects: ["temp"],
          },
        },
      }),
    );
    await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מה מזג האוויר כאן?",
    });
    const forecast = forecastUrls(fetchProbe!.probes);
    expect(forecast[0]).toContain(`latitude=${PIN_LAT}`);
    expect(forecast[0]).toContain(`longitude=${PIN_LNG}`);
    expect(geocodeUrls(fetchProbe!.probes)).toHaveLength(0);
    expect(getPendingLocation(account!.employeeId)).toBeNull();
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("5 ambiguous saved homes → ask; no provider forecast", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    await seedHomeFiling(account!.employeeId, `${HOME_LAT}, ${HOME_LNG}`);
    await seedHomeFiling(
      account!.employeeId,
      "32.05, 34.75",
      "בית הורים",
    );
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "", buttons: [] }],
        metadata: {
          weather: {
            place: "בית",
            near: "",
            aspects: ["temp"],
          },
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מזג אוויר בבית",
    });
    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/כמה מיקומים שמורים/);
    expect(forecastUrls(fetchProbe!.probes)).toHaveLength(0);
    expect(geocodeUrls(fetchProbe!.probes)).toHaveLength(0);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("6 saved home label without coords → ask; no geocode of label", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    await seedHomeFiling(account!.employeeId, "הרצל 1 תל אביב");
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "", buttons: [] }],
        metadata: {
          weather: {
            place: "מיקום הבית",
            near: "",
            aspects: ["temp"],
          },
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מזג אוויר ליד הבית",
    });
    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/אין קואורדינטות/);
    expect(forecastUrls(fetchProbe!.probes)).toHaveLength(0);
    expect(geocodeUrls(fetchProbe!.probes)).toHaveLength(0);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("7 named city still geocodes; pending pin ignored when place set", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    setPendingLocation(account!.employeeId, {
      lat: PIN_LAT,
      lng: PIN_LNG,
      name: "סיכה",
      address: "",
    });
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          weather: {
            place: "תל אביב",
            near: "",
            aspects: ["temp"],
          },
        },
      }),
    );
    await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מזג אוויר בתל אביב",
    });
    expect(geocodeUrls(fetchProbe!.probes).length).toBeGreaterThan(0);
    const forecast = forecastUrls(fetchProbe!.probes);
    expect(forecast[0]).toContain(`latitude=${CITY_GEO_LAT}`);
    expect(forecast[0]).not.toContain(`latitude=${PIN_LAT}`);
    expect(getPendingLocation(account!.employeeId)?.lat).toBeCloseTo(PIN_LAT);
    clearPendingLocation(account!.employeeId);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });
});
