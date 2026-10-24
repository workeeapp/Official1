/**
 * GTFS schedule + nearest_stop query contracts — eval DB only.
 * Run: npm run test:eval-db -w backend -- tests/gtfs-query.eval-db.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { ingestParsedFeed } from "../src/services/gtfs-ingest.js";
import {
  formatScheduleHebrew,
  queryNearestStop,
  querySchedule,
  resolveBoardingStopIds,
  resolveGtfsAgencyHint,
  resolveScheduleStopRef,
} from "../src/services/gtfs-query.js";
import { gtfsTimeToSeconds } from "../src/services/gtfs-time.js";
import { buildMiniGtfsFeed } from "./gtfs-fixture.js";

const prisma = new PrismaClient();

describe("gtfs query schedule + nearest_stop (eval-db)", () => {
  let generationId = "";

  beforeAll(() => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  });

  beforeEach(async () => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    process.env.GTFS_ENABLED = "1";
    await prisma.gtfsFeedGeneration.deleteMany({});
    const loaded = await ingestParsedFeed(prisma, buildMiniGtfsFeed(), {
      sourceLabel: "query-mini",
    });
    generationId = loaded.generationId;
  });

  afterAll(async () => {
    await prisma.gtfsFeedGeneration.deleteMany({}).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("expands duplicate stop_code to boarding platforms", async () => {
    const ids = await resolveBoardingStopIds(prisma, generationId, "2007");
    expect(ids.map((s) => s.feedStopId).sort()).toEqual(["S1A", "S1B"]);
  });

  it("asks when line has multiple agencies", async () => {
    const result = await querySchedule(prisma, {
      stopCode: "2007",
      line: "51",
      serviceDate: "2026-10-24",
      windowStartSeconds: 7 * 3600,
      windowEndSeconds: 12 * 3600,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.ambiguity.kind).toBe("agency");
    expect(result.ambiguity.options.length).toBeGreaterThan(1);
  });

  it("asks when direction is ambiguous for one agency", async () => {
    const result = await querySchedule(prisma, {
      stopCode: "2007",
      line: "51",
      agency: "אלקטרה",
      serviceDate: "2026-10-24",
      windowStartSeconds: 7 * 3600,
      windowEndSeconds: 12 * 3600,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.ambiguity.kind).toBe("direction");
  });

  it("returns official schedule when agency+direction resolved", async () => {
    const result = await querySchedule(prisma, {
      stopCode: "2007",
      line: "51",
      agency: "אלקטרה",
      direction: "1",
      serviceDate: "2026-10-24",
      windowStartSeconds: 7 * 3600,
      windowEndSeconds: 12 * 3600,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceHe).toMatch(/משרד התחבורה/);
    expect(result.sourceHe).toMatch(/לא זמן אמת/);
    expect(result.departures.length).toBeGreaterThan(0);
    expect(result.departures.every((d) => d.stopCode === "2007")).toBe(true);
    const text = formatScheduleHebrew(result);
    expect(text).toMatch(/מתוזמנות/);
    expect(text).not.toMatch(/גוגל/);
  });

  it("schedule by unique spoken stop name resolves to stop_code", async () => {
    const resolved = await resolveScheduleStopRef(
      prisma,
      generationId,
      "תחנה רחוקה",
      { line: "1" },
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.via).toBe("stop_name");
    expect(resolved.match.stopCode).toBe("3001");

    const result = await querySchedule(prisma, {
      stopCode: "תחנה רחוקה",
      line: "1",
      agency: "אלקטרה",
      direction: "1",
      serviceDate: "2026-10-24",
      windowStartSeconds: 7 * 3600,
      windowEndSeconds: 12 * 3600,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.departures.every((d) => d.stopCode === "3001")).toBe(true);
  });

  it("schedule by stop name keeps exact stop_code queries working", async () => {
    const resolved = await resolveScheduleStopRef(prisma, generationId, "2007");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.via).toBe("stop_code");
    expect(resolved.match.stopCode).toBe("2007");
  });

  it("asks when spoken stop name matches several stop_codes (no line filter)", async () => {
    const resolved = await resolveScheduleStopRef(
      prisma,
      generationId,
      "שלום דורני",
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.kind).toBe("ambiguous");
    if (resolved.kind !== "ambiguous") return;
    expect(resolved.ambiguity.kind).toBe("stop");
    expect(resolved.ambiguity.options.some((o) => o.includes("5001"))).toBe(
      true,
    );
    expect(resolved.ambiguity.options.some((o) => o.includes("5002"))).toBe(
      true,
    );
  });

  it("line filter can uniquely resolve a shared stop name", async () => {
    // 5001 serves line 51 only; 5002 serves line 1 only (fixture).
    const for51 = await resolveScheduleStopRef(
      prisma,
      generationId,
      "שלום דורני",
      { line: "51" },
    );
    expect(for51.ok).toBe(true);
    if (!for51.ok) return;
    expect(for51.match.stopCode).toBe("5001");

    const for1 = await resolveScheduleStopRef(
      prisma,
      generationId,
      "שלום דורני",
      { line: "1" },
    );
    expect(for1.ok).toBe(true);
    if (!for1.ok) return;
    expect(for1.match.stopCode).toBe("5002");
  });

  it("handles after-midnight GTFS times on the service day", async () => {
    expect(gtfsTimeToSeconds("25:15:00")).toBe(25 * 3600 + 15 * 60);
    const result = await querySchedule(prisma, {
      stopCode: "2007",
      line: "1",
      agency: "אלקטרה",
      direction: "1",
      serviceDate: "2026-10-24",
      windowStartSeconds: 24 * 3600,
      windowEndSeconds: 28 * 3600,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.departures.some((d) => d.depSeconds > 86400)).toBe(true);
  });

  it("reports absent service when no trips for the date", async () => {
    const result = await querySchedule(prisma, {
      stopCode: "2007",
      line: "1",
      agency: "אלקטרה",
      direction: "1",
      serviceDate: "2026-10-26",
      windowStartSeconds: 0,
      windowEndSeconds: 12 * 3600,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("no_service");
  });

  it("nearest_stop defaults to today's service and ranks by distance", async () => {
    const result = await queryNearestStop(prisma, {
      lat: 32.09,
      lng: 34.85,
      line: "1",
      agency: "אלקטרה",
      direction: "1",
      serviceDate: "2026-10-24",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stops[0]?.stopCode).toBe("2007");
    expect(result.stops[0]?.distanceMeters).toBeLessThan(
      result.stops[1]?.distanceMeters ?? 1e9,
    );
    expect(result.sourceHe).toMatch(/משרד התחבורה/);
  });

  it("nearest_stop asks on agency ambiguity", async () => {
    const result = await queryNearestStop(prisma, {
      lat: 32.09,
      lng: 34.85,
      line: "51",
      serviceDate: "2026-10-24",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("ambiguous");
  });

  it("respects GTFS_ENABLED kill switch", async () => {
    process.env.GTFS_ENABLED = "0";
    const result = await querySchedule(prisma, {
      stopCode: "2007",
      line: "1",
      agency: "אלקטרה",
      direction: "1",
      serviceDate: "2026-10-24",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("disabled");
  });

  it("resolves Hebrew agency name to numeric agency_id", async () => {
    const result = await resolveGtfsAgencyHint(prisma, "אלקטרה", {
      generationId,
      line: "1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matches).toEqual([
      { agencyId: "25", name: "אלקטרה אפיקים" },
    ]);
  });

  it("rejects unknown agency hint", async () => {
    const result = await resolveGtfsAgencyHint(prisma, "מפעיל-לא-קיים", {
      generationId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("unknown");
    expect(result.messageHe).toMatch(/לא מצאתי מפעיל/);
  });

  it("asks when agency hint matches multiple operators", async () => {
    const result = await resolveGtfsAgencyHint(prisma, "א", {
      generationId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("ambiguous");
    expect(result.options.length).toBeGreaterThan(1);
    expect(result.messageHe).toMatch(/כמה מפעילים/);
  });
});
