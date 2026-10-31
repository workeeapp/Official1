/**
 * Live Jewish calendar / Shabbat via Hebcal (no API key).
 * Model→Action→Engine: engine only formats Hebcal facts — never invents times.
 *
 * MVP place resolution (PIN / saved coords): product is Israel-only for now, so
 * lat/lng paths use Asia/Jerusalem. Do not treat that as a global tz default
 * for abroad pins — a real coords→tzid path needs a later approval.
 */

import type { EmployeeRecordSnapshot } from "./employee-records.service.js";
import type { PendingLocation } from "./pending-location.js";
import { fromPendingLocation } from "./resolved-location.js";
import {
  formatSavedLabelMissingCoordsAsk,
  formatSavedRouteAmbiguousAsk,
  formatSavedRouteNotice,
  matchSavedPlaceWithoutCoords,
  resolveSavedRoutePoint,
  type SavedLocationContactRef,
} from "./saved-route-location.js";

export type JewishAspect =
  | "summary"
  | "candles"
  | "havdalah"
  | "parasha"
  | "holidays";

export type JewishLocation = {
  label: string;
  geonameid?: number;
  latitude?: number;
  longitude?: number;
  tzid: string;
};

export type JewishTimedItem = {
  category: "candles" | "havdalah" | "parashat" | "holiday";
  title: string;
  dateIso: string;
  /** HH:mm local when present. */
  clock: string;
};

export type JewishFacts = {
  placeLabel: string;
  aspects: JewishAspect[];
  candles: JewishTimedItem | null;
  havdalah: JewishTimedItem | null;
  parasha: JewishTimedItem | null;
  holidays: JewishTimedItem[];
  missingPlace: boolean;
  error?: string;
  /** Spoken holiday name filter when set (e.g. ערב פסח). */
  holidayQuery?: string;
  /**
   * True when more holidays were collected than the display cap shows.
   * Confirmed local display truncation.
   */
  holidaysDisplayTruncated?: boolean;
  /**
   * True when the holiday collect hit its hard cap.
   * Potential incompleteness within the look-ahead window only.
   */
  holidaysCollectCapped?: boolean;
};

/** Display cap for holiday bullets in Hebrew (after collect). */
export const JEWISH_HOLIDAYS_DISPLAY_CAP = 6;

/** Collect cap inside the default upcoming window (no name query). */
export const JEWISH_HOLIDAYS_COLLECT_CAP = 8;

/** Look-ahead days when listing upcoming holidays (no name query). */
export const JEWISH_HOLIDAYS_LOOKAHEAD_DAYS = 90;

/** Look-ahead when filtering a named holiday («ערב פסח») — can be next spring. */
export const JEWISH_HOLIDAYS_NAMED_LOOKAHEAD_DAYS = 400;

/** Collect cap when searching by holiday name across the named look-ahead. */
export const JEWISH_HOLIDAYS_NAMED_COLLECT_CAP = 120;

/** Confirmed local holiday display truncation. */
export const JEWISH_HOLIDAYS_LOCAL_TRUNCATION_HE =
  "(מוצגים חלק מהחגים — יש עוד שלא הוצגו בגלל מגבלת תצוגה.)";

/**
 * Collect hit the hard cap inside the 90-day window — potential incompleteness.
 * Does not claim holidays exist beyond the window.
 */
export const JEWISH_HOLIDAYS_COLLECT_CAP_HE =
  "(ייתכן שרשימת החגים בחלון 90 הימים חלקית — נאספו עד למגבלת האיסוף.)";

const ASPECT_SET = new Set<JewishAspect>([
  "summary",
  "candles",
  "havdalah",
  "parasha",
  "holidays",
]);

const SHABBAT_URL = "https://www.hebcal.com/shabbat";
const HEBCAL_URL = "https://www.hebcal.com/hebcal";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";

const DEFAULT_TZ = "Asia/Jerusalem";
/** Jerusalem — used when place is empty for parasha / holidays. */
const DEFAULT_GEONAMEID = 281184;

/**
 * Common Israel cities → Hebcal geonameid (spoken Hebrew / variants).
 * Unknown cities fall back to Open-Meteo geocode + lat/lng.
 */
const IL_GEONAME: Array<{ id: number; names: string[] }> = [
  { id: 281184, names: ["ירושלים", "jerusalem", "ירושלים עיהק"] },
  { id: 293397, names: ["תל אביב", "ת״א", "תא", "tel aviv", "telaviv"] },
  {
    id: 293918,
    names: ["פתח תקווה", "פתח תקוה", "פתח־תקווה", "petah tikva", "petach tikva"],
  },
  { id: 294801, names: ["חיפה", "haifa"] },
  { id: 293788, names: ["רמת גן", "ramat gan"] },
  { id: 294514, names: ["בני ברק", "bnei brak", "bene berak"] },
  { id: 293807, names: ["ראשון לציון", "ראשון", "rishon"] },
  { id: 293690, names: ["נתניה", "netanya"] },
  { id: 294781, names: ["חולון", "holon"] },
  { id: 294098, names: ["אשדוד", "ashdod"] },
  { id: 295620, names: ["באר שבע", "באר־שבע", "beer sheva"] },
  { id: 293703, names: ["הרצליה", "herzliya"] },
  { id: 294277, names: ["מודיעין", "modiin", "מודיעין מכבים רעות"] },
  { id: 294117, names: ["אשקלון", "ashkelon"] },
  { id: 293286, names: ["רחובות", "rehovot"] },
  { id: 293322, names: ["רעננה", "raanana"] },
  { id: 295365, names: ["כפר סבא", "kfar saba"] },
  { id: 293396, names: ["גבעתיים", "givatayim"] },
  {
    id: 293426,
    names: ["קרית אונו", "קריית אונו", "kiryat ono", "qiryat ono"],
  },
  { id: 294074, names: ["בת ים", "bat yam"] },
  { id: 294946, names: ["חדרה", "hadera"] },
  { id: 293100, names: ["לוד", "lod"] },
  { id: 294421, names: ["רמלה", "ramla"] },
];

export function parseJewishAspects(raw: unknown): JewishAspect[] {
  if (!Array.isArray(raw)) {
    return ["summary"];
  }
  const out: JewishAspect[] = [];
  for (const entry of raw) {
    const key = String(entry ?? "")
      .trim()
      .toLowerCase() as JewishAspect;
    if (ASPECT_SET.has(key) && !out.includes(key)) {
      out.push(key);
    }
  }
  return out.length > 0 ? out : ["summary"];
}

function normPlace(s: string): string {
  return s
    .replace(/["״"']/g, "")
    .replace(/תקווה/g, "תקוה")
    .replace(/־/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Resolve spoken city to Hebcal geonameid when known.
 * Exact normalized match only (aliases in IL_GEONAME still apply).
 * No substring includes — avoids short-alias false positives (ראשון / תא).
 */
export function lookupIlGeonameid(place: string): number | null {
  const q = normPlace(place);
  if (!q) {
    return null;
  }
  for (const row of IL_GEONAME) {
    for (const name of row.names) {
      if (normPlace(name) === q) {
        return row.id;
      }
    }
  }
  return null;
}

/** Hebrew ask when place=speaker but PENDING_LOCATION is missing. */
export const JEWISH_SPEAKER_MISSING_PIN_ASK =
  "שלח סיכת מיקום בוואטסאפ, או ציין יישוב לבדיקת זמני שבת.";

/**
 * True when live jewish must yield to a candle-offset reminder on the same
 * turn (mirrors chat.service candleAnchorReminder).
 */
export function shouldSkipLiveJewishForCandleReminders(
  reminders:
    | ReadonlyArray<{
        scheduleAnchor?: string | null;
        action?: string | null;
      }>
    | null
    | undefined,
): boolean {
  return (reminders ?? []).some(
    (row) =>
      String(row.scheduleAnchor ?? "") === "jewish_candles" &&
      (row.action === "add" || row.action === "update"),
  );
}

export type JewishPlaceInputResult =
  | {
      kind: "location";
      loc: JewishLocation;
      notice?: string;
      source: "pin" | "saved";
    }
  | { kind: "ask"; text: string }
  | { kind: "named"; place: string };

/**
 * Narrow place ladder for live jewish (not full RAL):
 * speaker+PIN → SRP → address-like without coords → named string for
 * resolveJewishLocation (geonameid / Open-Meteo).
 *
 * MVP: pin/saved coords use Asia/Jerusalem (Israel-only product assumption).
 */
export function resolveJewishPlaceInput(input: {
  place: string;
  pending?: PendingLocation | null;
  snapshot?: Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null;
  contacts?: SavedLocationContactRef[] | null;
}): JewishPlaceInputResult {
  const q = String(input.place ?? "").trim();
  if (!q) {
    return { kind: "named", place: "" };
  }

  const speaker = q.toLowerCase() === "speaker";
  const pin = fromPendingLocation(input.pending ?? null);

  if (speaker) {
    if (pin) {
      return {
        kind: "location",
        loc: {
          label: pin.label || "המיקום שלך",
          latitude: pin.lat,
          longitude: pin.lng,
          // MVP Israel-only: no coords→tzid helper yet.
          tzid: DEFAULT_TZ,
        },
        source: "pin",
      };
    }
    return { kind: "ask", text: JEWISH_SPEAKER_MISSING_PIN_ASK };
  }

  const saved = resolveSavedRoutePoint(q, input.snapshot, input.contacts);
  if (saved.kind === "ambiguous") {
    return {
      kind: "ask",
      text: formatSavedRouteAmbiguousAsk(q, saved.options),
    };
  }
  if (saved.kind === "hit") {
    return {
      kind: "location",
      loc: {
        label: saved.label,
        latitude: saved.lat,
        longitude: saved.lng,
        // MVP Israel-only: no coords→tzid helper yet.
        tzid: DEFAULT_TZ,
      },
      notice: formatSavedRouteNotice(saved.label),
      source: "saved",
    };
  }

  const noCoords = matchSavedPlaceWithoutCoords(
    q,
    input.snapshot,
    input.contacts,
  );
  if (noCoords.kind === "unique") {
    return {
      kind: "ask",
      text: formatSavedLabelMissingCoordsAsk(noCoords.row.label),
    };
  }
  if (noCoords.kind === "ambiguous") {
    return {
      kind: "ask",
      text: formatSavedRouteAmbiguousAsk(q, noCoords.options),
    };
  }

  return { kind: "named", place: q };
}

function clockFromIso(iso: string): string {
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1]! : "";
}

function formatHebClock(iso: string): string {
  const clock = clockFromIso(iso);
  if (!clock) {
    return "";
  }
  const [hh, mm] = clock.split(":");
  const h = Number(hh);
  if (!Number.isFinite(h)) {
    return clock;
  }
  return `${h}:${mm}`;
}

type HebcalItem = {
  category?: string;
  title?: string;
  hebrew?: string;
  date?: string;
  memo?: string;
};

type ShabbatResponse = {
  location?: { title?: string; city?: string; geonameid?: number };
  items?: HebcalItem[];
};

type HebcalResponse = {
  items?: HebcalItem[];
};

function mapItem(
  row: HebcalItem,
  category: JewishTimedItem["category"],
): JewishTimedItem {
  const dateIso = String(row.date ?? "").trim();
  const title =
    String(row.hebrew ?? "").trim() ||
    String(row.title ?? "").trim();
  return {
    category,
    title,
    dateIso,
    clock: formatHebClock(dateIso),
  };
}

export async function resolveJewishLocation(
  place: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JewishLocation | null> {
  const trimmed = place.trim();
  if (!trimmed) {
    return {
      label: "ירושלים",
      geonameid: DEFAULT_GEONAMEID,
      tzid: DEFAULT_TZ,
    };
  }
  const known = lookupIlGeonameid(trimmed);
  if (known != null) {
    return { label: trimmed, geonameid: known, tzid: DEFAULT_TZ };
  }
  const url = new URL(GEOCODE_URL);
  url.searchParams.set("name", trimmed);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "he");
  url.searchParams.set("countryCode", "IL");
  const res = await fetchImpl(url.toString());
  if (!res.ok) {
    return null;
  }
  const json = (await res.json()) as {
    results?: Array<{
      name?: string;
      latitude?: number;
      longitude?: number;
      timezone?: string;
    }>;
  };
  const hit = json.results?.[0];
  if (
    !hit ||
    typeof hit.latitude !== "number" ||
    typeof hit.longitude !== "number"
  ) {
    return null;
  }
  return {
    label: String(hit.name ?? trimmed).trim() || trimmed,
    latitude: hit.latitude,
    longitude: hit.longitude,
    tzid: String(hit.timezone ?? DEFAULT_TZ).trim() || DEFAULT_TZ,
  };
}

function appendLocationParams(
  url: URL,
  loc: JewishLocation,
): void {
  if (loc.geonameid != null) {
    url.searchParams.set("geonameid", String(loc.geonameid));
  } else if (loc.latitude != null && loc.longitude != null) {
    url.searchParams.set("latitude", String(loc.latitude));
    url.searchParams.set("longitude", String(loc.longitude));
    url.searchParams.set("tzid", loc.tzid);
  }
}

async function fetchShabbat(
  loc: JewishLocation,
  gy?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ShabbatResponse> {
  const url = new URL(SHABBAT_URL);
  url.searchParams.set("cfg", "json");
  url.searchParams.set("M", "on");
  url.searchParams.set("i", "on");
  url.searchParams.set("lg", "h");
  appendLocationParams(url, loc);
  if (gy && /^\d{4}-\d{2}-\d{2}$/.test(gy)) {
    url.searchParams.set("gy", gy.slice(0, 4));
    url.searchParams.set("gm", String(Number(gy.slice(5, 7))));
    url.searchParams.set("gd", String(Number(gy.slice(8, 10))));
  }
  const res = await fetchImpl(url.toString());
  if (!res.ok) {
    throw new Error(`hebcal shabbat HTTP ${res.status}`);
  }
  return (await res.json()) as ShabbatResponse;
}

/** Strip Hebrew niqqud / cantillation so «עֶרֶב פֶּסַח» matches «ערב פסח». */
export function stripHebrewNiqqud(s: string): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/["״"'׳]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Score how well a Hebcal holiday title matches a spoken query (0 = none). */
export function jewishHolidayMatchScore(title: string, query: string): number {
  const t = stripHebrewNiqqud(title);
  const q = stripHebrewNiqqud(query);
  if (!q || !t) {
    return 0;
  }
  if (t === q) {
    return 100;
  }
  if (t.startsWith(q) || t.includes(` ${q}`) || t.includes(`${q} `)) {
    return 90;
  }
  const tokens = q.split(/\s+/).filter((tok) => tok.length >= 2);
  if (tokens.length === 0) {
    return 0;
  }
  const hit = tokens.filter((tok) => t.includes(tok)).length;
  if (hit === tokens.length) {
    return 70 + Math.min(hit, 20);
  }
  if (hit >= Math.ceil(tokens.length * 0.6)) {
    return 40 + hit;
  }
  return 0;
}

export function filterHolidaysByQuery(
  holidays: JewishTimedItem[],
  query: string,
): JewishTimedItem[] {
  const q = String(query ?? "").trim();
  if (!q) {
    return holidays;
  }
  const scored = holidays
    .map((h) => ({ h, score: jewishHolidayMatchScore(h.title, q) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.h.dateIso.localeCompare(b.h.dateIso);
    });
  return scored.map((row) => row.h);
}

async function fetchUpcomingHolidays(
  loc: JewishLocation,
  startYmd: string,
  fetchImpl: typeof fetch = fetch,
  opts?: { lookaheadDays?: number; collectCap?: number },
): Promise<{ holidays: JewishTimedItem[]; collectCapped: boolean }> {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(startYmd)
    ? startYmd
    : new Date().toISOString().slice(0, 10);
  const lookahead =
    opts?.lookaheadDays ?? JEWISH_HOLIDAYS_LOOKAHEAD_DAYS;
  const collectCap = opts?.collectCap ?? JEWISH_HOLIDAYS_COLLECT_CAP;
  const endDate = new Date(`${start}T12:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + lookahead);
  const end = endDate.toISOString().slice(0, 10);

  const url = new URL(HEBCAL_URL);
  url.searchParams.set("v", "1");
  url.searchParams.set("cfg", "json");
  url.searchParams.set("maj", "on");
  url.searchParams.set("min", "on");
  url.searchParams.set("mod", "on");
  url.searchParams.set("nx", "on");
  url.searchParams.set("ss", "on");
  url.searchParams.set("mf", "on");
  url.searchParams.set("i", "on");
  url.searchParams.set("lg", "h");
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);
  appendLocationParams(url, loc);

  const res = await fetchImpl(url.toString());
  if (!res.ok) {
    throw new Error(`hebcal holidays HTTP ${res.status}`);
  }
  const json = (await res.json()) as HebcalResponse;
  const out: JewishTimedItem[] = [];
  let collectCapped = false;
  for (const row of json.items ?? []) {
    if (String(row.category ?? "") !== "holiday") {
      continue;
    }
    out.push(mapItem(row, "holiday"));
    if (out.length >= collectCap) {
      collectCapped = true;
      break;
    }
  }
  return { holidays: out, collectCapped };
}

function pickFromShabbat(items: HebcalItem[] | undefined): {
  candles: JewishTimedItem | null;
  havdalah: JewishTimedItem | null;
  parasha: JewishTimedItem | null;
} {
  let candles: JewishTimedItem | null = null;
  let havdalah: JewishTimedItem | null = null;
  let parasha: JewishTimedItem | null = null;
  for (const row of items ?? []) {
    const cat = String(row.category ?? "");
    if (cat === "candles" && !candles) {
      candles = mapItem(row, "candles");
    } else if (cat === "havdalah" && !havdalah) {
      havdalah = mapItem(row, "havdalah");
    } else if ((cat === "parashat" || cat === "parasha") && !parasha) {
      parasha = mapItem(row, "parashat");
    }
  }
  return { candles, havdalah, parasha };
}

export function formatJewishHebrew(facts: JewishFacts): string {
  if (facts.error) {
    return facts.error;
  }
  if (facts.missingPlace) {
    return "באיזה יישוב לבדוק את זמני השבת? (למשל פתח תקווה)";
  }
  const wantsSummary = facts.aspects.includes("summary");
  const wantsCandles = wantsSummary || facts.aspects.includes("candles");
  const wantsHavdalah = wantsSummary || facts.aspects.includes("havdalah");
  const wantsParasha = wantsSummary || facts.aspects.includes("parasha");
  const wantsHolidays = facts.aspects.includes("holidays");

  const lines: string[] = [];
  const where = facts.placeLabel ? ` ב${facts.placeLabel}` : "";

  if (wantsCandles && facts.candles) {
    lines.push(
      facts.candles.clock
        ? `הדלקת נרות${where}: ${facts.candles.clock}`
        : facts.candles.title,
    );
  } else if (wantsCandles && !facts.candles) {
    lines.push(`לא מצאתי שעת הדלקת נרות${where}.`);
  }

  if (wantsHavdalah && facts.havdalah) {
    lines.push(
      facts.havdalah.clock
        ? `יציאת שבת / הבדלה${where}: ${facts.havdalah.clock}`
        : facts.havdalah.title,
    );
  } else if (wantsHavdalah && !facts.havdalah) {
    lines.push(`לא מצאתי שעת יציאת שבת${where}.`);
  }

  if (wantsParasha && facts.parasha) {
    const name = facts.parasha.title.replace(/^פָּרָשַׁת\s+/u, "").trim();
    lines.push(
      name ? `פרשת השבוע: ${name}` : `פרשת השבוע: ${facts.parasha.title}`,
    );
  } else if (wantsParasha && !facts.parasha) {
    lines.push("לא מצאתי את פרשת השבוע.");
  }

  if (wantsHolidays) {
    const q = facts.holidayQuery?.trim() ?? "";
    if (facts.holidays.length === 0) {
      lines.push(
        q
          ? `לא מצאתי «${q}» בלוח העברי בשנה הקרובה.`
          : "לא מצאתי חגים קרובים.",
      );
    } else {
      lines.push(q ? `«${q}»:` : "חגים קרובים:");
      const displayTruncated =
        facts.holidaysDisplayTruncated === true ||
        facts.holidays.length > JEWISH_HOLIDAYS_DISPLAY_CAP;
      for (const h of facts.holidays.slice(0, JEWISH_HOLIDAYS_DISPLAY_CAP)) {
        const day = h.dateIso.slice(0, 10);
        const ymd = /^\d{4}-\d{2}-\d{2}$/.test(day)
          ? day.split("-").reverse().join(".")
          : day;
        lines.push(`• ${h.title}${ymd ? ` — ${ymd}` : ""}`);
      }
      if (displayTruncated) {
        lines.push(JEWISH_HOLIDAYS_LOCAL_TRUNCATION_HE);
      }
      if (facts.holidaysCollectCapped && !q) {
        lines.push(JEWISH_HOLIDAYS_COLLECT_CAP_HE);
      }
    }
  }

  if (lines.length === 0) {
    return "לא מצאתי נתונים בלוח העברי.";
  }
  return lines.join("\n");
}

/**
 * Next candle-lighting instant for `place`, then apply offsetMinutes
 * (negative = before). Returns null when place/Hebcal cannot resolve.
 * If that instant is already past `from`, advances to the following Shabbat.
 */
export async function nextCandleLighting(input: {
  place: string;
  offsetMinutes?: number;
  from?: Date;
  fetchImpl?: typeof fetch;
}): Promise<Date | null> {
  const place = String(input.place ?? "").trim();
  if (!place) {
    return null;
  }
  const offsetMs = (input.offsetMinutes ?? 0) * 60_000;
  const from = input.from ?? new Date();
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const loc = await resolveJewishLocation(place, fetchImpl);
    if (!loc) {
      return null;
    }
    // Probe this week, then next week if the offset fire already passed.
    for (const dayOffset of [0, 7]) {
      const probe = new Date(from.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      const ymd = probe.toLocaleDateString("en-CA", {
        timeZone: "Asia/Jerusalem",
      });
      const shabbat = await fetchShabbat(loc, ymd, fetchImpl);
      const candles = pickFromShabbat(shabbat.items).candles;
      if (!candles?.dateIso) {
        continue;
      }
      const candlesAt = new Date(candles.dateIso);
      if (!Number.isFinite(candlesAt.getTime())) {
        continue;
      }
      const fireAt = new Date(candlesAt.getTime() + offsetMs);
      if (fireAt.getTime() > from.getTime()) {
        return fireAt;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Hint for LAST_LIVE pack — never invents a place; null on ask/fail/default. */
export type JewishLastLiveHint = {
  label: string;
  lat: number | null;
  lng: number | null;
  kind: "pin" | "saved" | "geocoded" | "soft_place_text";
  usedPendingPin: boolean;
};

export type JewishReplyResult = {
  text: string;
  lastLive: JewishLastLiveHint | null;
};

function jewishReplyText(text: string): JewishReplyResult {
  return { text, lastLive: null };
}

export async function resolveJewishReply(input: {
  place: string;
  date?: string | null;
  aspects?: JewishAspect[] | unknown;
  /** Named holiday filter from ACTION (ערב פסח / חנוכה). */
  query?: string | null;
  /** PENDING_LOCATION pin for place=speaker. */
  pending?: PendingLocation | null;
  /** Speaker lists/filings for SRP + address-like guards. */
  snapshot?: Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null;
  /** SPEAKER_CONTACTS for saved-place resolve. */
  contacts?: SavedLocationContactRef[] | null;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<JewishReplyResult> {
  const aspects = parseJewishAspects(input.aspects);
  const place = String(input.place ?? "").trim();
  const holidayQuery = String(input.query ?? "").trim();
  const needsPlace =
    aspects.includes("summary") ||
    aspects.includes("candles") ||
    aspects.includes("havdalah");
  // Explicit ACTION place only — empty place that falls through to Jerusalem
  // default must NOT pack LAST_LIVE (avoids «שם» sticking to ירושלים).
  const mayPackLastLive = place.length > 0;

  if (needsPlace && !place) {
    return jewishReplyText(
      formatJewishHebrew({
        placeLabel: "",
        aspects,
        candles: null,
        havdalah: null,
        parasha: null,
        holidays: [],
        missingPlace: true,
        ...(holidayQuery ? { holidayQuery } : {}),
      }),
    );
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const placeInput = resolveJewishPlaceInput({
      place,
      pending: input.pending ?? null,
      snapshot: input.snapshot ?? null,
      contacts: input.contacts ?? null,
    });
    if (placeInput.kind === "ask") {
      return jewishReplyText(placeInput.text);
    }

    let loc: JewishLocation | null = null;
    let savedNotice = "";
    let source: "pin" | "saved" | "named" = "named";
    if (placeInput.kind === "location") {
      loc = placeInput.loc;
      savedNotice = placeInput.notice?.trim() ?? "";
      source = placeInput.source;
    } else {
      loc = await resolveJewishLocation(placeInput.place, fetchImpl);
    }
    if (!loc) {
      return jewishReplyText(
        `לא מצאתי את היישוב «${place}». נסי עיר בישראל (למשל תל אביב).`,
      );
    }

    const date = String(input.date ?? "").trim();
    const needsShabbat =
      aspects.includes("summary") ||
      aspects.includes("candles") ||
      aspects.includes("havdalah") ||
      aspects.includes("parasha");
    const needsHolidays = aspects.includes("holidays");

    let candles: JewishTimedItem | null = null;
    let havdalah: JewishTimedItem | null = null;
    let parasha: JewishTimedItem | null = null;
    let holidays: JewishTimedItem[] = [];
    let holidaysCollectCapped = false;
    let placeLabel = loc.label;

    if (needsShabbat) {
      const shabbat = await fetchShabbat(
        loc,
        /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
        fetchImpl,
      );
      if (shabbat.location?.title) {
        placeLabel = String(shabbat.location.title).replace(/, Israel$/i, "");
      }
      const picked = pickFromShabbat(shabbat.items);
      candles = picked.candles;
      havdalah = picked.havdalah;
      parasha = picked.parasha;
    }

    if (needsHolidays) {
      const start =
        /^\d{4}-\d{2}-\d{2}$/.test(date)
          ? date
          : (input.now ?? new Date()).toISOString().slice(0, 10);
      const named = Boolean(holidayQuery);
      const fetched = await fetchUpcomingHolidays(loc, start, fetchImpl, {
        lookaheadDays: named
          ? JEWISH_HOLIDAYS_NAMED_LOOKAHEAD_DAYS
          : JEWISH_HOLIDAYS_LOOKAHEAD_DAYS,
        collectCap: named
          ? JEWISH_HOLIDAYS_NAMED_COLLECT_CAP
          : JEWISH_HOLIDAYS_COLLECT_CAP,
      });
      holidays = named
        ? filterHolidaysByQuery(fetched.holidays, holidayQuery)
        : fetched.holidays;
      holidaysCollectCapped = named ? false : fetched.collectCapped;
    }

    const body = formatJewishHebrew({
      placeLabel,
      aspects,
      candles,
      havdalah,
      parasha,
      holidays,
      missingPlace: false,
      ...(holidayQuery ? { holidayQuery } : {}),
      holidaysDisplayTruncated:
        holidays.length > JEWISH_HOLIDAYS_DISPLAY_CAP,
      holidaysCollectCapped,
    });
    const text = savedNotice ? `${savedNotice}\n${body}` : body;

    let lastLive: JewishLastLiveHint | null = null;
    if (mayPackLastLive) {
      const lat =
        typeof loc.latitude === "number" && Number.isFinite(loc.latitude)
          ? loc.latitude
          : null;
      const lng =
        typeof loc.longitude === "number" && Number.isFinite(loc.longitude)
          ? loc.longitude
          : null;
      const kind: JewishLastLiveHint["kind"] =
        source === "pin"
          ? "pin"
          : source === "saved"
            ? "saved"
            : lat != null && lng != null
              ? "geocoded"
              : "soft_place_text";
      // Prefer ACTION/saved/pin label for deixis re-emit; named city keeps spoken place.
      const label =
        source === "pin" || source === "saved"
          ? loc.label
          : place || placeLabel;
      if (label.trim()) {
        lastLive = {
          label: label.trim(),
          lat,
          lng,
          kind,
          usedPendingPin: source === "pin",
        };
      }
    }

    return { text, lastLive };
  } catch {
    return jewishReplyText(
      "לא הצלחתי לבדוק את לוח השבת/החגים עכשיו. נסה שוב בעוד רגע.",
    );
  }
}
