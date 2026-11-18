/**
 * UWM Phase 4 — multi-item identity + precise scheduling (fixtures).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { LlmWebMonitorCondition } from "@workee/shared";
import {
  identityCore,
  resolveStableItemId,
  shaContent,
} from "../src/services/uwm-normalize.js";
import {
  computeNextPrecise,
  dualFireAt,
  isPastPreciseGrace,
  isWithinPreciseCatchUp,
  phaseMissed,
  phasePre,
  UWM_PRECISE_GRACE_MS,
} from "../src/services/uwm-schedule.js";
import { pollWebMonitor } from "../src/services/semantic-web-monitor.service.js";
import { resetUwmMetrics } from "../src/services/uwm-retrieval-metrics.js";
import type { UwmMonitorState } from "../src/services/uwm-types.js";

function leagueSpec(
  overrides: Partial<LlmWebMonitorCondition> = {},
): LlmWebMonitorCondition {
  return {
    type: "web_monitor",
    intent: "תעדכני שעה לפני כל משחק ליגה של ריאל מדריד",
    canonicalQuery: "Real Madrid league football fixtures kickoff",
    constraints: { entities: ["Real Madrid"] },
    objectives: [
      { id: "d1", kind: "discover_new" },
      { id: "p1", kind: "time_before_event", minutesBefore: 60 },
    ],
    evidenceMin: "observed",
    ...overrides,
  };
}

function fixtureSearch(items: unknown[], sources: string[]) {
  return async () => ({
    text: `UWM_FIXTURE_ITEMS: ${JSON.stringify(items)}\n\n`,
    sources,
    usage: null,
    raw: null,
  });
}

const emptyPlan: UwmMonitorState["sourcePlan"] = {
  coverage: "none",
  reason: "web_only",
  useWebDiscovery: true,
  primary: [{ id: "web_search", kind: "web_search", score: 1 }],
  secondary: [],
  requiredFacets: ["eventAt", "title"],
  facetCoverage: { eventAt: "web", title: "web" },
  reliabilityExpect: "low",
  decidedAt: new Date().toISOString(),
};

describe("UWM Phase 4 identity", () => {
  it("time change does not fork itemId (alias by identityCore)", () => {
    const core = identityCore({
      title: "Real Madrid vs Sevilla",
      locationText: "Bernabeu",
    });
    const first = resolveStableItemId({
      title: "Real Madrid vs Sevilla",
      locationText: "Bernabeu",
      eventAt: "2026-06-01T20:00:00Z",
      url: "https://a.example/1",
    });
    const state: UwmMonitorState["items"] = {
      [first.itemId]: {
        firstSeenAt: "2026-01-01T00:00:00Z",
        lastSeenAt: "2026-01-01T00:00:00Z",
        contentFp: "x",
        identityCore: core,
        eventAt: "2026-06-01T20:00:00Z",
        notified: {},
        status: "active",
      },
    };
    const moved = resolveStableItemId(
      {
        title: "Real Madrid vs Sevilla",
        locationText: "Bernabeu",
        eventAt: "2026-06-01T22:00:00Z",
        url: "https://b.example/2",
      },
      state,
    );
    expect(moved.itemId).toBe(first.itemId);
    expect(moved.aliased).toBe(true);
  });

  it("two distinct events keep separate ids", () => {
    const a = resolveStableItemId({
      title: "Real Madrid vs Sevilla",
      locationText: "Bernabeu",
      eventAt: "2026-06-01T20:00:00Z",
    });
    const state: UwmMonitorState["items"] = {
      [a.itemId]: {
        firstSeenAt: "x",
        lastSeenAt: "x",
        contentFp: "x",
        identityCore: a.identityCore,
        eventAt: "2026-06-01T20:00:00Z",
        notified: {},
      },
    };
    const b = resolveStableItemId(
      {
        title: "Real Madrid vs Sevilla",
        locationText: "Bernabeu",
        eventAt: "2026-09-01T20:00:00Z",
      },
      state,
    );
    expect(b.itemId).not.toBe(a.itemId);
  });

  it("cross-source same match merges to one item in a poll", async () => {
    resetUwmMetrics();
    const r = await pollWebMonitor({
      reminderId: "id1",
      userId: "u",
      composeCondition: leagueSpec({
        objectives: [{ id: "d1", kind: "discover_new" }],
      }),
      monitorState: null,
      watchOnce: false,
      skipExternalCache: true,
      now: new Date("2026-06-01T12:00:00Z"),
      searchImpl: fixtureSearch(
        [
          {
            title: "Real Madrid vs Valencia",
            url: "https://src-a.example/m1",
            sourceUrls: ["https://src-a.example/m1"],
            summary: "Real Madrid league",
            locationText: "Madrid",
            eventAt: "2026-06-01T20:00:00Z",
            retrievalOk: true,
          },
          {
            title: "Real Madrid vs Valencia",
            url: "https://src-b.example/m1",
            sourceUrls: ["https://src-b.example/m1"],
            summary: "Real Madrid league",
            locationText: "Madrid",
            eventAt: "2026-06-01T20:00:00Z",
            retrievalOk: true,
          },
        ],
        ["https://src-a.example/m1", "https://src-b.example/m1"],
      ),
    });
    expect(r.itemsMatched).toBe(1);
    expect(Object.keys(r.monitorState.items)).toHaveLength(1);
  });
});

describe("UWM Phase 4 precise schedule (C1–C4)", () => {
  beforeEach(() => resetUwmMetrics());

  it("C1: event in 5h + pre:60 → nextPrecise at event−60m; dual prefers discovery 3h first", async () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const eventAt = "2026-06-01T17:00:00Z"; // +5h
    const r = await pollWebMonitor({
      reminderId: "c1",
      userId: "u",
      composeCondition: leagueSpec(),
      monitorState: { version: 1, items: {}, boundSources: [], sourcePlan: emptyPlan },
      watchOnce: false,
      skipExternalCache: true,
      now,
      searchImpl: fixtureSearch(
        [
          {
            title: "Real Madrid vs Athletic",
            url: "https://fix.example/m",
            sourceUrls: ["https://fix.example/m"],
            summary: "Real Madrid league",
            locationText: "Madrid",
            eventAt,
            retrievalOk: true,
          },
        ],
        ["https://fix.example/m"],
      ),
    });
    expect(r.nextPrecise).toBeTruthy();
    expect(r.nextPrecise!.fireAtIso).toBe(
      new Date("2026-06-01T16:00:00Z").toISOString(),
    );
    expect(r.nextPrecise!.minutesBefore).toBe(60);
    // Discovery cadence 3h from now
    const discoveryNext = new Date(now.getTime() + 3 * 60 * 60_000);
    const dual = dualFireAt(discoveryNext, r.nextPrecise, now);
    expect(dual?.toISOString()).toBe(discoveryNext.toISOString());
    // After discovery tick at +3h, dual should pick precise (+4h)
    const atDiscovery = new Date("2026-06-01T15:00:00Z");
    const dual2 = dualFireAt(
      new Date(atDiscovery.getTime() + 3 * 60 * 60_000),
      r.nextPrecise,
      atDiscovery,
    );
    expect(dual2?.toISOString()).toBe(r.nextPrecise!.fireAtIso);
  });

  it("C2: eventAt shift updates nextPrecise; no double pre notify", async () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const first = await pollWebMonitor({
      reminderId: "c2",
      userId: "u",
      composeCondition: leagueSpec({
        objectives: [{ id: "p1", kind: "time_before_event", minutesBefore: 60 }],
      }),
      monitorState: { version: 1, items: {}, boundSources: [], sourcePlan: emptyPlan },
      watchOnce: false,
      skipExternalCache: true,
      now,
      searchImpl: fixtureSearch(
        [
          {
            title: "Real Madrid vs Betis",
            url: "https://fix.example/betis",
            sourceUrls: ["https://fix.example/betis"],
            summary: "Real Madrid",
            locationText: "Madrid",
            eventAt: "2026-06-01T17:00:00Z",
            retrievalOk: true,
          },
        ],
        ["https://fix.example/betis"],
      ),
    });
    expect(first.nextPrecise?.fireAtIso).toBe(
      new Date("2026-06-01T16:00:00Z").toISOString(),
    );
    const itemId = first.nextPrecise!.itemId;

    const moved = await pollWebMonitor({
      reminderId: "c2",
      userId: "u",
      composeCondition: leagueSpec({
        objectives: [{ id: "p1", kind: "time_before_event", minutesBefore: 60 }],
      }),
      monitorState: first.monitorState,
      watchOnce: false,
      skipExternalCache: true,
      now,
      searchImpl: fixtureSearch(
        [
          {
            title: "Real Madrid vs Betis",
            url: "https://other.example/betis",
            sourceUrls: ["https://other.example/betis"],
            summary: "Real Madrid",
            locationText: "Madrid",
            eventAt: "2026-06-01T19:00:00Z", // +2h
            retrievalOk: true,
          },
        ],
        ["https://other.example/betis"],
      ),
    });
    expect(moved.monitorState.items[itemId]?.eventAt).toBe(
      "2026-06-01T19:00:00Z",
    );
    expect(moved.nextPrecise?.fireAtIso).toBe(
      new Date("2026-06-01T18:00:00Z").toISOString(),
    );
    expect(moved.notify.shouldNotify).toBe(false);

    // Fire at new precise time → one notify
    const fired = await pollWebMonitor({
      reminderId: "c2",
      userId: "u",
      composeCondition: leagueSpec({
        objectives: [{ id: "p1", kind: "time_before_event", minutesBefore: 60 }],
      }),
      monitorState: moved.monitorState,
      watchOnce: false,
      skipExternalCache: true,
      preciseOnly: true,
      now: new Date("2026-06-01T18:00:00Z"),
      searchImpl: fixtureSearch(
        [
          {
            title: "Real Madrid vs Betis",
            url: "https://other.example/betis",
            sourceUrls: ["https://other.example/betis"],
            summary: "Real Madrid",
            locationText: "Madrid",
            eventAt: "2026-06-01T19:00:00Z",
            retrievalOk: true,
          },
        ],
        ["https://other.example/betis"],
      ),
    });
    expect(fired.notify.shouldNotify).toBe(true);
    expect(fired.notify.phase).toBe(phasePre("p1", 60));

    // Second fire same phase → no duplicate
    const again = await pollWebMonitor({
      reminderId: "c2",
      userId: "u",
      composeCondition: leagueSpec({
        objectives: [{ id: "p1", kind: "time_before_event", minutesBefore: 60 }],
      }),
      monitorState: fired.monitorState,
      lastReportSha: fired.notify.fingerprint,
      watchOnce: false,
      skipExternalCache: true,
      preciseOnly: true,
      now: new Date("2026-06-01T18:05:00Z"),
      searchImpl: fixtureSearch(
        [
          {
            title: "Real Madrid vs Betis",
            url: "https://other.example/betis",
            sourceUrls: ["https://other.example/betis"],
            summary: "Real Madrid",
            locationText: "Madrid",
            eventAt: "2026-06-01T19:00:00Z",
            retrievalOk: true,
          },
        ],
        ["https://other.example/betis"],
      ),
    });
    expect(again.notify.shouldNotify).toBe(false);
  });

  it("C3: cancelled item clears nextPrecise and does not notify", async () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const seeded = await pollWebMonitor({
      reminderId: "c3",
      userId: "u",
      composeCondition: leagueSpec({
        objectives: [{ id: "p1", kind: "time_before_event", minutesBefore: 60 }],
      }),
      monitorState: { version: 1, items: {}, boundSources: [], sourcePlan: emptyPlan },
      watchOnce: false,
      skipExternalCache: true,
      now,
      searchImpl: fixtureSearch(
        [
          {
            title: "Real Madrid vs Celta",
            url: "https://form.example/celta",
            sourceUrls: ["https://form.example/celta"],
            summary: "Real Madrid",
            locationText: "Madrid",
            eventAt: "2026-06-01T17:00:00Z",
            retrievalOk: true,
          },
        ],
        ["https://form.example/celta"],
      ),
    });
    expect(seeded.nextPrecise).toBeTruthy();

    const cancelled = await pollWebMonitor({
      reminderId: "c3",
      userId: "u",
      composeCondition: leagueSpec({
        objectives: [{ id: "p1", kind: "time_before_event", minutesBefore: 60 }],
      }),
      monitorState: seeded.monitorState,
      watchOnce: false,
      skipExternalCache: true,
      now: new Date("2026-06-01T16:00:00Z"),
      preciseOnly: true,
      searchImpl: fixtureSearch(
        [
          {
            title: "Real Madrid vs Celta",
            url: "https://form.example/celta",
            sourceUrls: ["https://form.example/celta"],
            summary: "cancelled",
            locationText: "Madrid",
            eventAt: "2026-06-01T17:00:00Z",
            attributes: { status: "cancelled" },
            retrievalOk: true,
          },
        ],
        ["https://form.example/celta"],
      ),
    });
    expect(cancelled.notify.shouldNotify).toBe(false);
    expect(cancelled.nextPrecise).toBeNull();
    const st = Object.values(cancelled.monitorState.items)[0];
    expect(st?.status).toBe("cancelled");
  });

  it("C4: catch-up inside grace notifies once; past grace → missed", async () => {
    const eventAt = "2026-06-01T17:00:00Z";
    const precise = new Date("2026-06-01T16:00:00Z");
    expect(
      isWithinPreciseCatchUp({
        now: new Date("2026-06-01T16:30:00Z"),
        preciseFireAt: precise,
        eventAtIso: eventAt,
      }),
    ).toBe(true);
    expect(
      isPastPreciseGrace({
        now: new Date(Date.parse(eventAt) + UWM_PRECISE_GRACE_MS + 1),
        eventAtIso: eventAt,
      }),
    ).toBe(true);

    const seeded = await pollWebMonitor({
      reminderId: "c4",
      userId: "u",
      composeCondition: leagueSpec({
        objectives: [{ id: "p1", kind: "time_before_event", minutesBefore: 60 }],
      }),
      monitorState: { version: 1, items: {}, boundSources: [], sourcePlan: emptyPlan },
      watchOnce: false,
      skipExternalCache: true,
      now: new Date("2026-06-01T12:00:00Z"),
      searchImpl: fixtureSearch(
        [
          {
            title: "Real Madrid vs Getafe",
            url: "https://form.example/get",
            sourceUrls: ["https://form.example/get"],
            summary: "Real Madrid",
            locationText: "Madrid",
            eventAt,
            retrievalOk: true,
          },
        ],
        ["https://form.example/get"],
      ),
    });

    const catchUp = await pollWebMonitor({
      reminderId: "c4",
      userId: "u",
      composeCondition: leagueSpec({
        objectives: [{ id: "p1", kind: "time_before_event", minutesBefore: 60 }],
      }),
      monitorState: seeded.monitorState,
      watchOnce: false,
      skipExternalCache: true,
      preciseOnly: true,
      now: new Date("2026-06-01T16:20:00Z"),
      searchImpl: fixtureSearch(
        [
          {
            title: "Real Madrid vs Getafe",
            url: "https://form.example/get",
            sourceUrls: ["https://form.example/get"],
            summary: "Real Madrid",
            locationText: "Madrid",
            eventAt,
            retrievalOk: true,
          },
        ],
        ["https://form.example/get"],
      ),
    });
    expect(catchUp.notify.shouldNotify).toBe(true);

    // Fresh item past grace
    const late = await pollWebMonitor({
      reminderId: "c4b",
      userId: "u",
      composeCondition: leagueSpec({
        objectives: [{ id: "p1", kind: "time_before_event", minutesBefore: 60 }],
      }),
      monitorState: {
        version: 1,
        items: {},
        boundSources: [],
        sourcePlan: emptyPlan,
        nextPrecise: {
          itemId: "pending",
          objectiveId: "p1",
          minutesBefore: 60,
          fireAtIso: precise.toISOString(),
          eventAtIso: eventAt,
        },
      },
      watchOnce: false,
      skipExternalCache: true,
      preciseOnly: true,
      now: new Date(Date.parse(eventAt) + UWM_PRECISE_GRACE_MS + 60_000),
      searchImpl: fixtureSearch(
        [
          {
            title: "Real Madrid vs Getafe",
            url: "https://form.example/get",
            sourceUrls: ["https://form.example/get"],
            summary: "Real Madrid",
            locationText: "Madrid",
            eventAt,
            retrievalOk: true,
          },
        ],
        ["https://form.example/get"],
      ),
    });
    expect(late.notify.shouldNotify).toBe(false);
    expect(late.notify.reason).toBe("missed");
    const lateItem = Object.values(late.monitorState.items)[0];
    expect(lateItem?.notified[phaseMissed("p1", 60)]).toBeTruthy();
  });

  it("multi-item: two events arm independent nextPrecise (earliest first)", async () => {
    const now = new Date("2026-06-01T10:00:00Z");
    const r = await pollWebMonitor({
      reminderId: "multi",
      userId: "u",
      composeCondition: leagueSpec({
        objectives: [{ id: "p1", kind: "time_before_event", minutesBefore: 60 }],
      }),
      monitorState: { version: 1, items: {}, boundSources: [], sourcePlan: emptyPlan },
      watchOnce: false,
      skipExternalCache: true,
      now,
      searchImpl: fixtureSearch(
        [
          {
            title: "Real Madrid vs Opp A",
            url: "https://f.example/a",
            sourceUrls: ["https://f.example/a"],
            summary: "Real Madrid",
            locationText: "Madrid",
            eventAt: "2026-06-01T20:00:00Z",
            retrievalOk: true,
          },
          {
            title: "Real Madrid vs Opp B",
            url: "https://f.example/b",
            sourceUrls: ["https://f.example/b"],
            summary: "Real Madrid",
            locationText: "Barcelona",
            eventAt: "2026-06-02T18:00:00Z",
            retrievalOk: true,
          },
        ],
        ["https://f.example/a", "https://f.example/b"],
      ),
    });
    expect(Object.keys(r.monitorState.items).length).toBe(2);
    expect(r.nextPrecise?.eventAtIso).toBe("2026-06-01T20:00:00Z");
    expect(r.nextPrecise?.fireAtIso).toBe(
      new Date("2026-06-01T19:00:00Z").toISOString(),
    );

    // After notifying first, nextPrecise moves to second
    const afterFirst = await pollWebMonitor({
      reminderId: "multi",
      userId: "u",
      composeCondition: leagueSpec({
        objectives: [{ id: "p1", kind: "time_before_event", minutesBefore: 60 }],
      }),
      monitorState: r.monitorState,
      watchOnce: false,
      skipExternalCache: true,
      preciseOnly: true,
      now: new Date("2026-06-01T19:00:00Z"),
      searchImpl: fixtureSearch(
        [
          {
            title: "Real Madrid vs Opp A",
            url: "https://f.example/a",
            sourceUrls: ["https://f.example/a"],
            summary: "Real Madrid",
            locationText: "Madrid",
            eventAt: "2026-06-01T20:00:00Z",
            retrievalOk: true,
          },
          {
            title: "Real Madrid vs Opp B",
            url: "https://f.example/b",
            sourceUrls: ["https://f.example/b"],
            summary: "Real Madrid",
            locationText: "Barcelona",
            eventAt: "2026-06-02T18:00:00Z",
            retrievalOk: true,
          },
        ],
        ["https://f.example/a", "https://f.example/b"],
      ),
    });
    expect(afterFirst.notify.shouldNotify).toBe(true);
    expect(afterFirst.nextPrecise?.eventAtIso).toBe("2026-06-02T18:00:00Z");
  });

  it("computeNextPrecise skips unverified / cancelled", () => {
    const now = new Date();
    const next = computeNextPrecise({
      now,
      objectives: [{ id: "p1", kind: "time_before_event", minutesBefore: 60 }],
      items: {
        a: {
          firstSeenAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          contentFp: "1",
          eventAt: new Date(now.getTime() + 5 * 3600_000).toISOString(),
          evidenceGrade: "unverified",
          notified: {},
          status: "active",
        },
        b: {
          firstSeenAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          contentFp: "2",
          eventAt: new Date(now.getTime() + 6 * 3600_000).toISOString(),
          evidenceGrade: "observed",
          notified: {},
          status: "cancelled",
        },
      },
    });
    expect(next).toBeNull();
    expect(shaContent(["x"])).toHaveLength(32);
  });
});
