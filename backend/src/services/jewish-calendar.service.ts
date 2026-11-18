/**
 * Zero-network Jewish calendar — `@hebcal/core` only.
 * Candle lighting, Havdalah, Parashat HaShavua, and holidays are pure astronomy /
 * calendar math. Never writes ExternalDataCache and never calls Web Search.
 */
import {
  HebrewCalendar,
  HDate,
  Location,
  flags,
  type Event,
} from "@hebcal/core";

export type LocalJewishTimedItem = {
  category: "candles" | "havdalah" | "parashat" | "holiday";
  title: string;
  dateIso: string;
  clock: string;
};

export type LocalShabbatResult = {
  placeLabel: string;
  candles: LocalJewishTimedItem | null;
  havdalah: LocalJewishTimedItem | null;
  parasha: LocalJewishTimedItem | null;
  externalCalls: 0;
  webSearchCalls: 0;
};

export type LocalHolidaysResult = {
  placeLabel: string;
  holidays: LocalJewishTimedItem[];
  collectCapped: boolean;
  externalCalls: 0;
  webSearchCalls: 0;
};

/** Spoken / alias → classic Hebcal Location.lookup name. */
const IL_LOCATION_ALIASES: Array<{ classic: string; names: string[] }> = [
  { classic: "Jerusalem", names: ["ירושלים", "jerusalem", "ירושלים עיהק"] },
  {
    classic: "Tel Aviv",
    names: ["תל אביב", "ת״א", "תא", "ת'א", "tel aviv", "telaviv"],
  },
  {
    classic: "Petach Tikvah",
    names: [
      "פתח תקווה",
      "פתח תקוה",
      "פתח־תקווה",
      "פ״ת",
      'פ"ת',
      "פת",
      "petah tikva",
      "petach tikva",
      "petach tikvah",
    ],
  },
  { classic: "Haifa", names: ["חיפה", "haifa"] },
  { classic: "Beer Sheva", names: ["באר שבע", "באר־שבע", "beer sheva"] },
  { classic: "Ashdod", names: ["אשדוד", "ashdod"] },
  { classic: "Eilat", names: ["אילת", "eilat"] },
  { classic: "Tiberias", names: ["טבריה", "tiberias"] },
];

function normPlace(s: string): string {
  return s
    .replace(/["״"'׳]/g, "")
    .replace(/תקווה/g, "תקוה")
    .replace(/־/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripNiqqud(s: string): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0591-\u05C7]/g, "");
}

export function resolveClassicIlCityName(place: string): string | null {
  const q = normPlace(place);
  if (!q) {
    return null;
  }
  for (const row of IL_LOCATION_ALIASES) {
    if (normPlace(row.classic) === q) {
      return row.classic;
    }
    for (const name of row.names) {
      if (normPlace(name) === q) {
        return row.classic;
      }
    }
  }
  if (Location.lookup(place.trim())) {
    return place.trim();
  }
  return null;
}

export function resolveHebcalLocation(place: string): Location | null {
  const trimmed = place.trim();
  if (!trimmed) {
    return Location.lookup("Jerusalem") ?? null;
  }
  const classic = resolveClassicIlCityName(trimmed);
  if (classic) {
    return Location.lookup(classic) ?? null;
  }
  return Location.lookup(trimmed) ?? null;
}

export function locationFromCoords(
  lat: number,
  lng: number,
  label = "מיקום",
): Location {
  return new Location(lat, lng, true, "Asia/Jerusalem", label, "IL");
}

function clockFromEvent(ev: Event): string {
  const timed = ev as Event & { eventTimeStr?: string; eventTime?: Date };
  if (typeof timed.eventTimeStr === "string" && timed.eventTimeStr.trim()) {
    return timed.eventTimeStr.trim().slice(0, 5);
  }
  if (
    timed.eventTime instanceof Date &&
    Number.isFinite(timed.eventTime.getTime())
  ) {
    return timed.eventTime.toLocaleTimeString("en-GB", {
      timeZone: "Asia/Jerusalem",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return "";
}

function dateIsoFromEvent(ev: Event): string {
  const timed = ev as Event & { eventTime?: Date };
  if (
    timed.eventTime instanceof Date &&
    Number.isFinite(timed.eventTime.getTime())
  ) {
    return timed.eventTime.toISOString();
  }
  const greg = ev.getDate().greg();
  return new Date(
    Date.UTC(greg.getFullYear(), greg.getMonth(), greg.getDate(), 12, 0, 0),
  ).toISOString();
}

function titleHe(ev: Event): string {
  try {
    return String(ev.render("he") || ev.getDesc() || "").trim();
  } catch {
    return String(ev.getDesc() || "").trim();
  }
}

function toTimed(
  ev: Event,
  category: LocalJewishTimedItem["category"],
): LocalJewishTimedItem {
  return {
    category,
    title: titleHe(ev),
    dateIso: dateIsoFromEvent(ev),
    clock: clockFromEvent(ev),
  };
}

function jerusalemYmd(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
}

function hdateFromYmd(ymd: string): HDate {
  const [y, m, day] = ymd.split("-").map(Number);
  return new HDate(new Date(Date.UTC(y!, m! - 1, day!, 12, 0, 0)));
}

export function computeShabbatTimes(input: {
  place: string;
  date?: string | null;
  location?: Location | null;
  now?: Date;
}): LocalShabbatResult | null {
  const loc = input.location ?? resolveHebcalLocation(input.place) ?? null;
  if (!loc) {
    return null;
  }
  const now = input.now ?? new Date();
  const ymd =
    input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date)
      ? input.date
      : jerusalemYmd(now);
  const start = hdateFromYmd(ymd);
  const end = start.add(10);
  const events = HebrewCalendar.calendar({
    start,
    end,
    location: loc,
    candlelighting: true,
    sedrot: true,
    il: true,
    locale: "he",
  });

  let candles: LocalJewishTimedItem | null = null;
  let havdalah: LocalJewishTimedItem | null = null;
  let parasha: LocalJewishTimedItem | null = null;
  for (const ev of events) {
    const f = ev.getFlags();
    const desc = String(ev.getDesc() || "");
    // Note: @hebcal/core has no flags.HAVDALAH — Havdalah events use
    // LIGHT_CANDLES_TZEIS (32) and getDesc() === "Havdalah".
    if (/^havdalah/i.test(desc) && !havdalah) {
      havdalah = toTimed(ev, "havdalah");
    } else if ((f & flags.LIGHT_CANDLES) !== 0 && !candles) {
      candles = toTimed(ev, "candles");
    } else if ((f & flags.PARSHA_HASHAVUA) !== 0 && !parasha) {
      parasha = toTimed(ev, "parashat");
    }
    if (candles && havdalah && parasha) {
      break;
    }
  }

  return {
    placeLabel: loc.getName() || input.place.trim() || "ישראל",
    candles,
    havdalah,
    parasha,
    externalCalls: 0,
    webSearchCalls: 0,
  };
}

export function computeUpcomingHolidays(input: {
  place?: string;
  startYmd: string;
  lookaheadDays?: number;
  collectCap?: number;
  location?: Location | null;
}): LocalHolidaysResult {
  const loc =
    input.location ??
    resolveHebcalLocation(input.place ?? "") ??
    Location.lookup("Jerusalem")!;
  const lookahead = input.lookaheadDays ?? 90;
  const collectCap = input.collectCap ?? 8;
  const start = hdateFromYmd(input.startYmd);
  const end = start.add(lookahead);
  const events = HebrewCalendar.calendar({
    start,
    end,
    il: true,
    locale: "he",
    noMinorFast: false,
    noModern: false,
    noRoshChodesh: true,
    noSpecialShabbat: true,
  });

  const holidays: LocalJewishTimedItem[] = [];
  let collectCapped = false;
  for (const ev of events) {
    const f = ev.getFlags();
    const desc = String(ev.getDesc() || "");
    // Skip Shabbat timed events (candles / Havdalah), not Chanukah candle rows.
    if (/^candle lighting$/i.test(desc) || /^havdalah$/i.test(desc)) {
      continue;
    }
    const blob = stripNiqqud(`${ev.getDesc()} ${titleHe(ev)}`);
    const isHoliday =
      (f & flags.CHAG) !== 0 ||
      (f & flags.MAJOR_FAST) !== 0 ||
      (f & flags.MINOR_FAST) !== 0 ||
      (f & flags.MODERN_HOLIDAY) !== 0 ||
      (f & flags.CHANUKAH_CANDLES) !== 0 ||
      (f & flags.MINOR_HOLIDAY) !== 0 ||
      /חנוכ|hanuk|פסח|sukkot|סוכות|פורים|purim|ראש השנה|יום כיפור|שבועות|טו בשבט|תשעה|chanukah/i.test(
        blob,
      );
    if (!isHoliday) {
      continue;
    }
    holidays.push(toTimed(ev, "holiday"));
    if (holidays.length >= collectCap) {
      collectCapped = true;
      break;
    }
  }

  return {
    placeLabel: loc.getName() || input.place?.trim() || "ישראל",
    holidays,
    collectCapped,
    externalCalls: 0,
    webSearchCalls: 0,
  };
}

export function nextLocalCandleLighting(input: {
  place: string;
  offsetMinutes?: number;
  from?: Date;
  location?: Location | null;
}): Date | null {
  const from = input.from ?? new Date();
  const offsetMs = (input.offsetMinutes ?? 0) * 60_000;
  for (const dayOffset of [0, 7, 14]) {
    const probe = new Date(from.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const shabbat = computeShabbatTimes({
      place: input.place,
      date: jerusalemYmd(probe),
      location: input.location,
      now: from,
    });
    const iso = shabbat?.candles?.dateIso;
    if (!iso) {
      continue;
    }
    const candlesAt = new Date(iso);
    if (!Number.isFinite(candlesAt.getTime())) {
      continue;
    }
    const fireAt = new Date(candlesAt.getTime() + offsetMs);
    if (fireAt.getTime() > from.getTime()) {
      return fireAt;
    }
  }
  return null;
}

const JEWISH_INLINE_RE =
  /(?:מתי\s+)?(?:נכנסת|יוצאת|מדליקים|הדלקת|הבדלה|havdalah|שבת|פרש(?:ת|ה)|חנוכ|פורים|פסח|סוכות|ראש\s*השנה|יום\s*כיפור|חג|לוח\s*עברי)/u;

export function isJewishCalendarQuery(text: string): boolean {
  return JEWISH_INLINE_RE.test(text.trim());
}

export function extractJewishPlaceFromQuery(text: string): string | null {
  const t = text.trim();
  const m = t.match(
    /(?:ב|ב־|ב-)\s*([א-ת״"'\w\s־-]{2,40}?)(?:\s*[?؟.!]|$)/u,
  );
  if (m?.[1]) {
    const place = m[1].replace(/[?؟.!]/g, "").trim();
    if (resolveClassicIlCityName(place) || resolveHebcalLocation(place)) {
      return place;
    }
  }
  for (const row of IL_LOCATION_ALIASES) {
    for (const name of row.names) {
      if (t.includes(name) || normPlace(t) === normPlace(name)) {
        return name;
      }
    }
  }
  return null;
}

export function formatLocalShabbatHebrew(input: {
  placeLabel: string;
  candles: LocalJewishTimedItem | null;
  havdalah: LocalJewishTimedItem | null;
  parasha: LocalJewishTimedItem | null;
}): string {
  const lines: string[] = [];
  const where = input.placeLabel.trim() || "ישראל";
  if (input.candles?.clock) {
    lines.push(`הדלקת נרות ב${where}: ${input.candles.clock}`);
  }
  if (input.havdalah?.clock) {
    lines.push(`הבדלה / יציאת שבת: ${input.havdalah.clock}`);
  }
  if (input.parasha?.title) {
    lines.push(`פרשת השבוע: ${input.parasha.title}`);
  }
  if (lines.length === 0) {
    return `לא הצלחתי לחשב זמני שבת עבור ${where}.`;
  }
  return lines.join("\n");
}

/** Inline chat helper — Shabbat/holiday answer with zero network / zero cache. */
export function resolveLocalJewishInline(input: {
  query: string;
  place?: string | null;
  now?: Date;
}): {
  text: string;
  placeLabel: string;
  externalCalls: 0;
  webSearchCalls: 0;
  cacheWrites: 0;
  searchTopic: string;
} | null {
  const place =
    (input.place?.trim() || extractJewishPlaceFromQuery(input.query) || "").trim();
  if (!place || !resolveHebcalLocation(place)) {
    return null;
  }
  const wantsHoliday = /חנוכ|פורים|פסח|סוכות|ראש\s*השנה|יום\s*כיפור|חג/u.test(
    input.query,
  );
  if (wantsHoliday) {
    const startYmd = jerusalemYmd(input.now ?? new Date());
    const hol = computeUpcomingHolidays({
      place,
      startYmd,
      lookaheadDays: 400,
      collectCap: 40,
    });
    const q = input.query;
    const match =
      hol.holidays.find((h) =>
        /חנוכ|hanuk/i.test(q) ? /חנוכ|hanuk/i.test(h.title) : true,
      ) ?? hol.holidays[0];
    if (!match) {
      return null;
    }
    const day = match.dateIso.slice(0, 10);
    return {
      text: `${match.title} — ${day}`,
      placeLabel: hol.placeLabel,
      externalCalls: 0,
      webSearchCalls: 0,
      cacheWrites: 0,
      searchTopic: place,
    };
  }
  const shabbat = computeShabbatTimes({
    place,
    now: input.now,
  });
  if (!shabbat) {
    return null;
  }
  return {
    text: formatLocalShabbatHebrew(shabbat),
    placeLabel: shabbat.placeLabel,
    externalCalls: 0,
    webSearchCalls: 0,
    cacheWrites: 0,
    searchTopic: place,
  };
}
