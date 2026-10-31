/**
 * Geographic Core v1 — cross-domain sendChat acceptance (eval-db).
 * Stub LLM ACTION; providers mocked except free Open-Meteo where noted.
 * No production DB, WhatsApp sends, or live Google/Hebcal paid calls.
 *
 * Run: npm run test:eval-db -w backend -- tests/geographic-core-v1-acceptance.eval-db.test.ts
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

const PIN = { lat: 32.087, lng: 34.887, name: "פינ", address: "" };
const TIBERIAS = { lat: 32.7922, lng: 35.5312 };
const KINNERET_VIEWPORT = {
  low: { lat: 32.7, lng: 35.5 },
  high: { lat: 32.9, lng: 35.65 },
};

type CoreCall = {
  rawText: string;
  consumerHint?: string;
  geometryNeeds: unknown;
  status: string;
  kind: string;
  labelHe: string;
  provenance: string;
  coordinateProvenance?: string;
  savedRefId?: string;
  hadCoords?: boolean;
  representative?: boolean;
  policyTrace?: string;
};

type ScenarioLog = {
  id: string;
  pass: boolean;
  intent: string;
  core: string;
  spoken: string;
  evidence: string;
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
  const calls: CoreCall[] = [];
  const original = geographicResolve.resolveGeographic;
  const spy = vi
    .spyOn(geographicResolve, "resolveGeographic")
    .mockImplementation(async (input) => {
      const match: GeographicMatch = await original(input);
      calls.push({
        rawText: input.ask.rawText,
        consumerHint: input.ask.consumerHint,
        geometryNeeds: input.geometryNeeds,
        status: match.status,
        kind: match.kind,
        labelHe: match.labelHe,
        provenance: match.provenance,
        coordinateProvenance: match.coordinateProvenance,
        savedRefId: match.savedRef?.id,
        hadCoords: match.savedRef?.hadCoordsAtResolve,
        representative: match.representativePoint?.justified === true,
        policyTrace: match.policyTrace,
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

function summarizeCore(calls: CoreCall[]): string {
  if (calls.length === 0) return "(no Core call)";
  return calls
    .map(
      (c) =>
        `${c.rawText || "∅"}→${c.status}/${c.kind}` +
        (c.savedRefId ? ` savedRef=${c.savedRefId.slice(0, 8)}` : "") +
        (c.coordinateProvenance
          ? ` coordProv=${c.coordinateProvenance}`
          : "") +
        (c.policyTrace ? ` trace=${c.policyTrace}` : ""),
    )
    .join(" | ");
}

describe("Geographic Core v1 cross-domain acceptance (eval-db)", () => {
  let account: HarnessAccount | null = null;
  let guards: ReturnType<typeof installOutboundGuards> | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
    process.env.GOOGLE_PLACES_API_KEY = "eval-dummy-places-key-not-live";
    process.env.GOOGLE_ROUTES_API_KEY = "eval-dummy-routes-key-not-live";
    resetEnvCache();
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
      "[geo-v1-acceptance] SUMMARY\n" +
        logs
          .map(
            (l) =>
              `${l.pass ? "PASS" : "FAIL"} ${l.id}\n` +
              `  intent: ${l.intent}\n` +
              `  core: ${l.core}\n` +
              `  spoken: ${JSON.stringify(l.spoken.slice(0, 200))}\n` +
              `  evidence: ${l.evidence}\n` +
              `  notes: ${l.notes.join("; ")}`,
          )
          .join("\n"),
    );
  });

  async function boot(instructions: string) {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account, instructions);
    guards = installOutboundGuards();
    return lucyId;
  }

  it('1. Places — "מסעדות באזור הכנרת" area search, no city swap', async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot("You answer places.");
    const core = spyResolveGeographic();
    const placesBodies: Array<{
      textQuery?: string;
      locationRestriction?: { rectangle?: unknown };
      locationBias?: unknown;
    }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const href = String(input);
        if (href.includes("maps.googleapis.com/maps/api/geocode")) {
          return new Response(
            JSON.stringify({
              status: "OK",
              results: [
                {
                  formatted_address: "הכנרת, ישראל",
                  partial_match: false,
                  types: ["natural_feature", "colloquial_area"],
                  geometry: {
                    location_type: "APPROXIMATE",
                    location: { lat: 32.8, lng: 35.58 },
                    viewport: {
                      northeast: {
                        lat: KINNERET_VIEWPORT.high.lat,
                        lng: KINNERET_VIEWPORT.high.lng,
                      },
                      southwest: {
                        lat: KINNERET_VIEWPORT.low.lat,
                        lng: KINNERET_VIEWPORT.low.lng,
                      },
                    },
                    bounds: {
                      northeast: {
                        lat: KINNERET_VIEWPORT.high.lat,
                        lng: KINNERET_VIEWPORT.high.lng,
                      },
                      southwest: {
                        lat: KINNERET_VIEWPORT.low.lat,
                        lng: KINNERET_VIEWPORT.low.lng,
                      },
                    },
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (href.includes("places.googleapis.com")) {
          placesBodies.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(
            JSON.stringify({
              places: [
                {
                  id: "places/kinneret-1",
                  displayName: { text: "מסעדה על הכנרת", languageCode: "he" },
                  formattedAddress: "טבריה",
                  location: { latitude: 32.79, longitude: 35.54 },
                },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch (no live Google): ${href}`);
      }),
    );

    const intent = {
      places: {
        query: "מסעדות",
        place: "הכנרת",
        near: "",
        geo_mode: "area_restrict",
        aspects: ["summary"],
        intent: "business",
      },
    };
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "מחפשת.", buttons: [] }],
        metadata: intent,
      }),
    );

    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מסעדות באזור הכנרת",
    });
    const spoken = parseLlmReply(result.reply).response;
    guards!.assertNone();

    const body = placesBodies[0];
    const coreArea = core.calls.find(
      (c) =>
        /כנרת/.test(c.rawText) &&
        JSON.stringify(c.geometryNeeds).includes("area"),
    );
    const pass =
      placesBodies.length > 0 &&
      Boolean(body?.locationRestriction?.rectangle) &&
      body?.locationBias == null &&
      Boolean(coreArea && coreArea.status === "resolved") &&
      /כנרת/.test(coreArea!.labelHe) &&
      !/יחידה מינהלית|narrow_admin|צפת|גליל ים/.test(spoken) &&
      !/לא זיהיתי את האזור/.test(spoken);

    logs.push({
      id: "1-places-kinneret-area",
      pass,
      intent: JSON.stringify(intent.places),
      core: summarizeCore(core.calls),
      spoken,
      evidence: "mock Google Geocode + Places (no live paid)",
      notes: [
        `restriction=${Boolean(body?.locationRestriction?.rectangle)}`,
        `core=${coreArea?.status}/${coreArea?.kind}/${coreArea?.labelHe}`,
      ],
    });
    core.restore();
    expect(pass, spoken).toBe(true);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  }, 30_000);

  it('2. Routes — "איך מגיעים באוטובוס לכנרת?" clarifies region endpoint', async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot("You answer routes.");
    setPendingLocation(account!.employeeId, { ...PIN, at: Date.now() });
    const core = spyResolveGeographic();
    let routesComputeCalls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const href = String(input);
        if (href.includes("routes.googleapis.com")) {
          routesComputeCalls += 1;
          throw new Error("Routes compute must not run for region destination");
        }
        if (href.includes("places.googleapis.com")) {
          // Point ladder empty → fall through to area providers.
          return new Response(JSON.stringify({ places: [] }), { status: 200 });
        }
        if (href.includes("geocoding-api.open-meteo.com")) {
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        if (href.includes("maps.googleapis.com/maps/api/geocode")) {
          return new Response(
            JSON.stringify({
              status: "OK",
              results: [
                {
                  formatted_address: "הכנרת, ישראל",
                  partial_match: false,
                  types: ["natural_feature", "colloquial_area"],
                  geometry: {
                    location_type: "APPROXIMATE",
                    location: { lat: 32.8, lng: 35.58 },
                    viewport: {
                      northeast: {
                        lat: KINNERET_VIEWPORT.high.lat,
                        lng: KINNERET_VIEWPORT.high.lng,
                      },
                      southwest: {
                        lat: KINNERET_VIEWPORT.low.lat,
                        lng: KINNERET_VIEWPORT.low.lng,
                      },
                    },
                    bounds: {
                      northeast: {
                        lat: KINNERET_VIEWPORT.high.lat,
                        lng: KINNERET_VIEWPORT.high.lng,
                      },
                      southwest: {
                        lat: KINNERET_VIEWPORT.low.lat,
                        lng: KINNERET_VIEWPORT.low.lng,
                      },
                    },
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${href}`);
      }),
    );

    const intent = {
      routes: {
        origin: "speaker",
        destination: "כנרת",
        mode: "transit",
        aspects: ["summary"],
      },
    };
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: intent,
      }),
    );

    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "איך מגיעים באוטובוס לכנרת?",
    });
    const spoken = parseLlmReply(result.reply).response;
    guards!.assertNone();

    const destCore = core.calls.find((c) => /כנרת/.test(c.rawText));
    const clarifies =
      /נקוד|יעד|מדויק|לאיזו|באיזו עיר|אזור/.test(spoken) ||
      destCore?.status === "needs_clarify" ||
      destCore?.status === "unsupported_for_consumer" ||
      destCore?.kind === "region";
    const noCentroidInvent =
      routesComputeCalls === 0 &&
      !/טבריה|מסלול מומלץ|דק׳|דקות/.test(spoken);
    const pass =
      Boolean(destCore) &&
      clarifies &&
      noCentroidInvent &&
      !/יחידה מינהלית|narrow_admin/.test(spoken);

    logs.push({
      id: "2-routes-kinneret-clarify",
      pass,
      intent: JSON.stringify(intent.routes),
      core: summarizeCore(core.calls),
      spoken,
      evidence: "mock Places empty + OM empty + Geocode region (no live paid)",
      notes: [
        `routesCompute=${routesComputeCalls}`,
        `dest=${destCore?.status}/${destCore?.kind}`,
      ],
    });
    core.restore();
    clearPendingLocation(account!.employeeId);
    expect(pass, spoken).toBe(true);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  }, 30_000);

  it('3. Routes — "איך מגיעים באוטובוס לטבריה?" usable transit endpoint', async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot("You answer routes.");
    setPendingLocation(account!.employeeId, { ...PIN, at: Date.now() });
    const core = spyResolveGeographic();
    const computeBodies: Array<{
      travelMode?: string;
      destination?: {
        location?: { latLng?: { latitude?: number; longitude?: number } };
        address?: string;
      };
    }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const href = String(input);
        if (href.includes("routes.googleapis.com")) {
          computeBodies.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(
            JSON.stringify({
              routes: [
                {
                  duration: "3600s",
                  localizedValues: { duration: { text: "שעה" } },
                  legs: [
                    {
                      steps: [
                        {
                          travelMode: "TRANSIT",
                          staticDuration: "3600s",
                          transitDetails: {
                            headsign: "טבריה",
                            stopDetails: {
                              departureStop: { name: "מוצא" },
                              arrivalStop: { name: "טבריה מרכז" },
                              departureTime: "2026-10-31T08:00:00.000Z",
                              arrivalTime: "2026-10-31T09:00:00.000Z",
                            },
                            transitLine: { nameShort: "500" },
                            localizedValues: {
                              departureTime: { time: { text: "11:00" } },
                              arrivalTime: { time: { text: "12:00" } },
                            },
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (href.includes("places.googleapis.com")) {
          return new Response(
            JSON.stringify({
              places: [
                {
                  displayName: { text: "טבריה" },
                  location: {
                    latitude: TIBERIAS.lat,
                    longitude: TIBERIAS.lng,
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (href.includes("geocoding-api.open-meteo.com")) {
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        if (href.includes("maps.googleapis.com")) {
          return new Response(
            JSON.stringify({ status: "ZERO_RESULTS", results: [] }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${href}`);
      }),
    );

    const intent = {
      routes: {
        origin: "speaker",
        destination: "טבריה",
        mode: "transit",
        aspects: ["summary"],
      },
    };
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: intent,
      }),
    );

    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "איך מגיעים באוטובוס לטבריה?",
    });
    const spoken = parseLlmReply(result.reply).response;
    guards!.assertNone();

    const destCore = core.calls.find((c) => /טבריה/.test(c.rawText));
    const dest = computeBodies[0]?.destination?.location?.latLng;
    const destOk =
      dest != null &&
      Math.abs((dest.latitude ?? 0) - TIBERIAS.lat) < 0.05 &&
      Math.abs((dest.longitude ?? 0) - TIBERIAS.lng) < 0.05;
    const transit =
      computeBodies[0]?.travelMode === "TRANSIT" ||
      computeBodies.length > 0;
    const pass =
      computeBodies.length > 0 &&
      destOk &&
      transit &&
      destCore?.status === "resolved" &&
      !/לאיזו|באיזו עיר|אזור רחב/.test(spoken) &&
      /טבריה|אוטובוס|מסלול|שעה|11:00|בודקת|דק/.test(spoken);

    logs.push({
      id: "3-routes-tiberias-transit",
      pass,
      intent: JSON.stringify(intent.routes),
      core: summarizeCore(core.calls),
      spoken,
      evidence: "mock Places point + mock Routes TRANSIT (no live paid)",
      notes: [
        `destLat=${dest?.latitude}`,
        `destLng=${dest?.longitude}`,
        `mode=${computeBodies[0]?.travelMode}`,
        `coreDest=${destCore?.status}/${destCore?.kind}`,
      ],
    });
    core.restore();
    clearPendingLocation(account!.employeeId);
    expect(pass, JSON.stringify({ spoken, dest, core: destCore })).toBe(true);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  }, 30_000);

  it('4. Weather — "מה מזג האוויר אצל סבתא?" savedRef survives geocode', async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot("You answer weather.");
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

    const intent = {
      weather: { place: "סבתא", near: "", date: "", aspects: ["temp"] },
    };
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: intent,
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
    const noAddressLevelClaim =
      !/ברחוב הרצל\s*5|בדיוק ברחוב|בכתובת הרצל/.test(spoken);
    const pass =
      Boolean(coreSaved?.savedRefId === filing.id) &&
      coreSaved?.hadCoords === false &&
      coreSaved?.status === "resolved" &&
      coreSaved?.kind === "saved" &&
      coreSaved?.provenance === "saved" &&
      Boolean(coreSaved?.coordinateProvenance) &&
      coreSaved?.coordinateProvenance !== "saved" &&
      geocodedAddress &&
      forecastUrls.length > 0 &&
      noAddressLevelClaim &&
      !/יחידה מינהלית|narrow_admin/.test(spoken);

    logs.push({
      id: "4-weather-grandma-saved",
      pass,
      intent: JSON.stringify(intent.weather),
      core: summarizeCore(core.calls),
      spoken,
      evidence: "real Open-Meteo geocode+forecast; stub LLM",
      notes: [
        `savedRef=${coreSaved?.savedRefId}`,
        `label=${coreSaved?.labelHe}`,
        `prov=${coreSaved?.provenance}`,
        `coordProv=${coreSaved?.coordinateProvenance}`,
        `geocodeNames=${JSON.stringify(geocodeNames)}`,
        `noAddressClaim=${noAddressLevelClaim}`,
      ],
    });
    core.restore();
    expect(
      pass,
      JSON.stringify({ core: coreSaved, geocodeNames, spoken }),
    ).toBe(true);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  }, 45_000);

  it('5. Jewish — "מתי נכנסת שבת בצפת?" named city → Hebcal', async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot("You answer jewish.");
    const core = spyResolveGeographic();
    const hebcalUrls: string[] = [];
    const omNames: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("geocoding-api.open-meteo.com")) {
          try {
            omNames.push(new URL(url).searchParams.get("name") ?? "");
          } catch {
            /* ignore */
          }
          return new Response(
            JSON.stringify({
              results: [
                {
                  name: "צפת",
                  latitude: 32.9646,
                  longitude: 35.496,
                  timezone: "Asia/Jerusalem",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("hebcal.com")) {
          hebcalUrls.push(url);
          return new Response(
            JSON.stringify({
              location: { title: "צפת", city: "Safed" },
              items: [
                {
                  category: "candles",
                  title: "Candle lighting",
                  date: "2026-10-30T16:45:00+03:00",
                },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const intent = {
      jewish: { place: "צפת", date: "", aspects: ["candles"] },
    };
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: intent,
      }),
    );

    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מתי נכנסת שבת בצפת?",
    });
    const spoken = parseLlmReply(result.reply).response;
    guards!.assertNone();

    const coreHit = core.calls.find((c) => /צפת/.test(c.rawText));
    const hebcal = hebcalUrls[0] ?? "";
    // צפת is not in IL_GEONAME → lat/lng Hebcal path after Core skip ladder.
    const latOk =
      /latitude=32\.96/.test(hebcal) || /geonameid=/.test(hebcal);
    const lngOk =
      /longitude=35\.49/.test(hebcal) || /geonameid=/.test(hebcal);
    const notJerusalemDefault =
      !/geonameid=281184/.test(hebcal) &&
      !/latitude=31\.7/.test(hebcal);
    const namedViaSkip =
      coreHit?.policyTrace === "skip_provider_ladder" ||
      coreHit?.status === "needs_clarify";
    const pass =
      Boolean(coreHit) &&
      namedViaSkip &&
      hebcalUrls.length > 0 &&
      latOk &&
      lngOk &&
      notJerusalemDefault &&
      omNames.some((n) => /צפת/.test(n)) &&
      /צפת|נר|16:45|שבת|בודקת/.test(spoken);

    logs.push({
      id: "5-jewish-safed",
      pass,
      intent: JSON.stringify(intent.jewish),
      core: summarizeCore(core.calls),
      spoken,
      evidence: "mock OM geocode + mock Hebcal (צפת → lat/lng path)",
      notes: [
        `core=${coreHit?.status}/${coreHit?.policyTrace}`,
        `omNames=${JSON.stringify(omNames)}`,
        `hebcal=${hebcal.slice(0, 120)}`,
      ],
    });
    core.restore();
    expect(pass, JSON.stringify({ spoken, hebcal, omNames, coreHit })).toBe(
      true,
    );
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  }, 30_000);

  it('6. Weather — "מה מזג האוויר בגליל?" no silent צפת / גליל ים', async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot("You answer weather.");
    const core = spyResolveGeographic();
    const probe = installRealFetchHostProbe([
      "geocoding-api.open-meteo.com",
      "api.open-meteo.com",
      "marine-api.open-meteo.com",
      "maps.googleapis.com",
    ]);

    const intent = {
      weather: { place: "הגליל", near: "", date: "", aspects: ["temp"] },
    };
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: intent,
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
    const okRegion =
      coreHit?.status === "resolved" &&
      coreHit.kind === "region" &&
      /גליל/.test(coreHit.labelHe) &&
      !/צפת|גליל ים/.test(coreHit.labelHe);
    const okClarify =
      coreHit?.status === "needs_clarify" ||
      /באיזו עיר|לא זיהיתי|אזור רחב|מדויק יותר/.test(spoken);
    const pass =
      !silentWrong && (okRegion || okClarify) && core.calls.length > 0;

    logs.push({
      id: "6-weather-galil-ambiguous",
      pass,
      intent: JSON.stringify(intent.weather),
      core: summarizeCore(core.calls),
      spoken,
      evidence: "real Open-Meteo (+ optional mock-blocked Google); stub LLM",
      notes: [
        `core=${coreHit?.status}/${coreHit?.kind}/${coreHit?.labelHe}`,
        `silentWrong=${silentWrong}`,
        `hosts=${[...new Set(probe.probes.map((p) => p.host))].join(",")}`,
      ],
    });
    core.restore();
    probe.restore();
    expect(pass, spoken).toBe(true);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  }, 45_000);
});
