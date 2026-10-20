/**
 * Live Jewish calendar / Shabbat via Hebcal (no API key).
 * Model→Action→Engine: engine only formats Hebcal facts — never invents times.
 */

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
};

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

/** Resolve spoken city to Hebcal geonameid when known. */
export function lookupIlGeonameid(place: string): number | null {
  const q = normPlace(place);
  if (!q) {
    return null;
  }
  for (const row of IL_GEONAME) {
    for (const name of row.names) {
      if (normPlace(name) === q || q.includes(normPlace(name))) {
        return row.id;
      }
    }
  }
  return null;
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

async function fetchUpcomingHolidays(
  loc: JewishLocation,
  startYmd: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JewishTimedItem[]> {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(startYmd)
    ? startYmd
    : new Date().toISOString().slice(0, 10);
  const endDate = new Date(`${start}T12:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 90);
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
  for (const row of json.items ?? []) {
    if (String(row.category ?? "") !== "holiday") {
      continue;
    }
    out.push(mapItem(row, "holiday"));
    if (out.length >= 8) {
      break;
    }
  }
  return out;
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
    if (facts.holidays.length === 0) {
      lines.push("לא מצאתי חגים קרובים.");
    } else {
      lines.push("חגים קרובים:");
      for (const h of facts.holidays.slice(0, 6)) {
        const day = h.dateIso.slice(0, 10);
        const ymd = /^\d{4}-\d{2}-\d{2}$/.test(day)
          ? day.split("-").reverse().join(".")
          : day;
        lines.push(`• ${h.title}${ymd ? ` — ${ymd}` : ""}`);
      }
    }
  }

  if (lines.length === 0) {
    return "לא מצאתי נתונים בלוח העברי.";
  }
  return lines.join("\n");
}

export async function resolveJewishReply(input: {
  place: string;
  date?: string | null;
  aspects?: JewishAspect[] | unknown;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<string> {
  const aspects = parseJewishAspects(input.aspects);
  const place = String(input.place ?? "").trim();
  const needsPlace =
    aspects.includes("summary") ||
    aspects.includes("candles") ||
    aspects.includes("havdalah");

  if (needsPlace && !place) {
    return formatJewishHebrew({
      placeLabel: "",
      aspects,
      candles: null,
      havdalah: null,
      parasha: null,
      holidays: [],
      missingPlace: true,
    });
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const loc = await resolveJewishLocation(place, fetchImpl);
    if (!loc) {
      return `לא מצאתי את היישוב «${place}». נסי עיר בישראל (למשל תל אביב).`;
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
      holidays = await fetchUpcomingHolidays(loc, start, fetchImpl);
    }

    return formatJewishHebrew({
      placeLabel,
      aspects,
      candles,
      havdalah,
      parasha,
      holidays,
      missingPlace: false,
    });
  } catch {
    return "לא הצלחתי לבדוק את לוח השבת/החגים עכשיו. נסה שוב בעוד רגע.";
  }
}
