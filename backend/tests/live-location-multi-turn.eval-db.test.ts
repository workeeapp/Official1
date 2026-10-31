/**
 * Stage 4 — stub/offline multi-turn location + conversational context.
 * sendChatMessage with stubbed LLM + stubbed Places/Weather fetch (eval-db).
 * Does not call a live model (Stage 5).
 *
 * Run: npm run test:eval-db -w backend -- tests/live-location-multi-turn.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { resetEnvCache } from "../src/config/env.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import {
  loadLastLiveLocationForConversation,
  loadLastRoutesBoardForConversation,
  packAssistantLlmRawForTests,
  sendChatMessage,
} from "../src/services/chat.service.js";
import { buildLastLiveLocation } from "../src/services/last-live-location.js";
import {
  clearPendingLocation,
  getPendingLocation,
  resetPendingLocations,
  setPendingLocation,
} from "../src/services/pending-location.js";
import type { LastRoutesBoard } from "../src/services/routes.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const HOME_LAT = 32.099279;
const HOME_LNG = 34.8923104;
const PIN_LAT = 31.501;
const PIN_LNG = 34.501;
const CITY_GEO_LAT = 32.08;
const CITY_GEO_LNG = 34.78;
const PLACE_LABEL = "רמת גן";

type FetchProbe = { url: string; body: string | null };

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
              displayName: { text: "מקום בדיקה" },
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
              formatted_address: PLACE_LABEL,
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

/** Sequential stub replies — one createResponse per turn. */
function stubLlmQueue(payloads: unknown[]) {
  let i = 0;
  return {
    async createConversation() {
      return `conv-${randomUUID()}`;
    },
    async createResponse() {
      const payload = payloads[Math.min(i, payloads.length - 1)];
      i += 1;
      return { reply: JSON.stringify(payload), raw: {} };
    },
  };
}

function placesBodies(probes: FetchProbe[]): string[] {
  return probes
    .filter((p) => p.url.includes("places.googleapis.com"))
    .map((p) => p.body ?? "");
}

function forecastUrls(probes: FetchProbe[]): string[] {
  return probes
    .map((p) => p.url)
    .filter((u) => u.includes("api.open-meteo.com/v1/forecast"));
}

function requestInputText(request: unknown): string {
  if (!request || typeof request !== "object") return "";
  const input = (request as Record<string, unknown>).input;
  return typeof input === "string" ? input : JSON.stringify(input ?? "");
}

const placesPayload = (query: string, place: string, near = "") => ({
  responses: [{ text: "מחפשת.", buttons: [] }],
  metadata: {
    places: {
      query,
      place,
      near,
      aspects: ["summary"],
    },
  },
});

const askOnlyPayload = (text: string) => ({
  responses: [{ text, buttons: [] }],
  metadata: {},
});

const sampleBoard = {
  origin: "A",
  destination: "B",
  mode: "transit",
  fetchedAt: "2026-10-30T10:00:00.000Z",
  itineraries: [
    {
      id: "1",
      duration: "10 min",
      summary: "קו 1",
      steps: [],
    },
  ],
} as LastRoutesBoard;

describe("live location multi-turn (eval-db, stubbed)", () => {
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

  async function conversationId(lucyId: string): Promise<string> {
    const row = await prisma.chatConversation.findFirst({
      where: {
        userId: account!.userId,
        employeeId: account!.employeeId,
        digitalEmployeeId: lucyId,
      },
      orderBy: { updatedAt: "desc" },
    });
    expect(row?.id).toBeTruthy();
    return row!.id;
  }

  async function chat(
    lucyId: string,
    message: string,
  ): Promise<Awaited<ReturnType<typeof sendChatMessage>>> {
    return sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message,
    });
  }

  it("1 continue same place: restaurants then cafes with prior label → LAST_LIVE packed + reinjected", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    setLlmClientForTests(
      stubLlmQueue([
        placesPayload("מסעדות", PLACE_LABEL),
        placesPayload("בתי קפה", PLACE_LABEL),
      ]),
    );

    await chat(lucyId, `מסעדות ב${PLACE_LABEL}`);
    const convId = await conversationId(lucyId);
    const afterFirst = await loadLastLiveLocationForConversation(convId);
    expect(afterFirst?.label).toBe(PLACE_LABEL);
    expect(afterFirst?.domain).toBe("places");
    expect(placesBodies(fetchProbe!.probes).length).toBeGreaterThan(0);

    const placesBeforeSecond = placesBodies(fetchProbe!.probes).length;
    const second = await chat(lucyId, "בתי קפה שם");
    const injected = requestInputText(second.request);
    expect(injected).toContain("LAST_LIVE_LOCATION:");
    expect(injected).toContain(PLACE_LABEL);
    expect(injected).toContain("AVAILABLE only");
    expect(placesBodies(fetchProbe!.probes).length).toBeGreaterThan(
      placesBeforeSecond,
    );
    const afterSecond = await loadLastLiveLocationForConversation(convId);
    expect(afterSecond?.label).toBe(PLACE_LABEL);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("2 reminder mid-thread does not hide prior LAST_LIVE for next live turn", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    setLlmClientForTests(
      stubLlmQueue([
        placesPayload("מסעדות", PLACE_LABEL),
        // Automatic reminder / ack — no live ACTION.
        {
          responses: [{ text: "⏰ תזכורת: לקנות חלב", buttons: [] }],
          metadata: {},
        },
        placesPayload("בתי קפה", PLACE_LABEL),
      ]),
    );

    await chat(lucyId, `מסעדות ב${PLACE_LABEL}`);
    await chat(lucyId, "(תזכורת אוטומטית)");
    const third = await chat(lucyId, "בתי קפה שם");
    const injected = requestInputText(third.request);
    expect(injected).toContain("LAST_LIVE_LOCATION:");
    expect(injected).toContain(PLACE_LABEL);
    const loc = await loadLastLiveLocationForConversation(
      await conversationId(lucyId),
    );
    expect(loc?.label).toBe(PLACE_LABEL);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("3 mention-only (no live ACTION) does not pack LAST_LIVE_LOCATION", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    setLlmClientForTests(
      stubLlmQueue([
        askOnlyPayload(`נשמע נחמד ${PLACE_LABEL}, מה תרצה לעשות שם?`),
      ]),
    );

    await chat(lucyId, `דיברנו על ${PLACE_LABEL} אבל בלי חיפוש`);
    const loc = await loadLastLiveLocationForConversation(
      await conversationId(lucyId),
    );
    expect(loc).toBeNull();
    expect(placesBodies(fetchProbe!.probes)).toHaveLength(0);
    expect(forecastUrls(fetchProbe!.probes)).toHaveLength(0);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("4 failed / ask-for-pin weather does not update LAST_LIVE; prior stays", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    setLlmClientForTests(
      stubLlmQueue([
        placesPayload("מסעדות", PLACE_LABEL),
        {
          responses: [{ text: "", buttons: [] }],
          metadata: {
            weather: {
              place: "",
              near: "speaker",
              aspects: ["temp"],
            },
          },
        },
      ]),
    );

    await chat(lucyId, `מסעדות ב${PLACE_LABEL}`);
    const convId = await conversationId(lucyId);
    const prior = await loadLastLiveLocationForConversation(convId);
    expect(prior?.label).toBe(PLACE_LABEL);

    const failed = await chat(lucyId, "מה מזג האוויר כאן?");
    const spoken = parseLlmReply(failed.reply).response;
    expect(spoken).toMatch(/מיקום|סיכ/);
    expect(forecastUrls(fetchProbe!.probes)).toHaveLength(0);
    // Still the prior successful places location — failed ask did not overwrite.
    const after = await loadLastLiveLocationForConversation(convId);
    expect(after?.label).toBe(PLACE_LABEL);
    expect(after?.domain).toBe("places");
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("5 two candidates (pin + LAST_LIVE): stub asks; engine does not auto-pick either", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    setLlmClientForTests(
      stubLlmQueue([
        placesPayload("מסעדות", PLACE_LABEL),
        askOnlyPayload(
          "לאיזה מקום התכוונת — לסיכה ששלחת או לרמת גן מהחיפוש הקודם?",
        ),
      ]),
    );

    await chat(lucyId, `מסעדות ב${PLACE_LABEL}`);
    setPendingLocation(account!.employeeId, {
      lat: PIN_LAT,
      lng: PIN_LNG,
      name: "סיכה שלי",
      address: "",
    });
    const placesBeforeAsk = placesBodies(fetchProbe!.probes).length;

    const ask = await chat(lucyId, "בתי קפה שם");
    const injected = requestInputText(ask.request);
    expect(injected).toContain("LAST_LIVE_LOCATION:");
    expect(injected).toContain(PLACE_LABEL);
    expect(injected).toContain("PENDING_LOCATION:");
    expect(injected).toContain(String(PIN_LAT));
    expect(parseLlmReply(ask.reply).response).toMatch(/סיכה|רמת גן|מקום/);
    // No new Places call — stub asked; engine did not invent a resolve.
    expect(placesBodies(fetchProbe!.probes).length).toBe(placesBeforeAsk);
    expect(getPendingLocation(account!.employeeId)?.lat).toBeCloseTo(PIN_LAT);
    clearPendingLocation(account!.employeeId);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("6 pin (כאן/near=speaker) vs conversational place label", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    setLlmClientForTests(
      stubLlmQueue([
        placesPayload("מסעדות", PLACE_LABEL),
        placesPayload("בתי קפה", "", "speaker"),
        placesPayload("פיצה", PLACE_LABEL),
      ]),
    );

    await chat(lucyId, `מסעדות ב${PLACE_LABEL}`);
    setPendingLocation(account!.employeeId, {
      lat: PIN_LAT,
      lng: PIN_LNG,
      name: "סיכה",
      address: "",
    });

    const probesBeforePin = fetchProbe!.probes.length;
    await chat(lucyId, "בתי קפה כאן");
    const pinBodies = placesBodies(
      fetchProbe!.probes.slice(probesBeforePin),
    );
    expect(pinBodies.length).toBeGreaterThan(0);
    const pinParsed = JSON.parse(pinBodies[0]!);
    expect(pinParsed.locationBias?.circle?.center?.latitude).toBeCloseTo(
      PIN_LAT,
    );
    expect(pinParsed.locationBias?.circle?.center?.longitude).toBeCloseTo(
      PIN_LNG,
    );
    // near=speaker consume clears the pin after successful use (engine policy).

    // Re-arm pin: named place ACTION must still use the label, not pin coords.
    setPendingLocation(account!.employeeId, {
      lat: PIN_LAT,
      lng: PIN_LNG,
      name: "סיכה",
      address: "",
    });
    const probesBeforeNamed = fetchProbe!.probes.length;
    const named = await chat(lucyId, `פיצה ב${PLACE_LABEL}`);
    const namedInject = requestInputText(named.request);
    expect(namedInject).toContain("LAST_LIVE_LOCATION:");
    expect(namedInject).toContain("PENDING_LOCATION:");
    const namedBodies = placesBodies(
      fetchProbe!.probes.slice(probesBeforeNamed),
    );
    expect(namedBodies.length).toBeGreaterThan(0);
    const namedParsed = JSON.parse(namedBodies[0]!);
    const namedCenter = namedParsed.locationBias?.circle?.center;
    if (namedCenter?.latitude != null) {
      expect(namedCenter.latitude).not.toBeCloseTo(PIN_LAT, 2);
    }
    // Pin unused by named place → still pending.
    expect(getPendingLocation(account!.employeeId)?.lat).toBeCloseTo(PIN_LAT);
    clearPendingLocation(account!.employeeId);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("7 lastRoutesBoard ↔ LAST_LIVE_LOCATION: neither scan hides the other", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    setLlmClientForTests(
      stubLlmQueue([
        placesPayload("מסעדות", PLACE_LABEL),
        askOnlyPayload("⏰ תזכורת: משהו"),
        placesPayload("בתי קפה", PLACE_LABEL),
      ]),
    );

    await chat(lucyId, `מסעדות ב${PLACE_LABEL}`);
    const convId = await conversationId(lucyId);

    // Simulate a prior successful routes board on the same assistant raw that
    // already holds LAST_LIVE (coexistence on one message).
    const withLoc = await prisma.chatMessage.findFirst({
      where: { conversationId: convId, author: "assistant" },
      orderBy: { createdAt: "desc" },
      select: { id: true, raw: true },
    });
    expect(withLoc).toBeTruthy();
    const loc = buildLastLiveLocation({
      label: PLACE_LABEL,
      kind: "soft_place_text",
      domain: "places",
      role: "place",
      at: "2026-10-30T11:00:00.000Z",
    })!;
    await prisma.chatMessage.update({
      where: { id: withLoc!.id },
      data: {
        raw: packAssistantLlmRawForTests({
          request: { ok: true },
          response: { reply: "מצאתי" },
          lastRoutesBoard: sampleBoard,
          lastLiveLocation: loc,
        }) as object,
      },
    });

    expect(
      (await loadLastRoutesBoardForConversation(convId))?.destination,
    ).toBe("B");
    expect((await loadLastLiveLocationForConversation(convId))?.label).toBe(
      PLACE_LABEL,
    );

    // Intervening reminder — neither store cleared.
    await chat(lucyId, "(תזכורת)");
    expect(
      (await loadLastRoutesBoardForConversation(convId))?.destination,
    ).toBe("B");
    expect((await loadLastLiveLocationForConversation(convId))?.label).toBe(
      PLACE_LABEL,
    );

    // Fresh places success packs location on a new message; board still found
    // via newest-first scan of older rows.
    const follow = await chat(lucyId, "בתי קפה שם");
    expect(requestInputText(follow.request)).toContain("LAST_LIVE_LOCATION:");
    expect(
      (await loadLastRoutesBoardForConversation(convId))?.destination,
    ).toBe("B");
    expect((await loadLastLiveLocationForConversation(convId))?.label).toBe(
      PLACE_LABEL,
    );
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });
});
