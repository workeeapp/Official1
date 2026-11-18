/**
 * External Data Caching — multi-domain read-through store.
 *
 * Future providers (web_search, tmdb, tv_schedule, events, transit, hebcal,
 * places, …) share one table via open `provider` / `scope` strings and
 * deterministic `buildNormalizedCacheKey` so geo/date/query variants collide
 * across users without schema migrations.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";

export const EXTERNAL_CACHE_TTL_TIERS = ["STATIC", "DAILY", "REALTIME"] as const;
export type ExternalCacheTtlTier = (typeof EXTERNAL_CACHE_TTL_TIERS)[number];

/** Default TTL seconds per tier (overridable via `ttlSeconds`). */
export const EXTERNAL_CACHE_TTL_SECONDS: Record<ExternalCacheTtlTier, number> = {
  STATIC: 14 * 24 * 60 * 60,
  DAILY: 12 * 60 * 60,
  REALTIME: 60,
};

const DEFAULT_REGION = "IL";
const GEO_DECIMALS = 3;

export type ExternalCacheKeyInput = {
  provider: string;
  scope: string;
  query: string;
  region?: string;
  date?: string | Date | null;
  lat?: number | null;
  lng?: number | null;
};

export type WithExternalCacheOptions<T> = ExternalCacheKeyInput & {
  ttlTier: ExternalCacheTtlTier;
  /** Override tier default TTL. */
  ttlSeconds?: number;
  forceRefresh?: boolean;
  fetcher: () => Promise<T>;
};

export type ExternalCacheMeta = {
  cacheHit: boolean;
  /** Seconds since `fetchedAt` when hit; 0 on miss/refresh. */
  ageSeconds: number;
  cacheKey: string;
};

export type WithExternalCacheResult<T> = {
  payload: T;
} & ExternalCacheMeta;

function assertTtlTier(tier: string): asserts tier is ExternalCacheTtlTier {
  if (!(EXTERNAL_CACHE_TTL_TIERS as readonly string[]).includes(tier)) {
    throw new Error(`Invalid ExternalCache ttlTier: ${tier}`);
  }
}

/** Trim, collapse whitespace, lowercase. */
export function normalizeCacheQueryText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Coerce to `YYYY-MM-DD` (UTC calendar day for Date inputs). */
export function normalizeCacheDate(date: string | Date): string {
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) {
      throw new Error("Invalid ExternalCache date");
    }
    return date.toISOString().slice(0, 10);
  }
  const raw = date.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ExternalCache date: ${date}`);
  }
  return parsed.toISOString().slice(0, 10);
}

/** Round to 3 decimal places (~110m grid). */
export function roundCacheCoord(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ExternalCache coord: ${value}`);
  }
  const factor = 10 ** GEO_DECIMALS;
  return Math.round(value * factor) / factor;
}

function formatCoordToken(value: number): string {
  return roundCacheCoord(value).toFixed(GEO_DECIMALS);
}

/**
 * Deterministic cache key shared across users for the same logical query.
 * Format: provider|scope|region|date|lat|lng|query
 * Missing date/geo use empty tokens so structure stays stable.
 */
export function buildNormalizedCacheKey(input: ExternalCacheKeyInput): string {
  const provider = normalizeCacheQueryText(input.provider);
  const scope = normalizeCacheQueryText(input.scope);
  const region = normalizeCacheQueryText(input.region ?? DEFAULT_REGION) || DEFAULT_REGION.toLowerCase();
  const query = normalizeCacheQueryText(input.query);
  const dateToken =
    input.date === undefined || input.date === null || input.date === ""
      ? ""
      : normalizeCacheDate(input.date);
  const latToken =
    input.lat === undefined || input.lat === null ? "" : formatCoordToken(input.lat);
  const lngToken =
    input.lng === undefined || input.lng === null ? "" : formatCoordToken(input.lng);

  if (!provider || !scope) {
    throw new Error("ExternalCache provider and scope are required");
  }

  const key = [provider, scope, region, dateToken, latToken, lngToken, query].join("|");
  if (key.length > 512) {
    throw new Error(`ExternalCache cacheKey exceeds 512 chars (${key.length})`);
  }
  return key;
}

export function resolveTtlSeconds(
  ttlTier: ExternalCacheTtlTier,
  ttlSeconds?: number,
): number {
  assertTtlTier(ttlTier);
  if (ttlSeconds !== undefined) {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`Invalid ExternalCache ttlSeconds: ${ttlSeconds}`);
    }
    return Math.floor(ttlSeconds);
  }
  return EXTERNAL_CACHE_TTL_SECONDS[ttlTier];
}

function ageSecondsFrom(fetchedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - fetchedAt.getTime()) / 1000));
}

/**
 * Read-through wrapper: HIT returns cached payload; MISS/EXPIRED/forceRefresh
 * invokes fetcher and upserts by cacheKey.
 */
export async function withExternalCache<T>(
  options: WithExternalCacheOptions<T>,
): Promise<WithExternalCacheResult<T>> {
  assertTtlTier(options.ttlTier);
  const cacheKey = buildNormalizedCacheKey(options);
  const now = new Date();

  if (!options.forceRefresh) {
    const existing = await prisma.externalDataCache.findUnique({
      where: { cacheKey },
    });
    if (existing && existing.expiresAt > now) {
      await prisma.externalDataCache.update({
        where: { cacheKey },
        data: {
          hitCount: { increment: 1 },
          lastHitAt: now,
        },
      });
      return {
        payload: existing.payload as T,
        cacheHit: true,
        ageSeconds: ageSecondsFrom(existing.fetchedAt, now),
        cacheKey,
      };
    }
  }

  const payload = await options.fetcher();
  const ttlSeconds = resolveTtlSeconds(options.ttlTier, options.ttlSeconds);
  const fetchedAt = new Date();
  const expiresAt = new Date(fetchedAt.getTime() + ttlSeconds * 1000);

  await prisma.externalDataCache.upsert({
    where: { cacheKey },
    create: {
      cacheKey,
      provider: normalizeCacheQueryText(options.provider),
      scope: normalizeCacheQueryText(options.scope),
      ttlTier: options.ttlTier,
      payload: payload as Prisma.InputJsonValue,
      fetchedAt,
      expiresAt,
      hitCount: 0,
      lastHitAt: null,
    },
    update: {
      provider: normalizeCacheQueryText(options.provider),
      scope: normalizeCacheQueryText(options.scope),
      ttlTier: options.ttlTier,
      payload: payload as Prisma.InputJsonValue,
      fetchedAt,
      expiresAt,
      // Fresh write resets hit accounting for the new payload generation.
      hitCount: 0,
      lastHitAt: null,
    },
  });

  return {
    payload,
    cacheHit: false,
    ageSeconds: 0,
    cacheKey,
  };
}

/** Delete rows with expiresAt <= now. Returns deleted count. */
export async function purgeExpiredCache(now: Date = new Date()): Promise<number> {
  const result = await prisma.externalDataCache.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  return result.count;
}

/** Test/helper: load row by normalized key. */
export async function getExternalCacheRow(cacheKey: string) {
  return prisma.externalDataCache.findUnique({ where: { cacheKey } });
}
