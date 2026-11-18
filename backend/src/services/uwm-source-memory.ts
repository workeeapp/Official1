/**
 * UWM Source Memory — public proven-source profiles in ExternalDataCache.
 * Never stores userId, WatchSpec intent, predicates, or private constraints.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import {
  buildNormalizedCacheKey,
  resolveTtlSeconds,
} from "./external-cache.service.js";
import { recordUwmMetric } from "./uwm-retrieval-metrics.js";

export const SOURCE_MEMORY_PROVIDER = "source_memory";
export const SOURCE_MEMORY_SCOPE = "profile";

export type SourceMemoryProfile = {
  sourceId: string;
  url?: string;
  domain?: string;
  infoKinds: string[];
  successCount: number;
  failCount: number;
  reliabilityScore: number;
  lastCheckedAt: string;
  suggestedTtlTier: "STATIC" | "DAILY" | "REALTIME";
  accessNotes?: string;
};

const FORBIDDEN_KEYS = new Set([
  "userid",
  "user_id",
  "intent",
  "matchpredicate",
  "match_predicate",
  "objectives",
  "canonicalquery",
  "canonical_query",
  "ontriggeractionsactions",
  "on_trigger_actions",
  "ping",
  "targets",
  "monitorstate",
  "monitor_state",
]);

function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .slice(0, 200);
}

export function sourceMemoryCacheKey(sourceIdOrDomain: string): string {
  const query = normalizeDomain(sourceIdOrDomain) || "unknown";
  return buildNormalizedCacheKey({
    provider: SOURCE_MEMORY_PROVIDER,
    scope: SOURCE_MEMORY_SCOPE,
    query,
    region: "IL",
  });
}

/** Strip / reject private fields before write. */
export function sanitizeSourceMemoryProfile(
  raw: Record<string, unknown>,
): SourceMemoryProfile | null {
  for (const key of Object.keys(raw)) {
    const norm = key.trim().toLowerCase().replace(/-/g, "_");
    if (FORBIDDEN_KEYS.has(norm) || FORBIDDEN_KEYS.has(norm.replace(/_/g, ""))) {
      return null;
    }
  }
  const sourceId = String(raw.sourceId ?? raw.source_id ?? "")
    .trim()
    .slice(0, 128);
  if (!sourceId) {
    return null;
  }
  const domainRaw = raw.domain ?? raw.url;
  const domain =
    domainRaw == null || domainRaw === ""
      ? undefined
      : normalizeDomain(String(domainRaw));
  const url =
    typeof raw.url === "string" && raw.url.trim()
      ? raw.url.trim().slice(0, 500)
      : undefined;
  const infoKinds = Array.isArray(raw.infoKinds)
    ? raw.infoKinds.map((x) => String(x).trim()).filter(Boolean).slice(0, 16)
    : Array.isArray(raw.info_kinds)
      ? (raw.info_kinds as unknown[])
          .map((x) => String(x).trim())
          .filter(Boolean)
          .slice(0, 16)
      : [];
  const successCount = Math.max(
    0,
    Math.floor(Number(raw.successCount ?? raw.success_count ?? 0) || 0),
  );
  const failCount = Math.max(
    0,
    Math.floor(Number(raw.failCount ?? raw.fail_count ?? 0) || 0),
  );
  const reliabilityScore = Number(
    raw.reliabilityScore ?? raw.reliability_score ?? 0.5,
  );
  const lastCheckedAt =
    typeof raw.lastCheckedAt === "string" && raw.lastCheckedAt
      ? raw.lastCheckedAt
      : new Date().toISOString();
  const tierRaw = String(
    raw.suggestedTtlTier ?? raw.suggested_ttl_tier ?? "DAILY",
  ).toUpperCase();
  const suggestedTtlTier =
    tierRaw === "STATIC" || tierRaw === "REALTIME" ? tierRaw : "DAILY";
  const accessNotes =
    typeof raw.accessNotes === "string"
      ? raw.accessNotes.slice(0, 200)
      : typeof raw.access_notes === "string"
        ? raw.access_notes.slice(0, 200)
        : undefined;

  return {
    sourceId,
    ...(url ? { url } : {}),
    ...(domain ? { domain } : {}),
    infoKinds,
    successCount,
    failCount,
    reliabilityScore: Number.isFinite(reliabilityScore)
      ? Math.min(1, Math.max(0, reliabilityScore))
      : 0.5,
    lastCheckedAt,
    suggestedTtlTier,
    ...(accessNotes ? { accessNotes } : {}),
  };
}

export async function readSourceMemory(
  sourceIdOrDomain: string,
): Promise<{ profile: SourceMemoryProfile | null; cacheHit: boolean }> {
  const cacheKey = sourceMemoryCacheKey(sourceIdOrDomain);
  try {
    const row = await prisma.externalDataCache.findUnique({
      where: { cacheKey },
    });
    const now = new Date();
    if (!row || row.expiresAt <= now) {
      recordUwmMetric("cache", {
        provider: SOURCE_MEMORY_PROVIDER,
        hit: false,
        key: cacheKey.slice(0, 80),
      });
      recordUwmMetric("source_memory", {
        op: "read_miss",
        source: sourceIdOrDomain.slice(0, 64),
      });
      return { profile: null, cacheHit: false };
    }
    await prisma.externalDataCache.update({
      where: { cacheKey },
      data: { hitCount: { increment: 1 }, lastHitAt: now },
    });
    recordUwmMetric("cache", {
      provider: SOURCE_MEMORY_PROVIDER,
      hit: true,
      key: cacheKey.slice(0, 80),
    });
    const payload =
      row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : null;
    const profile = payload ? sanitizeSourceMemoryProfile(payload) : null;
    recordUwmMetric("source_memory", {
      op: "read_hit",
      source: sourceIdOrDomain.slice(0, 64),
      ok: Boolean(profile),
    });
    return { profile, cacheHit: true };
  } catch {
    recordUwmMetric("source_memory", {
      op: "read_error",
      source: sourceIdOrDomain.slice(0, 64),
    });
    return { profile: null, cacheHit: false };
  }
}

export async function writeSourceMemorySuccess(input: {
  sourceId: string;
  url?: string;
  domain?: string;
  infoKinds?: string[];
}): Promise<SourceMemoryProfile | null> {
  const existing = await readSourceMemory(input.domain ?? input.sourceId);
  const prev = existing.profile;
  const next = sanitizeSourceMemoryProfile({
    sourceId: input.sourceId,
    url: input.url ?? prev?.url,
    domain: input.domain ?? prev?.domain,
    infoKinds: [
      ...new Set([...(prev?.infoKinds ?? []), ...(input.infoKinds ?? [])]),
    ],
    successCount: (prev?.successCount ?? 0) + 1,
    failCount: prev?.failCount ?? 0,
    reliabilityScore: Math.min(
      1,
      (prev?.reliabilityScore ?? 0.5) + 0.05,
    ),
    lastCheckedAt: new Date().toISOString(),
    suggestedTtlTier: prev?.suggestedTtlTier ?? "STATIC",
    accessNotes: "ok",
  });
  if (!next) {
    recordUwmMetric("source_memory", { op: "write_rejected_private" });
    return null;
  }
  await upsertSourceMemory(next);
  recordUwmMetric("source_memory", {
    op: "write_success",
    source: next.sourceId.slice(0, 64),
    successCount: next.successCount,
  });
  return next;
}

export async function writeSourceMemoryFailure(input: {
  sourceId: string;
  domain?: string;
  accessNotes?: string;
}): Promise<SourceMemoryProfile | null> {
  const existing = await readSourceMemory(input.domain ?? input.sourceId);
  const prev = existing.profile;
  const next = sanitizeSourceMemoryProfile({
    sourceId: input.sourceId,
    domain: input.domain ?? prev?.domain,
    url: prev?.url,
    infoKinds: prev?.infoKinds ?? [],
    successCount: prev?.successCount ?? 0,
    failCount: (prev?.failCount ?? 0) + 1,
    reliabilityScore: Math.max(
      0,
      (prev?.reliabilityScore ?? 0.5) - 0.1,
    ),
    lastCheckedAt: new Date().toISOString(),
    suggestedTtlTier: prev?.suggestedTtlTier ?? "DAILY",
    accessNotes: input.accessNotes ?? "fail",
  });
  if (!next) {
    return null;
  }
  await upsertSourceMemory(next);
  recordUwmMetric("source_memory", {
    op: "write_fail",
    source: next.sourceId.slice(0, 64),
    failCount: next.failCount,
  });
  return next;
}

async function upsertSourceMemory(profile: SourceMemoryProfile): Promise<void> {
  const cacheKey = sourceMemoryCacheKey(profile.domain ?? profile.sourceId);
  const ttlSeconds = resolveTtlSeconds("STATIC");
  const fetchedAt = new Date();
  const expiresAt = new Date(fetchedAt.getTime() + ttlSeconds * 1000);
  const payload = profile as unknown as Prisma.InputJsonValue;
  await prisma.externalDataCache.upsert({
    where: { cacheKey },
    create: {
      cacheKey,
      provider: SOURCE_MEMORY_PROVIDER,
      scope: SOURCE_MEMORY_SCOPE,
      ttlTier: "STATIC",
      payload,
      fetchedAt,
      expiresAt,
      hitCount: 0,
      lastHitAt: null,
    },
    update: {
      payload,
      fetchedAt,
      expiresAt,
      ttlTier: "STATIC",
    },
  });
  recordUwmMetric("cache", {
    provider: SOURCE_MEMORY_PROVIDER,
    hit: false,
    write: true,
  });
}

/** Lookup similar public profiles by preferred domains (no user private data). */
export async function findSourceMemoryHints(
  preferred: string[],
): Promise<SourceMemoryProfile[]> {
  const out: SourceMemoryProfile[] = [];
  for (const raw of preferred.slice(0, 8)) {
    const { profile } = await readSourceMemory(raw);
    if (profile && profile.reliabilityScore >= 0.4) {
      out.push(profile);
    }
  }
  return out;
}
