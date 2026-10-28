/**
 * Mocked Google computeRoutes sendChat E2E for public-transit A→B (eval-db).
 * Stubbed LLM + stubbed global fetch — no live Google / Open-Meteo requests.
 * Non-destructive; leaves GTFS generation untouched.
 *
 * Run: npm run test:eval-db -w backend -- tests/routes-transit-sendchat.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
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
import {
  LIVE_SELECT_FAILURE_HE,
  LIVE_SELECT_NO_MATCH_HE,
  LIVE_SELECT_UNFILTERED_LABEL_HE,
} from "../src/services/live-retrieval-select.js";
import {
  ROUTES_DISRUPTION_UNAVAILABLE_HE,
  ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE,
} from "../src/services/routes.js";
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

const ORIGIN = "תחנה מרכזית פתח תקווה";
const DESTINATION = "תחנה מרכזית תל אביב";

/** Named-origin geocode — must not equal the stale pending pin. */
const ORIGIN_COORDS = { lat: 32.0945, lng: 34.8862 };
const DEST_COORDS = { lat: 32.0557, lng: 34.7794 };

const STALE_PIN = {
  lat: 32.087,
  lng: 34.887,
  name: "פינ ישן",
  address: "",
};

type ComputeRoutesBody = {
  travelMode?: string;
  arrivalTime?: string;
  departureTime?: string;
  computeAlternativeRoutes?: boolean;
  origin?: {
    address?: string;
    location?: { latLng?: { latitude?: number; longitude?: number } };
  };
  destination?: {
    address?: string;
    location?: { latLng?: { latitude?: number; longitude?: number } };
  };
};

type RoutesPayload = { routes: unknown[] };

/** Single TRANSIT itinerary (baseline A→B). */
function mockSingleTransitPayload(): RoutesPayload {
  const depIso = "2026-10-28T08:15:00.000Z";
  return {
    routes: [
      {
        duration: "1800s",
        localizedValues: { duration: { text: "30 דקות" } },
        legs: [
          {
            steps: [
              {
                travelMode: "WALK",
                staticDuration: "180s",
                navigationInstruction: { instructions: "הליכה לתחנה" },
              },
              {
                travelMode: "TRANSIT",
                staticDuration: "1620s",
                transitDetails: {
                  headsign: "תל אביב",
                  headway: "600s",
                  stopDetails: {
                    departureStop: { name: "ארנס" },
                    arrivalStop: { name: "השלום" },
                    departureTime: depIso,
                    arrivalTime: "2026-10-28T08:45:00.000Z",
                  },
                  transitLine: { nameShort: "51" },
                  localizedValues: {
                    departureTime: { time: { text: "11:15" } },
                    arrivalTime: { time: { text: "11:45" } },
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Two distinct alts for leave-first vs closest_board:
 * - Line 50: earlier leave, long boarding walk (default rank winner)
 * - Line 238: later leave, short boarding walk (closest_board winner)
 */
function mockTwoTransitAlternativesPayload(): RoutesPayload {
  return {
    routes: [
      {
        duration: "2700s",
        localizedValues: { duration: { text: "45 דקות" } },
        legs: [
          {
            steps: [
              {
                travelMode: "WALK",
                staticDuration: "900s",
                navigationInstruction: { instructions: "הליכה ארוכה" },
              },
              {
                travelMode: "TRANSIT",
                staticDuration: "1800s",
                transitDetails: {
                  headsign: "תל אביב",
                  stopDetails: {
                    departureStop: { name: "תחנה רחוקה" },
                    arrivalStop: { name: "השלום" },
                    departureTime: "2026-10-28T05:00:00.000Z",
                    arrivalTime: "2026-10-28T05:45:00.000Z",
                  },
                  transitLine: { nameShort: "50" },
                  localizedValues: {
                    departureTime: { time: { text: "08:00" } },
                    arrivalTime: { time: { text: "08:45" } },
                  },
                },
              },
            ],
          },
        ],
      },
      {
        duration: "2400s",
        localizedValues: { duration: { text: "40 דקות" } },
        legs: [
          {
            steps: [
              {
                travelMode: "WALK",
                staticDuration: "180s",
                navigationInstruction: { instructions: "הליכה קצרה" },
              },
              {
                travelMode: "TRANSIT",
                staticDuration: "2220s",
                transitDetails: {
                  headsign: "תל אביב",
                  stopDetails: {
                    departureStop: { name: "תחנה קרובה" },
                    arrivalStop: { name: "השלום" },
                    departureTime: "2026-10-28T05:40:00.000Z",
                    arrivalTime: "2026-10-28T06:20:00.000Z",
                  },
                  transitLine: { nameShort: "238" },
                  localizedValues: {
                    departureTime: { time: { text: "08:40" } },
                    arrivalTime: { time: { text: "09:20" } },
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Leave-first puts the transfer option first (itin:0); direct קו 238 is itin:1.
 * Stage B residual «בלי החלפות» should keep only itin:1.
 */
function mockTransferVsDirectPayload(): RoutesPayload {
  return {
    routes: [
      {
        duration: "3000s",
        localizedValues: { duration: { text: "50 דקות" } },
        legs: [
          {
            steps: [
              {
                travelMode: "WALK",
                staticDuration: "300s",
                navigationInstruction: { instructions: "הליכה לתחנה" },
              },
              {
                travelMode: "TRANSIT",
                staticDuration: "1200s",
                transitDetails: {
                  headsign: "החלפה",
                  stopDetails: {
                    departureStop: { name: "תחנה א" },
                    arrivalStop: { name: "תחנת החלפה" },
                    departureTime: "2026-10-28T05:00:00.000Z",
                    arrivalTime: "2026-10-28T05:20:00.000Z",
                  },
                  transitLine: { nameShort: "50" },
                  localizedValues: {
                    departureTime: { time: { text: "08:00" } },
                    arrivalTime: { time: { text: "08:20" } },
                  },
                },
              },
              {
                travelMode: "WALK",
                staticDuration: "180s",
                navigationInstruction: { instructions: "החלפה" },
              },
              {
                travelMode: "TRANSIT",
                staticDuration: "1320s",
                transitDetails: {
                  headsign: "תל אביב",
                  stopDetails: {
                    departureStop: { name: "תחנת החלפה" },
                    arrivalStop: { name: "השלום" },
                    departureTime: "2026-10-28T05:25:00.000Z",
                    arrivalTime: "2026-10-28T05:50:00.000Z",
                  },
                  transitLine: { nameShort: "82" },
                  localizedValues: {
                    departureTime: { time: { text: "08:25" } },
                    arrivalTime: { time: { text: "08:50" } },
                  },
                },
              },
            ],
          },
        ],
      },
      {
        duration: "2400s",
        localizedValues: { duration: { text: "40 דקות" } },
        legs: [
          {
            steps: [
              {
                travelMode: "WALK",
                staticDuration: "240s",
                navigationInstruction: { instructions: "הליכה" },
              },
              {
                travelMode: "TRANSIT",
                staticDuration: "2160s",
                transitDetails: {
                  headsign: "תל אביב",
                  stopDetails: {
                    departureStop: { name: "תחנה ישירה" },
                    arrivalStop: { name: "השלום" },
                    departureTime: "2026-10-28T05:30:00.000Z",
                    arrivalTime: "2026-10-28T06:10:00.000Z",
                  },
                  transitLine: { nameShort: "238" },
                  localizedValues: {
                    departureTime: { time: { text: "08:30" } },
                    arrivalTime: { time: { text: "09:10" } },
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function placesGeocodeHit(
  query: string,
  coords: { lat: number; lng: number },
  label: string,
) {
  return {
    places: [
      {
        id: `places/${encodeURIComponent(query)}`,
        displayName: { text: label, languageCode: "he" },
        formattedAddress: label,
        location: { latitude: coords.lat, longitude: coords.lng },
      },
    ],
  };
}

function installMockGoogleRoutesFetch(
  payloadFactory: () => RoutesPayload = mockSingleTransitPayload,
): {
  computeBodies: ComputeRoutesBody[];
  computeCallCount: () => number;
  placesCallCount: () => number;
  restore: () => void;
} {
  const computeBodies: ComputeRoutesBody[] = [];
  let computeCalls = 0;
  let placesCalls = 0;
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = String(input);
    if (href.includes("places.googleapis.com")) {
      placesCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        textQuery?: string;
      };
      const q = String(body.textQuery ?? "").trim();
      if (q.includes("פתח תקווה") || q === ORIGIN) {
        return {
          ok: true,
          status: 200,
          json: async () =>
            placesGeocodeHit(q, ORIGIN_COORDS, "תחנה מרכזית פתח תקווה"),
        } as Response;
      }
      if (q.includes("תל אביב") || q === DESTINATION) {
        return {
          ok: true,
          status: 200,
          json: async () =>
            placesGeocodeHit(q, DEST_COORDS, "תחנה מרכזית תל אביב"),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ places: [] }),
      } as Response;
    }
    if (href.includes("routes.googleapis.com") && href.includes("computeRoutes")) {
      computeCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as ComputeRoutesBody;
      computeBodies.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => payloadFactory(),
      } as Response;
    }
    throw new Error(
      `Unexpected fetch escaped Google mock (no live calls allowed): ${href}`,
    );
  });
  vi.stubGlobal("fetch", spy);
  return {
    computeBodies,
    computeCallCount: () => computeCalls,
    placesCallCount: () => placesCalls,
    restore() {
      vi.unstubAllGlobals();
    },
  };
}

describe("Routes transit A→B sendChat E2E (eval-db, mocked Google)", () => {
  let account: HarnessAccount | null = null;
  let whatsappTextSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fireDueSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scheduleSoonSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
    // Dummy keys only — fetch is fully stubbed; never hit real Google.
    process.env.GOOGLE_ROUTES_API_KEY = "test-dummy-routes-key-not-live";
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

  async function runSendChat(input: {
    routes: Record<string, unknown>;
    message: string;
    payloadFactory?: () => RoutesPayload;
    withStalePin?: boolean;
  }) {
    const before = await assertEvalDbAndGtfsUntouched();
    const mock = installMockGoogleRoutesFetch(
      input.payloadFactory ?? mockSingleTransitPayload,
    );
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(
      account,
      "You answer transit routes in Hebrew.",
    );
    if (input.withStalePin) {
      setPendingLocation(account.employeeId, STALE_PIN);
    }
    installOutboundGuards();
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת מסלול.", buttons: [] }],
        metadata: { routes: input.routes },
      }),
    );
    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: input.message,
    });
    assertNoOutbound();
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
    return { result, mock, before };
  }

  it("named origin+dest summary: one TRANSIT computeRoutes; pin unused/retained", async () => {
    const { result, mock } = await runSendChat({
      withStalePin: true,
      message:
        "איך מגיעים מתחנה מרכזית פתח תקווה לתחנה מרכזית תל אביב בתחבורה ציבורית?",
      routes: {
        origin: ORIGIN,
        destination: DESTINATION,
        aspects: ["summary"],
      },
    });

    expect(getPendingLocation(account!.employeeId)).toMatchObject({
      lat: STALE_PIN.lat,
      lng: STALE_PIN.lng,
    });
    expect(mock.computeCallCount()).toBe(1);
    expect(mock.computeBodies).toHaveLength(1);
    expect(mock.placesCallCount()).toBeGreaterThanOrEqual(1);

    const body = mock.computeBodies[0]!;
    expect(body.travelMode).toBe("TRANSIT");
    expect(body.origin?.location?.latLng?.latitude).toBe(ORIGIN_COORDS.lat);
    expect(body.origin?.location?.latLng?.longitude).toBe(ORIGIN_COORDS.lng);
    expect(body.origin?.location?.latLng?.latitude).not.toBe(STALE_PIN.lat);
    expect(body.destination?.location?.latLng?.latitude).toBe(DEST_COORDS.lat);
    expect(body.destination?.location?.latLng?.longitude).toBe(DEST_COORDS.lng);

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/מסלול בתחבורה ציבורית/);
    expect(spoken).toMatch(/30 דקות/);
    expect(spoken).toMatch(/קו 51|ארנס/);
    expect(spoken).not.toMatch(/שלח מיקום בוואטסאפ/);
    expect(spoken).not.toMatch(/חסר מפתח|לא מוגדר|לא מופעלים/);

    const pinAfter = getPendingLocation(account!.employeeId);
    expect(pinAfter?.lat).toBe(STALE_PIN.lat);
    expect(pinAfter?.lng).toBe(STALE_PIN.lng);
    mock.restore();
  });

  it("multi alternatives: Wave 1 compact lead for primary + cue for second", async () => {
    const { result, mock } = await runSendChat({
      payloadFactory: mockTwoTransitAlternativesPayload,
      message: "איך מגיעים מפתח תקווה לתל אביב בתחבורה ציבורית?",
      routes: {
        origin: ORIGIN,
        destination: DESTINATION,
        aspects: ["summary"],
      },
    });

    expect(mock.computeCallCount()).toBe(1);
    const body = mock.computeBodies[0]!;
    expect(body.travelMode).toBe("TRANSIT");
    expect(body.computeAlternativeRoutes).toBe(true);

    const spoken = parseLlmReply(result.reply).response;
    // Both alts represented under Wave 1: primary fully; secondary via count cue.
    expect(spoken).toContain("מצאתי 2 אפשרויות");
    expect(spoken).toContain(ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE);
    expect(spoken).toContain("המלצה:");
    // Default leave-first rank → קו 50 (earlier board), not 238.
    expect(spoken).toContain("קו 50");
    expect(spoken).toContain("משך משוער *45 דקות*");
    expect(spoken).toMatch(/עוד 1 אפשרויות/);
    expect(spoken).toMatch(/יציאה|משך|הליכה/);
    // Compact contract: do not expand secondary body / its line.
    expect(spoken).not.toContain("*אפשרות 2*");
    expect(spoken).not.toContain("קו 238");
    expect(spoken).not.toContain("משך משוער *40 דקות*");
    mock.restore();
  });

  it("prefer closest_board: ranks short boarding walk ahead of earlier leave", async () => {
    const { result, mock } = await runSendChat({
      payloadFactory: mockTwoTransitAlternativesPayload,
      message: "איזה קו הכי קרוב לבית לתחנה מרכזית תל אביב?",
      routes: {
        origin: ORIGIN,
        destination: DESTINATION,
        aspects: ["summary"],
        prefer: "closest_board",
        require_live_select: false,
      },
    });

    expect(mock.computeCallCount()).toBe(1);
    expect(mock.computeBodies[0]!.travelMode).toBe("TRANSIT");

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/תחנת העלייה הקרובה ביותר|הקו עם תחנת העלייה/);
    expect(spoken).toContain("קו 238");
    expect(spoken).toContain("תחנה קרובה");
    expect(spoken).toMatch(/הליכה כ־3 דקות/);
    expect(spoken).toContain(ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE);
    // Must not lead with the earlier-leave / longer-walk option.
    expect(spoken.indexOf("238")).toBeLessThan(spoken.indexOf("אפשרויות"));
    expect(spoken).not.toMatch(/הקו עם תחנת העלייה הקרובה ביותר[\s\S]*קו 50/);
    mock.restore();
  });

  it("arrival-time planning: arrivalTime on Google body + leave-by Hebrew", async () => {
    const ARRIVAL = "2026-10-28T10:00";
    const { result, mock } = await runSendChat({
      payloadFactory: mockSingleTransitPayload,
      message: "מתי לצאת כדי להגיע לתחנה מרכזית תל אביב עד 10:00?",
      routes: {
        origin: ORIGIN,
        destination: DESTINATION,
        arrival: ARRIVAL,
        aspects: ["summary"],
      },
    });

    expect(mock.computeCallCount()).toBe(1);
    const body = mock.computeBodies[0]!;
    expect(body.travelMode).toBe("TRANSIT");
    expect(body.departureTime).toBeUndefined();
    expect(typeof body.arrivalTime).toBe("string");
    expect(body.arrivalTime!.length).toBeGreaterThan(10);
    // Engine converts Jerusalem-local arrival → RFC3339 for Google.
    const arrivalMs = Date.parse(body.arrivalTime!);
    expect(Number.isFinite(arrivalMs)).toBe(true);

    const spoken = parseLlmReply(result.reply).response;
    // 10:00 Asia/Jerusalem − 30m duration → leave-by 09:30.
    expect(spoken).toMatch(/צא בסביבות/);
    expect(spoken).toContain("09:30");
    expect(spoken).toMatch(/10:00|עד/);
    expect(spoken).toMatch(/30 דקות|קו 51|ארנס/);
    mock.restore();
  });

  /**
   * Capability #6 contract (prompt + ACTION schema): network-wide disruptions
   * → routes=null + disclose U. Engine does not fetch SX; canonical copy is
   * ROUTES_DISRUPTION_UNAVAILABLE_HE. This regression locks chat pass-through
   * of that honest disclose with zero provider calls.
   */
  it("network-wide disruptions: routes=null disclose; no provider fetch", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(
        `Unexpected fetch on disruption U path (no live calls): ${String(input)}`,
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(
      account,
      "You answer transit routes in Hebrew.",
    );
    installOutboundGuards();
    setLlmClientForTests(
      stubLlmReply({
        responses: [
          { text: ROUTES_DISRUPTION_UNAVAILABLE_HE, buttons: [] },
        ],
        // Documented contract: Network-wide disruptions → routes=null + disclose U.
        metadata: { routes: null },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "יש שיבושים או ביטולים ברשת התחבורה הציבורית עכשיו?",
    });

    assertNoOutbound();
    expect(fetchSpy).not.toHaveBeenCalled();

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toBe(ROUTES_DISRUPTION_UNAVAILABLE_HE);
    expect(spoken).toMatch(/שיבוש|ביטול/);
    expect(spoken).toMatch(/לא מחובר/);
    // Must not claim a network check or an all-clear.
    expect(spoken).not.toMatch(/אין שיבושים|אין ביטולים|בדקתי את הרשת|אין דיווחים/);
    expect(spoken).not.toMatch(/תחזית חיה|SIRI|גוגל/);

    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
    vi.unstubAllGlobals();
  });

  /** Two-turn LLM: routes require_live_select, then live_select metadata. */
  function stubRequireLiveSelectTurns(liveSelectMeta: unknown): {
    getTurnCount: () => number;
  } {
    let llmTurns = 0;
    setLlmClientForTests({
      async createConversation() {
        return `conv-${randomUUID()}`;
      },
      async createResponse() {
        llmTurns += 1;
        if (llmTurns === 1) {
          return {
            reply: JSON.stringify({
              responses: [{ text: "בודקת מסלולים.", buttons: [] }],
              metadata: {
                routes: {
                  origin: ORIGIN,
                  destination: DESTINATION,
                  aspects: ["summary"],
                  require_live_select: true,
                },
              },
            }),
            raw: {},
          };
        }
        return {
          reply: JSON.stringify({
            responses: [{ text: "", buttons: [] }],
            metadata: { live_select: liveSelectMeta },
          }),
          raw: {},
        };
      },
    });
    return { getTurnCount: () => llmTurns };
  }

  /**
   * Capability #8 residual V: require_live_select Stage B among Google alts.
   * First LLM turn emits routes + require_live_select; second turn (live_select)
   * keeps only itin:1 (direct קו 238) from the ranked board — never invents lines.
   */
  it("Stage B require_live_select: keeps subset of Google alts (fewer transfers)", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const mock = installMockGoogleRoutesFetch(mockTransferVsDirectPayload);

    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(
      account,
      "You answer transit routes in Hebrew.",
    );
    installOutboundGuards();
    const turns = stubRequireLiveSelectTurns({
      domain: "routes",
      live_record_ids: ["itin:1"],
    });

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "איך מגיעים מפתח תקווה לתל אביב בלי החלפות?",
    });

    assertNoOutbound();
    expect(turns.getTurnCount()).toBe(2);
    expect(mock.computeCallCount()).toBe(1);
    expect(mock.computeBodies[0]!.travelMode).toBe("TRANSIT");
    expect(mock.computeBodies[0]!.computeAlternativeRoutes).toBe(true);

    const spoken = parseLlmReply(result.reply).response;
    // Selected subset = direct קו 238 from Google fixture (itin:1).
    expect(spoken).toContain("קו 238");
    expect(spoken).toMatch(/40 דקות|מסלול בתחבורה ציבורית|תחנה ישירה/);
    // Rejected transfer option must not appear; no invented lines.
    expect(spoken).not.toContain("קו 50");
    expect(spoken).not.toContain("קו 82");
    expect(spoken).not.toContain("קו 999");
    expect(spoken).not.toContain("מצאתי 2 אפשרויות");
    expect(spoken).not.toContain(LIVE_SELECT_FAILURE_HE);
    expect(spoken).not.toContain(LIVE_SELECT_NO_MATCH_HE);
    expect(spoken).not.toContain(LIVE_SELECT_UNFILTERED_LABEL_HE);

    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
    mock.restore();
  });

  it("Stage B require_live_select no_match: empty ids → no selected itinerary", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const mock = installMockGoogleRoutesFetch(mockTransferVsDirectPayload);

    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(
      account,
      "You answer transit routes in Hebrew.",
    );
    installOutboundGuards();
    // Documented: empty live_record_ids → no_match (not silent keep-all).
    const turns = stubRequireLiveSelectTurns({
      domain: "routes",
      live_record_ids: [],
    });

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "איך מגיעים מפתח תקווה לתל אביב בלי החלפות ברכבת קלה בלבד?",
    });

    assertNoOutbound();
    expect(turns.getTurnCount()).toBe(2);
    expect(mock.computeCallCount()).toBe(1);

    const spoken = parseLlmReply(result.reply).response;
    // User-facing: optional Stage-A ack + no_match (reports no suitable match; no clarify ask).
    expect(spoken).toContain(LIVE_SELECT_NO_MATCH_HE);
    expect(spoken).toMatch(/לא מצאתי התאמה/);
    expect(spoken.trim().endsWith(LIVE_SELECT_NO_MATCH_HE)).toBe(true);
    // No itinerary presented as selected; no invented lines; no failure/unfiltered board.
    expect(spoken).not.toContain("קו 50");
    expect(spoken).not.toContain("קו 82");
    expect(spoken).not.toContain("קו 238");
    expect(spoken).not.toContain("קו 999");
    expect(spoken).not.toContain("מצאתי 2 אפשרויות");
    expect(spoken).not.toContain(LIVE_SELECT_FAILURE_HE);
    expect(spoken).not.toContain(LIVE_SELECT_UNFILTERED_LABEL_HE);
    expect(spoken).not.toMatch(/מסלול בתחבורה ציבורית מ«/);

    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
    mock.restore();
  });

  it("Stage B require_live_select failure: decline → labeled unfiltered board", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const mock = installMockGoogleRoutesFetch(mockTransferVsDirectPayload);

    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(
      account,
      "You answer transit routes in Hebrew.",
    );
    installOutboundGuards();
    // Documented: live_select null = keep_all decline → failure (required filter).
    const turns = stubRequireLiveSelectTurns(null);

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "איך מגיעים מפתח תקווה לתל אביב בלי החלפות?",
    });

    assertNoOutbound();
    expect(turns.getTurnCount()).toBe(2);
    expect(mock.computeCallCount()).toBe(1);

    const spoken = parseLlmReply(result.reply).response;
    // User-facing: optional ack + failure line, then labeled unfiltered board (not silent success).
    expect(spoken).toContain(LIVE_SELECT_FAILURE_HE);
    expect(spoken).toContain(LIVE_SELECT_UNFILTERED_LABEL_HE);
    const failAt = spoken.indexOf(LIVE_SELECT_FAILURE_HE);
    const labelAt = spoken.indexOf(LIVE_SELECT_UNFILTERED_LABEL_HE);
    expect(failAt).toBeGreaterThanOrEqual(0);
    expect(labelAt).toBeGreaterThan(failAt);
    // Unfiltered board may list Google alts — labeled, not as a successful filter.
    expect(spoken).toContain("מצאתי 2 אפשרויות");
    expect(spoken).toContain("קו 50");
    // Not a clean subset success (failure precedes board; no invented lines).
    expect(spoken.startsWith("מסלול בתחבורה ציבורית")).toBe(false);
    expect(spoken.indexOf("מסלול בתחבורה ציבורית")).toBe(-1);
    expect(spoken).not.toContain("קו 999");
    expect(spoken).not.toContain(LIVE_SELECT_NO_MATCH_HE);

    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
    mock.restore();
  });
});
