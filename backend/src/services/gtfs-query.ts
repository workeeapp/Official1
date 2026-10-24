/**
 * Official MOT static GTFS queries: schedule + nearest_stop.
 * Never claims real-time. Reads only the active generation.
 */
import type { PrismaClient } from "@prisma/client";
import {
  jerusalemMinutesSinceMidnight,
  jerusalemYmd,
  secondsToDisplayHm,
  toServiceDateKey,
} from "./gtfs-time.js";

export const GTFS_OFFICIAL_SOURCE_HE =
  "לוח זמנים רשמי (משרד התחבורה) — מתוזמן, לא זמן אמת";

export const GTFS_DISABLED_HE =
  "לוח הזמנים הרשמי של משרד התחבורה כבוי כרגע (GTFS_ENABLED).";

export const GTFS_NO_ACTIVE_HE =
  "אין כרגע לוח זמנים רשמי טעון. נסי שוב אחרי עדכון הפיד.";

export type GtfsAmbiguityKind = "agency" | "direction" | "stop";

export type GtfsAmbiguity = {
  kind: GtfsAmbiguityKind;
  messageHe: string;
  options: string[];
};

export type GtfsDepartureRow = {
  stopCode: string;
  stopName: string;
  line: string;
  agencyName: string;
  directionLabel: string;
  headsign: string;
  departureTime: string;
  depSeconds: number;
  serviceDate: string;
};

export type GtfsNearbyStop = {
  stopCode: string;
  stopName: string;
  distanceMeters: number;
  line: string;
  directionLabel: string;
  agencyName: string;
};

export function isGtfsEnabled(): boolean {
  return process.env.GTFS_ENABLED === "1";
}

export async function getActiveGenerationId(
  prisma: PrismaClient,
): Promise<string | null> {
  const row = await prisma.gtfsFeedGeneration.findFirst({
    where: { status: "active" },
    select: { id: true },
  });
  return row?.id ?? null;
}

export type GtfsAgencyMatch = {
  agencyId: string;
  name: string;
};

export type ResolveAgencyHintResult =
  | { ok: true; matches: GtfsAgencyMatch[] }
  | {
      ok: false;
      kind: "unknown" | "ambiguous" | "no_feed";
      messageHe: string;
      options: string[];
    };

/**
 * Map a speaker agency hint (Hebrew name substring or exact agency_id) to GTFS
 * agency_id values for SIRI OperatorRef filtering. Never equates name === id.
 */
export async function resolveGtfsAgencyHint(
  prisma: PrismaClient,
  hint: string,
  options?: { generationId?: string | null; line?: string },
): Promise<ResolveAgencyHintResult> {
  const q = hint.trim();
  if (!q) {
    return { ok: true, matches: [] };
  }
  // Without GTFS, numeric agency_id can still filter SIRI OperatorRef; Hebrew
  // names cannot be resolved (never equate name === id).
  if (!isGtfsEnabled() && options?.generationId == null) {
    if (/^\d+$/.test(q)) {
      return { ok: true, matches: [{ agencyId: q, name: q }] };
    }
    return {
      ok: false,
      kind: "no_feed",
      messageHe: GTFS_DISABLED_HE,
      options: [],
    };
  }
  const generationId =
    options?.generationId ?? (await getActiveGenerationId(prisma));
  if (!generationId) {
    return {
      ok: false,
      kind: "no_feed",
      messageHe: GTFS_NO_ACTIVE_HE,
      options: [],
    };
  }

  let agencyRows = await prisma.gtfsAgency.findMany({
    where: { generationId },
    select: { agencyId: true, name: true },
  });

  // When a line is known, prefer agencies that actually operate that short_name.
  const line = String(options?.line ?? "").trim();
  if (line) {
    const routeAgencyIds = [
      ...new Set(
        (
          await prisma.gtfsRoute.findMany({
            where: { generationId, shortName: line },
            select: { agencyId: true },
          })
        ).map((r) => r.agencyId),
      ),
    ];
    if (routeAgencyIds.length > 0) {
      const scoped = agencyRows.filter((a) => routeAgencyIds.includes(a.agencyId));
      if (scoped.length > 0) agencyRows = scoped;
    }
  }

  const lower = q.toLowerCase();
  const matches = agencyRows.filter(
    (a) =>
      a.agencyId.toLowerCase() === lower ||
      a.name.toLowerCase().includes(lower),
  );

  // Dedupe by agencyId.
  const byId = new Map<string, GtfsAgencyMatch>();
  for (const m of matches) {
    byId.set(m.agencyId, { agencyId: m.agencyId, name: m.name });
  }
  const unique = [...byId.values()];

  if (unique.length === 0) {
    return {
      ok: false,
      kind: "unknown",
      messageHe: `לא מצאתי מפעיל התואם ל«${q}» בלוח הרשמי.`,
      options: [],
    };
  }
  if (unique.length > 1) {
    return {
      ok: false,
      kind: "ambiguous",
      messageHe: `מצאתי כמה מפעילים ל«${q}». איזה מפעיל?`,
      options: uniqueSorted(unique.map((u) => u.name || u.agencyId)),
    };
  }
  return { ok: true, matches: unique };
}

/** Expand stop_code → boarding feed_stop_ids (location_type 0); else station row. */
export async function resolveBoardingStopIds(
  prisma: PrismaClient,
  generationId: string,
  stopCode: string,
): Promise<Array<{ feedStopId: string; name: string; stopCode: string }>> {
  const code = stopCode.trim();
  if (!code) return [];
  const rows = await prisma.gtfsStop.findMany({
    where: { generationId, stopCode: code },
    select: {
      feedStopId: true,
      name: true,
      stopCode: true,
      locationType: true,
    },
  });
  const boarding = rows.filter((r) => r.locationType === 0);
  const use = boarding.length > 0 ? boarding : rows.filter((r) => r.locationType === 1);
  const final = use.length > 0 ? use : rows;
  return final.map((r) => ({
    feedStopId: r.feedStopId,
    name: r.name,
    stopCode: r.stopCode,
  }));
}

export type ScheduleStopRefMatch = {
  stopCode: string;
  /** Display name (prefer boarding / station row). */
  stopName: string;
};

export type ResolveScheduleStopRefResult =
  | { ok: true; match: ScheduleStopRefMatch; via: "stop_code" | "stop_name" }
  | { ok: false; kind: "empty"; messageHe: string }
  | { ok: false; kind: "ambiguous"; ambiguity: GtfsAmbiguity };

function normalizeStopNameQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

function namesEqualFold(a: string, b: string): boolean {
  return a.trim().localeCompare(b.trim(), "he", { sensitivity: "accent" }) === 0;
}

/**
 * Resolve a schedule stop reference: prefer exact stop_code, else spoken name.
 * No city column in GtfsStops — disambiguate by stop_code (+ optional line filter).
 * Never silently picks among distinct stop_codes.
 */
export async function resolveScheduleStopRef(
  prisma: PrismaClient,
  generationId: string,
  stopRef: string,
  options?: { line?: string },
): Promise<ResolveScheduleStopRefResult> {
  const ref = normalizeStopNameQuery(stopRef);
  if (!ref) {
    return {
      ok: false,
      kind: "empty",
      messageHe: "ללוח הרשמי צריך קוד תחנה או שם תחנה.",
    };
  }

  const byCode = await resolveBoardingStopIds(prisma, generationId, ref);
  if (byCode.length > 0) {
    return {
      ok: true,
      via: "stop_code",
      match: {
        stopCode: byCode[0]!.stopCode,
        stopName: byCode[0]!.name,
      },
    };
  }

  // Name lookup — GtfsStops has name + parent_feed_stop_id, not a city field.
  const nameRows = await prisma.gtfsStop.findMany({
    where: {
      generationId,
      name: { contains: ref, mode: "insensitive" },
    },
    select: {
      stopCode: true,
      name: true,
      locationType: true,
      parentFeedStopId: true,
    },
    take: 120,
  });
  if (nameRows.length === 0) {
    return {
      ok: false,
      kind: "empty",
      messageHe: `לא מצאתי תחנה בשם או בקוד «${ref}» בלוח הרשמי.`,
    };
  }

  // One candidate per stop_code (platforms share a code).
  const byStopCode = new Map<
    string,
    { stopCode: string; stopName: string; exact: boolean }
  >();
  for (const row of nameRows) {
    const exact = namesEqualFold(row.name, ref);
    const existing = byStopCode.get(row.stopCode);
    if (!existing) {
      byStopCode.set(row.stopCode, {
        stopCode: row.stopCode,
        stopName: row.name,
        exact,
      });
      continue;
    }
    // Prefer exact-name rows; else prefer boarding (location_type 0) label already
    // handled by first-seen order — upgrade name if this row is exact.
    if (exact && !existing.exact) {
      byStopCode.set(row.stopCode, {
        stopCode: row.stopCode,
        stopName: row.name,
        exact: true,
      });
    }
  }

  let candidates = [...byStopCode.values()];
  const line = String(options?.line ?? "").trim();
  if (line && candidates.length > 1) {
    const codes = candidates.map((c) => c.stopCode);
    const serving = await prisma.$queryRawUnsafe<Array<{ stop_code: string }>>(
      `SELECT DISTINCT s.stop_code
       FROM "GtfsStops" s
       INNER JOIN "GtfsStopTimes" st
         ON st.generation_id = s.generation_id AND st.feed_stop_id = s.feed_stop_id
       INNER JOIN "GtfsTrips" t
         ON t.generation_id = st.generation_id AND t.feed_trip_id = st.feed_trip_id
       INNER JOIN "GtfsRoutes" r
         ON r.generation_id = t.generation_id AND r.feed_route_id = t.feed_route_id
       WHERE s.generation_id = $1::uuid
         AND s.stop_code = ANY($2::text[])
         AND r.short_name = $3`,
      generationId,
      codes,
      line,
    );
    const allowed = new Set(serving.map((r) => r.stop_code));
    const filtered = candidates.filter((c) => allowed.has(c.stopCode));
    if (filtered.length > 0) {
      candidates = filtered;
    }
  }

  const exactOnly = candidates.filter((c) => c.exact);
  let finalPool = exactOnly.length > 0 ? exactOnly : candidates;

  // Prefer names that equal or start with the query when contains matched many.
  if (finalPool.length > 1) {
    const q = ref.toLocaleLowerCase("he");
    const startsWith = finalPool.filter((c) => {
      const n = c.stopName.trim().toLocaleLowerCase("he");
      return n === q || n.startsWith(q);
    });
    if (startsWith.length > 0) {
      finalPool = startsWith;
    }
  }

  if (finalPool.length === 0) {
    return {
      ok: false,
      kind: "empty",
      messageHe: line
        ? `לא מצאתי תחנה בשם «${ref}» שמשרתת את קו ${line} בלוח הרשמי.`
        : `לא מצאתי תחנה בשם או בקוד «${ref}» בלוח הרשמי.`,
    };
  }
  if (finalPool.length === 1) {
    const hit = finalPool[0]!;
    return {
      ok: true,
      via: "stop_name",
      match: { stopCode: hit.stopCode, stopName: hit.stopName },
    };
  }

  const optionsHe = finalPool
    .map((c) => `${c.stopName} [${c.stopCode}]`)
    .sort((a, b) => a.localeCompare(b, "he"));
  return {
    ok: false,
    kind: "ambiguous",
    ambiguity: {
      kind: "stop",
      messageHe: line
        ? `מצאתי כמה תחנות בשם «${ref}» לקו ${line}. איזו תחנה? (אפשר לענות עם הקוד)`
        : `מצאתי כמה תחנות בשם «${ref}». איזו תחנה? (אפשר לענות עם הקוד)`,
      options: optionsHe,
    },
  };
}

type RouteCandidate = {
  feedRouteId: string;
  shortName: string;
  agencyId: string;
  agencyName: string;
  direction: string;
};

async function listRouteCandidates(
  prisma: PrismaClient,
  generationId: string,
  line: string,
  agencyHint: string,
): Promise<RouteCandidate[]> {
  const shortName = line.trim();
  if (!shortName) return [];
  const routes = await prisma.gtfsRoute.findMany({
    where: { generationId, shortName },
    select: { feedRouteId: true, shortName: true, agencyId: true },
  });
  if (routes.length === 0) return [];

  const networks = await prisma.gtfsRouteNetwork.findMany({
    where: {
      generationId,
      feedRouteId: { in: routes.map((r) => r.feedRouteId) },
    },
    select: {
      feedRouteId: true,
      direction: true,
      agencyId: true,
      agencyName: true,
    },
  });
  const byRoute = new Map<string, typeof networks>();
  for (const n of networks) {
    const list = byRoute.get(n.feedRouteId) ?? [];
    list.push(n);
    byRoute.set(n.feedRouteId, list);
  }

  const agencies = await prisma.gtfsAgency.findMany({
    where: {
      generationId,
      agencyId: { in: [...new Set(routes.map((r) => r.agencyId))] },
    },
    select: { agencyId: true, name: true },
  });
  const agencyNameById = new Map(agencies.map((a) => [a.agencyId, a.name]));

  const out: RouteCandidate[] = [];
  for (const r of routes) {
    const nets = byRoute.get(r.feedRouteId) ?? [];
    if (nets.length === 0) {
      out.push({
        feedRouteId: r.feedRouteId,
        shortName: r.shortName,
        agencyId: r.agencyId,
        agencyName: agencyNameById.get(r.agencyId) ?? r.agencyId,
        direction: "",
      });
      continue;
    }
    for (const n of nets) {
      out.push({
        feedRouteId: r.feedRouteId,
        shortName: r.shortName,
        agencyId: n.agencyId || r.agencyId,
        agencyName:
          n.agencyName ||
          agencyNameById.get(n.agencyId || r.agencyId) ||
          r.agencyId,
        direction: n.direction,
      });
    }
  }

  const hint = agencyHint.trim().toLowerCase();
  if (!hint) return out;
  return out.filter(
    (c) =>
      c.agencyName.toLowerCase().includes(hint) ||
      c.agencyId.toLowerCase() === hint,
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "he"),
  );
}

export type ScheduleQueryInput = {
  /**
   * Stop reference: MOT stop_code, or spoken stop name (resolved when code miss).
   * Field name kept for callers; name lookup is added inside querySchedule.
   */
  stopCode: string;
  line: string;
  agency?: string;
  direction?: string;
  headsign?: string;
  /** YYYY-MM-DD; default today Asia/Jerusalem. */
  serviceDate?: string;
  /** Inclusive window start seconds (service-day clock). */
  windowStartSeconds?: number;
  /** Inclusive window end seconds. */
  windowEndSeconds?: number;
  limit?: number;
  now?: Date;
};

export type ScheduleQueryResult =
  | { ok: true; departures: GtfsDepartureRow[]; sourceHe: string }
  | { ok: false; kind: "disabled" | "no_feed" | "no_service" | "empty"; messageHe: string }
  | { ok: false; kind: "ambiguous"; ambiguity: GtfsAmbiguity };

export async function querySchedule(
  prisma: PrismaClient,
  input: ScheduleQueryInput,
): Promise<ScheduleQueryResult> {
  if (!isGtfsEnabled()) {
    return { ok: false, kind: "disabled", messageHe: GTFS_DISABLED_HE };
  }
  const generationId = await getActiveGenerationId(prisma);
  if (!generationId) {
    return { ok: false, kind: "no_feed", messageHe: GTFS_NO_ACTIVE_HE };
  }

  const now = input.now ?? new Date();
  const serviceDateIso = (input.serviceDate?.trim() || jerusalemYmd(now)).slice(
    0,
    10,
  );
  const serviceKey = toServiceDateKey(serviceDateIso);
  const windowStart =
    input.windowStartSeconds ?? jerusalemMinutesSinceMidnight(now) * 60;
  const windowEnd = input.windowEndSeconds ?? windowStart + 2 * 3600;
  const limit = Math.min(Math.max(input.limit ?? 12, 1), 40);

  const stopResolved = await resolveScheduleStopRef(
    prisma,
    generationId,
    input.stopCode,
    { line: input.line },
  );
  if (!stopResolved.ok) {
    if (stopResolved.kind === "ambiguous") {
      return { ok: false, kind: "ambiguous", ambiguity: stopResolved.ambiguity };
    }
    return {
      ok: false,
      kind: "empty",
      messageHe: stopResolved.messageHe,
    };
  }
  const resolvedStopCode = stopResolved.match.stopCode;
  const resolvedStopLabel = `${stopResolved.match.stopName} [${resolvedStopCode}]`;

  const stops = await resolveBoardingStopIds(
    prisma,
    generationId,
    resolvedStopCode,
  );
  if (stops.length === 0) {
    return {
      ok: false,
      kind: "empty",
      messageHe: `לא מצאתי תחנה עם קוד «${resolvedStopCode}» בלוח הרשמי.`,
    };
  }

  let candidates = await listRouteCandidates(
    prisma,
    generationId,
    input.line,
    input.agency ?? "",
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      kind: "empty",
      messageHe: `לא מצאתי קו «${input.line}» בלוח הרשמי.`,
    };
  }

  const agencies = uniqueSorted(candidates.map((c) => c.agencyName));
  if (!(input.agency ?? "").trim() && agencies.length > 1) {
    return {
      ok: false,
      kind: "ambiguous",
      ambiguity: {
        kind: "agency",
        messageHe: `לקו ${input.line} יש כמה מפעילים. איזה מפעיל?`,
        options: agencies,
      },
    };
  }

  const dirHint = (input.direction ?? "").trim();
  const directions = uniqueSorted(
    candidates.map((c) => c.direction).filter(Boolean),
  );
  if (!dirHint && directions.length > 1) {
    return {
      ok: false,
      kind: "ambiguous",
      ambiguity: {
        kind: "direction",
        messageHe: `לקו ${input.line} יש כמה כיוונים. לאיזה כיוון?`,
        options: directions,
      },
    };
  }
  if (dirHint) {
    const byDir = candidates.filter(
      (c) =>
        !c.direction ||
        c.direction === dirHint ||
        c.direction.includes(dirHint),
    );
    candidates = byDir.length > 0 ? byDir : candidates;
  }

  const routeIds = [...new Set(candidates.map((c) => c.feedRouteId))];
  const stopIds = stops.map((s) => s.feedStopId);

  const serviceExists = await prisma.gtfsCalendarDate.findFirst({
    where: {
      generationId,
      date: serviceKey,
      exceptionType: 1,
    },
    select: { serviceId: true },
  });
  // In MOT 10-day package service_id === YYYYMMDD; also accept any exception for that date.
  const serviceId = serviceExists ? serviceKey : serviceKey;
  const hasService = await prisma.gtfsTrip.findFirst({
    where: { generationId, serviceId },
    select: { feedTripId: true },
  });
  if (!hasService) {
    return {
      ok: false,
      kind: "no_service",
      messageHe: `אין שירות בלוח הרשמי בתאריך ${serviceDateIso}.`,
    };
  }

  const headsignHint = (input.headsign ?? "").trim();
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      stop_code: string;
      stop_name: string;
      short_name: string;
      agency_name: string;
      direction: string;
      headsign: string;
      departure_time: string;
      dep_seconds: number;
    }>
  >(
    `SELECT s.stop_code, s.name AS stop_name, r.short_name,
            COALESCE(NULLIF(rn.agency_name, ''), a.name, r.agency_id) AS agency_name,
            COALESCE(rn.direction, '') AS direction,
            t.headsign,
            st.departure_time,
            st.dep_seconds
     FROM "GtfsStopTimes" st
     INNER JOIN "GtfsTrips" t
       ON t.generation_id = st.generation_id AND t.feed_trip_id = st.feed_trip_id
     INNER JOIN "GtfsRoutes" r
       ON r.generation_id = t.generation_id AND r.feed_route_id = t.feed_route_id
     INNER JOIN "GtfsStops" s
       ON s.generation_id = st.generation_id AND s.feed_stop_id = st.feed_stop_id
     LEFT JOIN "GtfsAgencies" a
       ON a.generation_id = r.generation_id AND a.agency_id = r.agency_id
     LEFT JOIN LATERAL (
       SELECT n.agency_name, n.direction
       FROM "GtfsRouteNetworks" n
       WHERE n.generation_id = r.generation_id AND n.feed_route_id = r.feed_route_id
       ORDER BY n.id
       LIMIT 1
     ) rn ON TRUE
     WHERE st.generation_id = $1::uuid
       AND st.feed_stop_id = ANY($2::text[])
       AND st.dep_seconds >= $3
       AND st.dep_seconds <= $4
       AND t.service_id = $5
       AND t.feed_route_id = ANY($6::text[])
       AND ($7::text = '' OR t.headsign ILIKE '%' || $7 || '%')
     ORDER BY st.dep_seconds ASC
     LIMIT $8`,
    generationId,
    stopIds,
    windowStart,
    windowEnd,
    serviceId,
    routeIds,
    headsignHint,
    limit,
  );

  if (rows.length === 0) {
    return {
      ok: false,
      kind: "empty",
      messageHe: `אין יציאות מתוזמנות לקו ${input.line} מתחנה ${resolvedStopLabel} בחלון שנבחר (${serviceDateIso}).`,
    };
  }

  return {
    ok: true,
    sourceHe: GTFS_OFFICIAL_SOURCE_HE,
    departures: rows.map((r) => ({
      stopCode: r.stop_code,
      stopName: r.stop_name,
      line: r.short_name,
      agencyName: r.agency_name,
      directionLabel: r.direction,
      headsign: r.headsign,
      departureTime: secondsToDisplayHm(r.dep_seconds) || r.departure_time.slice(0, 5),
      depSeconds: r.dep_seconds,
      serviceDate: serviceDateIso,
    })),
  };
}

export type NearestStopQueryInput = {
  lat: number;
  lng: number;
  line: string;
  agency?: string;
  direction?: string;
  /** Default: today Asia/Jerusalem. */
  serviceDate?: string;
  limit?: number;
  maxDistanceMeters?: number;
  now?: Date;
};

export type NearestStopQueryResult =
  | { ok: true; stops: GtfsNearbyStop[]; sourceHe: string }
  | { ok: false; kind: "disabled" | "no_feed" | "empty"; messageHe: string }
  | { ok: false; kind: "ambiguous"; ambiguity: GtfsAmbiguity };

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export async function queryNearestStop(
  prisma: PrismaClient,
  input: NearestStopQueryInput,
): Promise<NearestStopQueryResult> {
  if (!isGtfsEnabled()) {
    return { ok: false, kind: "disabled", messageHe: GTFS_DISABLED_HE };
  }
  const generationId = await getActiveGenerationId(prisma);
  if (!generationId) {
    return { ok: false, kind: "no_feed", messageHe: GTFS_NO_ACTIVE_HE };
  }

  const now = input.now ?? new Date();
  const serviceDateIso = (input.serviceDate?.trim() || jerusalemYmd(now)).slice(
    0,
    10,
  );
  const serviceKey = toServiceDateKey(serviceDateIso);
  const limit = Math.min(Math.max(input.limit ?? 3, 1), 10);
  const maxDist = input.maxDistanceMeters ?? 2500;

  let candidates = await listRouteCandidates(
    prisma,
    generationId,
    input.line,
    input.agency ?? "",
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      kind: "empty",
      messageHe: `לא מצאתי קו «${input.line}» בלוח הרשמי.`,
    };
  }

  const agencies = uniqueSorted(candidates.map((c) => c.agencyName));
  if (!(input.agency ?? "").trim() && agencies.length > 1) {
    return {
      ok: false,
      kind: "ambiguous",
      ambiguity: {
        kind: "agency",
        messageHe: `לקו ${input.line} יש כמה מפעילים. איזה מפעיל?`,
        options: agencies,
      },
    };
  }

  const directions = uniqueSorted(
    candidates.map((c) => c.direction).filter(Boolean),
  );
  const dirHint = (input.direction ?? "").trim();
  if (!dirHint && directions.length > 1) {
    return {
      ok: false,
      kind: "ambiguous",
      ambiguity: {
        kind: "direction",
        messageHe: `לקו ${input.line} יש כמה כיוונים. לאיזה כיוון?`,
        options: directions,
      },
    };
  }
  if (dirHint) {
    const byDir = candidates.filter(
      (c) =>
        !c.direction ||
        c.direction === dirHint ||
        c.direction.includes(dirHint),
    );
    candidates = byDir.length > 0 ? byDir : candidates;
  }

  const routeIds = [...new Set(candidates.map((c) => c.feedRouteId))];

  // Stops that have a trip for this line on the service date (default today).
  const stopRows = await prisma.$queryRawUnsafe<
    Array<{
      feed_stop_id: string;
      stop_code: string;
      name: string;
      lat: number;
      lon: number;
      location_type: number;
    }>
  >(
    `SELECT DISTINCT s.feed_stop_id, s.stop_code, s.name, s.lat, s.lon, s.location_type
     FROM "GtfsStopTimes" st
     INNER JOIN "GtfsTrips" t
       ON t.generation_id = st.generation_id AND t.feed_trip_id = st.feed_trip_id
     INNER JOIN "GtfsStops" s
       ON s.generation_id = st.generation_id AND s.feed_stop_id = st.feed_stop_id
     WHERE st.generation_id = $1::uuid
       AND t.service_id = $2
       AND t.feed_route_id = ANY($3::text[])
       AND s.location_type = 0`,
    generationId,
    serviceKey,
    routeIds,
  );

  if (stopRows.length === 0) {
    return {
      ok: false,
      kind: "empty",
      messageHe: `לא מצאתי תחנות לקו ${input.line} עם שירות ב־${serviceDateIso}.`,
    };
  }

  const scored = stopRows
    .map((s) => ({
      stopCode: s.stop_code,
      stopName: s.name,
      distanceMeters: Math.round(
        haversineMeters(input.lat, input.lng, s.lat, s.lon),
      ),
      line: input.line,
      directionLabel: dirHint || candidates[0]?.direction || "",
      agencyName: candidates[0]?.agencyName || "",
    }))
    .filter((s) => s.distanceMeters <= maxDist)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  // Dedupe by stop_code (platforms share code) keeping nearest.
  const seen = new Set<string>();
  const unique: GtfsNearbyStop[] = [];
  for (const s of scored) {
    if (seen.has(s.stopCode)) continue;
    seen.add(s.stopCode);
    unique.push(s);
    if (unique.length >= limit) break;
  }

  if (unique.length === 0) {
    return {
      ok: false,
      kind: "empty",
      messageHe: `לא מצאתי תחנה קרובה לקו ${input.line} בטווח ${maxDist} מ׳.`,
    };
  }

  return {
    ok: true,
    sourceHe: GTFS_OFFICIAL_SOURCE_HE,
    stops: unique,
  };
}

export function formatScheduleHebrew(
  result: Extract<ScheduleQueryResult, { ok: true }>,
): string {
  const lines = result.departures.map((d) => {
    const dir =
      d.headsign || d.directionLabel
        ? ` לכיוון ${d.headsign || d.directionLabel}`
        : "";
    return `• ${d.departureTime} קו ${d.line}${dir} (${d.agencyName}) — תחנה ${d.stopName} [${d.stopCode}]`;
  });
  return [
    `יציאות מתוזמנות (${result.departures[0]?.serviceDate ?? ""}):`,
    ...lines,
    result.sourceHe,
  ].join("\n");
}

export function formatNearestStopHebrew(
  result: Extract<NearestStopQueryResult, { ok: true }>,
): string {
  const lines = result.stops.map(
    (s) =>
      `• ${s.stopName} [${s.stopCode}] — ${s.distanceMeters} מ׳ (קו ${s.line}${
        s.directionLabel ? ` כיוון ${s.directionLabel}` : ""
      }${s.agencyName ? `, ${s.agencyName}` : ""})`,
  );
  return [
    "התחנות הקרובות לקו המבוקש:",
    ...lines,
    result.sourceHe,
  ].join("\n");
}

export function formatAmbiguityHebrew(ambiguity: GtfsAmbiguity): string {
  return `${ambiguity.messageHe}\n${ambiguity.options.map((o) => `• ${o}`).join("\n")}`;
}
