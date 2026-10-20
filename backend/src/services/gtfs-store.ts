/**
 * MOT Israel GTFS → local SQLite (node:sqlite).
 * Data lives under .data/gtfs/ (gitignored).
 *
 * Large files (especially stop_times.txt ~1GB) are streamed line-by-line.
 * Import writes to mot.sqlite.tmp then renames so chat never opens a half-built DB.
 */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "fs";
import { createInterface } from "readline";
import { dirname, join } from "path";
import { pipeline } from "stream/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { Readable } from "stream";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

export const GTFS_ZIP_URL =
  "https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip";

const META_KEY_IMPORTED_AT = "imported_at";
const STALE_MS = 24 * 60 * 60 * 1000;
const STREAM_COMMIT_EVERY = 20_000;

export type GtfsPaths = {
  rootDir: string;
  zipPath: string;
  extractDir: string;
  dbPath: string;
};

let syncInFlight: Promise<void> | null = null;
let lastSyncError: string | null = null;
let openDb: DatabaseSync | null = null;
let openDbPath: string | null = null;

export function defaultGtfsPaths(root = process.cwd()): GtfsPaths {
  const rootDir = join(root, ".data", "gtfs");
  return {
    rootDir,
    zipPath: join(rootDir, "israel-public-transportation.zip"),
    extractDir: join(rootDir, "raw"),
    dbPath: join(rootDir, "mot.sqlite"),
  };
}

/** Repo-root relative to backend package when running from backend/. */
export function resolveRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // backend/src/services → repo root
  return join(here, "..", "..", "..");
}

export function getLastGtfsSyncError(): string | null {
  return lastSyncError;
}

function closeOpenDbIf(path: string): void {
  if (openDb && openDbPath === path) {
    try {
      openDb.close();
    } catch {
      /* ignore */
    }
    openDb = null;
    openDbPath = null;
  }
}

function stopTimesCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM stop_times")
    .get() as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

/** Ready = imported_at fresh AND stop_times populated. */
export function isGtfsDbFresh(dbPath: string, now = Date.now()): boolean {
  if (!existsSync(dbPath)) {
    return false;
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(META_KEY_IMPORTED_AT) as { value?: string } | undefined;
      const imported = Number(row?.value ?? 0);
      if (!Number.isFinite(imported) || imported <= 0) {
        return false;
      }
      if (now - imported >= STALE_MS) {
        return false;
      }
      return stopTimesCount(db) > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export function parseCsvLine(line: string): string[] {
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
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function colIndex(headers: string[], name: string): number {
  const i = headers.indexOf(name);
  if (i < 0) {
    throw new Error(`gtfs csv missing column ${name}`);
  }
  return i;
}

async function downloadZip(url: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`gtfs download HTTP ${res.status}`);
  }
  const tmp = `${dest}.part`;
  const file = createWriteStream(tmp);
  const nodeStream =
    typeof Readable.fromWeb === "function"
      ? Readable.fromWeb(res.body as import("stream/web").ReadableStream)
      : Readable.from(res.body as unknown as AsyncIterable<Uint8Array>);
  await pipeline(nodeStream, file);
  renameSync(tmp, dest);
}

async function unzipTo(zipPath: string, extractDir: string): Promise<void> {
  mkdirSync(extractDir, { recursive: true });
  await execFileAsync("unzip", ["-o", "-q", zipPath, "-d", extractDir]);
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = OFF;
    DROP TABLE IF EXISTS meta;
    DROP TABLE IF EXISTS agency;
    DROP TABLE IF EXISTS stops;
    DROP TABLE IF EXISTS routes;
    DROP TABLE IF EXISTS trips;
    DROP TABLE IF EXISTS stop_times;
    DROP TABLE IF EXISTS calendar;
    DROP TABLE IF EXISTS calendar_dates;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE agency (
      agency_id TEXT PRIMARY KEY,
      agency_name TEXT NOT NULL
    );
    CREATE TABLE stops (
      stop_id TEXT PRIMARY KEY,
      stop_code TEXT,
      stop_name TEXT NOT NULL,
      stop_desc TEXT,
      stop_lat REAL,
      stop_lon REAL
    );
    CREATE TABLE routes (
      route_id TEXT PRIMARY KEY,
      agency_id TEXT,
      route_short_name TEXT NOT NULL,
      route_long_name TEXT,
      route_desc TEXT,
      route_type INTEGER
    );
    CREATE TABLE trips (
      trip_id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      trip_headsign TEXT,
      direction_id TEXT
    );
    CREATE TABLE stop_times (
      trip_id TEXT NOT NULL,
      stop_id TEXT NOT NULL,
      arrival_time TEXT,
      departure_time TEXT NOT NULL,
      stop_sequence INTEGER
    );
    CREATE TABLE calendar (
      service_id TEXT PRIMARY KEY,
      monday INTEGER, tuesday INTEGER, wednesday INTEGER, thursday INTEGER,
      friday INTEGER, saturday INTEGER, sunday INTEGER,
      start_date TEXT, end_date TEXT
    );
    CREATE TABLE calendar_dates (
      service_id TEXT NOT NULL,
      date TEXT NOT NULL,
      exception_type INTEGER NOT NULL
    );
  `);
}

/**
 * Stream a GTFS CSV into SQLite without loading the whole file into memory.
 */
export async function importTableStreaming(
  db: DatabaseSync,
  filePath: string,
  insertSql: string,
  mapRow: (headers: string[], row: string[]) => unknown[] | null,
): Promise<number> {
  if (!existsSync(filePath)) {
    return 0;
  }
  const stmt = db.prepare(insertSql);
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let headers: string[] | null = null;
  let inserted = 0;
  let inTx = false;
  const begin = () => {
    db.exec("BEGIN");
    inTx = true;
  };
  const commit = () => {
    if (inTx) {
      db.exec("COMMIT");
      inTx = false;
    }
  };
  try {
    begin();
    for await (const line of rl) {
      if (!line) {
        continue;
      }
      if (!headers) {
        headers = parseCsvLine(line).map((h) => h.trim());
        continue;
      }
      const mapped = mapRow(headers, parseCsvLine(line));
      if (!mapped) {
        continue;
      }
      stmt.run(...mapped);
      inserted += 1;
      if (inserted % STREAM_COMMIT_EVERY === 0) {
        commit();
        begin();
      }
    }
    commit();
  } catch (error) {
    if (inTx) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
    }
    throw error;
  } finally {
    rl.close();
  }
  return inserted;
}

function createIndexes(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_routes_short ON routes(route_short_name);
    CREATE INDEX IF NOT EXISTS idx_stops_name ON stops(stop_name);
    CREATE INDEX IF NOT EXISTS idx_trips_route ON trips(route_id);
    CREATE INDEX IF NOT EXISTS idx_trips_service ON trips(service_id);
    CREATE INDEX IF NOT EXISTS idx_stop_times_stop ON stop_times(stop_id);
    CREATE INDEX IF NOT EXISTS idx_stop_times_trip ON stop_times(trip_id);
    CREATE INDEX IF NOT EXISTS idx_stop_times_dep ON stop_times(departure_time);
    CREATE INDEX IF NOT EXISTS idx_cal_dates ON calendar_dates(service_id, date);
  `);
}

/**
 * Import extracted GTFS into SQLite atomically (tmp → rename).
 */
export async function importGtfsFromExtract(
  extractDir: string,
  dbPath: string,
): Promise<void> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const tmpPath = `${dbPath}.tmp`;
  closeOpenDbIf(dbPath);
  closeOpenDbIf(tmpPath);
  if (existsSync(tmpPath)) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }

  const db = new DatabaseSync(tmpPath);
  try {
    createSchema(db);
    await importTableStreaming(
      db,
      join(extractDir, "agency.txt"),
      "INSERT OR REPLACE INTO agency(agency_id, agency_name) VALUES (?, ?)",
      (h, row) => {
        const id = row[colIndex(h, "agency_id")] ?? "";
        const name = row[colIndex(h, "agency_name")] ?? "";
        if (!id) return null;
        return [id, name];
      },
    );
    await importTableStreaming(
      db,
      join(extractDir, "stops.txt"),
      "INSERT OR REPLACE INTO stops(stop_id, stop_code, stop_name, stop_desc, stop_lat, stop_lon) VALUES (?, ?, ?, ?, ?, ?)",
      (h, row) => {
        const stop_id = row[colIndex(h, "stop_id")] ?? "";
        const stop_name = row[colIndex(h, "stop_name")] ?? "";
        if (!stop_id || !stop_name) return null;
        const stop_code = h.includes("stop_code")
          ? (row[colIndex(h, "stop_code")] ?? "")
          : "";
        const stop_desc = h.includes("stop_desc")
          ? (row[colIndex(h, "stop_desc")] ?? "")
          : "";
        const stop_lat = h.includes("stop_lat")
          ? Number(row[colIndex(h, "stop_lat")] ?? "")
          : null;
        const stop_lon = h.includes("stop_lon")
          ? Number(row[colIndex(h, "stop_lon")] ?? "")
          : null;
        return [
          stop_id,
          stop_code,
          stop_name,
          stop_desc,
          Number.isFinite(stop_lat) ? stop_lat : null,
          Number.isFinite(stop_lon) ? stop_lon : null,
        ];
      },
    );
    await importTableStreaming(
      db,
      join(extractDir, "routes.txt"),
      "INSERT OR REPLACE INTO routes(route_id, agency_id, route_short_name, route_long_name, route_desc, route_type) VALUES (?, ?, ?, ?, ?, ?)",
      (h, row) => {
        const route_id = row[colIndex(h, "route_id")] ?? "";
        const short = row[colIndex(h, "route_short_name")] ?? "";
        if (!route_id || !short) return null;
        return [
          route_id,
          h.includes("agency_id") ? (row[colIndex(h, "agency_id")] ?? "") : "",
          short,
          h.includes("route_long_name")
            ? (row[colIndex(h, "route_long_name")] ?? "")
            : "",
          h.includes("route_desc") ? (row[colIndex(h, "route_desc")] ?? "") : "",
          h.includes("route_type")
            ? Number(row[colIndex(h, "route_type")] ?? 3)
            : 3,
        ];
      },
    );
    await importTableStreaming(
      db,
      join(extractDir, "trips.txt"),
      "INSERT OR REPLACE INTO trips(trip_id, route_id, service_id, trip_headsign, direction_id) VALUES (?, ?, ?, ?, ?)",
      (h, row) => {
        const trip_id = row[colIndex(h, "trip_id")] ?? "";
        const route_id = row[colIndex(h, "route_id")] ?? "";
        const service_id = row[colIndex(h, "service_id")] ?? "";
        if (!trip_id || !route_id || !service_id) return null;
        return [
          trip_id,
          route_id,
          service_id,
          h.includes("trip_headsign")
            ? (row[colIndex(h, "trip_headsign")] ?? "")
            : "",
          h.includes("direction_id")
            ? (row[colIndex(h, "direction_id")] ?? "")
            : "",
        ];
      },
    );
    const stopTimesInserted = await importTableStreaming(
      db,
      join(extractDir, "stop_times.txt"),
      "INSERT INTO stop_times(trip_id, stop_id, arrival_time, departure_time, stop_sequence) VALUES (?, ?, ?, ?, ?)",
      (h, row) => {
        const trip_id = row[colIndex(h, "trip_id")] ?? "";
        const stop_id = row[colIndex(h, "stop_id")] ?? "";
        const departure_time = row[colIndex(h, "departure_time")] ?? "";
        if (!trip_id || !stop_id || !departure_time) return null;
        return [
          trip_id,
          stop_id,
          h.includes("arrival_time")
            ? (row[colIndex(h, "arrival_time")] ?? departure_time)
            : departure_time,
          departure_time,
          h.includes("stop_sequence")
            ? Number(row[colIndex(h, "stop_sequence")] ?? 0)
            : 0,
        ];
      },
    );
    if (stopTimesInserted <= 0) {
      throw new Error("gtfs stop_times import produced 0 rows");
    }
    await importTableStreaming(
      db,
      join(extractDir, "calendar.txt"),
      "INSERT OR REPLACE INTO calendar(service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      (h, row) => {
        const service_id = row[colIndex(h, "service_id")] ?? "";
        if (!service_id) return null;
        return [
          service_id,
          Number(row[colIndex(h, "monday")] ?? 0),
          Number(row[colIndex(h, "tuesday")] ?? 0),
          Number(row[colIndex(h, "wednesday")] ?? 0),
          Number(row[colIndex(h, "thursday")] ?? 0),
          Number(row[colIndex(h, "friday")] ?? 0),
          Number(row[colIndex(h, "saturday")] ?? 0),
          Number(row[colIndex(h, "sunday")] ?? 0),
          row[colIndex(h, "start_date")] ?? "",
          row[colIndex(h, "end_date")] ?? "",
        ];
      },
    );
    await importTableStreaming(
      db,
      join(extractDir, "calendar_dates.txt"),
      "INSERT INTO calendar_dates(service_id, date, exception_type) VALUES (?, ?, ?)",
      (h, row) => {
        const service_id = row[colIndex(h, "service_id")] ?? "";
        const date = row[colIndex(h, "date")] ?? "";
        if (!service_id || !date) return null;
        return [
          service_id,
          date,
          Number(row[colIndex(h, "exception_type")] ?? 1),
        ];
      },
    );
    createIndexes(db);
    db.prepare(
      "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
    ).run(META_KEY_IMPORTED_AT, String(Date.now()));
  } finally {
    db.close();
  }

  // Publish atomically.
  if (existsSync(dbPath)) {
    try {
      unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
  // Drop leftover WAL/SHM from previous db if any.
  for (const suffix of ["-wal", "-shm"]) {
    const side = `${dbPath}${suffix}`;
    if (existsSync(side)) {
      try {
        unlinkSync(side);
      } catch {
        /* ignore */
      }
    }
  }
  renameSync(tmpPath, dbPath);
}

/** Build a tiny fixture DB for unit tests. */
export function buildFixtureGtfsDb(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  if (existsSync(dbPath)) {
    unlinkSync(dbPath);
  }
  const db = new DatabaseSync(dbPath);
  try {
    createSchema(db);
    db.prepare(
      "INSERT INTO agency(agency_id, agency_name) VALUES (?, ?)",
    ).run("1", "דן");
    db.prepare(
      "INSERT INTO routes(route_id, agency_id, route_short_name, route_long_name, route_desc, route_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "r51",
      "1",
      "51",
      "מסוף משה ארנס-פתח תקווה<->ת.מרכזית תל אביב",
      "",
      3,
    );
    db.prepare(
      "INSERT INTO stops(stop_id, stop_code, stop_name, stop_desc, stop_lat, stop_lon) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("s1", "33599", "מסוף משה ארנס/רציפים", "פתח תקווה", 32.1, 34.9);
    db.prepare(
      "INSERT INTO stops(stop_id, stop_code, stop_name, stop_desc, stop_lat, stop_lon) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "s2",
      "36496",
      "תחנה מרכזית פתח תקווה",
      "פתח תקווה",
      32.09,
      34.88,
    );
    db.prepare(
      `INSERT INTO calendar(service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
       VALUES (?,1,1,1,1,1,1,1,?,?)`,
    ).run("svc", "20200101", "20301231");
    db.prepare(
      "INSERT INTO trips(trip_id, route_id, service_id, trip_headsign, direction_id) VALUES (?, ?, ?, ?, ?)",
    ).run("t1", "r51", "svc", "תל אביב", "0");
    db.prepare(
      "INSERT INTO stop_times(trip_id, stop_id, arrival_time, departure_time, stop_sequence) VALUES (?, ?, ?, ?, ?)",
    ).run("t1", "s1", "15:10:00", "15:10:00", 1);
    db.prepare(
      "INSERT INTO stop_times(trip_id, stop_id, arrival_time, departure_time, stop_sequence) VALUES (?, ?, ?, ?, ?)",
    ).run("t1", "s2", "15:20:00", "15:20:00", 2);
    db.prepare(
      "INSERT INTO trips(trip_id, route_id, service_id, trip_headsign, direction_id) VALUES (?, ?, ?, ?, ?)",
    ).run("t2", "r51", "svc", "תל אביב", "0");
    db.prepare(
      "INSERT INTO stop_times(trip_id, stop_id, arrival_time, departure_time, stop_sequence) VALUES (?, ?, ?, ?, ?)",
    ).run("t2", "s1", "16:05:00", "16:05:00", 1);
    createIndexes(db);
    db.prepare(
      "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
    ).run(META_KEY_IMPORTED_AT, String(Date.now()));
  } finally {
    db.close();
  }
}

export async function syncMotGtfs(
  paths: GtfsPaths,
  opts?: { skipDownloadIfPresent?: boolean },
): Promise<void> {
  mkdirSync(paths.rootDir, { recursive: true });
  const skipDl =
    opts?.skipDownloadIfPresent === true &&
    existsSync(paths.zipPath) &&
    existsSync(join(paths.extractDir, "stop_times.txt"));
  if (!skipDl) {
    await downloadZip(GTFS_ZIP_URL, paths.zipPath);
    await unzipTo(paths.zipPath, paths.extractDir);
  } else if (!existsSync(join(paths.extractDir, "stop_times.txt"))) {
    await unzipTo(paths.zipPath, paths.extractDir);
  }
  await importGtfsFromExtract(paths.extractDir, paths.dbPath);
  closeOpenDbIf(paths.dbPath);
  lastSyncError = null;
}

export function getOpenGtfsDb(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath) || !isGtfsDbFresh(dbPath)) {
    return null;
  }
  if (openDb && openDbPath === dbPath) {
    return openDb;
  }
  if (openDb) {
    try {
      openDb.close();
    } catch {
      /* ignore */
    }
  }
  openDb = new DatabaseSync(dbPath, { readOnly: true });
  openDbPath = dbPath;
  return openDb;
}

/**
 * Ensure a fresh GTFS DB exists. If missing/stale, start sync (awaits).
 * Concurrent callers share one in-flight sync.
 */
export async function ensureGtfsDb(paths: GtfsPaths): Promise<"ready" | "syncing"> {
  if (isGtfsDbFresh(paths.dbPath)) {
    return "ready";
  }
  if (syncInFlight) {
    return "syncing";
  }
  lastSyncError = null;
  syncInFlight = syncMotGtfs(paths, { skipDownloadIfPresent: true })
    .catch((error) => {
      lastSyncError =
        error instanceof Error ? error.message : "gtfs sync failed";
      console.error("gtfs sync failed", error);
      throw error;
    })
    .finally(() => {
      syncInFlight = null;
    });
  await syncInFlight;
  return "ready";
}

/** Kick off sync without awaiting (for chat when DB missing). */
export function startGtfsSyncIfNeeded(paths: GtfsPaths): boolean {
  if (isGtfsDbFresh(paths.dbPath)) {
    return false;
  }
  if (syncInFlight) {
    return true;
  }
  lastSyncError = null;
  syncInFlight = syncMotGtfs(paths, { skipDownloadIfPresent: true })
    .catch((error) => {
      lastSyncError =
        error instanceof Error ? error.message : "gtfs sync failed";
      console.error("gtfs sync failed", error);
    })
    .finally(() => {
      syncInFlight = null;
    });
  return true;
}

export function isGtfsSyncInFlight(): boolean {
  return syncInFlight != null;
}
