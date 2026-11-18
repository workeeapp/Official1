/**
 * Centralized External Lookup configuration.
 *
 * Quotas, TTL tiers, per-source overrides, default cacheScope, and feature /
 * fallback flags live here — services must not hardcode limits.
 *
 * Jewish / @hebcal/core is intentionally absent: local-only, 0 HTTP, 0 quota,
 * 0 ExternalDataCache writes.
 *
 * Retrieval → core (reminders/watches stay on Action → apply → Gates):
 * - Known event time → schedule_anchor external_event
 * - Recurring monitoring → existing refreshable compose_condition only when
 *   liveRefresh (or an injected fetcher) can re-fetch
 * - Non-refreshable → answer / one-shot Action; never a fake recurring watch
 */
import type { LlmWebLookupCacheScope } from "@workee/shared";
import {
  EXTERNAL_CACHE_TTL_SECONDS,
  type ExternalCacheTtlTier,
} from "./external-cache.service.js";

export type ExternalLookupProviderId =
  | "web_search"
  | "places"
  | "weather"
  | "market"
  | "flights"
  | "sports"
  | "fx";

export type ExternalLookupProviderConfig = {
  id: ExternalLookupProviderId;
  /** When false, callers should fail closed / skip provider HTTP. */
  enabled: boolean;
  /**
   * True when a real outbound refresh path is wired (HTTP / hosted search).
   * False = cache/watch plumbing only; fetches stay empty until a provider is
   * injected (e.g. sports schedule example). Recurring watches need
   * `liveRefresh: true` (or an injected fetcher) to observe state changes.
   */
  liveRefresh: boolean;
  /** Default ExternalDataCache ttlTier. */
  ttlTier: ExternalCacheTtlTier;
  /** Optional absolute TTL override (seconds). */
  ttlSeconds?: number;
  /** Default semantic cache scope (server may still honor per-call override). */
  defaultCacheScope: LlmWebLookupCacheScope;
  /** Burn daily MISS quota on uncached fetch when userId is set. */
  burnsQuota: boolean;
  /** Open provider/scope strings used in ExternalDataCache keys. */
  provider: string;
  scope: string;
};

export type ExternalLookupConfig = {
  /** Per-user daily uncached MISS budget (shared across quota-burning providers). */
  dailyMissQuota: number;
  /** Quota row retention (hours). */
  quotaTtlHours: number;
  /** Fallback when a provider is disabled or returns empty. */
  emptyReplyHe: string;
  quotaExceededHe: string;
  providers: Record<ExternalLookupProviderId, ExternalLookupProviderConfig>;
};

/**
 * Product defaults. Env overrides are applied in `getExternalLookupConfig`.
 * Flights (נתב״ג boards) use a short REALTIME TTL so HIT skips AviationStack.
 */
export const EXTERNAL_LOOKUP_CONFIG_DEFAULTS: ExternalLookupConfig = {
  dailyMissQuota: 30,
  quotaTtlHours: 36,
  emptyReplyHe:
    "לא מצאתי מקור מאומת לזה כרגע — אבדוק שוב אם תרצו, בלי לנחש.",
  quotaExceededHe:
    "הגעתם למכסת החיפושים להיום — נסו שוב מחר, או בקשו משהו שכבר בדקנו (מהמטמון).",
  providers: {
    web_search: {
      id: "web_search",
      enabled: true,
      liveRefresh: true,
      ttlTier: "DAILY",
      defaultCacheScope: "global",
      burnsQuota: true,
      provider: "web_search",
      scope: "grounding",
    },
    places: {
      id: "places",
      enabled: true,
      liveRefresh: true,
      ttlTier: "STATIC",
      defaultCacheScope: "global",
      burnsQuota: true,
      provider: "places",
      scope: "local_search",
    },
    weather: {
      id: "weather",
      enabled: true,
      liveRefresh: true,
      ttlTier: "REALTIME",
      ttlSeconds: 15 * 60,
      defaultCacheScope: "global",
      burnsQuota: true,
      provider: "weather",
      scope: "forecast",
    },
    market: {
      id: "market",
      enabled: true,
      liveRefresh: true,
      ttlTier: "REALTIME",
      ttlSeconds: 5 * 60,
      defaultCacheScope: "global",
      burnsQuota: true,
      provider: "market",
      scope: "quote",
    },
    fx: {
      id: "fx",
      enabled: true,
      liveRefresh: true,
      ttlTier: "REALTIME",
      ttlSeconds: 5 * 60,
      defaultCacheScope: "global",
      burnsQuota: true,
      provider: "market",
      scope: "fx",
    },
    flights: {
      id: "flights",
      enabled: true,
      liveRefresh: true,
      /** Short board TTL for נתב״ג — HIT → 0 AviationStack calls. */
      ttlTier: "REALTIME",
      ttlSeconds: 90,
      defaultCacheScope: "global",
      burnsQuota: true,
      provider: "flights",
      scope: "board",
    },
    /** Example schedule domain — cache/watch wiring only until a feed is injected. */
    sports: {
      id: "sports",
      enabled: true,
      liveRefresh: false,
      ttlTier: "DAILY",
      ttlSeconds: 30 * 60,
      defaultCacheScope: "global",
      burnsQuota: true,
      provider: "sports",
      scope: "schedule",
    },
  },
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Live config (env-overridable). Safe to call often — cheap object build. */
export function getExternalLookupConfig(): ExternalLookupConfig {
  const d = EXTERNAL_LOOKUP_CONFIG_DEFAULTS;
  return {
    dailyMissQuota: envInt("EXTERNAL_LOOKUP_DAILY_QUOTA", d.dailyMissQuota),
    quotaTtlHours: envInt("EXTERNAL_LOOKUP_QUOTA_TTL_HOURS", d.quotaTtlHours),
    emptyReplyHe: d.emptyReplyHe,
    quotaExceededHe: d.quotaExceededHe,
    providers: {
      web_search: {
        ...d.providers.web_search,
        enabled: envBool("EXTERNAL_LOOKUP_WEB_SEARCH", true),
      },
      places: {
        ...d.providers.places,
        enabled: envBool("EXTERNAL_LOOKUP_PLACES", true),
      },
      weather: {
        ...d.providers.weather,
        enabled: envBool("EXTERNAL_LOOKUP_WEATHER", true),
        ttlSeconds: envInt(
          "EXTERNAL_LOOKUP_WEATHER_TTL_SECONDS",
          d.providers.weather.ttlSeconds ?? 900,
        ),
      },
      market: {
        ...d.providers.market,
        enabled: envBool("EXTERNAL_LOOKUP_MARKET", true),
        ttlSeconds: envInt(
          "EXTERNAL_LOOKUP_MARKET_TTL_SECONDS",
          d.providers.market.ttlSeconds ?? 300,
        ),
      },
      fx: {
        ...d.providers.fx,
        enabled: envBool("EXTERNAL_LOOKUP_FX", true),
        ttlSeconds: envInt(
          "EXTERNAL_LOOKUP_FX_TTL_SECONDS",
          d.providers.fx.ttlSeconds ?? 300,
        ),
      },
      flights: {
        ...d.providers.flights,
        enabled: envBool("EXTERNAL_LOOKUP_FLIGHTS", true),
        ttlSeconds: envInt(
          "EXTERNAL_LOOKUP_FLIGHTS_TTL_SECONDS",
          d.providers.flights.ttlSeconds ?? 90,
        ),
      },
      sports: {
        ...d.providers.sports,
        enabled: envBool("EXTERNAL_LOOKUP_SPORTS", true),
        ttlSeconds: envInt(
          "EXTERNAL_LOOKUP_SPORTS_TTL_SECONDS",
          d.providers.sports.ttlSeconds ?? 1800,
        ),
      },
    },
  };
}

export function getExternalLookupProviderConfig(
  id: ExternalLookupProviderId,
): ExternalLookupProviderConfig {
  return getExternalLookupConfig().providers[id];
}

/** Resolve TTL seconds from provider config (tier default or override). */
export function providerTtlSeconds(
  id: ExternalLookupProviderId,
): { ttlTier: ExternalCacheTtlTier; ttlSeconds: number } {
  const cfg = getExternalLookupProviderConfig(id);
  const ttlSeconds =
    cfg.ttlSeconds ?? EXTERNAL_CACHE_TTL_SECONDS[cfg.ttlTier];
  return { ttlTier: cfg.ttlTier, ttlSeconds };
}

/** FX symbols use the `fx` provider config (same Yahoo path as market). */
export function isFxMarketQuery(query: string): boolean {
  const q = query.trim().toLowerCase();
  return (
    /usdils|eurils|=x$/.test(q) ||
    /דולר|יורו|dollar|euro|שער\s*הדולר|שער\s*היורו|fx\b|forex/.test(q)
  );
}
