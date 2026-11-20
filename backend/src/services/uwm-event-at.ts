/**
 * Fail-closed eventAt extraction from hosted web_search / page prose.
 * Never invents kickoff from URL path dates (often publication/update).
 * Local wall times require an explicit timezone or strong place cue.
 *
 * Contract: eventAt is always an absolute UTC ISO string (…Z) after normalize.
 * Date-only strings are never eventAt.
 */

export type EventAtExtraction = {
  /** UTC ISO kickoff (always …Z). */
  eventAtIso: string;
  /** Local wall clock that was interpreted (YYYY-MM-DDTHH:mm). */
  localWall: string;
  /** IANA zone used for conversion. */
  timeZone: string;
  /** Short evidence snippet used for the parse. */
  snippet: string;
  /** How timezone was resolved. */
  timeZoneSource: "explicit_offset" | "named_zone" | "place_cue";
};

/** Absolute UTC/offset datetime — not date-only, not timezone-less local. */
const ABSOLUTE_ISO_RE =
  /^(\d{4}-\d{2}-\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True only for absolute timestamps with explicit Z or numeric offset.
 * Does not treat Date.parse success as sufficient (rejects date-only / local).
 */
export function isAbsoluteUtcTimestamp(value: string | null | undefined): boolean {
  if (!value || typeof value !== "string") return false;
  const t = value.trim();
  if (!ABSOLUTE_ISO_RE.test(t)) return false;
  const ms = Date.parse(t);
  return Number.isFinite(ms);
}

/**
 * Normalize an absolute timestamp to canonical `…Z` UTC ISO.
 * Returns null for date-only, timezone-less local, or unparseable input.
 */
export function normalizeAbsoluteUtcIso(
  value: string | null | undefined,
): string | null {
  if (!isAbsoluteUtcTimestamp(value)) return null;
  return new Date(Date.parse(value!.trim())).toISOString();
}

/**
 * publishedAt policy: absolute → UTC Z; date-only stays YYYY-MM-DD; else null.
 * Never invents midnight UTC from a bare date.
 */
export function normalizePublishedAt(
  value: string | null | undefined,
): string | null {
  if (!value || typeof value !== "string") return null;
  const t = value.trim();
  if (DATE_ONLY_RE.test(t)) return t;
  return normalizeAbsoluteUtcIso(t);
}

/** True for YYYY-MM-DD with no time component. */
export function isDateOnly(value: string | null | undefined): boolean {
  return Boolean(value && DATE_ONLY_RE.test(value.trim()));
}

const EN_MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const HE_MONTHS: Record<string, number> = {
  ינואר: 1,
  פברואר: 2,
  מרץ: 3,
  אפריל: 4,
  מאי: 5,
  יוני: 6,
  יולי: 7,
  אוגוסט: 8,
  ספטמבר: 9,
  אוקטובר: 10,
  נובמבר: 11,
  דצמבר: 12,
};

/** Place / named-zone cues → IANA. Only unambiguous mappings. */
const PLACE_ZONE_CUES: Array<{ re: RegExp; zone: string }> = [
  { re: /שעון\s*מדריד|madrid\s*time|europe\/madrid/i, zone: "Europe/Madrid" },
  {
    re: /(?:ב|in\s+)?מדריד\b|(?:in\s+)?madrid\b|סנטיאגו\s*ברנבאו|bernab[eé]u|realmadrid\.com/i,
    zone: "Europe/Madrid",
  },
  {
    re: /שעון\s*ישראל|israel\s*time|asia\/jerusalem|שעון\s*ירושלים/i,
    zone: "Asia/Jerusalem",
  },
  { re: /שעון\s*לונדון|london\s*time|europe\/london\b/i, zone: "Europe/London" },
  { re: /שעון\s*פריז|paris\s*time|europe\/paris\b/i, zone: "Europe/Paris" },
];

type WallParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  snippet: string;
  /** When the source already carried an absolute offset/Z. */
  absoluteIso?: string;
  /** Per-clock zone when the prose labels this clock explicitly. */
  timeZone?: string;
  timeZoneSource?: EventAtExtraction["timeZoneSource"];
};

/**
 * Convert a local civil datetime in `timeZone` to a UTC Date.
 * Uses Intl offset probing (no extra TZ dependency).
 */
export function zonedLocalToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  const { year, month, day, hour, minute, timeZone } = input;
  if (
    !Number.isFinite(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  try {
    // Validate zone exists
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    return null;
  }

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const read = (ms: number) => {
    const parts = dtf.formatToParts(new Date(ms));
    const get = (t: string) =>
      Number(parts.find((p) => p.type === t)?.value ?? NaN);
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour"),
      minute: get("minute"),
      second: get("second"),
    };
  };
  const asTz = read(utcGuess);
  if (
    !Number.isFinite(asTz.year) ||
    !Number.isFinite(asTz.month) ||
    !Number.isFinite(asTz.day)
  ) {
    return null;
  }
  const asTzMs = Date.UTC(
    asTz.year,
    asTz.month - 1,
    asTz.day,
    asTz.hour,
    asTz.minute,
    asTz.second,
  );
  const corrected = new Date(utcGuess - (asTzMs - utcGuess));
  // Verify round-trip (handles DST edges fail-closed on mismatch)
  const verify = read(corrected.getTime());
  if (
    verify.year !== year ||
    verify.month !== month ||
    verify.day !== day ||
    verify.hour !== hour ||
    verify.minute !== minute
  ) {
    return null;
  }
  return corrected;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function wallKey(p: WallParts): string {
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Strip markdown emphasis for more reliable regex matching. */
function normalizeProse(text: string): string {
  return String(text ?? "")
    .replace(/\*\*/g, "")
    .replace(/[_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the searchable corpus from retrieval text + source captions.
 * URL path/query dates are intentionally NOT copied in as event evidence.
 */
/** @internal exported for tests/debug */
export function buildEventAtCorpus(input: {
  text: string;
  sources?: string[];
}): string {
  const parts = [normalizeProse(input.text)];
  for (const raw of input.sources ?? []) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    // Keep caption before URL; drop bare URL-only rows (path dates are noise).
    const withoutUrl = s.replace(/https?:\/\/\S+/gi, " ").trim();
    if (withoutUrl.length >= 8) {
      parts.push(normalizeProse(withoutUrl));
    }
  }
  return parts.filter(Boolean).join("\n");
}

function resolveTimeZone(corpus: string): {
  zone: string;
  source: EventAtExtraction["timeZoneSource"];
} | null {
  // Explicit venue-zone labels first (Madrid/London/Paris).
  if (/שעון\s*מדריד|madrid\s*time|europe\/madrid|שעון\s*ספרד|spain\s*time/i.test(corpus)) {
    return { zone: "Europe/Madrid", source: "named_zone" };
  }
  if (/שעון\s*לונדון|london\s*time|europe\/london\b/i.test(corpus)) {
    return { zone: "Europe/London", source: "named_zone" };
  }
  if (/שעון\s*פריז|paris\s*time|europe\/paris\b/i.test(corpus)) {
    return { zone: "Europe/Paris", source: "named_zone" };
  }
  // Event venue / club place beats a secondary "local Israel time" gloss.
  // Example: kickoff in Madrid mentioned with an Israel conversion line.
  if (
    /(?:ב|in\s+)?מדריד\b|(?:in\s+)?madrid\b|סנטיאגו\s*ברנבאו|bernab[eé]u|realmadrid\.com|בספרד|in\s+spain/i.test(
      corpus,
    )
  ) {
    return { zone: "Europe/Madrid", source: "place_cue" };
  }
  if (/שעון\s*ישראל|israel\s*time|asia\/jerusalem|שעון\s*ירושלים/i.test(corpus)) {
    return { zone: "Asia/Jerusalem", source: "named_zone" };
  }
  for (const cue of PLACE_ZONE_CUES) {
    if (cue.re.test(corpus)) {
      return { zone: cue.zone, source: "place_cue" };
    }
  }
  return null;
}

type ClockHit = {
  hour: number;
  minute: number;
  snippet: string;
  /** Absolute index of the clock match in corpus. */
  at: number;
};

function zoneAround(corpus: string, at: number): {
  zone: string;
  source: EventAtExtraction["timeZoneSource"];
} | null {
  // Prefer the timezone label closest to this clock (usually immediately after).
  const windowFrom = Math.max(0, at - 24);
  const windowTo = Math.min(corpus.length, at + 56);
  const slice = corpus.slice(windowFrom, windowTo);
  const cues: Array<{ re: RegExp; zone: string }> = [
    { re: /שעון\s*מדריד|madrid\s*time|בספרד|שעון\s*ספרד|spain\s*time/gi, zone: "Europe/Madrid" },
    { re: /שעון\s*ישראל|בישראל|israel\s*time|שעון\s*ירושלים/gi, zone: "Asia/Jerusalem" },
    { re: /שעון\s*לונדון|london\s*time/gi, zone: "Europe/London" },
    { re: /שעון\s*פריז|paris\s*time/gi, zone: "Europe/Paris" },
  ];
  let best: { zone: string; dist: number } | null = null;
  for (const cue of cues) {
    for (const m of slice.matchAll(cue.re)) {
      const abs = windowFrom + (m.index ?? 0);
      const dist = Math.abs(abs - at);
      if (!best || dist < best.dist) {
        best = { zone: cue.zone, dist };
      }
    }
  }
  if (!best) return null;
  return { zone: best.zone, source: "named_zone" };
}

function parseClocksInWindow(
  corpus: string,
  from: number,
  to: number,
): ClockHit[] {
  const start = Math.max(0, from);
  const end = Math.min(corpus.length, to);
  const slice = corpus.slice(start, end);
  const out: ClockHit[] = [];

  for (const m of slice.matchAll(/(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/gi)) {
    let hour = Number(m[1]);
    const minute = Number(m[2]);
    const ap = m[3]!.toLowerCase();
    if (hour < 1 || hour > 12 || minute > 59) continue;
    if (ap === "p" && hour < 12) hour += 12;
    if (ap === "a" && hour === 12) hour = 0;
    out.push({ hour, minute, snippet: m[0], at: start + (m.index ?? 0) });
  }
  for (const m of slice.matchAll(/(?:בשעה\s*)?(\d{1,2})[:.](\d{2})(?!\d)/g)) {
    const abs = start + (m.index ?? 0);
    // Skip if this span already covered by am/pm parse
    if (out.some((c) => Math.abs(c.at - abs) < 3)) continue;
    const after = slice.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 5);
    if (/^\s*[ap]\.?m\.?/i.test(after)) continue;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) continue;
    out.push({ hour, minute, snippet: m[0], at: abs });
  }
  return out;
}

function parseClockNear(
  corpus: string,
  index: number,
  window = 80,
): ClockHit | null {
  return parseClocksInWindow(corpus, index - 20, index + window)[0] ?? null;
}

/** @internal exported for diagnostics */
export function collectWallCandidates(corpus: string): WallParts[] {
  const out: WallParts[] = [];

  // Absolute ISO with Z or numeric offset — timezone is in the string.
  const isoAbs =
    /\b(20\d{2}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))\b/gi;
  for (const m of corpus.matchAll(isoAbs)) {
    const raw = m[1]!.replace(" ", "T");
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) continue;
    const d = new Date(ms);
    out.push({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      snippet: m[1]!,
      absoluteIso: new Date(ms).toISOString(),
    });
  }

  // ISO local without offset: 2026-11-21T21:00 or 2026-11-21 21:00
  const isoLocal =
    /\b(20\d{2})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::\d{2})?\b/g;
  for (const m of corpus.matchAll(isoLocal)) {
    // Skip if this was already captured as absolute (has Z/+/- after)
    const after = corpus.slice(m.index! + m[0].length, m.index! + m[0].length + 6);
    if (/^Z|^[+-]\d{2}/i.test(after)) continue;
    const clockOk = true;
    if (!clockOk) continue;
    out.push({
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      snippet: m[0],
    });
  }

  // English: November 21, 2026 / Nov 21 2026 / November 21, at 9:00 pm (year elsewhere)
  const enDate =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi;
  const corpusYears = [...corpus.matchAll(/\b(20\d{2})\b/g)].map((x) =>
    Number(x[1]),
  );
  const uniqueYears = [...new Set(corpusYears)];
  for (const m of corpus.matchAll(enDate)) {
    const month = EN_MONTHS[m[1]!.toLowerCase()];
    if (!month) continue;
    const day = Number(m[2]);
    let year = m[3] ? Number(m[3]) : NaN;
    if (!Number.isFinite(year)) {
      // Inherit year only when the whole corpus agrees on a single 20xx.
      if (uniqueYears.length !== 1) continue;
      year = uniqueYears[0]!;
    }
    const clock = parseClockNear(corpus, m.index! + m[0].length);
    // Also allow clock just before the date ("at 9:00 pm on November 21, 2026")
    const clockBefore = parseClockNear(
      corpus,
      Math.max(0, m.index! - 40),
      60,
    );
    const clockUse = clock ?? clockBefore;
    if (!clockUse) continue;
    const local = zoneAround(corpus, clockUse.at);
    out.push({
      year,
      month,
      day,
      hour: clockUse.hour,
      minute: clockUse.minute,
      snippet: `${m[0]} ${clockUse.snippet}`.trim(),
      ...(local
        ? { timeZone: local.zone, timeZoneSource: local.source }
        : {}),
    });
  }

  // Hebrew: 21 בנובמבר 2026 — may list Israel + Spain clocks; keep both.
  const heDate =
    /(\d{1,2})\s*ב\s*(ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)\s+(20\d{2})/g;
  for (const m of corpus.matchAll(heDate)) {
    const day = Number(m[1]);
    const month = HE_MONTHS[m[2]!];
    const year = Number(m[3]);
    if (!month) continue;
    const dateEnd = m.index! + m[0].length;
    const clocks = parseClocksInWindow(corpus, dateEnd - 10, dateEnd + 140);
    const before = parseClocksInWindow(corpus, m.index! - 40, m.index! + 5);
    const use = clocks.length > 0 ? clocks : before;
    if (use.length === 0) continue;
    for (const clockUse of use) {
      const local = zoneAround(corpus, clockUse.at);
      out.push({
        year,
        month,
        day,
        hour: clockUse.hour,
        minute: clockUse.minute,
        snippet: `${m[0]} ${clockUse.snippet}`.trim(),
        ...(local
          ? { timeZone: local.zone, timeZoneSource: local.source }
          : {}),
      });
    }
  }

  return out;
}

/**
 * Extract a single unambiguous eventAt from retrieval prose.
 * Fail-closed on missing time, missing year, missing timezone, or conflicts.
 */
export function extractEventAtFromRetrievalText(input: {
  text: string;
  sources?: string[];
}): EventAtExtraction | null {
  const corpus = buildEventAtCorpus(input);
  if (corpus.length < 8) return null;

  const walls = collectWallCandidates(corpus);
  if (walls.length === 0) return null;

  // Absolute ISO rows are already UTC — take them if unanimous.
  const absolutes = walls.filter((w) => w.absoluteIso);
  if (absolutes.length > 0) {
    const uniq = [...new Set(absolutes.map((w) => w.absoluteIso!))];
    if (uniq.length !== 1) return null;
    const hit = absolutes[0]!;
    return {
      eventAtIso: hit.absoluteIso!,
      localWall: wallKey(hit),
      timeZone: "UTC",
      snippet: hit.snippet.slice(0, 160),
      timeZoneSource: "explicit_offset",
    };
  }

  const fallbackZone = resolveTimeZone(corpus);
  const converted: EventAtExtraction[] = [];
  for (const w of walls) {
    if (w.absoluteIso) continue;
    const zone = w.timeZone
      ? {
          zone: w.timeZone,
          source: w.timeZoneSource ?? ("named_zone" as const),
        }
      : fallbackZone;
    if (!zone) continue;
    const utc = zonedLocalToUtc({
      year: w.year,
      month: w.month,
      day: w.day,
      hour: w.hour,
      minute: w.minute,
      timeZone: zone.zone,
    });
    if (!utc) continue;
    converted.push({
      eventAtIso: utc.toISOString(),
      localWall: wallKey(w),
      timeZone: zone.zone,
      snippet: w.snippet.slice(0, 160),
      timeZoneSource: zone.source,
    });
  }
  if (converted.length === 0) return null;

  const uniqIso = [...new Set(converted.map((c) => c.eventAtIso))];
  if (uniqIso.length !== 1) return null;

  // Prefer venue-local (Madrid) snippet when several equivalent conversions exist.
  const venuePreferred = converted.filter((c) => c.timeZone === "Europe/Madrid");
  const pool = venuePreferred.length > 0 ? venuePreferred : converted;
  return pool.sort((a, b) => b.snippet.length - a.snippet.length)[0]!;
}
