/**
 * UWM Provider Registry — technical capabilities of existing Lucy providers.
 * Not a closed list of user scenarios / product domains.
 */
import {
  getExternalLookupConfig,
  type ExternalLookupProviderId,
} from "./external-lookup.config.js";

export type UwmReliabilityBase =
  | "high"
  | "medium"
  | "low"
  | "example_only";

export type UwmCostClass = "api" | "web_search" | "local_zero";

/** Facets a NormalizedMonitorItem / Watch objective may require. */
export type UwmFacet =
  | "title"
  | "summary"
  | "url"
  | "eventAt"
  | "locationText"
  | "price"
  | "weather"
  | "flightStatus"
  | "contentFp"
  | "open_web";

export type UwmRegistryEntry = {
  id: string;
  /** Maps to ExternalLookup provider id when applicable. */
  lookupId?: ExternalLookupProviderId;
  enabled: boolean;
  liveRefresh: boolean;
  capabilityTags: string[];
  /** NL description of what this adapter can / cannot answer. */
  capabilitySummary: string;
  /** Inputs that must be bindable from WatchSpec constraints. */
  inputSchemaHints: string[];
  outputFacets: UwmFacet[];
  entityHints: string[];
  geoCoverage: string[];
  reliabilityBase: UwmReliabilityBase;
  costClass: UwmCostClass;
  quotaBurns: boolean;
  limitsNote?: string;
};

const STATIC_CAPABILITIES: Omit<
  UwmRegistryEntry,
  "enabled" | "liveRefresh" | "quotaBurns"
>[] = [
  {
    id: "web_search",
    lookupId: "web_search",
    capabilityTags: ["open_web_grounding", "discovery", "search"],
    capabilitySummary:
      "Hosted web search grounding for arbitrary public facts, events, publications, and policy pages. Can surface titles, URLs, approximate event times and locations from the open web. Not a structured live quote/board feed.",
    inputSchemaHints: [],
    outputFacets: [
      "title",
      "summary",
      "url",
      "eventAt",
      "locationText",
      "contentFp",
      "open_web",
    ],
    entityHints: [],
    geoCoverage: ["global"],
    reliabilityBase: "medium",
    costClass: "web_search",
    limitsNote: "Daily MISS quota; lexical cache keys",
  },
  {
    id: "market",
    lookupId: "market",
    capabilityTags: ["quote", "price", "ticker"],
    capabilitySummary:
      "Live market / equity quotes and daily change for a bound ticker or symbol. Cannot discover concerts, sports fixtures, airline policy pages, or general news.",
    inputSchemaHints: ["symbol"],
    outputFacets: ["price", "title", "contentFp"],
    entityHints: ["ticker", "symbol", "דולר", "יורו", "stock"],
    geoCoverage: ["global"],
    reliabilityBase: "high",
    costClass: "api",
  },
  {
    id: "fx",
    lookupId: "fx",
    capabilityTags: ["fx", "forex", "exchange_rate"],
    capabilitySummary:
      "FX / currency pair quotes (e.g. USDILS). Cannot answer non-FX open-web monitoring requests.",
    inputSchemaHints: ["symbol"],
    outputFacets: ["price", "title", "contentFp"],
    entityHints: ["usd", "eur", "דולר", "יורו", "fx"],
    geoCoverage: ["global"],
    reliabilityBase: "high",
    costClass: "api",
  },
  {
    id: "weather",
    lookupId: "weather",
    capabilityTags: ["forecast", "rain", "temperature"],
    capabilitySummary:
      "Weather forecast for a bound place/city (temp, rain). Cannot discover events, tickets, or policy documents.",
    inputSchemaHints: ["place"],
    outputFacets: ["weather", "title", "contentFp", "locationText"],
    entityHints: ["city", "place"],
    geoCoverage: ["global"],
    reliabilityBase: "high",
    costClass: "api",
  },
  {
    id: "flights",
    lookupId: "flights",
    capabilityTags: ["flight_board", "eta", "aviation"],
    capabilitySummary:
      "Airport departure/arrival board status for a bound flight number (and airport). Cannot monitor unrelated web topics or sports/concert schedules.",
    inputSchemaHints: ["flight"],
    outputFacets: ["flightStatus", "eventAt", "title", "contentFp"],
    entityHints: ["flight", "airport", "TLV"],
    geoCoverage: ["IL", "global"],
    reliabilityBase: "high",
    costClass: "api",
    limitsNote: "AviationStack board TTL ~90s",
  },
  {
    id: "places",
    lookupId: "places",
    capabilityTags: ["local_business", "hours", "maps"],
    capabilitySummary:
      "Google Places local business search (hours, rating, address) for a query/place. Not a general event discovery or sports schedule feed.",
    inputSchemaHints: ["place_or_query"],
    outputFacets: ["title", "locationText", "url", "summary"],
    entityHints: ["business", "venue"],
    geoCoverage: ["IL", "global"],
    reliabilityBase: "high",
    costClass: "api",
  },
  {
    id: "sports",
    lookupId: "sports",
    capabilityTags: ["schedule", "fixture", "match"],
    capabilitySummary:
      "Example sports schedule plumbing only. Default production path returns empty until a schedule fetcher is injected. Do not treat as a live league feed.",
    inputSchemaHints: ["team"],
    outputFacets: ["eventAt", "title", "locationText"],
    entityHints: ["team", "club"],
    geoCoverage: ["global"],
    reliabilityBase: "example_only",
    costClass: "api",
    limitsNote: "liveRefresh false until injector",
  },
];

/** Live registry snapshot seeded from External Lookup config + capability metadata. */
export function listUwmRegistryEntries(): UwmRegistryEntry[] {
  const cfg = getExternalLookupConfig();
  return STATIC_CAPABILITIES.map((base) => {
    const lookup = base.lookupId
      ? cfg.providers[base.lookupId]
      : undefined;
    return {
      ...base,
      enabled: lookup?.enabled ?? true,
      liveRefresh: lookup?.liveRefresh ?? base.id === "web_search",
      quotaBurns: lookup?.burnsQuota ?? base.costClass !== "local_zero",
    };
  });
}

export function getUwmRegistryEntry(id: string): UwmRegistryEntry | null {
  return (
    listUwmRegistryEntries().find((e) => e.id === id) ?? null
  );
}
