import { beforeEach, describe, expect, it } from "vitest";
import type { LlmWebMonitorCondition } from "@workee/shared";
import { listUwmRegistryEntries } from "../src/services/uwm-provider-registry.js";
import {
  requiredFacetsForWatch,
  selectSourcesForWatch,
  semanticFitScore,
} from "../src/services/uwm-source-selector.js";
import {
  countUwmMetrics,
  listUwmMetrics,
  resetUwmMetrics,
} from "../src/services/uwm-retrieval-metrics.js";
import { resolveWatchOnceForWebMonitor } from "../src/services/reminder.service.js";

function spec(
  partial: Partial<LlmWebMonitorCondition> &
    Pick<LlmWebMonitorCondition, "intent" | "canonicalQuery" | "objectives">,
): LlmWebMonitorCondition {
  return {
    type: "web_monitor",
    ...partial,
  };
}

describe("UWM Phase 2 SourceSelector (offline)", () => {
  beforeEach(() => {
    resetUwmMetrics();
  });

  it("registry seeds existing providers + web_search fallback", () => {
    const ids = listUwmRegistryEntries().map((e) => e.id);
    expect(ids).toContain("web_search");
    expect(ids).toContain("market");
    expect(ids).toContain("weather");
    expect(ids).toContain("flights");
    expect(ids).not.toContain("concerts");
    expect(ids).not.toContain("real_madrid");
  });

  it("watch_once defaults false for ongoing web_monitor (Phase 1 audit)", () => {
    expect(
      resolveWatchOnceForWebMonitor({
        condition: { type: "web_monitor" },
        proposedWatchOnce: true,
        watchOnceExplicit: false,
      }),
    ).toBe(false);
    expect(
      resolveWatchOnceForWebMonitor({
        condition: { type: "web_monitor" },
        proposedWatchOnce: true,
        watchOnceExplicit: true,
      }),
    ).toBe(true);
  });

  it("full API coverage skips planned web search (market price change)", async () => {
    const watch = spec({
      intent: "תעדכני כששער הדולר משתנה",
      canonicalQuery: "USD ILS dollar exchange rate",
      constraints: { entities: ["דולר"] },
      objectives: [
        { id: "o1", kind: "detect_change", changeAspects: ["price"] },
      ],
    });
    const plan = await selectSourcesForWatch(watch);
    expect(plan.coverage).toBe("full");
    expect(plan.useWebDiscovery).toBe(false);
    expect(plan.reason).toBe("api_full");
    expect(plan.primary.some((p) => p.id === "market" || p.id === "fx")).toBe(
      true,
    );
    expect(plan.primary.some((p) => p.id === "web_search")).toBe(false);
    expect(
      countUwmMetrics("web_search", (e) => e.fields.planned === true),
    ).toBe(0);
    expect(
      countUwmMetrics("api_call", (e) => e.fields.planned === true),
    ).toBeGreaterThan(0);
  });

  it("partial coverage combines API + web when eventAt uncovered", async () => {
    const watch = spec({
      intent: "מחיר המניה וגם מתי האירוע הבא של החברה",
      canonicalQuery: "SOLT stock price and next company event date",
      constraints: { entities: ["SOLT"] },
      objectives: [
        { id: "o_price", kind: "detect_change", changeAspects: ["price"] },
        { id: "o_pre", kind: "time_before_event", minutesBefore: 60 },
      ],
    });
    const facets = requiredFacetsForWatch(watch);
    expect(facets).toContain("eventAt");
    expect(facets).toContain("contentFp");
    const plan = await selectSourcesForWatch(watch);
    expect(plan.coverage).toBe("partial");
    expect(plan.useWebDiscovery).toBe(true);
    expect(plan.reason).toBe("api_partial_plus_web");
    expect(plan.primary.some((p) => p.kind === "api")).toBe(true);
    expect(plan.primary.some((p) => p.id === "web_search")).toBe(true);
    expect(plan.facetCoverage.eventAt).toBe("web");
  });

  it("no suitable API → web_only for open concert monitoring", async () => {
    const watch = spec({
      intent: "תעדכני אותי כשיש הופעה של שלמה ארצי במרכז",
      canonicalQuery: "שלמה ארצי הופעות מרכז הארץ",
      constraints: { entities: ["שלמה ארצי"], geo: "מרכז הארץ" },
      objectives: [{ id: "o_discover", kind: "discover_new" }],
    });
    const plan = await selectSourcesForWatch(watch);
    expect(plan.coverage).toBe("none");
    expect(plan.useWebDiscovery).toBe(true);
    expect(["web_only", "memory_reuse"]).toContain(plan.reason);
    expect(plan.primary.map((p) => p.id)).toContain("web_search");
    // sports example_only must not win just because of "match"/schedule tags
    expect(plan.primary.some((p) => p.id === "sports")).toBe(false);
  });

  it("semantic fit prefers capability summary over loose tag overlap", () => {
    const watch = spec({
      intent: "מתי הטיסה שלי LY831 ממריאה",
      canonicalQuery: "flight LY831 departure status",
      constraints: { entities: ["LY831"] },
      objectives: [
        { id: "o1", kind: "detect_change", changeAspects: ["status"] },
      ],
    });
    const flights = listUwmRegistryEntries().find((e) => e.id === "flights")!;
    const market = listUwmRegistryEntries().find((e) => e.id === "market")!;
    expect(semanticFitScore(flights, watch)).toBeGreaterThan(
      semanticFitScore(market, watch),
    );
  });

  it("records select metrics", async () => {
    await selectSourcesForWatch(
      spec({
        intent: "משהו כללי באינטרנט",
        canonicalQuery: "random public fact monitor",
        objectives: [{ id: "d", kind: "discover_new" }],
      }),
    );
    expect(listUwmMetrics().some((e) => e.kind === "select")).toBe(true);
  });
});
