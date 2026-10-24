/**
 * Gate 4A — live_arrivals + GTFS schedule fallback / ambiguity (eval DB).
 * Mocked SIRI HTTP only. Run:
 *   npm run test:eval-db -w backend -- tests/siri-live-arrivals.eval-db.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { ingestParsedFeed } from "../src/services/gtfs-ingest.js";
import { resolveRoutesReply } from "../src/services/routes.js";
import { buildMiniGtfsFeed } from "./gtfs-fixture.js";

const prisma = new PrismaClient();

function loadFreshSiriFixture(now: Date = new Date()): unknown {
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, "fixtures/siri-sm-valid.json"), "utf8"),
  ) as {
    Siri: {
      ServiceDelivery: {
        ResponseTimestamp: string;
        StopMonitoringDelivery: Array<{
          ResponseTimestamp: string;
          MonitoredStopVisit: Array<{ RecordedAtTime: string }>;
        }>;
      };
    };
  };
  const ts = now.toISOString();
  raw.Siri.ServiceDelivery.ResponseTimestamp = ts;
  for (const d of raw.Siri.ServiceDelivery.StopMonitoringDelivery) {
    d.ResponseTimestamp = ts;
    for (const v of d.MonitoredStopVisit) {
      v.RecordedAtTime = ts;
    }
  }
  return raw;
}

describe("live_arrivals + GTFS fallback (eval-db)", () => {
  beforeAll(() => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
    expect(process.env.WORKEE_DISABLE_REMINDER_FIRE).toBe("1");
  });

  beforeEach(async () => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    process.env.GTFS_ENABLED = "1";
    delete process.env.SIRI_ENABLED;
    delete process.env.SIRI_SM_BASE_URL;
    delete process.env.SIRI_SM_KEY;
    await prisma.gtfsFeedGeneration.deleteMany({});
    await ingestParsedFeed(prisma, buildMiniGtfsFeed(), {
      sourceLabel: "siri-fallback-mini",
    });
  });

  afterAll(async () => {
    await prisma.gtfsFeedGeneration.deleteMany({}).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("T4: ambiguous agency asks before claiming live", async () => {
    process.env.SIRI_ENABLED = "1";
    process.env.SIRI_SM_BASE_URL = "https://example.test/siri";
    process.env.SIRI_SM_KEY = "TESTKEY";
    const fetchImpl = vi.fn();
    const reply = await resolveRoutesReply({
      origin: "",
      destination: "",
      stopCode: "2007",
      line: "51",
      serviceDate: "2026-10-24",
      aspects: ["live_arrivals"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reply.text).toMatch(/מפעיל/);
    expect(reply.text).not.toMatch(/הגעות חזויות \(זמן אמת\)/);
  });

  it("T7/T11: SIRI disabled → schedule fallback labeled מתוזמן, schedule aspect still works", async () => {
    const fetchImpl = vi.fn();
    const live = await resolveRoutesReply({
      origin: "",
      destination: "",
      stopCode: "2007",
      line: "1",
      agency: "אלקטרה",
      headsign: "1",
      serviceDate: "2026-10-24",
      departure: "09:00",
      windowEnd: "11:00",
      aspects: ["live_arrivals"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(live.text).toMatch(/מתוזמנ|SIRI_ENABLED/);
    expect(live.text).not.toMatch(/הגעות חזויות \(זמן אמת\)/);
    expect(live.text).toMatch(/משרד התחבורה|SIRI_ENABLED/);

    const sched = await resolveRoutesReply({
      origin: "",
      destination: "",
      stopCode: "2007",
      line: "1",
      agency: "אלקטרה",
      headsign: "1",
      serviceDate: "2026-10-24",
      departure: "09:00",
      windowEnd: "11:00",
      aspects: ["schedule"],
    });
    expect(sched.text).toMatch(/יציאות מתוזמנות/);
    expect(sched.text).toMatch(/לא זמן אמת/);
  });

  it("T9: duplicate stop_code platforms — live uses public stop_code MonitoringRef", async () => {
    process.env.SIRI_ENABLED = "1";
    process.env.SIRI_SM_BASE_URL = "https://example.test/siri";
    process.env.SIRI_SM_KEY = "TESTKEY";
    const body = loadFreshSiriFixture(new Date());
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const reply = await resolveRoutesReply({
      origin: "",
      destination: "",
      stopCode: "2007",
      line: "1",
      agency: "אלקטרה",
      headsign: "1",
      aspects: ["live_arrivals"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalled();
    const url = String(fetchImpl.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("MonitoringRef=2007");
    expect(url).not.toContain("S1A");
    expect(reply.text).toMatch(/הגעות חזויות|מתוזמנ/);
  });

  it("T2: stale SIRI falls back to schedule with truthful wording", async () => {
    process.env.SIRI_ENABLED = "1";
    process.env.SIRI_SM_BASE_URL = "https://example.test/siri";
    process.env.SIRI_SM_KEY = "TESTKEY";
    const staleFixture = loadFreshSiriFixture(
      new Date(Date.now() - 10 * 60_000),
    ) as {
      Siri: {
        ServiceDelivery: {
          ResponseTimestamp: string;
          StopMonitoringDelivery: Array<{
            ResponseTimestamp: string;
            MonitoredStopVisit: Array<{ RecordedAtTime: string }>;
          }>;
        };
      };
    };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(staleFixture), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const reply = await resolveRoutesReply({
      origin: "",
      destination: "",
      stopCode: "2007",
      line: "1",
      agency: "אלקטרה",
      headsign: "1",
      serviceDate: "2026-10-24",
      departure: "09:00",
      windowEnd: "11:00",
      aspects: ["live_arrivals"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply.text).toMatch(/ישנה|מתוזמנ/);
    expect(reply.text).not.toMatch(/הגעות חזויות \(זמן אמת\)/);
  });

  it("Hebrew agency name filters OperatorRef by resolved agency_id", async () => {
    process.env.SIRI_ENABLED = "1";
    process.env.SIRI_SM_BASE_URL = "https://example.test/siri";
    process.env.SIRI_SM_KEY = "TESTKEY";
    const now = new Date();
    const body = loadFreshSiriFixture(now) as {
      Siri: {
        ServiceDelivery: {
          StopMonitoringDelivery: Array<{
            MonitoredStopVisit: unknown[];
          }>;
        };
      };
    };
    // Active visit from a second operator — must be excluded after Hebrew→25 resolve.
    const otherOpArrival = "2099-01-01T18:45:00.000+03:00";
    body.Siri.ServiceDelivery.StopMonitoringDelivery[0]!.MonitoredStopVisit.push({
      RecordedAtTime: now.toISOString(),
      MonitoringRef: "2007",
      MonitoredVehicleJourney: {
        LineRef: "R51B",
        PublishedLineName: "51",
        OperatorRef: "3",
        FramedVehicleJourneyRef: {
          DataFrameRef: "2026-10-24",
          DatedVehicleJourneyRef: "other-op-51",
        },
        VehicleRef: "egged-only",
        MonitoredCall: {
          StopPointRef: "2007",
          ExpectedArrivalTime: otherOpArrival,
          ArrivalStatus: "onTime",
        },
      },
    });
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const reply = await resolveRoutesReply({
      origin: "",
      destination: "",
      stopCode: "2007",
      line: "51",
      agency: "אלקטרה",
      headsign: "1",
      aspects: ["live_arrivals"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalled();
    const calledUrl = String(fetchImpl.mock.calls[0]?.[0] ?? "");
    expect(calledUrl).not.toContain(encodeURIComponent("אלקטרה"));
    expect(calledUrl).not.toMatch(/OperatorRef=אלקטרה/);
    expect(reply.text).toMatch(/הגעות חזויות \(זמן אמת\)/);
    expect(reply.text).toMatch(/קו 51/);
    expect(reply.text).not.toMatch(/18:45/);
    expect(reply.text).not.toMatch(/מתוזמנ/);
  });

  it("unresolved Hebrew agency does not present multi-operator live as filtered", async () => {
    process.env.GTFS_ENABLED = "0";
    process.env.SIRI_ENABLED = "1";
    process.env.SIRI_SM_BASE_URL = "https://example.test/siri";
    process.env.SIRI_SM_KEY = "TESTKEY";
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(loadFreshSiriFixture(new Date())), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const reply = await resolveRoutesReply({
      origin: "",
      destination: "",
      stopCode: "2007",
      line: "51",
      agency: "אלקטרה",
      headsign: "1",
      aspects: ["live_arrivals"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reply.text).not.toMatch(/הגעות חזויות \(זמן אמת\)/);
    expect(reply.text).toMatch(/לוח|כבוי|מפעיל/);
  });

  it("freshness_unknown falls back without claiming live", async () => {
    process.env.SIRI_ENABLED = "1";
    process.env.SIRI_SM_BASE_URL = "https://example.test/siri";
    process.env.SIRI_SM_KEY = "TESTKEY";
    const body = loadFreshSiriFixture(new Date()) as {
      Siri: {
        ServiceDelivery: {
          ResponseTimestamp?: string;
          StopMonitoringDelivery: Array<{ ResponseTimestamp?: string }>;
        };
      };
    };
    delete body.Siri.ServiceDelivery.ResponseTimestamp;
    for (const d of body.Siri.ServiceDelivery.StopMonitoringDelivery) {
      delete d.ResponseTimestamp;
    }
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const reply = await resolveRoutesReply({
      origin: "",
      destination: "",
      stopCode: "2007",
      line: "1",
      agency: "אלקטרה",
      headsign: "1",
      serviceDate: "2026-10-24",
      departure: "09:00",
      windowEnd: "11:00",
      aspects: ["live_arrivals"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply.text).toMatch(/לא ניתן לאמת|מתוזמנ/);
    expect(reply.text).not.toMatch(/הגעות חזויות \(זמן אמת\)/);
  });

  it("T12: GTFS active generation readable while live path runs", async () => {
    process.env.SIRI_ENABLED = "1";
    process.env.SIRI_SM_BASE_URL = "https://example.test/siri";
    process.env.SIRI_SM_KEY = "TESTKEY";
    const body = loadFreshSiriFixture(new Date());
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const [live, nearest] = await Promise.all([
      resolveRoutesReply({
        origin: "",
        destination: "",
        stopCode: "2007",
        aspects: ["live_arrivals"],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      resolveRoutesReply({
        origin: "speaker",
        destination: "",
        line: "1",
        agency: "אלקטרה",
        headsign: "1",
        serviceDate: "2026-10-24",
        aspects: ["nearest_stop"],
        originLat: 32.09,
        originLng: 34.85,
      }),
    ]);
    expect(live.text.length).toBeGreaterThan(0);
    expect(nearest.text).toMatch(/תחנ/);
  });
});
