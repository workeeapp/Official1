/**
 * Cached external lookups (hosted web.search + quota) and fast inline chat grounding.
 * Reuses runHostedWebSearch + withExternalCache primitives — missions keep mission-runner
 * for multi-step research/portal browsing.
 */
import type { Prisma } from "@prisma/client";
import {
  HOSTED_WEB_SEARCH_MODEL,
  runHostedWebSearch,
  type HostedWebSearchResult,
} from "./llm-client.js";
import {
  buildNormalizedCacheKey,
  normalizeCacheDate,
  resolveTtlSeconds,
  withExternalCache,
  type ExternalCacheTtlTier,
  type WithExternalCacheResult,
} from "./external-cache.service.js";
import { prisma } from "../database/prisma.js";

export const EXTERNAL_LOOKUP_DAILY_QUOTA = 30;

export const WEB_LOOKUP_EMPTY_HE =
  "לא מצאתי מקור מאומת לזה כרגע — אבדוק שוב אם תרצו, בלי לנחש.";

export const EXTERNAL_LOOKUP_QUOTA_HE =
  "הגעתם למכסת החיפושים להיום — נסו שוב מחר, או בקשו משהו שכבר בדקנו (מהמטמון).";

export type CachedWebSearchPayload = {
  text: string;
  sources: string[];
  model: string;
};

export type CachedWebSearchOptions = {
  query: string;
  /** Quota accounting — omit for system/mission bootstrap without a user. */
  userId?: string | null;
  region?: string;
  date?: string | Date | null;
  lat?: number | null;
  lng?: number | null;
  scope?: string;
  ttlTier?: ExternalCacheTtlTier;
  forceRefresh?: boolean;
  model?: string;
  now?: Date;
  /** Test seam. */
  searchImpl?: (query: string, model: string) => Promise<HostedWebSearchResult>;
};

export type CachedWebSearchResult = WithExternalCacheResult<CachedWebSearchPayload> & {
  quotaBurned: boolean;
  quotaBlocked: boolean;
};

const FORCE_REFRESH_RE =
  /(?:תבדקי?\s*מחדש|תבדוק\s*מחדש|תרעננ[יו]|רענון|force\s*refresh|check\s*again|search\s*again)/iu;

export function detectForceRefreshIntent(text: string): boolean {
  return FORCE_REFRESH_RE.test(text.trim());
}

/** Heuristic TTL for web lookups by query shape. */
export function inferWebLookupTtlTier(query: string): ExternalCacheTtlTier {
  const q = query.trim().toLowerCase();
  if (
    /שעות\s*פתיחה|opening\s*hours|open\s*now|מתי\s*סוגר|מתי\s*פותח/.test(q)
  ) {
    return "STATIC";
  }
  if (
    /שבת|הדלקת\s*נרות|havdalah|parasha|פרשת|קולנוע|סינמה|cinema|הופע|קונצרט|concert|אירוע|event|טלוויז|tv\b|שידור/.test(
      q,
    )
  ) {
    return "DAILY";
  }
  if (/עכשיו|live|כרגע|תוצאה|score|שער\s*הדולר|מזג\s*אוויר/.test(q)) {
    return "REALTIME";
  }
  return "DAILY";
}

export function inferWebLookupScope(query: string): string {
  const q = query.trim().toLowerCase();
  if (/קולנוע|cinema|סינמה|סרט/.test(q)) return "cinema_showtimes";
  if (/הופע|קונצרט|concert|אירוע|event/.test(q)) return "concerts";
  if (/שבת|נרות|havdalah|parasha|פרשת/.test(q)) return "shabbat_times";
  if (/שעות\s*פתיחה|opening\s*hours/.test(q)) return "place_hours";
  return "grounding";
}

function quotaCacheKey(userId: string, day: string): string {
  return buildNormalizedCacheKey({
    provider: "quota",
    scope: "external_lookup_daily",
    query: userId,
    region: "IL",
    date: day,
  });
}

export async function getExternalLookupQuotaUsed(
  userId: string,
  now = new Date(),
): Promise<number> {
  const day = normalizeCacheDate(now);
  const row = await prisma.externalDataCache.findUnique({
    where: { cacheKey: quotaCacheKey(userId, day) },
  });
  const payload = row?.payload as { used?: unknown } | null;
  const used = typeof payload?.used === "number" ? payload.used : 0;
  return Math.max(0, Math.floor(used));
}

/** Burn one uncached external lookup against the per-user daily quota. */
export async function burnExternalLookupQuota(
  userId: string,
  now = new Date(),
): Promise<{ allowed: boolean; used: number }> {
  const day = normalizeCacheDate(now);
  const cacheKey = quotaCacheKey(userId, day);
  const existing = await prisma.externalDataCache.findUnique({
    where: { cacheKey },
  });
  const prev = (existing?.payload as { used?: number } | null)?.used ?? 0;
  const used = Math.max(0, Math.floor(Number(prev) || 0));
  if (used >= EXTERNAL_LOOKUP_DAILY_QUOTA) {
    return { allowed: false, used };
  }
  const next = used + 1;
  const expiresAt = new Date(now.getTime() + 36 * 60 * 60 * 1000);
  const payload = { used: next } as Prisma.InputJsonValue;
  await prisma.externalDataCache.upsert({
    where: { cacheKey },
    create: {
      cacheKey,
      provider: "quota",
      scope: "external_lookup_daily",
      ttlTier: "DAILY",
      payload,
      fetchedAt: now,
      expiresAt,
      hitCount: 0,
    },
    update: {
      payload,
      fetchedAt: now,
      expiresAt,
    },
  });
  return { allowed: true, used: next };
}

/**
 * Read-through hosted web search. Cache HIT burns 0 quota; MISS burns 1 when userId set.
 */
export async function cachedHostedWebSearch(
  options: CachedWebSearchOptions,
): Promise<CachedWebSearchResult> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("cachedHostedWebSearch requires query");
  }
  const forceRefresh = options.forceRefresh === true;
  const ttlTier = options.ttlTier ?? inferWebLookupTtlTier(query);
  const scope = options.scope ?? inferWebLookupScope(query);
  const model = options.model?.trim() || HOSTED_WEB_SEARCH_MODEL;
  const now = options.now ?? new Date();
  const region = options.region ?? "IL";
  const date = options.date ?? normalizeCacheDate(now);
  const searchImpl =
    options.searchImpl ??
    (async (q: string, m: string) =>
      runHostedWebSearch({ query: q, model: m, now }));

  const keyInput = {
    provider: "web_search",
    scope,
    query,
    region,
    date,
    lat: options.lat,
    lng: options.lng,
  };
  const cacheKey = buildNormalizedCacheKey(keyInput);

  if (!forceRefresh) {
    const existing = await prisma.externalDataCache.findUnique({
      where: { cacheKey },
    });
    if (existing && existing.expiresAt > now) {
      await prisma.externalDataCache.update({
        where: { cacheKey },
        data: { hitCount: { increment: 1 }, lastHitAt: now },
      });
      const ageSeconds = Math.max(
        0,
        Math.floor((now.getTime() - existing.fetchedAt.getTime()) / 1000),
      );
      return {
        payload: existing.payload as CachedWebSearchPayload,
        cacheHit: true,
        ageSeconds,
        cacheKey,
        quotaBurned: false,
        quotaBlocked: false,
      };
    }
  }

  if (options.userId) {
    const gate = await burnExternalLookupQuota(options.userId, now);
    if (!gate.allowed) {
      return {
        payload: { text: "", sources: [], model },
        cacheHit: false,
        ageSeconds: 0,
        cacheKey,
        quotaBurned: false,
        quotaBlocked: true,
      };
    }
  }

  // Miss / forceRefresh — store via shared withExternalCache (fetcher runs once).
  let fetchCount = 0;
  const stored = await withExternalCache<CachedWebSearchPayload>({
    ...keyInput,
    ttlTier,
    ttlSeconds: resolveTtlSeconds(ttlTier),
    forceRefresh: true,
    fetcher: async () => {
      fetchCount += 1;
      const r = await searchImpl(query, model);
      return {
        text: r.text.trim(),
        sources: r.sources.slice(0, 8),
        model,
      };
    },
  });

  return {
    ...stored,
    cacheHit: false,
    quotaBurned: Boolean(options.userId),
    quotaBlocked: false,
    // ensure fetcher ran
    payload: stored.payload,
  };
  void fetchCount;
}

export type InlineWebLookupResult = {
  text: string;
  verified: boolean;
  cacheHit: boolean;
  quotaBlocked: boolean;
  searchTopic: string;
  sources: string[];
};

/** Format verified answer or honest Hebrew fallback (never invent). */
export function formatInlineWebLookupReply(
  result: CachedWebSearchResult,
  topic: string,
): InlineWebLookupResult {
  if (result.quotaBlocked) {
    return {
      text: EXTERNAL_LOOKUP_QUOTA_HE,
      verified: false,
      cacheHit: false,
      quotaBlocked: true,
      searchTopic: topic,
      sources: [],
    };
  }
  const text = result.payload.text.trim();
  const sources = result.payload.sources ?? [];
  const verified = text.length > 0 || sources.length > 0;
  if (!verified) {
    return {
      text: WEB_LOOKUP_EMPTY_HE,
      verified: false,
      cacheHit: result.cacheHit,
      quotaBlocked: false,
      searchTopic: topic,
      sources: [],
    };
  }
  const sourcesTail =
    sources.length > 0
      ? `\n\nמקורות:\n${sources
          .slice(0, 3)
          .map((s) => `• ${s}`)
          .join("\n")}`
      : "";
  return {
    text: `${text}${sourcesTail}`.slice(0, 3500),
    verified: true,
    cacheHit: result.cacheHit,
    quotaBlocked: false,
    searchTopic: topic,
    sources,
  };
}

/** Same-turn inline grounding for chat (not multi-step missions). */
export async function resolveInlineWebLookup(input: {
  query: string;
  userId?: string | null;
  forceRefresh?: boolean;
  speakerMessage?: string;
  lat?: number | null;
  lng?: number | null;
  searchImpl?: CachedWebSearchOptions["searchImpl"];
  now?: Date;
}): Promise<InlineWebLookupResult> {
  const query = input.query.trim();
  const forceRefresh =
    input.forceRefresh === true ||
    detectForceRefreshIntent(input.speakerMessage ?? "");
  const cached = await cachedHostedWebSearch({
    query,
    userId: input.userId,
    forceRefresh,
    lat: input.lat,
    lng: input.lng,
    searchImpl: input.searchImpl,
    now: input.now,
  });
  return formatInlineWebLookupReply(cached, query);
}
