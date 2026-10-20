import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  importGtfsFromExtract,
  isGtfsDbFresh,
} from "../src/services/gtfs-store.js";

describe("importGtfsFromExtract streaming", () => {
  let dir = "";

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("streams stop_times and publishes meta atomically", async () => {
    dir = mkdtempSync(join(tmpdir(), "gtfs-stream-"));
    const extract = join(dir, "raw");
    mkdirSync(extract);
    writeFileSync(
      join(extract, "agency.txt"),
      "agency_id,agency_name\n1,דן\n",
      "utf8",
    );
    writeFileSync(
      join(extract, "stops.txt"),
      "stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon\ns1,1,מסוף ארנס,פתח תקווה,32.1,34.9\n",
      "utf8",
    );
    writeFileSync(
      join(extract, "routes.txt"),
      "route_id,agency_id,route_short_name,route_long_name,route_type\nr1,1,51,ארנס-תא,3\n",
      "utf8",
    );
    writeFileSync(
      join(extract, "trips.txt"),
      "route_id,service_id,trip_id,trip_headsign,direction_id\nr1,svc,t1,תא,0\n",
      "utf8",
    );
    writeFileSync(
      join(extract, "stop_times.txt"),
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,15:10:00,15:10:00,s1,1\nt1,15:20:00,15:20:00,s1,2\n",
      "utf8",
    );
    writeFileSync(
      join(extract, "calendar.txt"),
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nsvc,1,1,1,1,1,1,1,20200101,20301231\n",
      "utf8",
    );
    writeFileSync(
      join(extract, "calendar_dates.txt"),
      "service_id,date,exception_type\n",
      "utf8",
    );

    const dbPath = join(dir, "mot.sqlite");
    await importGtfsFromExtract(extract, dbPath);
    expect(isGtfsDbFresh(dbPath)).toBe(true);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const st = db
        .prepare("SELECT COUNT(*) AS c FROM stop_times")
        .get() as { c: number };
      expect(st.c).toBe(2);
      const meta = db
        .prepare("SELECT value FROM meta WHERE key = 'imported_at'")
        .get() as { value: string };
      expect(Number(meta.value)).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
