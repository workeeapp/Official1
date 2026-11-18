/**
 * UWM SourceSelector — capability-based plan for a web_monitor WatchSpec.
 * Tags alone are never sufficient; facets + bindability + summary fit decide.
 */
import type { LlmWebMonitorCondition, LlmWebMonitorObjective } from "@workee/shared";
import {
  getUwmRegistryEntry,
  listUwmRegistryEntries,
  type UwmFacet,
  type UwmRegistryEntry,
} from "./uwm-provider-registry.js";
import { recordUwmMetric } from "./uwm-retrieval-metrics.js";
import {
  findSourceMemoryHints,
  type SourceMemoryProfile,
} from "./uwm-source-memory.js";

export type UwmSourceRef = {
  id: string;
  kind: "api" | "web_search" | "memory";
  score: number;
};

export type UwmSourcePlan = {
  coverage: "full" | "partial" | "none";
  primary: UwmSourceRef[];
  secondary: UwmSourceRef[];
  useWebDiscovery: boolean;
  facetCoverage: Record<string, "api" | "web" | "uncovered">;
  reliabilityExpect: "high" | "medium" | "low";
  reason:
    | "api_full"
    | "api_partial_plus_web"
    | "web_only"
    | "memory_reuse"
    | "api_fail_fallback";
  decidedAt: string;
  requiredFacets: UwmFacet[];
};

const FACET_SYNONYMS: Record<string, UwmFacet[]> = {
  event: ["eventAt"],
  events: ["eventAt"],
  kickoff: ["eventAt"],
  showtime: ["eventAt"],
  broadcast: ["eventAt"],
  deadline: ["eventAt"],
  date: ["eventAt"],
  time: ["eventAt"],
  when: ["eventAt"],
  venue: ["locationText"],
  place: ["locationText"],
  city: ["locationText"],
  region: ["locationText"],
  geo: ["locationText"],
  location: ["locationText"],
  price: ["price"],
  quote: ["price"],
  ticker: ["price"],
  weather: ["weather"],
  rain: ["weather"],
  flight: ["flightStatus", "eventAt"],
  departure: ["flightStatus", "eventAt"],
  change: ["contentFp"],
  policy: ["contentFp", "url", "title"],
  publication: ["title", "url", "contentFp"],
  concert: ["title", "eventAt", "locationText", "url"],
  performance: ["title", "eventAt", "locationText", "url"],
  match: ["title", "eventAt", "locationText"],
  fixture: ["title", "eventAt"],
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/** Facets required by objectives + constraints (not user-domain enums). */
export function requiredFacetsForWatch(
  spec: LlmWebMonitorCondition,
): UwmFacet[] {
  const facets = new Set<UwmFacet>(["title"]);
  for (const obj of spec.objectives) {
    addObjectiveFacets(obj, facets);
  }
  const blob = [
    spec.intent,
    spec.canonicalQuery,
    spec.constraints?.geo ?? "",
    ...(spec.constraints?.entities ?? []),
    ...(spec.constraints?.timeWindow ? [spec.constraints.timeWindow] : []),
  ].join(" ");
  for (const token of tokenize(blob)) {
    const mapped = FACET_SYNONYMS[token];
    if (mapped) {
      for (const f of mapped) facets.add(f);
    }
  }
  if (spec.constraints?.geo) {
    facets.add("locationText");
  }
  return [...facets];
}

function addObjectiveFacets(
  obj: LlmWebMonitorObjective,
  facets: Set<UwmFacet>,
): void {
  if (obj.kind === "discover_new") {
    facets.add("title");
    facets.add("url");
    facets.add("open_web");
  }
  if (obj.kind === "detect_change") {
    // Structured APIs may fingerprint without a page URL.
    facets.add("contentFp");
    if (obj.changeAspects?.some((a) => /price|quote|שער|מחיר/i.test(a))) {
      facets.add("price");
    }
  }
  if (obj.kind === "time_before_event") {
    facets.add("eventAt");
    facets.add("title");
  }
}

function constraintsSatisfyHint(
  spec: LlmWebMonitorCondition,
  hint: string,
): boolean {
  const entities = (spec.constraints?.entities ?? []).map((e) =>
    e.toLowerCase(),
  );
  const geo = (spec.constraints?.geo ?? "").toLowerCase();
  const blob = `${spec.intent} ${spec.canonicalQuery} ${entities.join(" ")} ${geo}`.toLowerCase();
  switch (hint) {
    case "symbol":
      return (
        entities.some((e) => /usd|eur|ils|ticker|symbol|דולר|יורו|מניה|solt/i.test(e)) ||
        /דולר|יורו|usd|eur|ticker|שער/.test(blob)
      );
    case "place":
      return Boolean(geo) || /מזג|weather|תל אביב|ירושלים|city|עיר/.test(blob);
    case "place_or_query":
      return Boolean(geo) || entities.length > 0 || blob.length > 8;
    case "flight":
      return (
        entities.some((e) => /ly\d+|[a-z]{2}\d+/i.test(e)) ||
        /טיסה|flight\s*[a-z0-9]/i.test(blob)
      );
    case "team":
      return (
        entities.length > 0 ||
        /קבוצ|נבחרת|madrid|team|ריאל|מכבי/.test(blob)
      );
    default:
      return true;
  }
}

function isBindable(entry: UwmRegistryEntry, spec: LlmWebMonitorCondition): boolean {
  if (!entry.enabled) return false;
  if (entry.reliabilityBase === "example_only" && !entry.liveRefresh) {
    return false;
  }
  if (!entry.liveRefresh && entry.id !== "web_search") {
    return false;
  }
  return entry.inputSchemaHints.every((h) => constraintsSatisfyHint(spec, h));
}

/** Provider theme tokens (HE/EN) for semantic fit beyond English summaries. */
const PROVIDER_THEME_TOKENS: Record<string, string[]> = {
  market: [
    "price",
    "quote",
    "ticker",
    "stock",
    "דולר",
    "יורו",
    "שער",
    "מניה",
    "מחיר",
    "בורסה",
  ],
  fx: ["fx", "forex", "usd", "eur", "דולר", "יורו", "שער", "מטבע"],
  weather: ["weather", "forecast", "rain", "מזג", "גשם", "טמפרטורה", "חום"],
  flights: [
    "flight",
    "airport",
    "departure",
    "arrival",
    "טיסה",
    "המראה",
    "נחיתה",
    "נתבג",
  ],
  places: ["place", "restaurant", "hours", "עסק", "מסעדה", "שעות", "חניון"],
  sports: ["sports", "match", "fixture", "league", "משחק", "ליגה", "קבוצה"],
  web_search: ["web", "search", "internet", "אינטרנט", "חיפוש"],
};

/** Semantic fit of capability vs intent — not tag equality. */
export function semanticFitScore(
  entry: UwmRegistryEntry,
  spec: LlmWebMonitorCondition,
): number {
  const intentBlob = `${spec.intent} ${spec.canonicalQuery}`.toLowerCase();
  const intentTokens = new Set(tokenize(intentBlob));
  const summaryTokens = new Set([
    ...tokenize(entry.capabilitySummary),
    ...(PROVIDER_THEME_TOKENS[entry.id] ?? []),
  ]);
  if (intentTokens.size === 0) return 0;
  let hit = 0;
  for (const t of intentTokens) {
    if (summaryTokens.has(t)) hit += 1;
    const facets = FACET_SYNONYMS[t];
    if (facets?.some((f) => entry.outputFacets.includes(f))) {
      hit += 1.5;
    }
  }
  for (const theme of PROVIDER_THEME_TOKENS[entry.id] ?? []) {
    if (theme.length >= 3 && intentBlob.includes(theme)) {
      hit += 0.75;
    }
  }
  // Bindable structured providers get a floor when their input hints match.
  if (
    entry.costClass === "api" &&
    entry.inputSchemaHints.some((h) => constraintsSatisfyHint(spec, h)) &&
    entry.inputSchemaHints.length > 0
  ) {
    hit += 1;
  }
  // Negative: open-web discovery vs narrow structured API without event facets
  const wantsOpenWeb =
    spec.objectives.some(
      (o) => o.kind === "discover_new" || o.kind === "time_before_event",
    ) &&
    !constraintsSatisfyHint(spec, "symbol") &&
    !constraintsSatisfyHint(spec, "flight");
  if (wantsOpenWeb && entry.costClass === "api" && entry.id !== "web_search") {
    if (
      !entry.outputFacets.includes("eventAt") &&
      !entry.outputFacets.includes("open_web")
    ) {
      hit -= 2;
    }
  }
  // Tag overlap is a weak boost only
  const tagBoost = entry.capabilityTags.some((tag) =>
    tokenize(tag).some((t) => intentTokens.has(t)),
  )
    ? 0.25
    : 0;
  return hit + tagBoost;
}

function reliabilityRank(
  entry: UwmRegistryEntry,
  memory?: SourceMemoryProfile | null,
): number {
  const base =
    entry.reliabilityBase === "high"
      ? 1
      : entry.reliabilityBase === "medium"
        ? 0.7
        : entry.reliabilityBase === "low"
          ? 0.4
          : 0.1;
  if (memory) {
    return Math.min(1, (base + memory.reliabilityScore) / 2);
  }
  return base;
}

function expectReliability(
  entries: UwmRegistryEntry[],
): "high" | "medium" | "low" {
  if (entries.some((e) => e.reliabilityBase === "high" && e.liveRefresh)) {
    return "high";
  }
  if (entries.some((e) => e.reliabilityBase === "medium")) {
    return "medium";
  }
  return "low";
}

/**
 * Build a SourcePlan for a web_monitor WatchSpec.
 * Missing providers never reject — falls back to web_search.
 */
export async function selectSourcesForWatch(
  spec: LlmWebMonitorCondition,
): Promise<UwmSourcePlan> {
  const required = requiredFacetsForWatch(spec);
  const memoryHints = await findSourceMemoryHints(
    spec.preferredSources ?? [],
  );
  const registry = listUwmRegistryEntries().filter((e) => e.id !== "web_search");
  const web = getUwmRegistryEntry("web_search")!;

  const candidates = registry
    .filter((e) => isBindable(e, spec))
    .map((e) => {
      const mem = memoryHints.find(
        (m) => m.sourceId === e.id || m.infoKinds.includes(e.id),
      );
      const fit = semanticFitScore(e, spec);
      const score = fit * 2 + reliabilityRank(e, mem);
      return { entry: e, fit, score, mem };
    })
    .filter((c) => c.fit > 0.5)
    .sort((a, b) => b.score - a.score);

  const facetCoverage: Record<string, "api" | "web" | "uncovered"> = {};
  for (const f of required) {
    facetCoverage[f] = "uncovered";
  }

  const apiCovered = new Set<UwmFacet>();
  const primaryApi: UwmSourceRef[] = [];
  for (const c of candidates) {
    let contributed = false;
    for (const f of required) {
      if (
        c.entry.outputFacets.includes(f) &&
        facetCoverage[f] === "uncovered"
      ) {
        facetCoverage[f] = "api";
        apiCovered.add(f);
        contributed = true;
      }
    }
    if (contributed) {
      primaryApi.push({
        id: c.entry.id,
        kind: "api",
        score: c.score,
      });
    }
    if (required.every((f) => facetCoverage[f] === "api")) {
      break;
    }
  }

  const uncovered = required.filter((f) => facetCoverage[f] === "uncovered");
  let coverage: UwmSourcePlan["coverage"];
  let useWebDiscovery: boolean;
  let reason: UwmSourcePlan["reason"];
  const primary: UwmSourceRef[] = [...primaryApi];
  const secondary: UwmSourceRef[] = [];

  if (uncovered.length === 0 && primaryApi.length > 0) {
    coverage = "full";
    useWebDiscovery = false;
    reason = "api_full";
  } else if (primaryApi.length > 0 && uncovered.length > 0) {
    coverage = "partial";
    useWebDiscovery = true;
    reason = "api_partial_plus_web";
    for (const f of uncovered) {
      facetCoverage[f] = "web";
    }
    primary.push({ id: "web_search", kind: "web_search", score: 1 });
  } else {
    coverage = "none";
    useWebDiscovery = true;
    reason =
      memoryHints.length > 0 ? "memory_reuse" : "web_only";
    for (const f of required) {
      facetCoverage[f] = "web";
    }
    primary.push({ id: "web_search", kind: "web_search", score: 1 });
    for (const m of memoryHints.slice(0, 3)) {
      secondary.push({
        id: m.domain ?? m.sourceId,
        kind: "memory",
        score: m.reliabilityScore,
      });
    }
  }

  // Prefer memory domains as secondary hints under web path (keep coverage reason).
  if (useWebDiscovery && memoryHints.length > 0) {
    if (reason === "web_only") {
      reason = "memory_reuse";
    }
    for (const m of memoryHints.slice(0, 3)) {
      if (!secondary.some((s) => s.id === (m.domain ?? m.sourceId))) {
        secondary.push({
          id: m.domain ?? m.sourceId,
          kind: "memory",
          score: m.reliabilityScore,
        });
      }
    }
  }

  const plan: UwmSourcePlan = {
    coverage,
    primary,
    secondary,
    useWebDiscovery,
    facetCoverage,
    reliabilityExpect: expectReliability(
      useWebDiscovery && primaryApi.length === 0
        ? [web]
        : primaryApi.map((p) => getUwmRegistryEntry(p.id)!).filter(Boolean),
    ),
    reason,
    decidedAt: new Date().toISOString(),
    requiredFacets: required,
  };

  recordUwmMetric("select", {
    coverage: plan.coverage,
    reason: plan.reason,
    useWeb: plan.useWebDiscovery,
    primary: plan.primary.map((p) => p.id).join(","),
    facets: required.join(","),
  });
  if (plan.useWebDiscovery) {
    recordUwmMetric("web_search", {
      planned: true,
      reason: plan.reason,
    });
  } else {
    for (const p of plan.primary) {
      recordUwmMetric("api_call", {
        planned: true,
        provider: p.id,
        executed: false,
      });
    }
  }

  return plan;
}
