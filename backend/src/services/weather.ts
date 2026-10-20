import { jerusalemYmd } from "../utils/relative-date.js";

export type WeatherAspect =
  | "summary"
  | "temp"
  | "wind"
  | "waves"
  | "humidity";

export type WeatherPlace = {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  timezone?: string;
};

export type WeatherDayFacts = {
  date: string;
  condition: string;
  tempMinC: number | null;
  tempMaxC: number | null;
  tempNowC: number | null;
  humidityPct: number | null;
  windKmh: number | null;
  windGustKmh: number | null;
  waveHeightM: number | null;
};

export type WeatherFacts = {
  place: WeatherPlace;
  requestedDate: string;
  days: WeatherDayFacts[];
  aspects: WeatherAspect[];
};

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";

const ASPECT_SET = new Set<WeatherAspect>([
  "summary",
  "temp",
  "wind",
  "waves",
  "humidity",
]);

/** WMO weather interpretation codes → short Hebrew. */
const WMO_HE: Record<number, string> = {
  0: "בהיר",
  1: "בעיקר בהיר",
  2: "מעונן חלקית",
  3: "מעונן",
  45: "ערפל",
  48: "ערפל עם כפור",
  51: "טפטוף קל",
  53: "טפטוף",
  55: "טפטוף חזק",
  56: "טפטוף קפוא קל",
  57: "טפטוף קפוא",
  61: "גשם קל",
  63: "גשם",
  65: "גשם חזק",
  66: "גשם קפוא קל",
  67: "גשם קפוא",
  71: "שלג קל",
  73: "שלג",
  75: "שלג חזק",
  77: "גרגרי שלג",
  80: "ממטרים קלים",
  81: "ממטרים",
  82: "ממטרים חזקים",
  85: "ממטרי שלג קלים",
  86: "ממטרי שלג חזקים",
  95: "סופת רעמים",
  96: "סופת רעמים עם ברד קל",
  99: "סופת רעמים עם ברד",
};

export function parseWeatherAspects(raw: unknown): WeatherAspect[] {
  if (!Array.isArray(raw)) {
    return ["summary"];
  }
  const out: WeatherAspect[] = [];
  for (const entry of raw) {
    const key = String(entry ?? "")
      .trim()
      .toLowerCase() as WeatherAspect;
    if (ASPECT_SET.has(key) && !out.includes(key)) {
      out.push(key);
    }
  }
  return out.length > 0 ? out : ["summary"];
}

export function conditionFromWmo(code: number | null | undefined): string {
  if (typeof code !== "number" || !Number.isFinite(code)) {
    return "לא ידוע";
  }
  return WMO_HE[Math.trunc(code)] ?? "לא ידוע";
}

function round1(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return null;
  }
  return Math.round(n * 10) / 10;
}

function wantsAspect(aspects: WeatherAspect[], key: WeatherAspect): boolean {
  if (aspects.includes("summary")) {
    return true;
  }
  return aspects.includes(key);
}

function needsWaves(aspects: WeatherAspect[]): boolean {
  return aspects.includes("waves") || aspects.includes("summary");
}

type GeocodeResponse = {
  results?: Array<{
    name?: string;
    latitude?: number;
    longitude?: number;
    country?: string;
    timezone?: string;
    admin1?: string;
  }>;
};

export async function geocodePlace(
  place: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WeatherPlace | null> {
  const q = place.trim();
  if (!q) {
    return null;
  }
  const url = new URL(GEOCODE_URL);
  url.searchParams.set("name", q);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "he");
  const res = await fetchImpl(url.toString());
  if (!res.ok) {
    throw new Error(`weather geocode HTTP ${res.status}`);
  }
  const body = (await res.json()) as GeocodeResponse;
  const row = body.results?.[0];
  if (
    !row ||
    typeof row.latitude !== "number" ||
    typeof row.longitude !== "number"
  ) {
    return null;
  }
  const label = [row.name, row.admin1, row.country]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(", ");
  return {
    name: label || q,
    latitude: row.latitude,
    longitude: row.longitude,
    country: row.country,
    timezone: row.timezone,
  };
}

type ForecastResponse = {
  timezone?: string;
  current?: {
    time?: string;
    temperature_2m?: number;
    relative_humidity_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    wind_gusts_10m?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    wind_speed_10m_max?: number[];
    wind_gusts_10m_max?: number[];
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    relative_humidity_2m?: number[];
    weather_code?: number[];
    wind_speed_10m?: number[];
    wind_gusts_10m?: number[];
  };
};

type MarineResponse = {
  daily?: {
    time?: string[];
    wave_height_max?: number[];
  };
  hourly?: {
    time?: string[];
    wave_height?: number[];
  };
};

async function fetchForecast(
  place: WeatherPlace,
  fetchImpl: typeof fetch,
): Promise<ForecastResponse> {
  const url = new URL(FORECAST_URL);
  url.searchParams.set("latitude", String(place.latitude));
  url.searchParams.set("longitude", String(place.longitude));
  url.searchParams.set("timezone", place.timezone || "auto");
  url.searchParams.set("forecast_days", "7");
  url.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m",
  );
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_gusts_10m_max",
  );
  url.searchParams.set(
    "hourly",
    "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m",
  );
  url.searchParams.set("wind_speed_unit", "kmh");
  const res = await fetchImpl(url.toString());
  if (!res.ok) {
    throw new Error(`weather forecast HTTP ${res.status}`);
  }
  return (await res.json()) as ForecastResponse;
}

async function fetchMarine(
  place: WeatherPlace,
  fetchImpl: typeof fetch,
): Promise<MarineResponse | null> {
  const url = new URL(MARINE_URL);
  url.searchParams.set("latitude", String(place.latitude));
  url.searchParams.set("longitude", String(place.longitude));
  url.searchParams.set("timezone", place.timezone || "auto");
  url.searchParams.set("forecast_days", "7");
  url.searchParams.set("daily", "wave_height_max");
  url.searchParams.set("hourly", "wave_height");
  try {
    const res = await fetchImpl(url.toString());
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as MarineResponse;
  } catch {
    return null;
  }
}

function middayHourIndex(hourlyTimes: string[] | undefined, ymd: string): number {
  if (!hourlyTimes?.length) {
    return -1;
  }
  const noon = hourlyTimes.findIndex((t) => t.startsWith(`${ymd}T12:`));
  if (noon >= 0) {
    return noon;
  }
  return hourlyTimes.findIndex((t) => t.startsWith(ymd));
}

function waveForDay(marine: MarineResponse | null, ymd: string): number | null {
  if (!marine) {
    return null;
  }
  const dailyIdx = marine.daily?.time?.indexOf(ymd) ?? -1;
  if (dailyIdx >= 0) {
    return round1(marine.daily?.wave_height_max?.[dailyIdx]);
  }
  const hourIdx = middayHourIndex(marine.hourly?.time, ymd);
  if (hourIdx >= 0) {
    return round1(marine.hourly?.wave_height?.[hourIdx]);
  }
  return null;
}

function buildDayFacts(
  forecast: ForecastResponse,
  marine: MarineResponse | null,
  ymd: string,
  todayYmd: string,
): WeatherDayFacts | null {
  const dailyIdx = forecast.daily?.time?.indexOf(ymd) ?? -1;
  if (dailyIdx < 0 && ymd !== todayYmd) {
    return null;
  }

  const hourIdx = middayHourIndex(forecast.hourly?.time, ymd);
  const isToday = ymd === todayYmd;
  const current = isToday ? forecast.current : undefined;

  const weatherCode =
    current?.weather_code ??
    (dailyIdx >= 0 ? forecast.daily?.weather_code?.[dailyIdx] : undefined) ??
    (hourIdx >= 0 ? forecast.hourly?.weather_code?.[hourIdx] : undefined);

  return {
    date: ymd,
    condition: conditionFromWmo(
      typeof weatherCode === "number" ? weatherCode : null,
    ),
    tempMinC:
      dailyIdx >= 0
        ? round1(forecast.daily?.temperature_2m_min?.[dailyIdx])
        : null,
    tempMaxC:
      dailyIdx >= 0
        ? round1(forecast.daily?.temperature_2m_max?.[dailyIdx])
        : null,
    tempNowC: isToday
      ? round1(current?.temperature_2m)
      : hourIdx >= 0
        ? round1(forecast.hourly?.temperature_2m?.[hourIdx])
        : null,
    humidityPct: isToday
      ? round1(current?.relative_humidity_2m)
      : hourIdx >= 0
        ? round1(forecast.hourly?.relative_humidity_2m?.[hourIdx])
        : null,
    windKmh: isToday
      ? round1(current?.wind_speed_10m)
      : dailyIdx >= 0
        ? round1(forecast.daily?.wind_speed_10m_max?.[dailyIdx])
        : hourIdx >= 0
          ? round1(forecast.hourly?.wind_speed_10m?.[hourIdx])
          : null,
    windGustKmh: isToday
      ? round1(current?.wind_gusts_10m)
      : dailyIdx >= 0
        ? round1(forecast.daily?.wind_gusts_10m_max?.[dailyIdx])
        : hourIdx >= 0
          ? round1(forecast.hourly?.wind_gusts_10m?.[hourIdx])
          : null,
    waveHeightM: waveForDay(marine, ymd),
  };
}

export async function fetchWeatherFacts(input: {
  place: string;
  date?: string | null;
  aspects?: WeatherAspect[] | unknown;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<WeatherFacts | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const aspects = parseWeatherAspects(input.aspects);
  const geo = await geocodePlace(input.place, fetchImpl);
  if (!geo) {
    return null;
  }

  const today = jerusalemYmd(input.now);
  const requested = String(input.date ?? "")
    .trim()
    .match(/^\d{4}-\d{2}-\d{2}$/)
    ? String(input.date).trim()
    : today;

  const forecast = await fetchForecast(geo, fetchImpl);
  const marine = needsWaves(aspects)
    ? await fetchMarine(geo, fetchImpl)
    : null;

  const day = buildDayFacts(forecast, marine, requested, today);
  const days: WeatherDayFacts[] = [];
  if (day) {
    days.push(day);
  } else if (forecast.daily?.time?.length) {
    // Fallback: first available daily row.
    const first = forecast.daily.time[0]!;
    const fallback = buildDayFacts(forecast, marine, first, today);
    if (fallback) {
      days.push(fallback);
    }
  }

  if (days.length === 0) {
    return null;
  }

  return {
    place: geo,
    requestedDate: requested,
    days,
    aspects,
  };
}

function fmtNum(n: number | null, suffix: string): string | null {
  if (n === null) {
    return null;
  }
  const text = Number.isInteger(n) ? String(n) : String(n);
  return `${text}${suffix}`;
}

function dateLabel(ymd: string, today: string): string {
  if (ymd === today) {
    return "היום";
  }
  const t = Date.parse(`${today}T12:00:00+03:00`);
  const d = Date.parse(`${ymd}T12:00:00+03:00`);
  if (Number.isFinite(t) && Number.isFinite(d)) {
    const diffDays = Math.round((d - t) / 86_400_000);
    if (diffDays === 1) {
      return "מחר";
    }
    if (diffDays === -1) {
      return "אתמול";
    }
  }
  const [y, m, day] = ymd.split("-");
  return `${day}.${m}.${y}`;
}

/** Deterministic Hebrew reply from fetched facts (engine replaces model response). */
export function formatWeatherHebrew(
  facts: WeatherFacts,
  now = new Date(),
): string {
  const today = jerusalemYmd(now);
  const day = facts.days[0];
  if (!day) {
    return `לא מצאתי נתוני מזג אוויר עבור ${facts.place.name}.`;
  }

  const when = dateLabel(day.date, today);
  const place = facts.place.name;
  const aspects = facts.aspects;
  const lines: string[] = [];

  const focusWaves =
    aspects.includes("waves") &&
    !aspects.includes("summary") &&
    aspects.length === 1;
  const focusWind =
    aspects.includes("wind") &&
    !aspects.includes("summary") &&
    !aspects.includes("waves") &&
    aspects.filter((a) => a !== "wind").length === 0;
  const focusHumidity =
    aspects.includes("humidity") &&
    !aspects.includes("summary") &&
    aspects.length === 1;
  const focusTemp =
    aspects.includes("temp") &&
    !aspects.includes("summary") &&
    aspects.length === 1;

  if (focusWaves) {
    const wave = fmtNum(day.waveHeightM, " מ׳");
    if (wave) {
      return `גובה הגלים ב${place} ${when}: כ־${wave}.`;
    }
    return `אין נתון גלים זמין ל${place} ${when}.`;
  }

  if (focusWind) {
    const wind = fmtNum(day.windKmh, " קמ״ש");
    const gust = fmtNum(day.windGustKmh, " קמ״ש");
    if (wind && gust) {
      return `משב הרוח ב${place} ${when}: כ־${wind}, משבים עד כ־${gust}.`;
    }
    if (wind) {
      return `הרוח ב${place} ${when}: כ־${wind}.`;
    }
    return `אין נתון רוח זמין ל${place} ${when}.`;
  }

  if (focusHumidity) {
    const hum = fmtNum(day.humidityPct, "%");
    if (hum) {
      return `הלחות ב${place} ${when}: כ־${hum}.`;
    }
    return `אין נתון לחות זמין ל${place} ${when}.`;
  }

  if (focusTemp) {
    if (day.tempNowC !== null && when === "היום") {
      return `הטמפרטורה ב${place} עכשיו: כ־${fmtNum(day.tempNowC, "°C")}.`;
    }
    if (day.tempMinC !== null && day.tempMaxC !== null) {
      return `הטמפרטורה ב${place} ${when}: ${fmtNum(day.tempMinC, "°C")}–${fmtNum(day.tempMaxC, "°C")}.`;
    }
    if (day.tempNowC !== null) {
      return `הטמפרטורה ב${place} ${when}: כ־${fmtNum(day.tempNowC, "°C")}.`;
    }
    return `אין נתון טמפרטורה זמין ל${place} ${when}.`;
  }

  // summary / multi-aspect
  lines.push(`מזג האוויר ב${place} ${when}: ${day.condition}.`);

  if (wantsAspect(aspects, "temp")) {
    if (day.tempNowC !== null && when === "היום") {
      lines.push(`טמפרטורה עכשיו כ־${fmtNum(day.tempNowC, "°C")}.`);
    }
    if (day.tempMinC !== null && day.tempMaxC !== null) {
      lines.push(
        `טווח יומי ${fmtNum(day.tempMinC, "°C")}–${fmtNum(day.tempMaxC, "°C")}.`,
      );
    }
  }

  if (wantsAspect(aspects, "wind")) {
    const wind = fmtNum(day.windKmh, " קמ״ש");
    const gust = fmtNum(day.windGustKmh, " קמ״ש");
    if (wind && gust) {
      lines.push(`רוח כ־${wind}, משבים עד כ־${gust}.`);
    } else if (wind) {
      lines.push(`רוח כ־${wind}.`);
    }
  }

  if (wantsAspect(aspects, "humidity")) {
    const hum = fmtNum(day.humidityPct, "%");
    if (hum) {
      lines.push(`לחות כ־${hum}.`);
    }
  }

  if (wantsAspect(aspects, "waves")) {
    const wave = fmtNum(day.waveHeightM, " מ׳");
    if (wave) {
      lines.push(`גובה גלים כ־${wave}.`);
    }
  }

  return lines.join(" ");
}

/** Resolve live weather ACTION → spoken Hebrew (or error sentence). */
export async function resolveWeatherReply(input: {
  place: string;
  date?: string | null;
  aspects?: WeatherAspect[] | unknown;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const place = input.place.trim();
  if (!place) {
    return "לאיזה מקום לבדוק את מזג האוויר?";
  }
  try {
    const facts = await fetchWeatherFacts(input);
    if (!facts) {
      return `לא מצאתי מקום בשם «${place}».`;
    }
    return formatWeatherHebrew(facts, input.now);
  } catch {
    return "לא הצלחתי לשלוף עכשיו את מזג האוויר. נסה שוב בעוד רגע.";
  }
}
