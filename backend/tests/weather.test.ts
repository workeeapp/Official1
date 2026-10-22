import { describe, expect, it, vi } from "vitest";
import {
  conditionFromWmo,
  fetchWeatherFacts,
  formatWeatherHebrew,
  parseWeatherAspects,
  resolveWeatherMessages,
  resolveWeatherReply,
  type WeatherFacts,
} from "../src/services/weather.js";

describe("parseWeatherAspects", () => {
  it("defaults to summary", () => {
    expect(parseWeatherAspects(undefined)).toEqual(["summary"]);
    expect(parseWeatherAspects([])).toEqual(["summary"]);
  });

  it("keeps known aspects only", () => {
    expect(parseWeatherAspects(["wind", "waves", "nope", "WIND"])).toEqual([
      "wind",
      "waves",
    ]);
  });
});

describe("conditionFromWmo", () => {
  it("maps known codes", () => {
    expect(conditionFromWmo(0)).toBe("בהיר");
    expect(conditionFromWmo(61)).toBe("גשם קל");
  });

  it("falls back for unknown", () => {
    expect(conditionFromWmo(999)).toBe("לא ידוע");
    expect(conditionFromWmo(null)).toBe("לא ידוע");
  });
});

describe("formatWeatherHebrew", () => {
  const base: WeatherFacts = {
    place: { name: "תל אביב", latitude: 32.08, longitude: 34.78 },
    requestedDate: "2026-10-20",
    aspects: ["summary"],
    days: [
      {
        date: "2026-10-20",
        condition: "בהיר",
        weatherCode: 0,
        isRain: false,
        precipMm: 0,
        tempMinC: 18,
        tempMaxC: 28,
        tempNowC: 24,
        humidityPct: 55,
        windKmh: 15,
        windGustKmh: 28,
        waveHeightM: 0.8,
      },
    ],
  };
  const now = new Date("2026-10-20T10:00:00+03:00");

  it("formats a summary with newlines and emphasized condition", () => {
    const text = formatWeatherHebrew(base, now);
    expect(text).toContain("תל אביב");
    expect(text).toContain("*בהיר*");
    expect(text).toContain("\n");
    expect(text).toContain("• עכשיו כ־24°C");
    expect(text).toContain("• רוח כ־15 קמ״ש");
    expect(text).toContain("• גובה גלים כ־0.8 מ׳");
  });

  it("formats waves-only", () => {
    const text = formatWeatherHebrew(
      { ...base, aspects: ["waves"] },
      now,
    );
    expect(text).toMatch(/גובה הגלים/);
    expect(text).toContain("0.8");
    expect(text).not.toContain("*בהיר*");
  });

  it("formats wind-only with gusts", () => {
    const text = formatWeatherHebrew(
      { ...base, aspects: ["wind"] },
      now,
    );
    expect(text).toMatch(/משב הרוח|הרוח/);
    expect(text).toContain("15");
    expect(text).toContain("28");
  });
});

function openMeteoFetchImpl() {
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
    if (href.includes("marine-api")) {
      return {
        ok: true,
        json: async () => ({
          daily: {
            time: ["2026-10-20"],
            wave_height_max: [1.2],
          },
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
          time: ["2026-10-20"],
          weather_code: [0],
          temperature_2m_max: [29],
          temperature_2m_min: [19],
          wind_speed_10m_max: [18],
          wind_gusts_10m_max: [30],
        },
        hourly: {
          time: ["2026-10-20T12:00"],
          temperature_2m: [26],
          relative_humidity_2m: [48],
          weather_code: [0],
          wind_speed_10m: [14],
          wind_gusts_10m: [22],
        },
      }),
    } as Response;
  });
}

describe("fetchWeatherFacts / resolveWeatherReply", () => {
  it("geocodes and builds day facts from Open-Meteo-shaped JSON", async () => {
    const fetchImpl = openMeteoFetchImpl();

    const facts = await fetchWeatherFacts({
      place: "תל אביב",
      aspects: ["summary"],
      now: new Date("2026-10-20T10:00:00+03:00"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(facts).not.toBeNull();
    expect(facts!.place.name).toContain("Tel Aviv");
    expect(facts!.days[0]!.tempNowC).toBe(25);
    expect(facts!.days[0]!.waveHeightM).toBe(1.2);
    expect(facts!.days[0]!.weatherCode).toBe(0);
    expect(facts!.days[0]!.isRain).toBe(false);

    const reply = await resolveWeatherReply({
      place: "תל אביב",
      aspects: ["waves"],
      now: new Date("2026-10-20T10:00:00+03:00"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply).toMatch(/גלים/);
    expect(reply).toContain("1.2");
  });

  it("returns a place-not-found sentence when geocode is empty", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [] }),
    })) as unknown as typeof fetch;

    const reply = await resolveWeatherReply({
      place: "NowhereLandXYZ",
      fetchImpl,
    });
    expect(reply).toContain("לא מצאתי מקום");
  });

  it("asks for place when empty", async () => {
    const reply = await resolveWeatherReply({ place: "  " });
    expect(reply).toContain("לאיזה מקום");
  });
});

describe("resolveWeatherMessages", () => {
  const now = new Date("2026-10-20T10:00:00+03:00");

  it("returns tip then body when tip composer succeeds", async () => {
    const composeTip = vi.fn(async () => "כדאי לקחת מטריה.");
    const result = await resolveWeatherMessages({
      place: "תל אביב",
      aspects: ["summary"],
      now,
      fetchImpl: openMeteoFetchImpl() as unknown as typeof fetch,
      composeTip,
    });
    expect(composeTip).toHaveBeenCalledOnce();
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toBe("כדאי לקחת מטריה.");
    expect(result.messages[1]).toContain("*בהיר*");
    expect(result.body).toBe(result.messages[1]);
  });

  it("returns body only when tip composer returns null", async () => {
    const composeTip = vi.fn(async () => null);
    const result = await resolveWeatherMessages({
      place: "תל אביב",
      aspects: ["summary"],
      now,
      fetchImpl: openMeteoFetchImpl() as unknown as typeof fetch,
      composeTip,
    });
    expect(composeTip).toHaveBeenCalledOnce();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toContain("*בהיר*");
    expect(result.body).toBe(result.messages[0]);
  });

  it("does not call tip composer for waves-only", async () => {
    const composeTip = vi.fn(async () => "should not run");
    const result = await resolveWeatherMessages({
      place: "תל אביב",
      aspects: ["waves"],
      now,
      fetchImpl: openMeteoFetchImpl() as unknown as typeof fetch,
      composeTip,
    });
    expect(composeTip).not.toHaveBeenCalled();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/גלים/);
  });
});
