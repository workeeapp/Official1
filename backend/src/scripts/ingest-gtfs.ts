/**
 * Bounded one-shot MOT GTFS ingest into the configured DATABASE_URL.
 *
 * Safety: when WORKEE_APPROVED_TEST_DATABASE_URL is set, refuses unless
 * DATABASE_URL matches exactly (eval isolation). Does not start a scheduler.
 *
 * Usage (repo root, eval env already applied via Node loader or shell):
 *   npx tsx backend/src/scripts/ingest-gtfs.ts --feed-dir <Gtfs_10_days> \
 *     [--route-networks <RouteNetworksByDate.txt>] [--service-date YYYYMMDD] \
 *     [--eval-env] [--no-activate] [--max-stop-times N]
 *
 * --service-date keeps nationwide agencies/stops/routes/networks but only
 * trips (+ full stop_times) active that calendar day. Prefer this over
 * --max-stop-times for coherent validation slices.
 *
 * Kill switch for queries is separate: GTFS_ENABLED=1
 */
import { resolve } from "node:path";
import { prisma } from "../database/prisma.js";
import {
  assertGtfsWriteDatabaseUrl,
  ingestParsedFeed,
  parseGtfsDirectory,
  GtfsIngestError,
} from "../services/gtfs-ingest.js";
import {
  assertApprovedEvalDatabaseUrl,
  evalDatabaseNameFromUrl,
} from "../eval/studio-db-guard.js";
import { loadLiveFullEvalEnv } from "../eval/load-live-full-eval-env.js";

function readArg(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  if (hasFlag("eval-env")) {
    loadLiveFullEvalEnv({ apply: true });
  }

  assertGtfsWriteDatabaseUrl();
  if (process.env.WORKEE_APPROVED_TEST_DATABASE_URL) {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    const name = evalDatabaseNameFromUrl(process.env.DATABASE_URL!);
    const u = new URL(process.env.DATABASE_URL!);
    console.info(
      `ingest_target host=${u.hostname} port=${u.port || "(default)"} db=${name} user=${u.username} (password hidden)`,
    );
  }

  const feedDir = readArg("feed-dir");
  if (!feedDir) {
    throw new Error(
      "Usage: ingest-gtfs --feed-dir <path> [--route-networks <path>] [--service-date YYYYMMDD] [--eval-env] [--no-activate] [--max-stop-times N]",
    );
  }

  const maxRaw = readArg("max-stop-times");
  const maxStopTimes = maxRaw ? Number(maxRaw) : undefined;
  if (maxRaw && (!Number.isFinite(maxStopTimes) || (maxStopTimes ?? 0) < 1)) {
    throw new Error("--max-stop-times must be a positive number");
  }
  const serviceDate = readArg("service-date");

  console.info(
    `parsing feed${serviceDate ? ` (service-date=${serviceDate})` : ""}…`,
  );
  const feed = await parseGtfsDirectory(resolve(feedDir), {
    routeNetworksPath: readArg("route-networks"),
    maxStopTimes,
    serviceDate,
  });
  console.info(
    `parsed agencies=${feed.agencies.length} stops=${feed.stops.length} routes=${feed.routes.length} trips=${feed.trips.length} stop_times=${feed.stopTimes.length} calendar_dates=${feed.calendarDates.length} route_networks=${feed.routeNetworks.length} feed=${feed.feedStartDate ?? "?"}-${feed.feedEndDate ?? "?"}`,
  );

  const sourceLabel = serviceDate
    ? `${resolve(feedDir)}#${serviceDate}`
    : resolve(feedDir);
  const result = await ingestParsedFeed(prisma, feed, {
    sourceLabel,
    activate: !hasFlag("no-activate"),
  });
  console.info(
    `ingest ok generation=${result.generationId} activated=${!hasFlag("no-activate")} counts=${JSON.stringify(result.counts)}`,
  );
}

main()
  .catch((error) => {
    const message =
      error instanceof GtfsIngestError || error instanceof Error
        ? error.message
        : String(error);
    console.error(message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
