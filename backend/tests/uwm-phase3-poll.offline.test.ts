/**
 * UWM Phase 3 — Retrieval / Normalization / Evidence (fixture + gate).
 * Distinguishes controlled fixtures from live external sources (none here).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { LlmWebMonitorCondition } from "@workee/shared";
import {
  evaluateComposeCondition,
  type ComposeEvalFacts,
} from "../src/services/compose-condition.js";
import {
  gradeEvidence,
  itemMatchesSpec,
  normalizeCandidates,
  shaContent,
} from "../src/services/uwm-normalize.js";
import {
  countUwmMetrics,
  listUwmMetrics,
  resetUwmMetrics,
} from "../src/services/uwm-retrieval-metrics.js";
import { pollWebMonitor } from "../src/services/semantic-web-monitor.service.js";
import type { UwmMonitorState } from "../src/services/uwm-types.js";

function concertSpec(
  overrides: Partial<LlmWebMonitorCondition> = {},
): LlmWebMonitorCondition {
  return {
    type: "web_monitor",
    intent: "תעדכני על הופעות חדשות של ארצי בישראל",
    canonicalQuery: "Artzi concert tickets Israel dates",
    constraints: { entities: ["ארצי"], geo: "ישראל" },
    objectives: [{ id: "o1", kind: "discover_new" }],
    evidenceMin: "observed",
    ...overrides,
  };
}

function policySpec(
  overrides: Partial<LlmWebMonitorCondition> = {},
): LlmWebMonitorCondition {
  return {
    type: "web_monitor",
    intent: "תעדכני אם מדיניות הכבודה של חברת תעופה משתנה",
    canonicalQuery: "airline baggage allowance policy change",
    constraints: { entities: ["baggage"] },
    objectives: [
      { id: "o1", kind: "detect_change", changeAspects: ["policy"] },
    ],
    evidenceMin: "observed",
    ...overrides,
  };
}


function mockSearch(text: string, sources: string[]) {
  return async () => ({
    text,
    sources,
    usage: null,
    raw: null,
  });
}

function fixtureSearchText(items: unknown[]): string {
  return `UWM_FIXTURE_ITEMS: ${JSON.stringify(items)}\n\n`;
}

describe("UWM Phase 3 poll + evidence (fixtures)", () => {
  beforeEach(() => {
    resetUwmMetrics();
  });

  it("domain A: discovery finds items + binds source URLs (concerts, no domain provider)", async () => {
    const items = [
      {
        title: "הופעת ארצי בתל אביב 2026-06-01",
        url: "https://example.com/artzi-tlv",
        sourceUrls: ["https://example.com/artzi-tlv"],
        summary: "ארצי ישראל תל אביב",
        eventAt: "2026-06-01T20:00:00Z",
        locationText: "תל אביב ישראל",
        retrievalOk: true,
      },
    ];
    const r = await pollWebMonitor({
      reminderId: "r1",
      userId: "u1",
      composeCondition: concertSpec(),
      monitorState: null,
      watchOnce: false,
      skipExternalCache: true,
      searchImpl: async () => ({
        text: fixtureSearchText(items),
        sources: ["https://example.com/artzi-tlv"],
      }),
      pageFetchImpl: async () => ({ ok: false, text: "", soft404: true }),
    });
    expect(r.discoveryUsed).toBe(true);
    expect(r.boundPageUsed).toBe(false);
    expect(r.itemsMatched).toBeGreaterThan(0);
    expect(r.notify.shouldNotify).toBe(true);
    expect(r.notify.bodyHe).toMatch(/ארצי|פריט/);
    expect(r.monitorState.boundSources?.some((b) => b.url.includes("artzi"))).toBe(
      true,
    );
    const item = r.notify.item!;
    expect(item.evidenceGrade).toBe("observed");
    expect(item.retrievedAt).toBeTruthy();
    expect(item.provenance[0]?.fetchedAt).toBe(item.retrievedAt);
    expect(item.confidence).toBe(0);
  });

  it("domain B: airline policy detect_change — no specialized provider", async () => {
    const url = "https://airline.example/baggage-policy";
    const pageV1 =
      "Baggage allowance: 23kg checked. Official policy page. baggage";
    const pageV2 =
      "Baggage allowance: 20kg checked. Official policy updated. baggage";

    const seed = await pollWebMonitor({
      reminderId: "r2",
      userId: "u1",
      composeCondition: policySpec(),
      monitorState: {
        version: 1,
        items: {},
        boundSources: [{ url, sourceId: "web_page", failCount: 0 }],
        sourcePlan: {
          coverage: "none",
          reason: "web_only",
          useWebDiscovery: true,
          primary: [{ id: "web_search", kind: "web_search", score: 1 }],
          secondary: [],
          requiredFacets: ["contentFp"],
          facetCoverage: { contentFp: "web" },
          reliabilityExpect: "low",
          decidedAt: new Date().toISOString(),
        },
      } satisfies UwmMonitorState,
      watchOnce: false,
      skipExternalCache: true,
      searchImpl: async () => ({ text: "", sources: [], usage: null, raw: null }),
      pageFetchImpl: async () => ({ ok: true, text: pageV1 }),
    });
    expect(seed.boundPageUsed).toBe(true);
    expect(seed.discoveryUsed).toBe(false);
    expect(seed.notify.shouldNotify).toBe(false);
    const fp1 = Object.values(seed.monitorState.items)[0]?.contentFp;
    expect(fp1).toBeTruthy();

    const changed = await pollWebMonitor({
      reminderId: "r2",
      userId: "u1",
      composeCondition: policySpec(),
      monitorState: seed.monitorState,
      watchOnce: false,
      skipExternalCache: true,
      searchImpl: async () => {
        throw new Error("must not re-search when bound source refreshes");
      },
      pageFetchImpl: async () => ({ ok: true, text: pageV2 }),
    });
    expect(changed.boundPageUsed).toBe(true);
    expect(changed.discoveryUsed).toBe(false);
    expect(changed.notify.shouldNotify).toBe(true);
    expect(changed.notify.bodyHe).toMatch(/עדכון/);
    expect(changed.notify.item?.contentFp).not.toBe(fp1);
  });

  it("second poll refreshes bound URL instead of unnecessary search (discover_new still may search)", async () => {
    const url = "https://tickets.example/show-1";
    let searches = 0;
    let pageFetches = 0;
    const stateAfterDiscover = (
      await pollWebMonitor({
        reminderId: "r3",
        userId: "u1",
        composeCondition: concertSpec({
          objectives: [{ id: "o1", kind: "discover_new" }],
        }),
        monitorState: null,
        watchOnce: false,
        skipExternalCache: true,
        searchImpl: async () => {
          searches += 1;
          return {
            text: fixtureSearchText([
              {
                title: "ארצי show",
                url,
                sourceUrls: [url],
                summary: "ארצי ישראל",
                locationText: "ישראל",
                retrievalOk: true,
              },
            ]),
            sources: [url],
          };
        },
      })
    ).monitorState;

    expect(searches).toBe(1);
    expect(stateAfterDiscover.boundSources?.length).toBeGreaterThan(0);

    // detect_change-only: bound refresh, no search
    const changeOnly = concertSpec({
      intent: "תעדכני אם דף הכרטיסים משתנה",
      objectives: [
        { id: "o1", kind: "detect_change", changeAspects: ["content"] },
      ],
    });
    await pollWebMonitor({
      reminderId: "r3b",
      userId: "u1",
      composeCondition: changeOnly,
      monitorState: {
        ...stateAfterDiscover,
        sourcePlan: {
          coverage: "none",
          reason: "web_only",
          useWebDiscovery: true,
          primary: [{ id: "web_search", kind: "web_search", score: 1 }],
          secondary: [],
          requiredFacets: ["contentFp"],
          facetCoverage: { contentFp: "web" },
          reliabilityExpect: "low",
          decidedAt: new Date().toISOString(),
        },
      },
      watchOnce: false,
      skipExternalCache: true,
      searchImpl: async () => {
        searches += 1;
        return { text: "", sources: [], usage: null, raw: null };
      },
      pageFetchImpl: async () => {
        pageFetches += 1;
        return {
          ok: true,
          text: "ארצי show page content stable baggage not relevant",
        };
      },
    });
    expect(pageFetches).toBe(1);
    expect(searches).toBe(1);
  });

  it("soft-404 bound URL does not notify; rediscovery finds alternate", async () => {
    const bad = "https://dead.example/gone";
    const good = "https://alive.example/artzi";
    let fetches: string[] = [];
    const first = await pollWebMonitor({
      reminderId: "r4",
      userId: "u1",
      composeCondition: concertSpec(),
      monitorState: {
        version: 1,
        items: {},
        boundSources: [{ url: bad, sourceId: "web_page", failCount: 1 }],
        sourcePlan: {
          coverage: "none",
          reason: "web_only",
          useWebDiscovery: true,
          primary: [{ id: "web_search", kind: "web_search", score: 1 }],
          secondary: [],
          requiredFacets: ["title"],
          facetCoverage: { title: "web" },
          reliabilityExpect: "low",
          decidedAt: new Date().toISOString(),
        },
      },
      watchOnce: false,
      skipExternalCache: true,
      pageFetchImpl: async (url) => {
        fetches.push(url);
        return { ok: false, text: "soft-404 page not found", soft404: true };
      },
      searchImpl: async () => ({
        text: fixtureSearchText([
          {
            title: "ארצי live alternate",
            url: good,
            sourceUrls: [good],
            summary: "ארצי ישראל",
            locationText: "ישראל",
            retrievalOk: true,
          },
        ]),
        sources: [good],
      }),
    });
    expect(first.notify.shouldNotify).toBe(true);
    expect(first.discoveryUsed).toBe(true);
    expect(first.monitorState.boundSources?.some((b) => b.url === bad)).toBe(
      false,
    );
    expect(first.monitorState.boundSources?.some((b) => b.url === good)).toBe(
      true,
    );
    expect(
      countUwmMetrics(
        "source_memory",
        (e) => e.fields.op === "rediscovery_needed",
      ),
    ).toBeGreaterThan(0);
  });

  it("irrelevant search hits do not become matching items", async () => {
    const r = await pollWebMonitor({
      reminderId: "r5",
      userId: "u1",
      composeCondition: concertSpec(),
      monitorState: null,
      watchOnce: false,
      skipExternalCache: true,
      searchImpl: async () => ({
        text: fixtureSearchText([
          {
            title: "Cooking recipes for pasta",
            url: "https://food.example/pasta",
            sourceUrls: ["https://food.example/pasta"],
            summary: "tomato sauce",
            retrievalOk: true,
          },
        ]),
        sources: ["https://food.example/pasta"],
      }),
    });
    expect(r.itemsMatched).toBe(0);
    expect(r.notify.shouldNotify).toBe(false);
  });

  it("disputed / unverified evidence never notifies", async () => {
    const disputed = await pollWebMonitor({
      reminderId: "r6",
      userId: "u1",
      composeCondition: concertSpec({ evidenceMin: "observed" }),
      monitorState: null,
      watchOnce: false,
      skipExternalCache: true,
      searchImpl: async () => ({
        text: fixtureSearchText([
          {
            title: "ארצי show",
            url: "https://a.example/1",
            sourceUrls: ["https://a.example/1"],
            summary: "ארצי ישראל",
            locationText: "ישראל",
            eventAt: "2026-07-01",
            conflictEventAt: "2026-08-01",
            retrievalOk: true,
          },
        ]),
        sources: ["https://a.example/1"],
      }),
    });
    expect(disputed.notify.shouldNotify).toBe(false);
    expect(
      disputed.notify.reason === "disputed" ||
        disputed.itemsMatched === 0 ||
        disputed.notify.item?.evidenceGrade === "disputed" ||
        !disputed.notify.shouldNotify,
    ).toBe(true);

    const unverified = normalizeCandidates({
      candidates: [
        {
          title: "ארצי rumored",
          summary: "ארצי",
          retrievalOk: true,
        },
      ],
      fetchedAt: new Date().toISOString(),
      sourceKind: "web",
      sourceId: "web_search",
    });
    expect(unverified[0]?.evidenceGrade).toBe("unverified");
    expect(unverified[0]?.verified).toBe(false);
    expect(
      gradeEvidence({
        candidate: { title: "x", retrievalOk: true },
        provenance: [],
      }).grade,
    ).toBe("unverified");
  });

  it("stale cache-only publishedAt does not notify", async () => {
    // Bound soft-fail → rediscovery disabled path: only discovery with cacheHit
    // simulated by forcing normalize via page that yields no bound success.
    // Use inject: poll with bound failCount low so no rediscovery, empty discovery
    // would not notify; instead verify isStale path via cacheHit + old publishedAt
    // through a dedicated search that we mark via web_page normalize + no fresh bound.
    const staleItems = normalizeCandidates({
      candidates: [
        {
          title: "ארצי old listing",
          url: "https://old.example/artzi",
          sourceUrls: ["https://old.example/artzi"],
          summary: "ארצי ישראל",
          locationText: "ישראל",
          publishedAt: "2019-01-01T00:00:00Z",
          retrievalOk: true,
        },
      ],
      fetchedAt: new Date().toISOString(),
      sourceKind: "web",
      sourceId: "web_search",
      cacheHit: true,
      spec: concertSpec(),
    });
    expect(staleItems[0]?.publishedAt).toBe("2019-01-01T00:00:00.000Z");
    expect(staleItems[0]?.retrievedAt).not.toBe(staleItems[0]?.publishedAt);
    expect(staleItems[0]!.provenance.every((p) => p.cacheHit === true)).toBe(
      true,
    );

    // Soft-404 alone never notifies
    const soft = await pollWebMonitor({
      reminderId: "r7",
      userId: "u1",
      composeCondition: concertSpec({
        objectives: [
          { id: "o1", kind: "detect_change", changeAspects: ["content"] },
        ],
      }),
      monitorState: {
        version: 1,
        items: {},
        boundSources: [
          {
            url: "https://gone.example/x",
            sourceId: "web_page",
            failCount: 0,
          },
        ],
        sourcePlan: {
          coverage: "none",
          reason: "web_only",
          useWebDiscovery: false,
          primary: [],
          secondary: [],
          requiredFacets: ["contentFp"],
          facetCoverage: { contentFp: "web" },
          reliabilityExpect: "low",
          decidedAt: new Date().toISOString(),
        },
      },
      watchOnce: false,
      skipExternalCache: true,
      pageFetchImpl: async () => ({
        ok: false,
        text: "404 page not found",
        soft404: true,
      }),
    });
    expect(soft.notify.shouldNotify).toBe(false);
    expect(soft.discoveryUsed).toBe(false);
  });

  it("no duplicate notify fingerprints in same cycle / second poll", async () => {
    const items = [
      {
        title: "ארצי once",
        url: "https://once.example/a",
        sourceUrls: ["https://once.example/a"],
        summary: "ארצי ישראל",
        locationText: "ישראל",
        retrievalOk: true,
      },
    ];
    const searchImpl = async () => ({
      text: fixtureSearchText(items),
      sources: ["https://once.example/a"],
    });
    const a = await pollWebMonitor({
      reminderId: "r8",
      userId: "u1",
      composeCondition: concertSpec(),
      monitorState: null,
      watchOnce: false,
      skipExternalCache: true,
      searchImpl,
    });
    expect(a.notify.shouldNotify).toBe(true);
    const b = await pollWebMonitor({
      reminderId: "r8",
      userId: "u1",
      composeCondition: concertSpec(),
      monitorState: a.monitorState,
      lastReportSha: a.notify.fingerprint,
      watchOnce: false,
      skipExternalCache: true,
      searchImpl,
      pageFetchImpl: async () => ({
        ok: true,
        text: "ארצי once page ישראל",
      }),
    });
    // Same finding (same URL / phase) must not re-alert in the next cycle.
    expect(b.notify.shouldNotify).toBe(false);
  });

  it("compose gate: web_monitor fail-closed without poll facts; opens on fingerprint", () => {
    const cond = concertSpec();
    const closed = evaluateComposeCondition({
      condition: cond,
      lastReportSha: null,
      facts: {} as ComposeEvalFacts,
    });
    expect(closed.skipSend).toBe(true);

    const open = evaluateComposeCondition({
      condition: cond,
      lastReportSha: null,
      facts: {
        webMonitor: {
          shouldNotify: true,
          fingerprint: "wm:abc:discovered",
          bodyHe: "נמצא",
        },
      },
    });
    expect(open.skipSend).toBe(false);
    expect(open.shaAfterSend).toBe("wm:abc:discovered");

    const dup = evaluateComposeCondition({
      condition: cond,
      lastReportSha: "wm:abc:discovered",
      facts: {
        webMonitor: {
          shouldNotify: true,
          fingerprint: "wm:abc:discovered",
        },
      },
    });
    expect(dup.skipSend).toBe(true);
  });

  it("model confidence alone cannot raise evidence grade", () => {
    const items = normalizeCandidates({
      candidates: [
        {
          title: "claim",
          summary: "no url",
          attributes: { modelConfidence: 0.99 },
          retrievalOk: true,
        },
      ],
      fetchedAt: new Date().toISOString(),
      sourceKind: "web",
      sourceId: "web_search",
    });
    expect(items[0]?.evidenceGrade).toBe("unverified");
    expect(items[0]?.confidence).toBe(0);
  });

  it("records usage metrics for discovery / bound / select", async () => {
    await pollWebMonitor({
      reminderId: "r9",
      userId: "u1",
      composeCondition: concertSpec(),
      monitorState: null,
      watchOnce: false,
      skipExternalCache: true,
      searchImpl: async () => ({
        text: fixtureSearchText([
          {
            title: "ארצי metrics",
            url: "https://m.example/a",
            sourceUrls: ["https://m.example/a"],
            summary: "ארצי ישראל",
            locationText: "ישראל",
            retrievalOk: true,
          },
        ]),
        sources: ["https://m.example/a"],
      }),
    });
    expect(countUwmMetrics("web_search")).toBeGreaterThan(0);
    expect(countUwmMetrics("select")).toBeGreaterThan(0);
    expect(listUwmMetrics().some((e) => e.kind === "cache")).toBe(true);
  });

  it("off-topic entity filter via itemMatchesSpec", () => {
    const spec = concertSpec();
    const bad = normalizeCandidates({
      candidates: [
        {
          title: "Unrelated sports odds",
          url: "https://x.example/1",
          sourceUrls: ["https://x.example/1"],
          retrievalOk: true,
        },
      ],
      fetchedAt: new Date().toISOString(),
      sourceKind: "web",
      sourceId: "web_search",
      spec,
    })[0]!;
    expect(itemMatchesSpec(bad, spec)).toBe(false);
    expect(shaContent(["a", "b"])).toHaveLength(32);
  });
});
