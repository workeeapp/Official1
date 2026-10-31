/**
 * Stage 2B sendChat smoke (eval-db). Stub LLM ACTION; real Open-Meteo for weather.
 * Places Google mocked (no Google key in .env.live-full-eval — no paid calls).
 *
 * Run: npm run test:eval-db -w backend -- tests/stage2b-sendchat-smoke.eval-db.test.ts
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { resetEnvCache } from "../src/config/env.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import * as geographicResolve from "../src/services/geographic-resolve.js";
import type { GeographicMatch } from "../src/services/geographic-match.js";
import {
  clearPendingLocation,
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
  installRealFetchHostProbe,
  stubLlmReply,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const HOME_LAT = 32.099279;
const HOME_LNG = 34.8923104;
const PIN_LAT = 31.5;
const PIN_LNG = 34.5;

/** Recorded-style viewport for הגליל (mock Places only — not live Google). */
const GALIL_VIEWPORT = {
  low: { lat: 32.7, lng: 35.05 },
  high: { lat: 33.15, lng: 35.65 },
};

type ScenarioLog = {
  id: string;
  pass: boolean;
  spoken: string;
  coreCalls: Array<{
    rawText: string;
    geometryNeeds: unknown;
    status: string;
    kind: string;
    labelHe: string;
    provenance: string;
    coordinateProvenance?: string;
    savedRefId?: string;
    hadCoords?: boolean;
    representative?: boolean;
  }>;
  notes: string[];
};

const logs: ScenarioLog[] = [];

function installOutboundGuards() {
  const whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
  const fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
  const scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");
  return {
    assertNone() {
      expect(whatsappTextSpy).not.toHaveBeenCalled();
      expect(fireDueSpy).not.toHaveBeenCalled();
      expect(scheduleSoonSpy).not.toHaveBeenCalled();
    },
    restore() {
      whatsappTextSpy.mockRestore();
      fireDueSpy.mockRestore();
      scheduleSoonSpy.mockRestore();
    },
  };
}

function spyResolveGeographic() {
  const calls: ScenarioLog["coreCalls"] = [];
  const original = geographicResolve.resolveGeographic;
  const spy = vi
    .spyOn(geographicResolve, "resolveGeographic")
    .mockImplementation(async (input) => {
      const match: GeographicMatch = await original(input);
      calls.push({
        rawText: input.ask.rawText,
        geometryNeeds: input.geometryNeeds,
        status: match.status,
        kind: match.kind,
        labelHe: match.labelHe,
        provenance: match.provenance,
        coordinateProvenance: match.coordinateProvenance,
        savedRefId: match.savedRef?.id,
        hadCoords: match.savedRef?.hadCoordsAtResolve,
        representative: match.representativePoint?.justified === true,
      });
      return match;
    });
  return {
    calls,
    restore() {
      spy.mockRestore();
    },
  };
}

describe("Stage 2B sendChat smoke (eval-db)", () => {
  let account: HarnessAccount | null = null;
  let guards: ReturnType<typeof installOutboundGuards> | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  beforeEach(async () => {
    await assertEvalDbAndGtfsUntouched();
    resetPendingLocations();
  });

  afterEach(async () => {
    setLlmClientForTests(null);
    vi.unstubAllGlobals();
    guards?.restore();
    guards = null;
    resetPendingLocations();
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  afterAll(() => {
    // eslint-disable-next-line no-console
    console.info(
      "[stage2b-smoke] SUMMARY\n" +
        logs
          .map(
            (l) =>
              `${l.pass ? "PASS" : "FAIL"} ${l.id} | core=${l.coreCalls.length} | ${l.notes.join("; ")} | spoken=${JSON.stringify(l.spoken.slice(0, 160))}`,
          )
          .join("\n"),
    );
  });

  async function boot() {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account, "You answer weather/places.");
    guards = installOutboundGuards();
    return lucyId;
  }

  it("1. Weather צפת — real OM via sendChat + Core", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    const core = spyResolveGeographic();
    const probe = installRealFetchHostProbe([
      "geocoding-api.open-meteo.com",
      "api.open-meteo.com",
      "marine-api.open-meteo.com",
    ]);

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          weather: { place: "צפת", near: "", date: "", aspects: ["summary", "temp"] },
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מה מזג האוויר בצפת?",
    });
    const spoken = parseLlmReply(result.reply).response;
    guards!.assertNone();

    const usedOm = probe.probes.some((p) => p.host.includes("open-meteo.com"));
    const coreHit = core.calls.find((c) => c.rawText === "צפת");
    const pass =
      usedOm &&
      core.calls.length > 0 &&
      Boolean(coreHit && coreHit.status === "resolved") &&
      /צפת|Safed|מזג|°|טמפ/i.test(spoken) &&
      !/לא זיהיתי|לא הצלחתי לשלוף/.test(spoken);

    logs.push({
      id: "1-weather-safed",
      pass,
      spoken,
      coreCalls: [...core.calls],
      notes: [
        `om=${usedOm}`,
        `coreStatus=${coreHit?.status}/${coreHit?.kind}/${coreHit?.provenance}`,
      ],
    });
    core.restore();
    probe.restore();
    expect(pass, spoken).toBe(true);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  }, 45_000);

  it("2. Weather הגליל — no silent צפת / גליל ים", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    const core = spyResolveGeographic();
    const probe = installRealFetchHostProbe([
      "geocoding-api.open-meteo.com",
      "api.open-meteo.com",
      "marine-api.open-meteo.com",
      "maps.googleapis.com",
    ]);

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          weather: { place: "הגליל", near: "", date: "", aspects: ["temp"] },
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מה מזג האוויר בגליל?",
    });
    const spoken = parseLlmReply(result.reply).response;
    guards!.assertNone();

    const coreHit = core.calls.find((c) => c.rawText.includes("גליל"));
    const silentWrong =
      /צפת|Safed|גליל ים|Sea of Galilee/i.test(spoken) &&
      !/גליל \(נקודה מייצגת|הגליל \(נקודה מייצגת|באיזו עיר|לא זיהיתי|אזור רחב/i.test(
        spoken,
      );
    // Accept: justified region representative labeled הגליל, OR natural clarify.
    const okRegion =
      coreHit?.status === "resolved" &&
      coreHit.kind === "region" &&
      /גליל/.test(coreHit.labelHe) &&
      !/צפת|גליל ים/.test(coreHit.labelHe);
    const okClarify =
      coreHit?.status === "needs_clarify" ||
      /באיזו עיר|לא זיהיתי|אזור רחב|מדויק יותר/.test(spoken);
    const pass = !silentWrong && (okRegion || okClarify) && core.calls.length > 0;

    logs.push({
      id: "2-weather-galil",
      pass,
      spoken,
      coreCalls: [...core.calls],
      notes: [
        `core=${coreHit?.status}/${coreHit?.kind}/${coreHit?.labelHe}`,
        `hosts=${[...new Set(probe.probes.map((p) => p.host))].join(",")}`,
        `silentWrong=${silentWrong}`,
      ],
    });
    core.restore();
    probe.restore();
    expect(pass, spoken).toBe(true);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  }, 45_000);

  it("3. Weather השרון — not an unrelated location dump", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    const core = spyResolveGeographic();
    const probe = installRealFetchHostProbe([
      "geocoding-api.open-meteo.com",
      "api.open-meteo.com",
      "marine-api.open-meteo.com",
      "maps.googleapis.com",
    ]);

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          weather: { place: "השרון", near: "", date: "", aspects: ["temp"] },
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מה מזג האוויר בשרון?",
    });
    const spoken = parseLlmReply(result.reply).response;
    guards!.assertNone();

    const coreHit = core.calls.find((c) => c.rawText.includes("שרון"));
    const unrelated =
      /(תל אביב|Tel Aviv|ירושלים|Jerusalem|חיפה|Haifa)/i.test(spoken) &&
      !/שרון/.test(spoken);
    const okRegion =
      coreHit?.status === "resolved" &&
      /שרון/.test(coreHit.labelHe) &&
      !unrelated;
    const okClarify =
      coreHit?.status === "needs_clarify" ||
      /באיזו עיר|לא זיהיתי|אזור רחב|מדויק יותר|שרון/.test(spoken);
    const pass = !unrelated && (okRegion || okClarify) && core.calls.length > 0;

    logs.push({
      id: "3-weather-sharon",
      pass,
      spoken,
      coreCalls: [...core.calls],
      notes: [
        `core=${coreHit?.status}/${coreHit?.kind}/${coreHit?.labelHe}`,
        `unrelated=${unrelated}`,
      ],
    });
    core.restore();
    probe.restore();
    expect(pass, spoken).toBe(true);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  }, 45_000);

  it("4. Weather בבית — saved with coords (pin ignored)", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    const filing = await prisma.employeeFiling.create({
      data: {
        employeeId: account!.employeeId,
        itemName: "בית",
        itemInfo: `${HOME_LAT}, ${HOME_LNG}`,
        itemDescription: "smoke",
        scope: "personal",
        visibleTo: [],
      },
    });
    setPendingLocation(account!.employeeId, {
      lat: PIN_LAT,
      lng: PIN_LNG,
      name: "סיכה",
      address: "",
    });
    const core = spyResolveGeographic();
    // Forecast stubbed so we assert coords without depending on marine; geocode unused.
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.open-meteo.com/v1/forecast")) {
        return new Response(
          JSON.stringify({
            timezone: "Asia/Jerusalem",
            current: {
              time: "2026-10-31T12:00",
              temperature_2m: 22,
              relative_humidity_2m: 40,
              weather_code: 0,
              wind_speed_10m: 10,
              wind_gusts_10m: 14,
              precipitation: 0,
            },
            daily: {
              time: ["2026-10-31"],
              weather_code: [0],
              temperature_2m_max: [24],
              temperature_2m_min: [16],
              precipitation_sum: [0],
              wind_speed_10m_max: [15],
            },
            hourly: {
              time: ["2026-10-31T12:00"],
              temperature_2m: [22],
              relative_humidity_2m: [40],
              weather_code: [0],
              wind_speed_10m: [10],
              wind_gusts_10m: [14],
              precipitation: [0],
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch in saved-coords smoke: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          weather: { place: "בית", near: "", date: "", aspects: ["temp"] },
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מה מזג האוויר בבית?",
    });
    const spoken = parseLlmReply(result.reply).response;
    guards!.assertNone();

    const forecastUrl = fetchSpy.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("forecast"));
    const usedHome =
      typeof forecastUrl === "string" &&
      forecastUrl.includes(`latitude=${HOME_LAT}`);
    const usedPin =
      typeof forecastUrl === "string" &&
      forecastUrl.includes(`latitude=${PIN_LAT}`);
    // RAL may short-circuit with useCoords before Core; Core optional here.
    const pass =
      usedHome &&
      !usedPin &&
      /בית|מזג|°|טמפ|22/.test(spoken);

    logs.push({
      id: "4-weather-home-coords",
      pass,
      spoken,
      coreCalls: [...core.calls],
      notes: [
        `filing=${filing.id}`,
        `forecast=${forecastUrl ?? "none"}`,
        `coreCalls=${core.calls.length}`,
        `layer=${core.calls.length ? "core-or-ral+core" : "ral-hit-useCoords"}`,
      ],
    });
    core.restore();
    clearPendingLocation(account!.employeeId);
    expect(pass, spoken).toBe(true);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  }, 30_000);

  it("5. Weather אצל סבתא — saved without coords + geocode keeps identity", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    // Nickname filing (not address-like name) with street in item_info — product case.
    const filing = await prisma.employeeFiling.create({
      data: {
        employeeId: account!.employeeId,
        itemName: "סבתא",
        itemInfo: "הרצל 5 רמת גן",
        itemDescription: "",
        scope: "personal",
        visibleTo: [],
      },
    });
    const core = spyResolveGeographic();
    const geocodeNames: string[] = [];
    const forecastUrls: string[] = [];
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        try {
          const u = new URL(url);
          if (u.host.includes("geocoding-api.open-meteo.com")) {
            geocodeNames.push(u.searchParams.get("name") ?? "");
          }
          if (u.pathname.includes("/v1/forecast")) {
            forecastUrls.push(url);
          }
        } catch {
          /* ignore */
        }
        return realFetch(input, init);
      }),
    );

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          weather: { place: "סבתא", near: "", date: "", aspects: ["temp"] },
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מה מזג האוויר אצל סבתא?",
    });
    const spoken = parseLlmReply(result.reply).response;
    guards!.assertNone();

    const coreSaved = core.calls.find(
      (c) => c.savedRefId === filing.id || c.kind === "saved",
    );
    const geocodedAddress = geocodeNames.some((n) => n.includes("הרצל"));
    const notGeocodedAliasAlone =
      geocodeNames.length === 0 ||
      geocodeNames.every((n) => n !== "סבתא" || n.includes("הרצל"));
    const usedForecast = forecastUrls.length > 0;
    // Identity preserved: savedRef on Core match; spoken may say סבתא or city after geocode.
    const pass =
      core.calls.length > 0 &&
      Boolean(coreSaved?.savedRefId === filing.id) &&
      coreSaved?.hadCoords === false &&
      coreSaved.status === "resolved" &&
      coreSaved.kind === "saved" &&
      geocodedAddress &&
      notGeocodedAliasAlone &&
      usedForecast &&
      !/לא זיהיתי|יחידה מינהלית|narrow_admin/.test(spoken);

    logs.push({
      id: "5-weather-grandma-nocoords",
      pass,
      spoken,
      coreCalls: [...core.calls],
      notes: [
        `filing=${filing.id}`,
        `source=filing`,
        `savedRef=${coreSaved?.savedRefId}`,
        `label=${coreSaved?.labelHe}`,
        `coordProv=${coreSaved?.coordinateProvenance}`,
        `geocodeNames=${JSON.stringify(geocodeNames)}`,
        `forecast=${forecastUrls[0] ?? "none"}`,
      ],
    });
    core.restore();
    expect(pass, `layer check: ${JSON.stringify({ core: core.calls, geocodeNames, spoken })}`).toBe(
      true,
    );
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  }, 45_000);

  it("6. Places מסעדות בגליל — regional locationRestriction; no jargon", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    process.env.GOOGLE_PLACES_API_KEY = "eval-dummy-places-key-not-live";
    resetEnvCache();
    const lucyId = await boot();
    const core = spyResolveGeographic();

    const placesBodies: unknown[] = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = String(input);
      if (href.includes("maps.googleapis.com/maps/api/geocode")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "OK",
            results: [
              {
                formatted_address: "הגליל, ישראל",
                partial_match: false,
                types: ["colloquial_area", "political"],
                geometry: {
                  location_type: "APPROXIMATE",
                  location: { lat: 32.9, lng: 35.3 },
                  viewport: {
                    northeast: {
                      lat: GALIL_VIEWPORT.high.lat,
                      lng: GALIL_VIEWPORT.high.lng,
                    },
                    southwest: {
                      lat: GALIL_VIEWPORT.low.lat,
                      lng: GALIL_VIEWPORT.low.lng,
                    },
                  },
                  bounds: {
                    northeast: {
                      lat: GALIL_VIEWPORT.high.lat,
                      lng: GALIL_VIEWPORT.high.lng,
                    },
                    southwest: {
                      lat: GALIL_VIEWPORT.low.lat,
                      lng: GALIL_VIEWPORT.low.lng,
                    },
                  },
                },
              },
            ],
          }),
        } as Response;
      }
      if (href.includes("places.googleapis.com")) {
        placesBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: [
              {
                id: "places/galil-1",
                displayName: { text: "מסעדה בגליל", languageCode: "he" },
                formattedAddress: "הגליל",
                location: { latitude: 32.95, longitude: 35.4 },
              },
            ],
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch (no live Google): ${href}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "מחפשת.", buttons: [] }],
        metadata: {
          places: {
            query: "מסעדות",
            place: "הגליל",
            near: "",
            geo_mode: "area_restrict",
            aspects: ["summary"],
            intent: "business",
          },
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מסעדות באזור הגליל",
    });
    const spoken = parseLlmReply(result.reply).response;
    guards!.assertNone();

    const body = placesBodies[0] as {
      locationRestriction?: { rectangle?: unknown };
      locationBias?: unknown;
      textQuery?: string;
    };
    const hasRestriction = Boolean(body?.locationRestriction?.rectangle);
    const noBias = body?.locationBias == null;
    const noJargon = !/יחידה מינהלית|narrow_admin/.test(spoken);
    const coreArea = core.calls.find(
      (c) =>
        c.rawText.includes("גליל") &&
        JSON.stringify(c.geometryNeeds).includes("area"),
    );
    const pass =
      placesBodies.length > 0 &&
      hasRestriction &&
      noBias &&
      noJargon &&
      Boolean(coreArea) &&
      !/לא זיהיתי את האזור/.test(spoken);

    logs.push({
      id: "6-places-galil-area",
      pass,
      spoken,
      coreCalls: [...core.calls],
      notes: [
        `placesCalls=${placesBodies.length}`,
        `restriction=${hasRestriction}`,
        `coreArea=${coreArea?.status}/${coreArea?.kind}`,
        `textQuery=${body?.textQuery ?? ""}`,
      ],
    });
    core.restore();
    expect(pass, spoken).toBe(true);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  }, 30_000);
});
