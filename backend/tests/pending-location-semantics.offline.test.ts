/**
 * Stage A: PENDING_LOCATION availability vs semantic ACTION choice + clear rules.
 * Engine executes ACTION only — no utterance NLP.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePlacesAction, parseWeatherAction } from "@workee/shared";
import {
  clearPendingLocation,
  formatPendingLocationContext,
  getPendingLocation,
  resetPendingLocations,
  setPendingLocation,
} from "../src/services/pending-location.js";
import { shouldClearPendingAfterSpeakerPinUse } from "../src/services/resolved-location.js";
import {
  resolvePlacesReplyDetailed,
} from "../src/services/places.js";
import { resolveWeatherMessages } from "../src/services/weather.js";

const EMP = "emp-pending-semantics";

afterEach(() => {
  resetPendingLocations();
  vi.restoreAllMocks();
});

function seedPin() {
  setPendingLocation(EMP, {
    lat: 32.087,
    lng: 34.887,
    name: "פינ ישן",
    address: "",
  });
}

function openMeteoFetchImpl() {
  return vi.fn(async (url: string) => {
    const href = String(url);
    if (href.includes("geocoding-api")) {
      return {
        ok: true,
        json: async () => ({
          results: [
            {
              name: "Haifa",
              latitude: 32.8,
              longitude: 34.98,
              country: "Israel",
              timezone: "Asia/Jerusalem",
            },
          ],
        }),
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({
        timezone: "Asia/Jerusalem",
        current: {
          time: "2026-10-20T10:00",
          temperature_2m: 22,
          relative_humidity_2m: 50,
          weather_code: 0,
          wind_speed_10m: 10,
          wind_gusts_10m: 15,
        },
        daily: {
          time: ["2026-10-20"],
          weather_code: [0],
          temperature_2m_max: [26],
          temperature_2m_min: [18],
          wind_speed_10m_max: [14],
          wind_gusts_10m_max: [20],
        },
        hourly: {
          time: ["2026-10-20T12:00"],
          temperature_2m: [23],
          relative_humidity_2m: [48],
          weather_code: [0],
          wind_speed_10m: [12],
          wind_gusts_10m: [18],
        },
      }),
    } as Response;
  });
}

describe("pending-location semantics (Stage A)", () => {
  it("11a ACTION: named city weather while pin in TTL — geocode city, keep pin", async () => {
    seedPin();
    const action = parseWeatherAction({
      weather: {
        place: "חיפה",
        near: "",
        aspects: ["summary"],
      },
    });
    expect(action?.place).toBe("חיפה");
    expect(action?.near).toBe("");

    const fetchImpl = openMeteoFetchImpl();
    const pin = getPendingLocation(EMP)!;
    const weather = await resolveWeatherMessages({
      place: action!.place,
      nearSpeaker: action!.near === "speaker",
      // Engine must NOT pass pin when place is named — simulate chat.service.
      latitude: null,
      longitude: null,
      aspects: action!.aspects,
      now: new Date("2026-10-20T10:00:00+03:00"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      composeTip: async () => null,
    });
    expect(weather.usedPendingPin).toBe(false);
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("geocoding-api"))).toBe(true);
    expect(urls.some((u) => u.includes(`latitude=${pin.lat}`))).toBe(false);
    expect(
      shouldClearPendingAfterSpeakerPinUse({
        usedPendingPin: weather.usedPendingPin,
        needsLocation: weather.needsLocation,
        replyText: weather.body,
      }),
    ).toBe(false);
    expect(getPendingLocation(EMP)).not.toBeNull();
  });

  it("11b ACTION: vague near-me without deixis must not emit near=speaker (parse drop)", () => {
    seedPin();
    // Model asks for clarification → weather null / places incomplete.
    expect(parseWeatherAction({ weather: { place: "", aspects: ["summary"] } })).toBeNull();
    expect(
      parsePlacesAction({
        places: { query: "", place: "", near: "", aspects: ["summary"] },
      }),
    ).toBeNull();
    // Pin remains available — engine never auto-selects it.
    expect(getPendingLocation(EMP)).not.toBeNull();
  });

  it("LOCATION DEIXIS: PENDING_LOCATION inject teaches pin vs chat anaphora (not bare «שם»→pin)", () => {
    seedPin();
    const ctx = formatPendingLocationContext(getPendingLocation(EMP));
    expect(ctx).toContain("PENDING_LOCATION:");
    expect(ctx).toContain("AVAILABLE only");
    // Clear pin cues remain.
    expect(ctx).toContain("מכאן");
    expect(ctx).toContain("מהמיקום ששלחתי");
    // Jewish pin path uses place:"speaker" (no near field on jewish ACTION).
    expect(ctx).toContain('jewish { place:"speaker"');
    expect(ctx).toContain('jewish place:"speaker"');
    // Conversational «שם» must not be listed as automatic pin deixis.
    expect(ctx).toMatch(/LOCATION ANAPHORA/);
    expect(ctx).toContain("שם");
    expect(ctx).toContain("re-emit that place string");
    expect(ctx).toContain("FORBIDDEN treating bare «שם» as this pin");
    // Intervening reminder / ambiguity → ask.
    expect(ctx).toMatch(/reminder|outbound/i);
    expect(ctx).toMatch(/ASK one short question/);
    // Must not revive the old blanket «שם»→pin teaching line.
    expect(ctx).not.toContain(
      "near-me deixis / «שם» / «מהמיקום ששלחתי» / «מכאן»",
    );
  });

  it("LOCATION DEIXIS: expected ACTION shapes for pin vs prior place vs ask (stub contract)", () => {
    // Pin path — model emits near=speaker (engine does not NLP «מכאן»).
    const pinAsk = parseWeatherAction({
      weather: { place: "", near: "speaker", aspects: ["summary"] },
    });
    expect(pinAsk?.near).toBe("speaker");
    expect(pinAsk?.place).toBe("");

    // Prior place anaphora — re-emit city; near empty (not speaker).
    const priorPlace = parseWeatherAction({
      weather: {
        place: "תל אביב",
        near: "",
        aspects: ["summary"],
      },
    });
    expect(priorPlace?.place).toBe("תל אביב");
    expect(priorPlace?.near).toBe("");

    // Ambiguous → model leaves weather null (ask in responses).
    expect(parseWeatherAction({ weather: null })).toBeNull();

    // Places: same split — near=speaker only for pin; named place for anaphora.
    const placesPin = parsePlacesAction({
      places: {
        query: "מסעדה",
        place: "",
        near: "speaker",
        aspects: ["summary"],
      },
    });
    expect(placesPin?.near).toBe("speaker");
    expect(placesPin?.place).toBe("");

    const placesAnaphora = parsePlacesAction({
      places: {
        query: "בית קפה",
        place: "מלון דן",
        near: "",
        aspects: ["summary"],
      },
    });
    expect(placesAnaphora?.place).toContain("דן");
    expect(placesAnaphora?.near).toBe("");
  });

  it("12 ACTION: clear deixis reuses pin after intervening turn (still in TTL)", async () => {
    seedPin();
    // Intervening Lucy turn does not clear pending.
    expect(getPendingLocation(EMP)).not.toBeNull();

    const action = parseWeatherAction({
      weather: {
        place: "",
        near: "speaker",
        aspects: ["temp"],
      },
    });
    expect(action?.near).toBe("speaker");
    expect(action?.place).toBe("");

    const pin = getPendingLocation(EMP)!;
    const fetchImpl = openMeteoFetchImpl();
    const weather = await resolveWeatherMessages({
      place: pin.name || "המיקום שלך",
      nearSpeaker: true,
      latitude: pin.lat,
      longitude: pin.lng,
      aspects: ["temp"],
      now: new Date("2026-10-20T10:00:00+03:00"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(weather.usedPendingPin).toBe(true);
    const forecastUrl = fetchImpl.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("forecast"));
    expect(forecastUrl).toContain(`latitude=${pin.lat}`);
    expect(forecastUrl).toContain(`longitude=${pin.lng}`);
    if (
      shouldClearPendingAfterSpeakerPinUse({
        usedPendingPin: weather.usedPendingPin,
        needsLocation: weather.needsLocation,
        replyText: weather.body,
      })
    ) {
      clearPendingLocation(EMP);
    }
    expect(getPendingLocation(EMP)).toBeNull();
  });

  it("places ask-for-pin does not clear pending; successful near=speaker does", async () => {
    seedPin();
    const ask = await resolvePlacesReplyDetailed({
      query: "פיצה",
      place: "",
      nearSpeaker: true,
      lat: null,
      lng: null,
      aspects: ["summary"],
      apiKey: "test-key",
    });
    expect(ask.needsLocation).toBe(true);
    expect(ask.usedPendingPin).toBe(false);
    expect(ask.text).toMatch(/שלח מיקום/);
    expect(
      shouldClearPendingAfterSpeakerPinUse({
        usedPendingPin: ask.usedPendingPin,
        needsLocation: ask.needsLocation,
        replyText: ask.text,
      }),
    ).toBe(false);
    expect(getPendingLocation(EMP)).not.toBeNull();

    const pin = getPendingLocation(EMP)!;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        places: [
          {
            id: "places/1",
            displayName: { text: "פיצה", languageCode: "he" },
            nationalPhoneNumber: "03-1",
            formattedAddress: "רחוב 1",
          },
        ],
      }),
    }));
    const ok = await resolvePlacesReplyDetailed({
      query: "פיצה",
      place: "",
      nearSpeaker: true,
      lat: pin.lat,
      lng: pin.lng,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(ok.usedPendingPin).toBe(true);
    expect(ok.needsLocation).toBe(false);
    if (
      shouldClearPendingAfterSpeakerPinUse({
        usedPendingPin: ok.usedPendingPin,
        needsLocation: ok.needsLocation,
        replyText: ok.text,
      })
    ) {
      clearPendingLocation(EMP);
    }
    expect(getPendingLocation(EMP)).toBeNull();
  });
});
