/**
 * Offline Chat live-domain orchestration (post-model).
 *
 * Production chain (chat.service.ts, live-domain block after model reply):
 *   parseReplyMetadata(reply) → gate (guest / place.trim / candle-anchor) →
 *   resolveWeatherMessages | resolvePlacesReply | resolveJewishReply →
 *   applyLiveDomainReply → empty spoken → EMPTY_REPLY_RETRY
 *
 * This suite does NOT call sendChatMessage (would need DB + OpenAI).
 * It exercises the real resolve/format/compose path with stub model JSON.
 *
 * Covered: reply-metadata parse, Chat-parity gates for weather/places/jewish,
 *   provider arg mapping via mocked fetch, Hebrew formatting, replace vs append,
 *   empty fallback, guest skip, places near=speaker + pending pin,
 *   places area_restrict ignoring pending pin (chat-parity mirror).
 * Not covered: natural-language → model tool selection, full sendChatMessage,
 *   PENDING_LOCATION store/clear, WATCH wrap, OpenAI tip composer (injected),
 *   Meta Graph, reminder create/fire, product DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLlmReply,
  parseReplyMetadata,
  type LlmMetadata,
} from "@workee/shared";
import { EMPTY_REPLY_RETRY } from "../src/services/employee-records.service.js";
import {
  applyLiveDomainReply,
  setEngineResponse,
} from "../src/services/whatsapp-send.js";
import { resolveWeatherMessages } from "../src/services/weather.js";
import { resolvePlacesReply } from "../src/services/places.js";
import { resolveJewishReply } from "../src/services/jewish.js";

const WEATHER_NOW = new Date("2026-10-20T10:00:00+03:00");

function modelReply(responses: string[], metadata: Record<string, unknown>): string {
  return JSON.stringify({ responses, metadata });
}

function openMeteoFetchImpl(options?: { failForecast?: boolean }) {
  return vi.fn(async (url: string) => {
    const href = String(url);
    if (href.includes("geocoding-api")) {
      return {
        ok: true,
        json: async () => ({
          results: [
            {
              name: "Tel Aviv",
              latitude: 32.08,
              longitude: 34.78,
              country: "Israel",
              timezone: "Asia/Jerusalem",
            },
          ],
        }),
      } as Response;
    }
    if (options?.failForecast) {
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    }
    if (href.includes("marine-api")) {
      return {
        ok: true,
        json: async () => ({
          daily: { time: ["2026-10-20", "2026-10-21"], wave_height_max: [1.2, 1.5] },
        }),
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({
        timezone: "Asia/Jerusalem",
        current: {
          time: "2026-10-20T10:00",
          temperature_2m: 25,
          relative_humidity_2m: 50,
          weather_code: 0,
          wind_speed_10m: 12,
          wind_gusts_10m: 20,
        },
        daily: {
          time: ["2026-10-20", "2026-10-21"],
          weather_code: [0, 61],
          temperature_2m_max: [29, 27],
          temperature_2m_min: [19, 18],
          wind_speed_10m_max: [18, 22],
          wind_gusts_10m_max: [30, 35],
        },
        hourly: {
          time: ["2026-10-20T12:00", "2026-10-21T12:00"],
          temperature_2m: [26, 24],
          relative_humidity_2m: [48, 60],
          weather_code: [0, 61],
          wind_speed_10m: [14, 16],
          wind_gusts_10m: [22, 28],
        },
      }),
    } as Response;
  });
}

function placesSearchFetchImpl(places: unknown[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    expect(String(url)).toContain("places.googleapis.com");
    const body = JSON.parse(String(init?.body ?? "{}")) as { textQuery?: string };
    return {
      ok: true,
      status: 200,
      json: async () => ({ places, _queried: body.textQuery }),
    } as Response;
  });
}

/** Geocode viewport + Places searchText for B2a area_restrict orchestration. */
function placesAreaRestrictFetchImpl(places: unknown[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("maps.googleapis.com/maps/api/geocode")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "OK",
          results: [
            {
              formatted_address: "השרון, ישראל",
              partial_match: false,
              geometry: {
                viewport: {
                  southwest: { lat: 32.05, lng: 34.75 },
                  northeast: { lat: 32.35, lng: 35.05 },
                },
              },
            },
          ],
        }),
      } as Response;
    }
    expect(href).toContain("places.googleapis.com");
    const body = JSON.parse(String(init?.body ?? "{}")) as { textQuery?: string };
    return {
      ok: true,
      status: 200,
      json: async () => ({ places, _queried: body.textQuery }),
    } as Response;
  });
}

function hebcalShabbatFetchImpl() {
  return vi.fn(async (url: string) => {
    const href = String(url);
    expect(href).toContain("hebcal.com/shabbat");
    expect(href).toContain("geonameid=");
    return {
      ok: true,
      json: async () => ({
        location: { title: "Petaẖ Tiqva, Israel", geonameid: 293918 },
        items: [
          {
            category: "candles",
            title: "Candle lighting: 5:39pm",
            hebrew: "הַדְלָקַת נֵרוֹת: 17:39",
            date: "2026-10-23T17:39:00+03:00",
          },
          {
            category: "havdalah",
            title: "Havdalah: 6:35pm",
            hebrew: "הַבְדָּלָה: 18:35",
            date: "2026-10-24T18:35:00+03:00",
          },
          {
            category: "parashat",
            title: "Parashat Lech-Lecha",
            hebrew: "פָּרָשַׁת לֶךְ־לְךָ",
            date: "2026-10-24",
          },
        ],
      }),
    } as Response;
  });
}

/**
 * Mirrors chat.service.ts live-domain block for weather / places / jewish only.
 * Keep in sync with production gates; do not treat as a substitute for sendChatMessage.
 */
async function applyChatLiveDomainPass(input: {
  workingReply: string;
  metadata: LlmMetadata;
  guestSpeaker?: boolean;
  fetchImpl: typeof fetch;
  composeWeatherTip?: (args: {
    factsBody: string;
    addressGender?: "male" | "female" | null;
  }) => Promise<string | null>;
  placesApiKey?: string | null;
  pendingLoc?: { lat: number; lng: number } | null;
  weatherNow?: Date;
}): Promise<string> {
  const guestSpeaker = input.guestSpeaker === true;
  let workingReply = input.workingReply;
  const metadata = input.metadata;

  const watchSampleTurn = (metadata.reminders ?? []).some(
    (row) =>
      (row.action === "add" || row.action === "update") &&
      row.composeCondition != null,
  );

  const weatherAction = guestSpeaker ? null : metadata.weather ?? null;
  const weatherNearSpeaker = weatherAction?.near === "speaker";
  if (
    weatherAction &&
    (weatherAction.place.trim() || weatherNearSpeaker)
  ) {
    const weatherUsePin =
      weatherNearSpeaker &&
      !weatherAction.place.trim() &&
      input.pendingLoc != null;
    const weather = await resolveWeatherMessages({
      place: weatherUsePin ? "המיקום שלך" : weatherAction.place,
      nearSpeaker: weatherNearSpeaker && !weatherAction.place.trim(),
      latitude: weatherUsePin ? input.pendingLoc!.lat : null,
      longitude: weatherUsePin ? input.pendingLoc!.lng : null,
      date: weatherAction.date,
      aspects: weatherAction.aspects,
      now: input.weatherNow ?? WEATHER_NOW,
      fetchImpl: input.fetchImpl,
      composeTip: input.composeWeatherTip ?? (async () => null),
    });
    workingReply = applyLiveDomainReply(
      workingReply,
      watchSampleTurn ? weather.body : weather.messages,
      { watchSample: watchSampleTurn },
    );
  }

  const placesAction = guestSpeaker ? null : metadata.places ?? null;
  const pendingLoc = guestSpeaker ? null : input.pendingLoc ?? null;
  if (placesAction?.query.trim()) {
    // Stage B1/B2a parity with chat.service: area_restrict ignores pending pin;
    // named place never inherits pending even if near=speaker was also set.
    const areaRestrict = placesAction.geoMode === "area_restrict";
    const namedPlace = placesAction.place.trim().length > 0;
    const nearSpeaker =
      !areaRestrict &&
      placesAction.near === "speaker" &&
      !namedPlace;
    const placesText = await resolvePlacesReply({
      query: placesAction.query,
      place: placesAction.place,
      aspects: placesAction.aspects,
      nearSpeaker,
      areaRestrict,
      // Pending pin only for near=speaker + empty place (never area_restrict /
      // named city). Explicit ACTION lat/lng still win when present.
      lat: areaRestrict
        ? null
        : placesAction.lat ??
          (nearSpeaker ? pendingLoc?.lat ?? null : null),
      lng: areaRestrict
        ? null
        : placesAction.lng ??
          (nearSpeaker ? pendingLoc?.lng ?? null : null),
      fetchImpl: input.fetchImpl,
      apiKey: input.placesApiKey,
    });
    workingReply = applyLiveDomainReply(workingReply, placesText, {
      watchSample: watchSampleTurn,
    });
  }

  const candleAnchorReminder = (metadata.reminders ?? []).some(
    (row) =>
      row.scheduleAnchor === "jewish_candles" &&
      (row.action === "add" || row.action === "update"),
  );
  const jewishAction =
    guestSpeaker || candleAnchorReminder ? null : metadata.jewish ?? null;
  if (jewishAction) {
    const { text: jewishText } = await resolveJewishReply({
      place: jewishAction.place,
      date: jewishAction.date,
      aspects: jewishAction.aspects,
      fetchImpl: input.fetchImpl,
      now: input.weatherNow ?? WEATHER_NOW,
    });
    workingReply = applyLiveDomainReply(workingReply, jewishText, {
      watchSample: watchSampleTurn,
    });
  }

  // chat.service.ts after live domains (~3045–3047)
  if (!parseLlmReply(workingReply).response.trim()) {
    workingReply = setEngineResponse(workingReply, EMPTY_REPLY_RETRY);
  }

  return workingReply;
}

describe("live-domain orchestration (offline, post-model)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        throw new Error(
          `unexpected real fetch blocked in offline orchestration test: ${String(url)}`,
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("weather: pure ask parses place/date, fetches Open-Meteo, replaces empty responses", async () => {
    const fetchImpl = openMeteoFetchImpl();
    const stub = modelReply([], {
      weather: {
        place: "תל אביב",
        date: "2026-10-21",
        aspects: ["summary"],
      },
    });
    const metadata = parseReplyMetadata(stub);
    expect(metadata.weather).toEqual({
      place: "תל אביב",
      near: "",
      date: "2026-10-21",
      aspects: ["summary"],
    });

    const tip = "קחי מטריה למחר.";
    const reply = await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      composeWeatherTip: async () => tip,
    });

    expect(fetchImpl).toHaveBeenCalled();
    const geocodeCall = fetchImpl.mock.calls.find((c) =>
      String(c[0]).includes("geocoding-api"),
    );
    const geocodeUrl = new URL(String(geocodeCall?.[0]));
    expect(geocodeUrl.searchParams.get("name")).toBe("תל אביב");

    const spoken = parseLlmReply(reply).responses;
    expect(spoken).toHaveLength(2);
    expect(spoken[0]).toBe(tip);
    expect(spoken[1]).toMatch(/תל אביב|Tel Aviv/i);
    expect(spoken[1]).toMatch(/\d/);
    expect(spoken[1]).not.toMatch(/°C\s*$/);
  });

  it("weather: ack keeps model text and appends facts body only", async () => {
    const fetchImpl = openMeteoFetchImpl();
    const stub = modelReply(["רגע, בודקת מזג אוויר"], {
      weather: { place: "תל אביב", date: "", aspects: ["temp"] },
    });
    const metadata = parseReplyMetadata(stub);

    const reply = await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      composeWeatherTip: async () => "should-not-appear",
    });

    const spoken = parseLlmReply(reply).responses;
    expect(spoken[0]).toBe("רגע, בודקת מזג אוויר");
    expect(spoken).toHaveLength(2);
    expect(spoken[1]).toMatch(/\d/);
    expect(spoken.join("\n")).not.toContain("should-not-appear");
  });

  it("weather: provider failure yields safe Hebrew with no fabricated temps", async () => {
    const fetchImpl = openMeteoFetchImpl({ failForecast: true });
    const stub = modelReply([], {
      weather: { place: "תל אביב", date: "", aspects: ["summary"] },
    });
    const metadata = parseReplyMetadata(stub);

    const reply = await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const spoken = parseLlmReply(reply).response;
    expect(spoken).toMatch(/לא הצלחתי|נסה שוב/);
    expect(spoken).not.toMatch(/\d+\s*°C/);
    expect(spoken).not.toMatch(/כ־\d+/);
  });

  it("weather: missing place → ACTION dropped; empty spoken gets EMPTY_REPLY_RETRY", async () => {
    const fetchImpl = openMeteoFetchImpl();
    const stub = modelReply([], {
      weather: { place: "", date: "", aspects: ["summary"] },
    });
    const metadata = parseReplyMetadata(stub);
    // parseWeatherAction returns null; parseReplyMetadata omits the key.
    expect(metadata.weather).toBeFalsy();

    const reply = await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(parseLlmReply(reply).response).toBe(EMPTY_REPLY_RETRY);
    expect(parseLlmReply(reply).response).not.toMatch(/\d+\s*°C/);
  });

  it("guest: skips weather resolve — no provider call, original spoken unchanged", async () => {
    const fetchImpl = openMeteoFetchImpl();
    const stub = modelReply(["שלום אורח"], {
      weather: {
        place: "תל אביב",
        date: "",
        aspects: ["summary"],
      },
    });
    const metadata = parseReplyMetadata(stub);
    expect(metadata.weather?.place).toBe("תל אביב");

    const reply = await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      guestSpeaker: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      composeWeatherTip: async () => "should-not-run",
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(parseLlmReply(reply).responses).toEqual(["שלום אורח"]);
    expect(parseLlmReply(reply).response).not.toMatch(/\d+\s*°C/);
  });

  it("places: maps query+city into Google search and formats phone/address", async () => {
    const fetchImpl = placesSearchFetchImpl([
      {
        id: "places/1",
        displayName: { text: "מקדונלדס קרית אונו", languageCode: "he" },
        nationalPhoneNumber: "03-9998888",
        formattedAddress: "רחוב 1, קרית אונו",
        addressComponents: [
          { longText: "55400", types: ["postal_code"] },
          { longText: "ישראל", types: ["country"] },
        ],
      },
    ]);
    const stub = modelReply([], {
      places: {
        query: "מקדונלדס",
        place: "קרית אונו",
        near: "",
        aspects: ["summary"],
      },
    });
    const metadata = parseReplyMetadata(stub);
    expect(metadata.places?.query).toBe("מקדונלדס");
    expect(metadata.places?.place).toBe("קרית אונו");

    const reply = await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      placesApiKey: "test-key",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body ?? "{}")) as { textQuery?: string };
    expect(body.textQuery).toBe("מקדונלדס קרית אונו");

    const spoken = parseLlmReply(reply).response;
    expect(spoken).toContain("מקדונלדס קרית אונו");
    expect(spoken).toContain("03-9998888");
  });

  it("places: named city ignores stale pending pin (no locationBias)", async () => {
    const stalePin = { lat: 32.087, lng: 34.887 };
    const fetchImpl = placesSearchFetchImpl([
      {
        id: "places/city",
        displayName: { text: "מסעדה בחיפה", languageCode: "he" },
        nationalPhoneNumber: "04-111",
        formattedAddress: "חיפה",
      },
    ]);
    const stub = modelReply([], {
      places: {
        query: "מסעדה",
        place: "חיפה",
        near: "",
        aspects: ["summary"],
      },
    });
    const metadata = parseReplyMetadata(stub);
    expect(metadata.places?.near).toBe("");
    expect(metadata.places?.place).toBe("חיפה");

    await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      placesApiKey: "test-key",
      pendingLoc: stalePin,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body ?? "{}")) as {
      textQuery?: string;
      locationBias?: unknown;
      rankPreference?: string;
    };
    expect(body.textQuery).toBe("מסעדה חיפה");
    expect(body.locationBias).toBeUndefined();
    expect(body.rankPreference).toBeUndefined();
  });

  it("places: named city + near=speaker still ignores pending pin (Stage B1)", async () => {
    const stalePin = { lat: 32.087, lng: 34.887 };
    const fetchImpl = placesSearchFetchImpl([
      {
        id: "places/city-near",
        displayName: { text: "מסעדה בחיפה", languageCode: "he" },
        nationalPhoneNumber: "04-222",
        formattedAddress: "חיפה",
      },
    ]);
    const stub = modelReply([], {
      places: {
        query: "מסעדה",
        place: "חיפה",
        near: "speaker",
        aspects: ["summary"],
      },
    });
    const metadata = parseReplyMetadata(stub);
    expect(metadata.places?.near).toBe("speaker");
    expect(metadata.places?.place).toBe("חיפה");

    await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      placesApiKey: "test-key",
      pendingLoc: stalePin,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body ?? "{}")) as {
      textQuery?: string;
      locationBias?: unknown;
      rankPreference?: string;
    };
    expect(body.textQuery).toBe("מסעדה חיפה");
    expect(body.locationBias).toBeUndefined();
    expect(body.rankPreference).toBeUndefined();
  });

  it("places: area_restrict ignores pending pin (locationRestriction, no bias)", async () => {
    // Chat-parity mirror (applyChatLiveDomainPass), not full sendChatMessage.
    const stalePin = { lat: 32.087, lng: 34.887 };
    const fetchImpl = placesAreaRestrictFetchImpl([
      {
        id: "places/sharon",
        displayName: { text: "קפה בשרון", languageCode: "he" },
        nationalPhoneNumber: "09-111",
        formattedAddress: "השרון",
      },
    ]);
    const stub = modelReply([], {
      places: {
        query: "בית קפה",
        place: "השרון",
        near: "",
        geo_mode: "area_restrict",
        aspects: ["summary"],
      },
    });
    const metadata = parseReplyMetadata(stub);
    expect(metadata.places?.geoMode).toBe("area_restrict");
    expect(metadata.places?.near).toBe("");
    expect(metadata.places?.lat).toBeNull();
    expect(metadata.places?.lng).toBeNull();

    await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      placesApiKey: "test-key",
      pendingLoc: stalePin,
    });

    const placesCalls = fetchImpl.mock.calls.filter((c) =>
      String(c[0]).includes("places.googleapis.com"),
    );
    expect(placesCalls).toHaveLength(1);
    const body = JSON.parse(
      String((placesCalls[0]![1] as RequestInit).body ?? "{}"),
    ) as {
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
    expect(body.textQuery).toBe("בית קפה");
    expect(body.locationBias).toBeUndefined();
    expect(body.rankPreference).toBeUndefined();
    expect(body.locationRestriction?.rectangle?.low).toEqual({
      latitude: 32.05,
      longitude: 34.75,
    });
    expect(body.locationRestriction?.rectangle?.high).toEqual({
      latitude: 32.35,
      longitude: 35.05,
    });
  });

  it("places: near=speaker uses pending lat/lng as locationBias", async () => {
    const pending = { lat: 32.087, lng: 34.887 };
    const fetchImpl = placesSearchFetchImpl([
      {
        id: "places/near",
        displayName: { text: "פיצה באזור", languageCode: "he" },
        nationalPhoneNumber: "03-1112222",
        formattedAddress: "רחוב קרוב 2",
      },
    ]);
    const stub = modelReply([], {
      places: {
        query: "פיצה",
        place: "",
        near: "speaker",
        aspects: ["summary"],
      },
    });
    const metadata = parseReplyMetadata(stub);
    expect(metadata.places?.near).toBe("speaker");
    expect(metadata.places?.place).toBe("");

    const reply = await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      placesApiKey: "test-key",
      pendingLoc: pending,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body ?? "{}")) as {
      textQuery?: string;
      locationBias?: {
        circle?: { center?: { latitude?: number; longitude?: number } };
      };
    };
    expect(body.textQuery).toBe("פיצה");
    expect(body.locationBias?.circle?.center).toEqual({
      latitude: pending.lat,
      longitude: pending.lng,
    });

    const spoken = parseLlmReply(reply).response;
    expect(spoken).toContain("פיצה באזור");
    expect(spoken).toContain("03-1112222");
  });

  it("places: missing API key returns safe notice without inventing phones", async () => {
    const fetchImpl = vi.fn();
    const stub = modelReply([], {
      places: {
        query: "חשמלאי",
        place: "פתח תקווה",
        near: "",
        aspects: ["phone"],
      },
    });
    const metadata = parseReplyMetadata(stub);

    const reply = await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      placesApiKey: "",
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    const spoken = parseLlmReply(reply).response;
    expect(spoken).toMatch(/לא מוגדר|חסר מפתח/);
    expect(spoken).not.toMatch(/\d{2,}-?\d{5,}/);
  });

  it("places: empty provider results → no fabricated listings", async () => {
    const fetchImpl = placesSearchFetchImpl([]);
    const stub = modelReply(["מחפשת…"], {
      places: {
        query: "xyzzy",
        place: "נווה מדבר",
        near: "",
        aspects: ["summary"],
      },
    });
    const metadata = parseReplyMetadata(stub);

    const reply = await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      placesApiKey: "test-key",
    });

    const spoken = parseLlmReply(reply).responses;
    expect(spoken[0]).toBe("מחפשת…");
    expect(spoken[1]).toMatch(/לא מצאתי תוצאות/);
    expect(spoken.join("\n")).not.toMatch(/טלפון:\s*\d/);
  });

  it("jewish: live candles lookup formats Hebcal times for a city", async () => {
    const fetchImpl = hebcalShabbatFetchImpl();
    const stub = modelReply([], {
      jewish: {
        place: "פתח תקווה",
        date: "",
        aspects: ["candles"],
      },
    });
    const metadata = parseReplyMetadata(stub);
    expect(metadata.jewish?.aspects).toEqual(["candles"]);

    const reply = await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalled();
    const spoken = parseLlmReply(reply).response;
    expect(spoken).toContain("17:39");
    expect(spoken).not.toMatch(/תזכיר|הזכרתי/);
  });

  it("jewish: candles without place → ACTION dropped; empty spoken gets EMPTY_REPLY_RETRY", async () => {
    const fetchImpl = vi.fn();
    const stub = modelReply([], {
      jewish: { place: "", date: "", aspects: ["candles"] },
    });
    const metadata = parseReplyMetadata(stub);
    // parseJewishAction nulls place-required aspects without a city — Chat never resolves.
    expect(metadata.jewish).toBeFalsy();

    const reply = await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(parseLlmReply(reply).response).toBe(EMPTY_REPLY_RETRY);
    expect(parseLlmReply(reply).response).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("jewish vs candle reminder: schedule_anchor jewish_candles skips live jewish lookup", async () => {
    const fetchImpl = hebcalShabbatFetchImpl();
    const stub = modelReply(["אשמח להזכיר לך להדליק נרות"], {
      jewish: {
        place: "פתח תקווה",
        date: "",
        aspects: ["candles"],
      },
      reminders: [
        {
          action: "add",
          item: "להדליק נרות",
          list_type: "tasks",
          text: "להדליק נרות",
          schedule_anchor: "jewish_candles",
          schedule_offset_minutes: -10,
          compose_place: "פתח תקווה",
        },
      ],
    });
    const metadata = parseReplyMetadata(stub);
    expect(metadata.jewish).not.toBeNull();
    expect(
      metadata.reminders.some((r) => r.scheduleAnchor === "jewish_candles"),
    ).toBe(true);

    const reply = await applyChatLiveDomainPass({
      workingReply: stub,
      metadata,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Chat prefers candle-offset reminder over live jewish — no Hebcal on this pass.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(parseLlmReply(reply).responses).toEqual([
      "אשמח להזכיר לך להדליק נרות",
    ]);
    expect(parseLlmReply(reply).response).not.toContain("17:39");
  });
});

