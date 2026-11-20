/**
 * Generic normalization + evidence grading for UWM retrieval payloads.
 * Never invents facts; model self-confidence alone cannot raise grade.
 */
import { createHash } from "node:crypto";
import type { LlmWebMonitorCondition } from "@workee/shared";
import type {
  NormalizedMonitorItem,
  UwmEvidenceGrade,
  UwmFactProvenance,
  UwmMonitorItemState,
} from "./uwm-types.js";
import {
  extractEventAtFromRetrievalText,
  isDateOnly,
  normalizeAbsoluteUtcIso,
  normalizePublishedAt,
} from "./uwm-event-at.js";

/** Same-core events farther apart than this are distinct items. */
export const UWM_ALIAS_MAX_DELTA_MS = 36 * 60 * 60_000;

export type RawMonitorCandidate = {
  title?: string;
  summary?: string;
  url?: string;
  sourceUrls?: string[];
  eventAt?: string | null;
  locationText?: string | null;
  publishedAt?: string | null;
  attributes?: Record<string, string | number | boolean | null>;
  /** When false, page soft-failed. */
  retrievalOk?: boolean;
  /** Conflicting eventAt from another source (same identity). */
  conflictEventAt?: string | null;
};

const FIXTURE_RE =
  /UWM_FIXTURE_ITEMS\s*:\s*(\[[\s\S]*?\])(?:\s*$|\s*\n\s*\n)/i;

export function shaContent(parts: Array<string | null | undefined>): string {
  return createHash("sha256")
    .update(parts.map((p) => String(p ?? "").trim().toLowerCase()).join("|"))
    .digest("hex")
    .slice(0, 32);
}

/** Normalize volatile title noise for identity (not for display). */
export function normalizeTitleForIdentity(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function venueOrUrlKey(
  locationText?: string | null,
  url?: string | null,
): string {
  const loc = String(locationText ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (loc) return loc;
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.toLowerCase().replace(/\/$/, "").slice(0, 120);
  } catch {
    return url.toLowerCase().slice(0, 120);
  }
}

/**
 * Identity core — title + venue/url, intentionally WITHOUT eventAt so a
 * reschedule does not fork a new itemId. Distinct events with the same core
 * are separated via resolveStableItemId time-window rules.
 */
export function identityCore(input: {
  title: string;
  url?: string | null;
  locationText?: string | null;
}): string {
  return [
    normalizeTitleForIdentity(input.title),
    venueOrUrlKey(input.locationText, input.url),
  ].join("|");
}

/**
 * Stable item id: prefer alias merge against existing monitorState items.
 * contentFp is never part of identity.
 */
export function resolveStableItemId(
  input: {
    title: string;
    eventAt?: string | null;
    url?: string | null;
    locationText?: string | null;
  },
  existing?: Record<string, UwmMonitorItemState>,
): { itemId: string; identityCore: string; aliased: boolean } {
  const core = identityCore(input);
  const eventMs = input.eventAt ? Date.parse(input.eventAt) : NaN;

  if (existing) {
    for (const [id, st] of Object.entries(existing)) {
      if (st.status === "cancelled" || st.status === "expired") continue;
      const stCore = st.identityCore;
      if (!stCore || stCore !== core) continue;
      if (!input.eventAt || !st.eventAt) {
        return { itemId: id, identityCore: core, aliased: true };
      }
      const prevMs = Date.parse(st.eventAt);
      if (!Number.isFinite(prevMs) || !Number.isFinite(eventMs)) {
        return { itemId: id, identityCore: core, aliased: true };
      }
      if (Math.abs(eventMs - prevMs) <= UWM_ALIAS_MAX_DELTA_MS) {
        return { itemId: id, identityCore: core, aliased: true };
      }
    }
  }

  // Bound-page URL monitors: URL-stable id (content changes must not fork).
  if (input.url && !input.eventAt) {
    const pageId = shaContent([`page:${input.url}`]).slice(0, 24);
    return { itemId: pageId, identityCore: core, aliased: false };
  }

  const day = input.eventAt ? String(input.eventAt).slice(0, 10) : "";
  return {
    itemId: shaContent([core, day]).slice(0, 24),
    identityCore: core,
    aliased: false,
  };
}

/** @deprecated Prefer resolveStableItemId — kept for callers/tests. */
export function stableItemId(input: {
  title: string;
  eventAt?: string | null;
  url?: string | null;
  locationText?: string | null;
}): string {
  return resolveStableItemId(input).itemId;
}

/** Fingerprint one changeAspect for history / detect_change. */
export function aspectFingerprint(
  item: Pick<
    NormalizedMonitorItem,
    "eventAt" | "locationText" | "title" | "summary" | "attributes" | "contentFp"
  >,
  aspect: string,
): string {
  const a = aspect.trim().toLowerCase();
  if (/^(eventat|event_at|time|kickoff|showtime|date)$/.test(a)) {
    return shaContent([item.eventAt ?? ""]);
  }
  if (/^(location|venue|place|geo)$/.test(a)) {
    return shaContent([item.locationText ?? ""]);
  }
  if (/^(price|quote|fare)$/.test(a)) {
    return shaContent([String(item.attributes?.price ?? item.attributes?.quote ?? "")]);
  }
  if (/^(status|cancelled|state)$/.test(a)) {
    return shaContent([String(item.attributes?.status ?? "")]);
  }
  if (/^(policy|content|body|text)$/.test(a)) {
    return item.contentFp;
  }
  return shaContent([item.title, item.summary, item.eventAt, JSON.stringify(item.attributes)]);
}

/** Parse controlled fixture block, else heuristic line/URL candidates. */
export function extractRawCandidates(input: {
  text: string;
  sources: string[];
}): RawMonitorCandidate[] {
  const fixture = input.text.match(FIXTURE_RE);
  if (fixture?.[1]) {
    try {
      const parsed = JSON.parse(fixture[1]) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((row) => row && typeof row === "object")
          .map((row) => row as RawMonitorCandidate);
      }
    } catch {
      // fall through
    }
  }

  const urls = [
    ...input.sources
      .map((s) => {
        const m = String(s).match(/https?:\/\/\S+/i);
        return m?.[0]?.replace(/[),.;]+$/, "") ?? "";
      })
      .filter(Boolean),
    ...(input.text.match(/https?:\/\/[^\s)>\]]+/gi) ?? []).map((u) =>
      u.replace(/[),.;]+$/, ""),
    ),
  ];
  const uniqueUrls = [...new Set(urls)].slice(0, 8);
  if (uniqueUrls.length === 0 && !input.text.trim()) {
    return [];
  }

  // Heuristic: one candidate per URL with nearby title line; thin text → empty.
  const lines = input.text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^UWM_FIXTURE/i.test(l));
  if (uniqueUrls.length === 0) {
    // No citable URL → leave unverified path empty (fail-closed for notify).
    return [];
  }
  // Shared across URL rows: one retrieval blob → at most one eventAt (fail-closed).
  const extracted = extractEventAtFromRetrievalText({
    text: input.text,
    sources: input.sources,
  });

  return uniqueUrls.map((url, i) => {
    const title =
      lines.find(
        (l) =>
          !/^https?:/i.test(l) &&
          l.length >= 4 &&
          l.length <= 160 &&
          !/UWM_FIXTURE/i.test(l),
      ) ?? `Result ${i + 1}`;
    const base: RawMonitorCandidate = {
      title,
      url,
      sourceUrls: [url],
      summary: lines.slice(0, 3).join(" ").slice(0, 280),
      retrievalOk: true,
    };
    if (!extracted) return base;
    return {
      ...base,
      eventAt: extracted.eventAtIso,
      attributes: {
        eventAtLocal: extracted.localWall,
        eventAtTimeZone: extracted.timeZone,
        eventAtTimeZoneSource: extracted.timeZoneSource,
        eventAtSnippet: extracted.snippet,
        eventAtExtractedFrom: "web_search_prose",
      },
    };
  });
}

/**
 * Sanitize candidate eventAt to UTC absolute only.
 * Date-only may be preserved on attributes.eventDate (not eventAt).
 */
export function sanitizeCandidateEventAt(c: RawMonitorCandidate): {
  eventAt: string | null;
  attributes: Record<string, string | number | boolean | null>;
} {
  const attrs: Record<string, string | number | boolean | null> = {
    ...(c.attributes ?? {}),
  };
  const raw = c.eventAt ?? null;
  if (isDateOnly(raw)) {
    attrs.eventDate = String(raw).trim();
    return { eventAt: null, attributes: attrs };
  }
  const utc = normalizeAbsoluteUtcIso(raw);
  return { eventAt: utc, attributes: attrs };
}

function officialHint(url?: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host.endsWith(".gov.il") ||
      host.endsWith(".gov") ||
      /\b(official|league|airport|airline)\b/i.test(host)
    );
  } catch {
    return false;
  }
}

export function gradeEvidence(input: {
  candidate: RawMonitorCandidate;
  provenance: UwmFactProvenance[];
  evidenceMin?: "observed" | "corroborated";
}): { grade: UwmEvidenceGrade; verified: boolean } {
  const c = input.candidate;
  if (c.retrievalOk === false) {
    return { grade: "unverified", verified: false };
  }
  if (c.conflictEventAt && c.eventAt && c.conflictEventAt !== c.eventAt) {
    return { grade: "disputed", verified: false };
  }
  const withUrl = input.provenance.filter((p) => Boolean(p.url));
  if (withUrl.length === 0 && !c.url) {
    return { grade: "unverified", verified: false };
  }
  const distinctHosts = new Set(
    withUrl
      .map((p) => {
        try {
          return new URL(p.url!).hostname;
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  );
  if (distinctHosts.size >= 2) {
    return { grade: "corroborated", verified: true };
  }
  if (withUrl.length >= 1 || c.url) {
    return { grade: "observed", verified: true };
  }
  return { grade: "unverified", verified: false };
}

export function normalizeCandidates(input: {
  candidates: RawMonitorCandidate[];
  fetchedAt: string;
  sourceKind: UwmFactProvenance["kind"];
  sourceId: string;
  cacheHit?: boolean;
  spec?: LlmWebMonitorCondition | null;
  /** Existing monitorState items for alias merge (Phase 4). */
  existingItems?: Record<string, UwmMonitorItemState>;
}): NormalizedMonitorItem[] {
  const out: NormalizedMonitorItem[] = [];
  const aspects =
    input.spec?.objectives
      ?.filter((o) => o.kind === "detect_change")
      .flatMap((o) => o.changeAspects ?? ["content"]) ?? [];
  for (const c of input.candidates) {
    const title = String(c.title ?? "").trim();
    if (!title) continue;
    const url = c.url?.trim() || undefined;
    const sourceUrls = [
      ...new Set(
        [...(c.sourceUrls ?? []), url].filter(Boolean).map((u) => String(u)),
      ),
    ];
    const retrievedAt = input.fetchedAt;
    const publishedAt = normalizePublishedAt(c.publishedAt ?? null);
    const sanitized = sanitizeCandidateEventAt(c);
    const eventAt = sanitized.eventAt;
    const attrs = sanitized.attributes;
    const contentFp = shaContent([
      title,
      c.summary,
      eventAt,
      c.locationText,
      JSON.stringify(attrs),
      (c as { bodyFp?: string }).bodyFp,
    ]);
    const provenance: UwmFactProvenance[] = sourceUrls.map((u, i) => ({
      sourceId: input.sourceId,
      kind: input.sourceKind,
      url: u,
      fetchedAt: retrievedAt,
      publishedAt,
      verifiedAt: retrievedAt,
      evidenceRole: i === 0 ? "primary" : "corroboration",
      officialHint: officialHint(u),
      cacheHit: input.cacheHit,
    }));
    if (provenance.length === 0 && url) {
      provenance.push({
        sourceId: input.sourceId,
        kind: input.sourceKind,
        url,
        fetchedAt: retrievedAt,
        publishedAt,
        verifiedAt: retrievedAt,
        evidenceRole: "primary",
        officialHint: officialHint(url),
        cacheHit: input.cacheHit,
      });
    }
    const { grade, verified } = gradeEvidence({
      candidate: c,
      provenance,
      evidenceMin: input.spec?.evidenceMin,
    });
    // Never trust a naked confidence field from candidates.
    const resolved =
      input.sourceKind === "web_page" && url
        ? {
            itemId: shaContent([`page:${url}`]).slice(0, 24),
            identityCore: identityCore({
              title,
              url,
              locationText: c.locationText,
            }),
            aliased: false,
          }
        : resolveStableItemId(
            {
              title,
              eventAt,
              url,
              locationText: c.locationText,
            },
            input.existingItems,
          );
    const draft: NormalizedMonitorItem = {
      itemId: resolved.itemId,
      identityCore: resolved.identityCore,
      title,
      summary: c.summary?.trim() || undefined,
      url,
      sourceUrls,
      eventAt,
      locationText: c.locationText ?? null,
      attributes: attrs,
      contentFp,
      confidence: 0,
      retrievedAt,
      publishedAt,
      verified,
      evidenceGrade: grade,
      provenance,
      retrievalOk: c.retrievalOk !== false,
    };
    if (aspects.length) {
      const aspectFps: Record<string, string> = {};
      for (const a of aspects) {
        aspectFps[a] = aspectFingerprint(draft, a);
      }
      draft.aspectFps = aspectFps;
    }
    // Cancelled signal from source attributes (fixture / structured)
    if (
      String(c.attributes?.status ?? "")
        .toLowerCase()
        .includes("cancel")
    ) {
      draft.attributes = { ...draft.attributes, status: "cancelled" };
    }
    out.push(draft);
  }
  return out;
}

/** Semantic relevance vs WatchSpec — hard filters, fail-closed. */
export function itemMatchesSpec(
  item: NormalizedMonitorItem,
  spec: LlmWebMonitorCondition,
): boolean {
  if (!item.retrievalOk) return false;
  const blob = `${item.title} ${item.summary ?? ""} ${item.locationText ?? ""}`.toLowerCase();
  for (const ent of spec.constraints?.entities ?? []) {
    const e = ent.trim().toLowerCase();
    if (e.length < 3) continue;
    const inItem = blob.includes(e);
    const inAsk =
      spec.canonicalQuery.toLowerCase().includes(e) ||
      spec.intent.toLowerCase().includes(e);
    // Irrelevant search hits (entity neither in item nor ask context) drop.
    if (!inItem && !inAsk) return false;
    if (!inItem && inAsk) {
      // Ask mentions entity but item does not — reject as off-topic.
      return false;
    }
  }
  const geo = spec.constraints?.geo?.trim().toLowerCase();
  if (geo && item.locationText) {
    if (!item.locationText.toLowerCase().includes(geo.split(/\s+/)[0] ?? geo)) {
      // soft: allow if geo token in title/summary
      if (!blob.includes(geo.split(/\s+/)[0] ?? "")) {
        return false;
      }
    }
  }
  return true;
}

export function meetsEvidenceMin(
  item: NormalizedMonitorItem,
  min: "observed" | "corroborated" | undefined,
): boolean {
  const need = min ?? "observed";
  if (item.evidenceGrade === "disputed" || item.evidenceGrade === "unverified") {
    return false;
  }
  if (need === "corroborated") {
    return item.evidenceGrade === "corroborated";
  }
  return item.evidenceGrade === "observed" || item.evidenceGrade === "corroborated";
}
