/**
 * Day-filtered GTFS parse (no DB). Verifies service-date keeps full trip
 * sequences without geographic caps.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GtfsIngestError,
  normalizeGtfsServiceDateKey,
  parseGtfsDirectory,
} from "../src/services/gtfs-ingest.js";

function writeFeed(dir: string) {
  writeFileSync(
    join(dir, "feed_info.txt"),
    "feed_publisher_name,feed_start_date,feed_end_date\nMOT,20261021,20261030\n",
  );
  writeFileSync(
    join(dir, "agency.txt"),
    "agency_id,agency_name\n25,אלקטרה\n3,אגד\n",
  );
  writeFileSync(
    join(dir, "stops.txt"),
    [
      "stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station",
      "S1,2007,תחנה,32.09,34.85,0,",
      "S2,3001,יעד,32.1,34.9,0,",
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "routes.txt"),
    "route_id,agency_id,route_short_name,route_long_name\nR1,25,1,קו 1\n",
  );
  writeFileSync(
    join(dir, "calendar_dates.txt"),
    [
      "service_id,date,exception_type",
      "20261024,20261024,1",
      "20261025,20261025,1",
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "trips.txt"),
    [
      "route_id,service_id,trip_id,trip_headsign,direction_id",
      "R1,20261024,T-DAY,מרכז,0",
      "R1,20261025,T-NEXT,מרכז,0",
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "stop_times.txt"),
    [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "T-DAY,08:00:00,08:00:00,S1,1",
      "T-DAY,08:10:00,08:10:00,S2,2",
      "T-NEXT,09:00:00,09:00:00,S1,1",
      "T-NEXT,09:10:00,09:10:00,S2,2",
    ].join("\n") + "\n",
  );
}

describe("gtfs service-date parse filter (offline)", () => {
  let dir = "";

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("normalizes YYYY-MM-DD and YYYYMMDD", () => {
    expect(normalizeGtfsServiceDateKey("2026-10-24")).toBe("20261024");
    expect(normalizeGtfsServiceDateKey("20261024")).toBe("20261024");
    expect(normalizeGtfsServiceDateKey("bad")).toBe("");
  });

  it("keeps nationwide stops/routes but only the selected day's trips + stop_times", async () => {
    dir = mkdtempSync(join(tmpdir(), "gtfs-day-"));
    writeFeed(dir);
    const feed = await parseGtfsDirectory(dir, { serviceDate: "2026-10-24" });
    expect(feed.feedStartDate).toBe("20261024");
    expect(feed.feedEndDate).toBe("20261024");
    expect(feed.agencies).toHaveLength(2);
    expect(feed.stops).toHaveLength(2);
    expect(feed.routes).toHaveLength(1);
    expect(feed.calendarDates).toEqual([
      { serviceId: "20261024", date: "20261024", exceptionType: 1 },
    ]);
    expect(feed.trips.map((t) => t.feedTripId)).toEqual(["T-DAY"]);
    expect(feed.stopTimes).toHaveLength(2);
    expect(feed.stopTimes.every((s) => s.feedTripId === "T-DAY")).toBe(true);
    expect(feed.stopTimes.map((s) => s.stopSequence).sort()).toEqual([1, 2]);
  });

  it("fails closed when service date is missing from calendar_dates", async () => {
    dir = mkdtempSync(join(tmpdir(), "gtfs-day-miss-"));
    writeFeed(dir);
    await expect(
      parseGtfsDirectory(dir, { serviceDate: "20261099" }),
    ).rejects.toBeInstanceOf(GtfsIngestError);
  });
});
