import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { buildFixtureGtfsDb } from "../src/services/gtfs-store.js";
import {
  formatTransitHebrew,
  parseTransitAspects,
  queryTransitDepartures,
  resolveTransitReply,
  scoreStopMatch,
} from "../src/services/transit.js";

describe("parseTransitAspects", () => {
  it("defaults to departures", () => {
    expect(parseTransitAspects(undefined)).toEqual(["departures"]);
  });
});

describe("scoreStopMatch", () => {
  it("scores central station in Petah Tikva", () => {
    const score = scoreStopMatch(
      "תחנה מרכזית פתח תקווה",
      "פתח תקווה",
      "תחנה מרכזית",
      "פתח תקווה",
    );
    expect(score).toBeGreaterThan(40);
  });

  it("scores Moshe Arens terminal for מסוף hint", () => {
    const score = scoreStopMatch(
      "מסוף משה ארנס/רציפים",
      "פתח תקווה",
      "מסוף ארנס",
      "פתח תקוה",
    );
    expect(score).toBeGreaterThan(30);
  });

  it("maps תחנה מרכזית פ״ת to Moshe Arens", () => {
    const arens = scoreStopMatch(
      "מסוף משה ארנס/רציפים",
      "רחוב: עיר: פתח תקווה רציף:",
      "תחנה מרכזית",
      "פתח תקוה",
    );
    const lightRail = scoreStopMatch(
      "תחנה מרכזית פתח תקווה",
      "רחוב: מסילת ברזל קו אדום גוש דן עיר: פתח תקווה",
      "תחנה מרכזית",
      "פתח תקוה",
    );
    expect(arens).toBeGreaterThan(40);
    expect(arens).toBeGreaterThan(lightRail);
  });
});

describe("formatTransitHebrew", () => {
  it("lists departures", () => {
    const text = formatTransitHebrew({
      line: "51",
      stop: "מסוף ארנס",
      place: "פתח תקווה",
      aspects: ["departures"],
      missing: [],
      ambiguousStops: [],
      departures: [
        {
          departureTime: "16:05:00",
          stopName: "מסוף משה ארנס/רציפים",
          stopCode: "33599",
          routeShortName: "51",
          routeLongName: "מסוף משה ארנס-פתח תקווה<->ת.מרכזית תל אביב",
          agencyName: "דן",
          headsign: "תל אביב",
        },
      ],
    });
    expect(text).toContain("קו 51");
    expect(text).toContain("16:05");
    expect(text).toContain("תל אביב");
    expect(text).toContain("מתוכנן");
  });

  it("asks when timetable not ready", () => {
    expect(
      formatTransitHebrew({
        line: "51",
        stop: "x",
        place: "y",
        aspects: ["departures"],
        missing: [],
        ambiguousStops: [],
        departures: [],
        notReady: true,
      }),
    ).toMatch(/נטען/);
  });

  it("explains sync failure", () => {
    expect(
      formatTransitHebrew({
        line: "51",
        stop: "x",
        place: "y",
        aspects: ["departures"],
        missing: [],
        ambiguousStops: [],
        departures: [],
        error: "sync_failed",
      }),
    ).toMatch(/לא הצלחתי לטעון/);
  });
});

describe("queryTransitDepartures fixture", () => {
  let dir = "";
  let dbPath = "";

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("returns next departures for line 51 at Arens", () => {
    dir = mkdtempSync(join(tmpdir(), "gtfs-fix-"));
    dbPath = join(dir, "fix.sqlite");
    buildFixtureGtfsDb(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const result = queryTransitDepartures(db, {
        line: "51",
        stop: "מסוף ארנס",
        place: "פתח תקווה",
        now: new Date("2026-10-20T12:00:00+03:00"),
      });
      expect(result.departures.length).toBeGreaterThan(0);
      expect(result.departures[0]!.routeShortName).toBe("51");
      expect(result.departures[0]!.stopName).toContain("ארנס");
      expect(result.departures.map((d) => d.departureTime)).toContain(
        "15:10:00",
      );
    } finally {
      db.close();
    }
  });

  it("resolveTransitReply uses injected fixture db", async () => {
    dir = mkdtempSync(join(tmpdir(), "gtfs-fix-"));
    dbPath = join(dir, "fix.sqlite");
    buildFixtureGtfsDb(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const text = await resolveTransitReply({
        line: "51",
        stop: "תחנה מרכזית",
        place: "פתח תקווה",
        aspects: ["departures"],
        now: new Date("2026-10-20T12:00:00+03:00"),
        db,
      });
      expect(text).toContain("קו 51");
      expect(text).toMatch(/15:20|16:05|15:10/);
    } finally {
      db.close();
    }
  });
});
