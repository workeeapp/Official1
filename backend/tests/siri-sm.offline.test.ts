/**
 * Gate 4A — SIRI-SM client offline (mocked fetch only; no live provider).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSiriStopMonitoringUrl,
  dedupeArrivals,
  fetchSiriStopArrivals,
  filterSiriArrivals,
  formatSiriArrivalsHebrew,
  isSiriSmConfigured,
  parseSiriStopMonitoringJson,
  readSiriSmConfig,
  SIRI_LIVE_SOURCE_HE,
  type SiriNormalizedArrival,
} from "../src/services/siri-sm.js";
import { resolveRoutesReply } from "../src/services/routes.js";

function loadFreshSiriFixture(now: Date = new Date()): unknown {
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, "fixtures/siri-sm-valid.json"), "utf8"),
  ) as {
    Siri: {
      ServiceDelivery: {
        ResponseTimestamp: string;
        StopMonitoringDelivery: Array<{
          ResponseTimestamp: string;
          MonitoredStopVisit: Array<{
            RecordedAtTime: string;
            MonitoredVehicleJourney: {
              MonitoredCall: {
                ExpectedArrivalTime?: string;
                AimedArrivalTime?: string;
              };
            };
          }>;
        }>;
      };
    };
  };
  const ts = now.toISOString();
  // Keep relative offsets between visits; only refresh recorded/response clocks.
  raw.Siri.ServiceDelivery.ResponseTimestamp = ts;
  for (const d of raw.Siri.ServiceDelivery.StopMonitoringDelivery) {
    d.ResponseTimestamp = ts;
    for (const v of d.MonitoredStopVisit) {
      v.RecordedAtTime = ts;
    }
  }
  return raw;
}

const NOW = new Date("2026-10-24T12:00:30.000+03:00");
const FIXTURE = loadFreshSiriFixture(NOW);

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.SIRI_ENABLED;
  delete process.env.SIRI_SM_BASE_URL;
  delete process.env.SIRI_SM_KEY;
});

describe("siri-sm config / kill switch", () => {
  it("T7: disabled or missing config never looks configured", () => {
    expect(isSiriSmConfigured(readSiriSmConfig({}))).toBe(false);
    expect(
      isSiriSmConfigured(
        readSiriSmConfig({
          SIRI_ENABLED: "1",
          SIRI_SM_BASE_URL: "",
          SIRI_SM_KEY: "x",
        } as NodeJS.ProcessEnv),
      ),
    ).toBe(false);
  });

  it("T7: fetch with SIRI_ENABLED unset does not call fetch", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchSiriStopArrivals({
      monitoringRef: "2007",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      config: { enabled: false, baseUrl: "", key: "" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("disabled");
  });

  it("T7: enabled without credentials does not call fetch", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchSiriStopArrivals({
      monitoringRef: "2007",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      config: { enabled: true, baseUrl: "", key: "" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("config_missing");
  });
});

describe("siri-sm parse / normalize", () => {
  it("T1: valid fixture yields live arrivals with official source label", () => {
    const result = parseSiriStopMonitoringJson(FIXTURE, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceHe).toBe(SIRI_LIVE_SOURCE_HE);
    expect(result.arrivals.length).toBeGreaterThanOrEqual(2);
    const text = formatSiriArrivalsHebrew(result);
    expect(text).toMatch(/הגעות חזויות/);
    expect(text).toMatch(/SIRI/);
    expect(text).not.toMatch(/גוגל/);
    expect(text).not.toMatch(/מתוזמן/);
  });

  it("T5: duplicates are collapsed", () => {
    const result = parseSiriStopMonitoringJson(FIXTURE, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const journeyIds = result.arrivals
      .filter((a) => a.datedVehicleJourneyRef === "20925867")
      .map((a) => a.datedVehicleJourneyRef);
    expect(journeyIds.length).toBe(1);
  });

  it("T6: cancelled arrivals are marked and listed separately in Hebrew", () => {
    const result = parseSiriStopMonitoringJson(FIXTURE, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.arrivals.some((a) => a.cancelled)).toBe(true);
    const text = formatSiriArrivalsHebrew(result);
    expect(text).toMatch(/בוטלו/);
  });

  it("T10: DatedVehicleJourneyRef is kept opaque without requiring GTFS join", () => {
    const result = parseSiriStopMonitoringJson(FIXTURE, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.arrivals[0]?.datedVehicleJourneyRef).toBeTruthy();
    // Display does not depend on verifying the id against GTFS.
    expect(formatSiriArrivalsHebrew(result)).toMatch(/קו/);
  });

  it("T2: stale ResponseTimestamp → stale fail", () => {
    const result = parseSiriStopMonitoringJson(FIXTURE, {
      now: new Date("2026-10-24T12:05:00.000+03:00"),
      staleAfterMs: 60_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("stale");
  });

  it("missing ResponseTimestamp → freshness_unknown (not live)", () => {
    const body = structuredClone(FIXTURE) as {
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
    const result = parseSiriStopMonitoringJson(body, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("freshness_unknown");
  });

  it("invalid ResponseTimestamp → freshness_unknown", () => {
    const body = structuredClone(FIXTURE) as {
      Siri: {
        ServiceDelivery: {
          ResponseTimestamp: string;
          StopMonitoringDelivery: Array<{ ResponseTimestamp: string }>;
        };
      };
    };
    body.Siri.ServiceDelivery.ResponseTimestamp = "not-a-date";
    for (const d of body.Siri.ServiceDelivery.StopMonitoringDelivery) {
      d.ResponseTimestamp = "also-bad";
    }
    const result = parseSiriStopMonitoringJson(body, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("freshness_unknown");
  });

  it("stale response stays stale even with recent RecordedAtTime", () => {
    const body = structuredClone(FIXTURE) as {
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
    const oldTs = "2026-10-24T11:00:00.000+03:00";
    const recentObs = "2026-10-24T12:00:20.000+03:00";
    body.Siri.ServiceDelivery.ResponseTimestamp = oldTs;
    for (const d of body.Siri.ServiceDelivery.StopMonitoringDelivery) {
      d.ResponseTimestamp = oldTs;
      for (const v of d.MonitoredStopVisit) {
        v.RecordedAtTime = recentObs;
      }
    }
    const result = parseSiriStopMonitoringJson(body, {
      now: NOW,
      staleAfterMs: 60_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("stale");
  });

  it("fresh response accepted even with older RecordedAtTime", () => {
    const body = structuredClone(FIXTURE) as {
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
    const freshTs = "2026-10-24T12:00:25.000+03:00";
    const oldObs = "2026-10-24T11:50:00.000+03:00";
    body.Siri.ServiceDelivery.ResponseTimestamp = freshTs;
    for (const d of body.Siri.ServiceDelivery.StopMonitoringDelivery) {
      d.ResponseTimestamp = freshTs;
      for (const v of d.MonitoredStopVisit) {
        v.RecordedAtTime = oldObs;
      }
    }
    const result = parseSiriStopMonitoringJson(body, {
      now: NOW,
      staleAfterMs: 60_000,
    });
    expect(result.ok).toBe(true);
  });

  it("invalid ExpectedArrivalTime is skipped (not invented)", () => {
    const body = {
      Siri: {
        ServiceDelivery: {
          ResponseTimestamp: "2026-10-24T12:00:00.000+03:00",
          StopMonitoringDelivery: [
            {
              ResponseTimestamp: "2026-10-24T12:00:00.000+03:00",
              Status: true,
              MonitoredStopVisit: [
                {
                  RecordedAtTime: "2026-10-24T12:00:00.000+03:00",
                  MonitoringRef: "2007",
                  MonitoredVehicleJourney: {
                    LineRef: "R1",
                    PublishedLineName: "1",
                    OperatorRef: "25",
                    FramedVehicleJourneyRef: {
                      DataFrameRef: "2026-10-24",
                      DatedVehicleJourneyRef: "x",
                    },
                    VehicleRef: "1",
                    MonitoredCall: {
                      StopPointRef: "2007",
                      ExpectedArrivalTime: "not-a-time",
                      AimedArrivalTime: "also-bad",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    };
    const result = parseSiriStopMonitoringJson(body, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("empty");
  });

  it("fresh response with only cancelled visits (no arrival times) does not claim predictions", () => {
    const body = {
      Siri: {
        ServiceDelivery: {
          ResponseTimestamp: "2026-10-24T12:00:00.000+03:00",
          StopMonitoringDelivery: [
            {
              ResponseTimestamp: "2026-10-24T12:00:00.000+03:00",
              Status: true,
              MonitoredStopVisit: [
                {
                  RecordedAtTime: "2026-10-24T12:00:00.000+03:00",
                  MonitoringRef: "2007",
                  MonitoredVehicleJourney: {
                    LineRef: "R1",
                    PublishedLineName: "1",
                    OperatorRef: "25",
                    FramedVehicleJourneyRef: {
                      DataFrameRef: "2026-10-24",
                      DatedVehicleJourneyRef: "c1",
                    },
                    VehicleRef: "1",
                    MonitoredCall: {
                      StopPointRef: "2007",
                      ArrivalStatus: "cancelled",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    };
    const result = parseSiriStopMonitoringJson(body, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.arrivals.every((a) => a.cancelled)).toBe(true);
    const text = formatSiriArrivalsHebrew(result);
    expect(text).not.toMatch(/הגעות חזויות \(זמן אמת\)/);
    expect(text).toMatch(/אין תחזיות הגעה פעילות|רק דיווחי ביטול/);
    expect(text).toMatch(/בוטלו/);
  });

  it("T3: empty visits → empty", () => {
    const empty = {
      Siri: {
        ServiceDelivery: {
          ResponseTimestamp: "2026-10-24T12:00:00.000+03:00",
          StopMonitoringDelivery: [
            {
              ResponseTimestamp: "2026-10-24T12:00:00.000+03:00",
              Status: true,
              MonitoredStopVisit: [],
            },
          ],
        },
      },
    };
    const result = parseSiriStopMonitoringJson(empty, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("empty");
  });

  it("T8: malformed body → malformed", () => {
    expect(parseSiriStopMonitoringJson(null, { now: NOW }).ok).toBe(false);
    expect(parseSiriStopMonitoringJson({ foo: 1 }, { now: NOW }).ok).toBe(
      false,
    );
  });

  it("filters by published line name without inventing LineRef", () => {
    const result = parseSiriStopMonitoringJson(FIXTURE, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const only51 = filterSiriArrivals(result.arrivals, {
      publishedLineName: "51",
    });
    expect(only51.every((a) => a.publishedLineName === "51")).toBe(true);
  });

  it("filters OperatorRef by exact agency_id only (not Hebrew name)", () => {
    const result = parseSiriStopMonitoringJson(FIXTURE, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      filterSiriArrivals(result.arrivals, { operatorRef: "25" }).length,
    ).toBeGreaterThan(0);
    expect(
      filterSiriArrivals(result.arrivals, { operatorRef: "אלקטרה" }).length,
    ).toBe(0);
  });
});

describe("siri-sm URL builder", () => {
  it("appends 2.8/json when base has no version path", () => {
    const url = buildSiriStopMonitoringUrl({
      baseUrl: "https://example.test/siri",
      key: "TESTKEY",
      monitoringRef: "2007",
      lineRef: "1209",
    });
    expect(url).toContain("/2.8/json?");
    expect(url).toContain("Key=TESTKEY");
    expect(url).toContain("MonitoringRef=2007");
    expect(url).toContain("LineRef=1209");
  });
});

describe("siri-sm fetch with mock", () => {
  it("T1/T8: successful mock fetch; http error does not throw", async () => {
    const okFetch = vi.fn(async () =>
      new Response(JSON.stringify(FIXTURE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const ok = await fetchSiriStopArrivals({
      monitoringRef: "2007",
      fetchImpl: okFetch as unknown as typeof fetch,
      config: {
        enabled: true,
        baseUrl: "https://example.test/siri",
        key: "TESTKEY",
      },
      now: NOW,
    });
    expect(okFetch).toHaveBeenCalledTimes(1);
    expect(ok.ok).toBe(true);

    const badFetch = vi.fn(async () => new Response("nope", { status: 500 }));
    const bad = await fetchSiriStopArrivals({
      monitoringRef: "2007",
      fetchImpl: badFetch as unknown as typeof fetch,
      config: {
        enabled: true,
        baseUrl: "https://example.test/siri",
        key: "TESTKEY",
      },
      now: NOW,
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.kind).toBe("http_error");
  });
});

describe("live_arrivals dispatch (mocked; no live provider)", () => {
  it("T7: live_arrivals with SIRI disabled falls back without claiming live", async () => {
    delete process.env.SIRI_ENABLED;
    delete process.env.SIRI_SM_BASE_URL;
    delete process.env.SIRI_SM_KEY;
    const fetchImpl = vi.fn();
    const reply = await resolveRoutesReply({
      origin: "",
      destination: "",
      stopCode: "2007",
      line: "1",
      agency: "אלקטרה",
      headsign: "1",
      serviceDate: "2026-10-24",
      aspects: ["live_arrivals"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reply.text).not.toMatch(/הגעות חזויות \(זמן אמת\)/);
    expect(reply.text).toMatch(/SIRI_ENABLED|תחזית|לוח|מתוזמנ|GTFS/);
  });

  it("GTFS disabled + Hebrew agency: never calls SIRI / never passes Hebrew as OperatorRef", async () => {
    delete process.env.GTFS_ENABLED;
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
      aspects: ["live_arrivals"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reply.text).not.toMatch(/הגעות חזויות \(זמן אמת\)/);
    expect(reply.text).toMatch(/לוח|מפעיל|GTFS|כבוי/);
  });

  it("numeric agency_id still filters OperatorRef when GTFS is off", async () => {
    delete process.env.GTFS_ENABLED;
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
      line: "51",
      agency: "25",
      aspects: ["live_arrivals"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalled();
    expect(reply.text).toMatch(/הגעות חזויות \(זמן אמת\)/);
    expect(reply.text).toMatch(/קו 51/);
    // Cancelled OperatorRef=3 must not appear once filtered to 25.
    expect(reply.text).not.toMatch(/בוטלו/);
  });

  it("T1: live_arrivals with mock SIRI returns live label", async () => {
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
      aspects: ["live_arrivals"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchImpl.mock.calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("example.test");
    expect(calledUrl).not.toMatch(/mot\.gov\.il/i);
    expect(reply.text).toMatch(/הגעות חזויות \(זמן אמת\)/);
    expect(reply.text).toMatch(/SIRI/);
    expect(reply.text).not.toMatch(/גוגל/);
  });

  it("T8: provider 500 falls back without live claim", async () => {
    process.env.SIRI_ENABLED = "1";
    process.env.SIRI_SM_BASE_URL = "https://example.test/siri";
    process.env.SIRI_SM_KEY = "TESTKEY";
    const fetchImpl = vi.fn(async () => new Response("err", { status: 500 }));
    const reply = await resolveRoutesReply({
      origin: "",
      destination: "",
      stopCode: "2007",
      line: "1",
      aspects: ["live_arrivals"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalled();
    expect(reply.text).not.toMatch(/הגעות חזויות \(זמן אמת\)/);
  });
});

describe("dedupeArrivals unit", () => {
  it("keeps first of identical keys", () => {
    const base: SiriNormalizedArrival = {
      stopCode: "1",
      lineRef: "L",
      publishedLineName: "9",
      operatorRef: "25",
      directionRef: "1",
      destinationRef: "",
      datedVehicleJourneyRef: "T",
      dataFrameRef: "2026-10-24",
      vehicleRef: "V",
      expectedArrivalIso: "2026-10-24T12:00:00.000+03:00",
      aimedArrivalIso: "",
      arrivalStatus: "onTime",
      recordedAtIso: "2026-10-24T12:00:00.000+03:00",
      cancelled: false,
    };
    expect(dedupeArrivals([base, { ...base }])).toHaveLength(1);
  });
});
