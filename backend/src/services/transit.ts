/**
 * Live Israel bus departures from MOT GTFS (schedule only — not SIRI).
 * Model→Action→Engine: engine formats DB facts; never invents times.
 */
import { jerusalemYmd } from "../utils/relative-date.js";
import {
  defaultGtfsPaths,
  getLastGtfsSyncError,
  getOpenGtfsDb,
  isGtfsDbFresh,
  isGtfsSyncInFlight,
  resolveRepoRoot,
  startGtfsSyncIfNeeded,
  type GtfsPaths,
} from "./gtfs-store.js";
import type { DatabaseSync } from "node:sqlite";

export type TransitAspect = "departures" | "summary";

export type TransitDeparture = {
  departureTime: string;
  stopName: string;
  stopCode: string;
  routeShortName: string;
  routeLongName: string;
  agencyName: string;
  headsign: string;
};

export type TransitFacts = {
  line: string;
  stop: string;
  place: string;
  aspects: TransitAspect[];
  departures: TransitDeparture[];
  ambiguousStops: string[];
  missing: string[];
  notReady?: boolean;
  error?: string;
};

const ASPECT_SET = new Set<TransitAspect>(["departures", "summary"]);

export function parseTransitAspects(raw: unknown): TransitAspect[] {
  if (!Array.isArray(raw)) {
    return ["departures"];
  }
  const out: TransitAspect[] = [];
  for (const entry of raw) {
    const key = String(entry ?? "")
      .trim()
      .toLowerCase() as TransitAspect;
    if (ASPECT_SET.has(key) && !out.includes(key)) {
      out.push(key);
    }
  }
  return out.length > 0 ? out : ["departures"];
}

/** Apostrophe / geresh / quote marks MOT and users mix freely (ז'בוטינסקי vs ז׳בוטינסקי). */
const TRANSIT_QUOTE_RE = /[''`´׳״"«»]/g;

export function normHeTransit(s: string): string {
  return s
    .replace(TRANSIT_QUOTE_RE, "")
    .replace(/תקווה/g, "תקוה")
    .replace(/ת\.?\s*מרכזית/g, "תחנה מרכזית")
    .replace(/־/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** SQL expr: strip apostrophe/geresh so LIKE '%זבוטינסקי%' matches MOT ז'בוטינסקי. */
function sqlStripQuotes(columnSql: string): string {
  // Nested REPLACE — SQLite has no translate(). ASCII ' + Hebrew ׳ cover MOT + typed Hebrew.
  return `REPLACE(REPLACE(${columnSql}, '''', ''), '׳', '')`;
}

function tokens(s: string): string[] {
  return normHeTransit(s)
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

/** Expand tokens for SQL LIKE — תקוה vs תקווה both appear in MOT data. */
function likeVariants(token: string): string[] {
  const out = new Set<string>([token]);
  if (token === "תקוה") {
    out.add("תקווה");
  } else if (token === "תקווה") {
    out.add("תקוה");
  }
  return [...out];
}

function isPetahTikva(place: string): boolean {
  const n = normHeTransit(place);
  return n.includes("פתח") && n.includes("תקוה");
}

function isCentralHint(stopHint: string): boolean {
  const n = normHeTransit(stopHint);
  return n.includes("מרכז") || n.includes("מסוף");
}

/** Score how well a stop name/desc matches stop hint + city. */
export function scoreStopMatch(
  stopName: string,
  stopDesc: string,
  stopHint: string,
  place: string,
): number {
  const name = normHeTransit(`${stopName} ${stopDesc}`);
  const hintTokens = tokens(stopHint);
  const placeTokens = tokens(place);
  if (hintTokens.length === 0) {
    return 0;
  }
  let score = 0;
  let hintHits = 0;
  for (const t of hintTokens) {
    if (name.includes(t)) {
      hintHits += 1;
      score += 20;
    }
  }
  // «תחנה מרכזית פ״ת» ≈ מסוף משה ארנס (local name of the central bus station).
  const arensCentral =
    isPetahTikva(place) &&
    isCentralHint(stopHint) &&
    (name.includes("ארנס") || (name.includes("מסוף") && name.includes("משה")));
  if (hintHits === 0 && !arensCentral) {
    return 0;
  }
  if (arensCentral) {
    score += 80;
  }
  // City is required when given — prefer «עיר: …» in MOT stop_desc.
  if (placeTokens.length > 0) {
    const placeHits = placeTokens.filter((t) => name.includes(t)).length;
    if (placeHits === 0) {
      return 0;
    }
    score += placeHits * 15;
    if (name.includes(`עיר ${placeTokens[0]}`) || name.includes("עיר פתח")) {
      score += 25;
    }
  }
  if (hintHits === hintTokens.length && hintHits > 0) {
    score += 30;
  }
  // Prefer central / terminal wording when user said מרכזית
  if (hintTokens.some((t) => t.includes("מרכז")) && name.includes("מרכז")) {
    score += 10;
  }
  if (hintTokens.some((t) => t.includes("מסוף")) && name.includes("מסוף")) {
    score += 10;
  }
  // Deprioritize light-rail / taxi stands when asking for a bus line.
  if (name.includes("רקל") || name.includes("מוניות") || name.includes("מסילת ברזל")) {
    score -= 50;
  }
  return score;
}


function weekdayColumn(ymd: string): string {
  // ymd YYYY-MM-DD in Asia/Jerusalem — use UTC noon to avoid DST edge.
  const d = new Date(`${ymd}T12:00:00+03:00`);
  const day = d.getUTCDay(); // 0=Sun … 6=Sat
  const map = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  return map[day]!;
}

function ymdCompact(ymd: string): string {
  return ymd.replace(/-/g, "");
}

function clockNowHe(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("hour")}:${get("minute")}:${get("second")}`;
}

function formatClockHe(gtfsTime: string): string {
  const m = gtfsTime.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) {
    return gtfsTime;
  }
  const h = Number(m[1]);
  const mm = m[2]!;
  if (!Number.isFinite(h)) {
    return gtfsTime;
  }
  // GTFS may use 24+ hours for after-midnight; show mod 24 for display.
  const displayH = h % 24;
  return `${displayH}:${mm}`;
}

/** SQL predicate: trip.service_id is active on ymd (calendar + exceptions). */
function serviceActiveSql(ymd: string): { sql: string; params: string[] } {
  const compact = ymdCompact(ymd);
  const col = weekdayColumn(ymd);
  // Added by calendar_dates exception_type=1, or regular calendar day,
  // and not removed by exception_type=2.
  return {
    sql: `(
      EXISTS (
        SELECT 1 FROM calendar_dates cd_add
        WHERE cd_add.service_id = t.service_id
          AND cd_add.date = ?
          AND cd_add.exception_type = 1
      )
      OR (
        EXISTS (
          SELECT 1 FROM calendar c
          WHERE c.service_id = t.service_id
            AND c.${col} = 1
            AND c.start_date <= ?
            AND c.end_date >= ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM calendar_dates cd_rm
          WHERE cd_rm.service_id = t.service_id
            AND cd_rm.date = ?
            AND cd_rm.exception_type = 2
        )
      )
    )`,
    params: [compact, compact, compact, compact],
  };
}

function hasActiveServiceToday(db: DatabaseSync, ymd: string): boolean {
  const compact = ymdCompact(ymd);
  const col = weekdayColumn(ymd);
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM calendar
       WHERE ${col} = 1 AND start_date <= ? AND end_date >= ?
       LIMIT 1`,
    )
    .get(compact, compact) as { ok?: number } | undefined;
  if (row) {
    return true;
  }
  const added = db
    .prepare(
      "SELECT 1 AS ok FROM calendar_dates WHERE date = ? AND exception_type = 1 LIMIT 1",
    )
    .get(compact) as { ok?: number } | undefined;
  return Boolean(added);
}

type StopRow = {
  stop_id: string;
  stop_code: string;
  stop_name: string;
  stop_desc: string;
};

function likeClause(
  tokensIn: string[],
  params: string[],
): string {
  const parts: string[] = [];
  const nameBare = sqlStripQuotes("stop_name");
  const descBare = sqlStripQuotes("IFNULL(stop_desc,'')");
  for (const t of tokensIn) {
    for (const variant of likeVariants(t)) {
      // Tokens are already quote-stripped via tokens() → normHeTransit.
      parts.push(`(${nameBare} LIKE ? OR ${descBare} LIKE ?)`);
      params.push(`%${variant}%`, `%${variant}%`);
    }
  }
  return parts.length > 0 ? `(${parts.join(" OR ")})` : "";
}

function findCandidateStops(
  db: DatabaseSync,
  place: string,
  stopHint: string,
): Array<StopRow & { score: number }> {
  const placeTokens = tokens(place);
  const hintTokens = tokens(stopHint);
  // Prefer specific hint tokens; for PT «מרכזית» also search Arens by name.
  const hintSearch = [...hintTokens];
  if (isPetahTikva(place) && isCentralHint(stopHint)) {
    hintSearch.push("ארנס", "מסוף משה");
  }
  if (hintSearch.length === 0) {
    return [];
  }

  const params: string[] = [];
  const hintSql = likeClause([...new Set(hintSearch)], params);
  // Require city when given — AND with hints so LIMIT cannot drop the real stop
  // (OR-only «פתח» matches tens of thousands of rows).
  const placeSql = placeTokens.length > 0 ? likeClause(placeTokens, params) : "";
  const where =
    placeSql.length > 0 ? `${hintSql} AND ${placeSql}` : hintSql;
  const sql = `SELECT stop_id, stop_code, stop_name, IFNULL(stop_desc,'') AS stop_desc
    FROM stops WHERE ${where} LIMIT 400`;
  const rows = db.prepare(sql).all(...params) as StopRow[];
  const scored = rows
    .map((row) => ({
      ...row,
      score: scoreStopMatch(
        row.stop_name,
        row.stop_desc,
        stopHint,
        place,
      ),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored;
}

function stopsServingLine(
  db: DatabaseSync,
  stopIds: string[],
  line: string,
  ymd: string,
): Set<string> {
  if (stopIds.length === 0) {
    return new Set();
  }
  const active = serviceActiveSql(ymd);
  const serving = new Set<string>();
  // Chunk stop IN lists — avoid SQLite variable limits.
  const chunkSize = 200;
  for (let i = 0; i < stopIds.length; i += chunkSize) {
    const chunk = stopIds.slice(i, i + chunkSize);
    const stopPlaceholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT DISTINCT st.stop_id AS stop_id
         FROM stop_times st
         JOIN trips t ON t.trip_id = st.trip_id
         JOIN routes r ON r.route_id = t.route_id
         WHERE r.route_short_name = ?
           AND st.stop_id IN (${stopPlaceholders})
           AND ${active.sql}`,
      )
      .all(line, ...chunk, ...active.params) as Array<{ stop_id: string }>;
    for (const row of rows) {
      serving.add(row.stop_id);
    }
  }
  return serving;
}

export function queryTransitDepartures(
  db: DatabaseSync,
  input: {
    line: string;
    stop: string;
    place: string;
    now?: Date;
  },
): {
  departures: TransitDeparture[];
  ambiguousStops: string[];
  error?: string;
} {
  const line = input.line.trim();
  const ymd = jerusalemYmd(input.now ?? new Date());
  const nowClock = clockNowHe(input.now ?? new Date());
  if (!hasActiveServiceToday(db, ymd)) {
    return { departures: [], ambiguousStops: [], error: "no_service" };
  }

  const candidates = findCandidateStops(db, input.place, input.stop);
  if (candidates.length === 0) {
    return { departures: [], ambiguousStops: [] };
  }

  const serving = stopsServingLine(
    db,
    candidates.map((c) => c.stop_id),
    line,
    ymd,
  );
  const filtered = candidates.filter((c) => serving.has(c.stop_id));
  const pool = filtered.length > 0 ? filtered : candidates;

  const topScore = pool[0]!.score;
  const top = pool.filter((c) => c.score >= topScore - 10).slice(0, 5);
  // Ambiguous if multiple distinct names at similar score and none clearly wins
  const distinctNames = [...new Set(top.map((c) => c.stop_name))];
  if (distinctNames.length > 1 && top[0]!.score < 60) {
    return {
      departures: [],
      ambiguousStops: distinctNames.slice(0, 5),
    };
  }

  const stopIds = top.map((c) => c.stop_id);
  const stopPlaceholders = stopIds.map(() => "?").join(",");
  const active = serviceActiveSql(ymd);
  const rows = db
    .prepare(
      `SELECT st.departure_time AS departure_time,
              s.stop_name AS stop_name,
              IFNULL(s.stop_code,'') AS stop_code,
              r.route_short_name AS route_short_name,
              IFNULL(r.route_long_name,'') AS route_long_name,
              IFNULL(a.agency_name,'') AS agency_name,
              IFNULL(t.trip_headsign,'') AS headsign
       FROM stop_times st
       JOIN trips t ON t.trip_id = st.trip_id
       JOIN routes r ON r.route_id = t.route_id
       JOIN stops s ON s.stop_id = st.stop_id
       LEFT JOIN agency a ON a.agency_id = r.agency_id
       WHERE r.route_short_name = ?
         AND st.stop_id IN (${stopPlaceholders})
         AND st.departure_time >= ?
         AND ${active.sql}
       ORDER BY st.departure_time ASC
       LIMIT 8`,
    )
    .all(line, ...stopIds, nowClock, ...active.params) as Array<{
    departure_time: string;
    stop_name: string;
    stop_code: string;
    route_short_name: string;
    route_long_name: string;
    agency_name: string;
    headsign: string;
  }>;

  const departures: TransitDeparture[] = rows.map((r) => ({
    departureTime: r.departure_time,
    stopName: r.stop_name,
    stopCode: r.stop_code,
    routeShortName: r.route_short_name,
    routeLongName: r.route_long_name,
    agencyName: r.agency_name,
    headsign: r.headsign,
  }));

  return { departures, ambiguousStops: [] };
}

export function formatTransitHebrew(facts: TransitFacts): string {
  if (facts.error === "sync_failed") {
    return "לא הצלחתי לטעון לוח זמנים של התחבורה הציבורית. נסה שוב בעוד רגע.";
  }
  if (facts.notReady) {
    return "לוח הזמנים של התחבורה הציבורית עדיין נטען. נסה שוב בעוד רגע.";
  }
  if (facts.error === "no_db") {
    return "לוח הזמנים של התחבורה הציבורית לא זמין כרגע. נסה שוב בעוד רגע.";
  }
  if (facts.missing.length > 0) {
    return `כדי לבדוק יציאות חסר לי: ${facts.missing.join(", ")}.`;
  }
  if (facts.ambiguousStops.length > 0) {
    return `מצאתי כמה תחנות דומות ל«${facts.stop}» ב${facts.place}: ${facts.ambiguousStops.map((s) => `«${s}»`).join(" או ")}. לאיזו התכוונת?`;
  }
  if (facts.departures.length === 0) {
    return `לא מצאתי יציאות קרובות לקו ${facts.line} מ«${facts.stop}» ב${facts.place} היום.`;
  }
  const lines: string[] = [
    `קו ${facts.line} — יציאות מ«${facts.departures[0]!.stopName}»${facts.place ? ` (${facts.place})` : ""}:`,
  ];
  for (const row of facts.departures) {
    const clock = formatClockHe(row.departureTime);
    const dir =
      row.headsign ||
      row.routeLongName.split("<->")[1]?.trim() ||
      row.routeLongName;
    const agency = row.agencyName ? ` · ${row.agencyName}` : "";
    lines.push(`• ${clock}${dir ? ` → ${dir}` : ""}${agency}`);
  }
  lines.push("(לוח זמנים מתוכנן — לא זמן אמת)");
  return lines.join("\n");
}

export async function resolveTransitReply(input: {
  line: string;
  stop: string;
  place: string;
  aspects?: TransitAspect[] | unknown;
  now?: Date;
  /** Inject paths for tests. */
  paths?: GtfsPaths;
  /** Inject open DB (skips ensure). */
  db?: DatabaseSync | null;
}): Promise<string> {
  const aspects = parseTransitAspects(input.aspects);
  const line = String(input.line ?? "")
    .replace(/^קו\s+/u, "")
    .trim();
  const stop = String(input.stop ?? "").trim();
  const place = String(input.place ?? "").trim();
  const missing: string[] = [];
  if (!line) missing.push("מספר קו");
  if (!stop) missing.push("תחנה");
  if (!place) missing.push("עיר");
  if (missing.length > 0) {
    return formatTransitHebrew({
      line,
      stop,
      place,
      aspects,
      departures: [],
      ambiguousStops: [],
      missing,
    });
  }

  const paths =
    input.paths ?? defaultGtfsPaths(resolveRepoRoot());

  let db = input.db ?? null;
  if (!db) {
    if (getLastGtfsSyncError() && !isGtfsDbFresh(paths.dbPath) && !isGtfsSyncInFlight()) {
      // Previous sync failed — retry once in background, tell the user clearly.
      startGtfsSyncIfNeeded(paths);
      return formatTransitHebrew({
        line,
        stop,
        place,
        aspects,
        departures: [],
        ambiguousStops: [],
        missing: [],
        error: "sync_failed",
      });
    }
    if (!isGtfsDbFresh(paths.dbPath)) {
      const started = startGtfsSyncIfNeeded(paths);
      if (started || isGtfsSyncInFlight() || !isGtfsDbFresh(paths.dbPath)) {
        return formatTransitHebrew({
          line,
          stop,
          place,
          aspects,
          departures: [],
          ambiguousStops: [],
          missing: [],
          notReady: true,
        });
      }
    }
    db = getOpenGtfsDb(paths.dbPath);
  }
  if (!db) {
    return formatTransitHebrew({
      line,
      stop,
      place,
      aspects,
      departures: [],
      ambiguousStops: [],
      missing: [],
      error: "no_db",
    });
  }

  try {
    const result = queryTransitDepartures(db, {
      line,
      stop,
      place,
      now: input.now,
    });
    return formatTransitHebrew({
      line,
      stop,
      place,
      aspects,
      departures: result.departures,
      ambiguousStops: result.ambiguousStops,
      missing: [],
      ...(result.error ? { error: result.error } : {}),
    });
  } catch {
    return "לא הצלחתי לבדוק לוח זמנים עכשיו. נסה שוב בעוד רגע.";
  }
}
