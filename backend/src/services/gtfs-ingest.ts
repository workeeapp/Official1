/**
 * Generation-scoped MOT GTFS ingest: stage → validate → activate | fail.
 * Incomplete staging never becomes active. Queries read status=active only.
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { assertApprovedEvalDatabaseUrl } from "../eval/studio-db-guard.js";
import { gtfsTimeToSeconds } from "./gtfs-time.js";

export type GtfsGenerationStatus =
  | "staging"
  | "active"
  | "retired"
  | "failed";

export class GtfsIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GtfsIngestError";
  }
}

export type GtfsIngestCounts = {
  agencies: number;
  stops: number;
  routes: number;
  routeNetworks: number;
  trips: number;
  stopTimes: number;
  calendarDates: number;
};

export type GtfsValidateThresholds = {
  minAgencies: number;
  minStops: number;
  minRoutes: number;
  minTrips: number;
  minStopTimes: number;
  minCalendarDates: number;
};

export const DEFAULT_GTFS_VALIDATE_THRESHOLDS: GtfsValidateThresholds = {
  minAgencies: 1,
  minStops: 1,
  minRoutes: 1,
  minTrips: 1,
  minStopTimes: 1,
  minCalendarDates: 1,
};

const BATCH = 500;

/** Fail closed before any write when an approved URL is configured for eval. */
export function assertGtfsWriteDatabaseUrl(): void {
  const approved = process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
  if (typeof approved === "string" && approved.trim() !== "") {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  }
}

export async function createStagingGeneration(
  prisma: PrismaClient,
  input: { sourceLabel?: string },
): Promise<string> {
  assertGtfsWriteDatabaseUrl();
  const row = await prisma.gtfsFeedGeneration.create({
    data: {
      status: "staging",
      sourceLabel: input.sourceLabel?.slice(0, 255) ?? null,
    },
  });
  return row.id;
}

export async function markGenerationFailed(
  prisma: PrismaClient,
  generationId: string,
  errorMessage: string,
): Promise<void> {
  assertGtfsWriteDatabaseUrl();
  await prisma.gtfsFeedGeneration.updateMany({
    where: { id: generationId, status: "staging" },
    data: {
      status: "failed",
      errorMessage: errorMessage.slice(0, 4000),
    },
  });
}

/**
 * Atomic activation: prior active → retired; staging → active.
 * Refuses non-staging rows.
 */
export async function activateGeneration(
  prisma: PrismaClient,
  generationId: string,
): Promise<void> {
  assertGtfsWriteDatabaseUrl();
  await prisma.$transaction(async (tx) => {
    const staging = await tx.gtfsFeedGeneration.findUnique({
      where: { id: generationId },
    });
    if (!staging || staging.status !== "staging") {
      throw new GtfsIngestError(
        `generation ${generationId} is not staging; refusing activation`,
      );
    }
    await tx.gtfsFeedGeneration.updateMany({
      where: { status: "active" },
      data: { status: "retired" },
    });
    const updated = await tx.gtfsFeedGeneration.updateMany({
      where: { id: generationId, status: "staging" },
      data: { status: "active", activatedAt: new Date(), errorMessage: null },
    });
    if (updated.count !== 1) {
      throw new GtfsIngestError(
        "activation race: staging row missing; refusing",
      );
    }
  });
}

export async function countGenerationRows(
  prisma: PrismaClient,
  generationId: string,
): Promise<GtfsIngestCounts> {
  const [
    agencies,
    stops,
    routes,
    routeNetworks,
    trips,
    stopTimes,
    calendarDates,
  ] = await Promise.all([
    prisma.gtfsAgency.count({ where: { generationId } }),
    prisma.gtfsStop.count({ where: { generationId } }),
    prisma.gtfsRoute.count({ where: { generationId } }),
    prisma.gtfsRouteNetwork.count({ where: { generationId } }),
    prisma.gtfsTrip.count({ where: { generationId } }),
    prisma.gtfsStopTime.count({ where: { generationId } }),
    prisma.gtfsCalendarDate.count({ where: { generationId } }),
  ]);
  return {
    agencies,
    stops,
    routes,
    routeNetworks,
    trips,
    stopTimes,
    calendarDates,
  };
}

export async function validateStagingGeneration(
  prisma: PrismaClient,
  generationId: string,
  thresholds: GtfsValidateThresholds = DEFAULT_GTFS_VALIDATE_THRESHOLDS,
): Promise<GtfsIngestCounts> {
  const gen = await prisma.gtfsFeedGeneration.findUnique({
    where: { id: generationId },
  });
  if (!gen || gen.status !== "staging") {
    throw new GtfsIngestError("validate requires a staging generation");
  }
  const counts = await countGenerationRows(prisma, generationId);
  const failures: string[] = [];
  if (counts.agencies < thresholds.minAgencies) {
    failures.push(`agencies ${counts.agencies} < ${thresholds.minAgencies}`);
  }
  if (counts.stops < thresholds.minStops) {
    failures.push(`stops ${counts.stops} < ${thresholds.minStops}`);
  }
  if (counts.routes < thresholds.minRoutes) {
    failures.push(`routes ${counts.routes} < ${thresholds.minRoutes}`);
  }
  if (counts.trips < thresholds.minTrips) {
    failures.push(`trips ${counts.trips} < ${thresholds.minTrips}`);
  }
  if (counts.stopTimes < thresholds.minStopTimes) {
    failures.push(
      `stop_times ${counts.stopTimes} < ${thresholds.minStopTimes}`,
    );
  }
  if (counts.calendarDates < thresholds.minCalendarDates) {
    failures.push(
      `calendar_dates ${counts.calendarDates} < ${thresholds.minCalendarDates}`,
    );
  }

  // Orphan stop_times: trip_id not in trips (sample via raw anti-join limit).
  const orphans = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
    `SELECT COUNT(*)::bigint AS c FROM "GtfsStopTimes" st
     WHERE st.generation_id = $1::uuid
       AND NOT EXISTS (
         SELECT 1 FROM "GtfsTrips" t
         WHERE t.generation_id = st.generation_id
           AND t.feed_trip_id = st.feed_trip_id
       )`,
    generationId,
  );
  const orphanCount = Number(orphans[0]?.c ?? 0);
  if (orphanCount > 0) {
    failures.push(`orphan stop_times trip_ids: ${orphanCount}`);
  }

  // At least one boarding stop (location_type 0) with a stop_code.
  const boarding = await prisma.gtfsStop.count({
    where: { generationId, locationType: 0, stopCode: { not: "" } },
  });
  if (boarding < 1) {
    failures.push("no boarding stops with stop_code");
  }

  if (failures.length > 0) {
    throw new GtfsIngestError(`validation failed: ${failures.join("; ")}`);
  }
  return counts;
}

export type GtfsParsedFeed = {
  feedStartDate?: string;
  feedEndDate?: string;
  agencies: Array<{ agencyId: string; name: string }>;
  stops: Array<{
    feedStopId: string;
    stopCode: string;
    name: string;
    lat: number;
    lon: number;
    locationType: number;
    parentFeedStopId: string | null;
  }>;
  routes: Array<{
    feedRouteId: string;
    agencyId: string;
    shortName: string;
    longName: string;
  }>;
  routeNetworks: Array<{
    feedRouteId: string;
    officeLineId: string;
    lineId: string;
    direction: string;
    agencyId: string;
    agencyName: string;
  }>;
  trips: Array<{
    feedTripId: string;
    feedRouteId: string;
    serviceId: string;
    directionId: number | null;
    headsign: string;
  }>;
  stopTimes: Array<{
    feedTripId: string;
    stopSequence: number;
    feedStopId: string;
    arrivalTime: string;
    departureTime: string;
    depSeconds: number;
  }>;
  calendarDates: Array<{
    serviceId: string;
    date: string;
    exceptionType: number;
  }>;
};

async function insertBatched<T>(
  rows: T[],
  write: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    await write(rows.slice(i, i + BATCH));
  }
}

/** Persist a fully parsed feed into an existing staging generation. */
export async function loadParsedFeedIntoStaging(
  prisma: PrismaClient,
  generationId: string,
  feed: GtfsParsedFeed,
): Promise<void> {
  assertGtfsWriteDatabaseUrl();
  const gen = await prisma.gtfsFeedGeneration.findUnique({
    where: { id: generationId },
  });
  if (!gen || gen.status !== "staging") {
    throw new GtfsIngestError("load requires staging generation");
  }

  if (feed.feedStartDate || feed.feedEndDate) {
    await prisma.gtfsFeedGeneration.update({
      where: { id: generationId },
      data: {
        feedStartDate: feed.feedStartDate ?? null,
        feedEndDate: feed.feedEndDate ?? null,
      },
    });
  }

  await insertBatched(feed.agencies, (chunk) =>
    prisma.gtfsAgency.createMany({
      data: chunk.map((a) => ({
        generationId,
        agencyId: a.agencyId,
        name: a.name,
      })),
      skipDuplicates: true,
    }),
  );
  await insertBatched(feed.stops, (chunk) =>
    prisma.gtfsStop.createMany({
      data: chunk.map((s) => ({
        generationId,
        feedStopId: s.feedStopId,
        stopCode: s.stopCode,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        locationType: s.locationType,
        parentFeedStopId: s.parentFeedStopId,
      })),
      skipDuplicates: true,
    }),
  );
  await insertBatched(feed.routes, (chunk) =>
    prisma.gtfsRoute.createMany({
      data: chunk.map((r) => ({
        generationId,
        feedRouteId: r.feedRouteId,
        agencyId: r.agencyId,
        shortName: r.shortName,
        longName: r.longName,
      })),
      skipDuplicates: true,
    }),
  );
  await insertBatched(feed.routeNetworks, (chunk) =>
    prisma.gtfsRouteNetwork.createMany({
      data: chunk.map((n) => ({
        id: randomUUID(),
        generationId,
        feedRouteId: n.feedRouteId,
        officeLineId: n.officeLineId,
        lineId: n.lineId,
        direction: n.direction,
        agencyId: n.agencyId,
        agencyName: n.agencyName,
      })),
    }),
  );
  await insertBatched(feed.trips, (chunk) =>
    prisma.gtfsTrip.createMany({
      data: chunk.map((t) => ({
        generationId,
        feedTripId: t.feedTripId,
        feedRouteId: t.feedRouteId,
        serviceId: t.serviceId,
        directionId: t.directionId,
        headsign: t.headsign,
      })),
      skipDuplicates: true,
    }),
  );
  await insertBatched(feed.stopTimes, (chunk) =>
    prisma.gtfsStopTime.createMany({
      data: chunk.map((st) => ({
        generationId,
        feedTripId: st.feedTripId,
        stopSequence: st.stopSequence,
        feedStopId: st.feedStopId,
        arrivalTime: st.arrivalTime,
        departureTime: st.departureTime,
        depSeconds: st.depSeconds,
      })),
      skipDuplicates: true,
    }),
  );
  await insertBatched(feed.calendarDates, (chunk) =>
    prisma.gtfsCalendarDate.createMany({
      data: chunk.map((c) => ({
        generationId,
        serviceId: c.serviceId,
        date: c.date,
        exceptionType: c.exceptionType,
      })),
      skipDuplicates: true,
    }),
  );
}

/**
 * Stage + validate + activate a parsed feed. On validation/load failure marks
 * staging as failed and leaves any prior active generation untouched.
 */
export async function ingestParsedFeed(
  prisma: PrismaClient,
  feed: GtfsParsedFeed,
  options?: {
    sourceLabel?: string;
    thresholds?: GtfsValidateThresholds;
    activate?: boolean;
  },
): Promise<{ generationId: string; counts: GtfsIngestCounts }> {
  assertGtfsWriteDatabaseUrl();
  const generationId = await createStagingGeneration(prisma, {
    sourceLabel: options?.sourceLabel,
  });
  try {
    await loadParsedFeedIntoStaging(prisma, generationId, feed);
    const counts = await validateStagingGeneration(
      prisma,
      generationId,
      options?.thresholds ?? DEFAULT_GTFS_VALIDATE_THRESHOLDS,
    );
    if (options?.activate !== false) {
      await activateGeneration(prisma, generationId);
    }
    return { generationId, counts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markGenerationFailed(prisma, generationId, message);
    throw err;
  }
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function readCsvRecords(
  filePath: string,
): Promise<{ header: string[]; rows: string[][] }> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let header: string[] | null = null;
  const rows: string[][] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line.replace(/^\uFEFF/, ""));
    if (!header) {
      header = cols.map((h) => h.trim());
      continue;
    }
    rows.push(cols);
  }
  if (!header) {
    throw new GtfsIngestError(`empty CSV: ${filePath}`);
  }
  return { header, rows };
}

function col(header: string[], row: string[], name: string): string {
  const i = header.indexOf(name);
  if (i < 0) return "";
  return (row[i] ?? "").trim();
}

/** Normalize YYYY-MM-DD or YYYYMMDD → YYYYMMDD; empty if invalid. */
export function normalizeGtfsServiceDateKey(raw: string): string {
  const s = String(raw ?? "").trim();
  if (/^\d{8}$/.test(s)) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  return "";
}

export type ParseGtfsDirectoryOptions = {
  routeNetworksPath?: string;
  /** Hard cap (tests/spikes only). Prefer serviceDate for coherent day slices. */
  maxStopTimes?: number;
  /**
   * Keep nationwide agencies/stops/routes/networks, but only trips (and their
   * full stop_times) whose service_id is active on this calendar date
   * (MOT: typically service_id === YYYYMMDD). Fail closed if the date is absent.
   */
  serviceDate?: string;
};

/**
 * Load GTFS + optional RouteNetworks from a directory.
 * Full 10-day OK when serviceDate omitted; day slice when serviceDate set.
 */
export async function parseGtfsDirectory(
  feedDir: string,
  options?: ParseGtfsDirectoryOptions,
): Promise<GtfsParsedFeed> {
  const dir = resolve(feedDir);
  const serviceDateKey = options?.serviceDate
    ? normalizeGtfsServiceDateKey(options.serviceDate)
    : "";
  if (options?.serviceDate && !serviceDateKey) {
    throw new GtfsIngestError(
      `invalid --service-date «${options.serviceDate}» (use YYYYMMDD or YYYY-MM-DD)`,
    );
  }

  const feedInfo = await readCsvRecords(resolve(dir, "feed_info.txt")).catch(
    () => null,
  );
  let feedStartDate = feedInfo
    ? col(feedInfo.header, feedInfo.rows[0] ?? [], "feed_start_date")
    : undefined;
  let feedEndDate = feedInfo
    ? col(feedInfo.header, feedInfo.rows[0] ?? [], "feed_end_date")
    : undefined;

  const agencyFile = await readCsvRecords(resolve(dir, "agency.txt"));
  const agencies = agencyFile.rows.map((row) => ({
    agencyId: col(agencyFile.header, row, "agency_id"),
    name: col(agencyFile.header, row, "agency_name"),
  })).filter((a) => a.agencyId);

  const stopsFile = await readCsvRecords(resolve(dir, "stops.txt"));
  const stops = stopsFile.rows
    .map((row) => {
      const feedStopId = col(stopsFile.header, row, "stop_id");
      const stopCode = col(stopsFile.header, row, "stop_code");
      const lat = Number(col(stopsFile.header, row, "stop_lat"));
      const lon = Number(col(stopsFile.header, row, "stop_lon"));
      const locationType = Number(
        col(stopsFile.header, row, "location_type") || "0",
      );
      const parent = col(stopsFile.header, row, "parent_station") || null;
      return {
        feedStopId,
        stopCode,
        name: col(stopsFile.header, row, "stop_name").slice(0, 255),
        lat: Number.isFinite(lat) ? lat : 0,
        lon: Number.isFinite(lon) ? lon : 0,
        locationType: Number.isFinite(locationType) ? locationType : 0,
        parentFeedStopId: parent,
      };
    })
    .filter((s) => s.feedStopId && s.stopCode);

  const routesFile = await readCsvRecords(resolve(dir, "routes.txt"));
  const routes = routesFile.rows
    .map((row) => ({
      feedRouteId: col(routesFile.header, row, "route_id"),
      agencyId: col(routesFile.header, row, "agency_id"),
      shortName: col(routesFile.header, row, "route_short_name").slice(0, 64),
      longName: col(routesFile.header, row, "route_long_name").slice(0, 255),
    }))
    .filter((r) => r.feedRouteId && r.shortName);

  const calFile = await readCsvRecords(resolve(dir, "calendar_dates.txt"));
  let calendarDates = calFile.rows
    .map((row) => ({
      serviceId: col(calFile.header, row, "service_id"),
      date: col(calFile.header, row, "date"),
      exceptionType: Number(col(calFile.header, row, "exception_type") || "1"),
    }))
    .filter((c) => c.serviceId && c.date);

  let serviceIds: Set<string> | null = null;
  if (serviceDateKey) {
    calendarDates = calendarDates.filter(
      (c) => c.date === serviceDateKey && c.exceptionType === 1,
    );
    if (calendarDates.length === 0) {
      throw new GtfsIngestError(
        `service date ${serviceDateKey} is not present in calendar_dates (exception_type=1)`,
      );
    }
    serviceIds = new Set(calendarDates.map((c) => c.serviceId));
    feedStartDate = serviceDateKey;
    feedEndDate = serviceDateKey;
  }

  const tripsFile = await readCsvRecords(resolve(dir, "trips.txt"));
  let trips = tripsFile.rows
    .map((row) => {
      const dirRaw = col(tripsFile.header, row, "direction_id");
      const directionId =
        dirRaw === "" ? null : Number.isFinite(Number(dirRaw)) ? Number(dirRaw) : null;
      return {
        feedTripId: col(tripsFile.header, row, "trip_id"),
        feedRouteId: col(tripsFile.header, row, "route_id"),
        serviceId: col(tripsFile.header, row, "service_id"),
        directionId,
        headsign: col(tripsFile.header, row, "trip_headsign").slice(0, 255),
      };
    })
    .filter((t) => t.feedTripId && t.feedRouteId && t.serviceId);

  if (serviceIds) {
    trips = trips.filter((t) => serviceIds!.has(t.serviceId));
    if (trips.length === 0) {
      throw new GtfsIngestError(
        `no trips for service date ${serviceDateKey} (service_ids=${[...serviceIds].join(",")})`,
      );
    }
  }

  const tripIdSet = serviceIds
    ? new Set(trips.map((t) => t.feedTripId))
    : null;

  const stopTimes: GtfsParsedFeed["stopTimes"] = [];
  const stPath = resolve(dir, "stop_times.txt");
  const stRl = createInterface({
    input: createReadStream(stPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let stHeader: string[] | null = null;
  for await (const line of stRl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line.replace(/^\uFEFF/, ""));
    if (!stHeader) {
      stHeader = cols.map((h) => h.trim());
      continue;
    }
    const feedTripId = col(stHeader, cols, "trip_id");
    if (tripIdSet && !tripIdSet.has(feedTripId)) continue;
    const departureTime = col(stHeader, cols, "departure_time");
    const depSeconds = gtfsTimeToSeconds(departureTime);
    if (depSeconds == null) continue;
    const feedStopId = col(stHeader, cols, "stop_id");
    const stopSequence = Number(col(stHeader, cols, "stop_sequence"));
    if (!feedTripId || !feedStopId || !Number.isFinite(stopSequence)) continue;
    stopTimes.push({
      feedTripId,
      stopSequence,
      feedStopId,
      arrivalTime: col(stHeader, cols, "arrival_time"),
      departureTime,
      depSeconds,
    });
    if (
      options?.maxStopTimes != null &&
      stopTimes.length >= options.maxStopTimes
    ) {
      break;
    }
  }

  if (tripIdSet && stopTimes.length === 0) {
    throw new GtfsIngestError(
      `no stop_times for service date ${serviceDateKey} after trip filter`,
    );
  }

  let routeNetworks: GtfsParsedFeed["routeNetworks"] = [];
  if (options?.routeNetworksPath) {
    const rn = await readCsvRecords(resolve(options.routeNetworksPath));
    routeNetworks = rn.rows
      .map((row) => ({
        feedRouteId: col(rn.header, row, "RouteId"),
        officeLineId: col(rn.header, row, "OfficeLineId"),
        lineId: col(rn.header, row, "LineId"),
        direction: col(rn.header, row, "Direction"),
        agencyId: col(rn.header, row, "AgencyId"),
        agencyName: col(rn.header, row, "AgencyName").slice(0, 255),
      }))
      .filter((n) => n.feedRouteId);
  }

  return {
    feedStartDate,
    feedEndDate,
    agencies,
    stops,
    routes,
    routeNetworks,
    trips,
    stopTimes,
    calendarDates,
  };
}
