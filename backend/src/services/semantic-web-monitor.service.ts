/**
 * UWM Phase 3–4 — poll orchestration: Discovery vs Bound Page Monitoring,
 * normalize, evidence, multi-item identity, precise arming. Called from reminder-fire.
 */
import type { LlmWebMonitorCondition } from "@workee/shared";
import { parseComposeCondition } from "@workee/shared";
import {
  cachedHostedWebSearch,
  type CachedWebSearchOptions,
} from "./external-lookup.service.js";
import {
  buildNormalizedCacheKey,
  withExternalCache,
} from "./external-cache.service.js";
import { recordUwmMetric } from "./uwm-retrieval-metrics.js";
import {
  writeSourceMemoryFailure,
  writeSourceMemorySuccess,
} from "./uwm-source-memory.js";
import {
  selectSourcesForWatch,
  type UwmSourcePlan,
} from "./uwm-source-selector.js";
import {
  aspectFingerprint,
  extractRawCandidates,
  itemMatchesSpec,
  meetsEvidenceMin,
  normalizeCandidates,
  shaContent,
} from "./uwm-normalize.js";
import {
  computeNextPrecise,
  computePreciseFireAt,
  isPastPreciseGrace,
  isWithinPreciseCatchUp,
  phaseMissed,
  phasePre,
  UWM_REARM_SLACK_MS,
} from "./uwm-schedule.js";
import type {
  NormalizedMonitorItem,
  UwmChangeHistoryEntry,
  UwmMonitorState,
  UwmNextPrecise,
  UwmPollNotify,
} from "./uwm-types.js";

export type PageFetchResult = {
  ok: boolean;
  text: string;
  status?: number;
  soft404?: boolean;
};

export type PollWebMonitorInput = {
  reminderId: string;
  userId: string;
  composeCondition: unknown;
  monitorState: unknown;
  watchOnce: boolean;
  lastReportSha?: string | null;
  now?: Date;
  /**
   * When true, skip discover/change notify and only evaluate precise
   * time_before_event (catch-up / armed fire).
   */
  preciseOnly?: boolean;
  /** Test seams */
  searchImpl?: CachedWebSearchOptions["searchImpl"];
  pageFetchImpl?: (url: string) => Promise<PageFetchResult>;
  skipExternalCache?: boolean;
};

export type PollWebMonitorResult = {
  notify: UwmPollNotify;
  monitorState: UwmMonitorState;
  discoveryUsed: boolean;
  boundPageUsed: boolean;
  itemsFound: number;
  itemsMatched: number;
  /** Suggested dual-schedule fireAt (precise arm only; discovery next merged in fire). */
  nextPrecise: UwmNextPrecise | null;
};

export function parseMonitorState(raw: unknown): UwmMonitorState {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>;
    const nextPrecise =
      row.nextPrecise &&
      typeof row.nextPrecise === "object" &&
      !Array.isArray(row.nextPrecise)
        ? (row.nextPrecise as UwmNextPrecise)
        : row.nextPrecise === null
          ? null
          : undefined;
    return {
      version: 1,
      lastPollAt: typeof row.lastPollAt === "string" ? row.lastPollAt : undefined,
      lastErrorClass:
        (row.lastErrorClass as UwmMonitorState["lastErrorClass"]) ?? null,
      sourcePlan: row.sourcePlan as UwmSourcePlan | undefined,
      items:
        row.items && typeof row.items === "object" && !Array.isArray(row.items)
          ? (row.items as UwmMonitorState["items"])
          : {},
      boundSources: Array.isArray(row.boundSources)
        ? (row.boundSources as UwmMonitorState["boundSources"])
        : [],
      nextPrecise: nextPrecise === undefined ? undefined : nextPrecise,
    };
  }
  return { version: 1, items: {}, boundSources: [], nextPrecise: null };
}

async function defaultPageFetch(url: string): Promise<PageFetchResult> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "WorkeeUWM/1.0" },
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    const soft404 =
      !res.ok ||
      /soft[\s-]?404|page not found|לא נמצא|404/i.test(text.slice(0, 2000));
    if (!res.ok || soft404 || text.trim().length < 40) {
      return { ok: false, text: text.slice(0, 4000), status: res.status, soft404: true };
    }
    return { ok: true, text: text.slice(0, 50_000), status: res.status };
  } catch {
    return { ok: false, text: "", soft404: true };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
}

function phaseFor(
  objectiveId: string,
  kind: string,
  minutesBefore?: number,
): string {
  if (kind === "time_before_event") {
    return `${objectiveId}:pre:${minutesBefore ?? 60}`;
  }
  if (kind === "detect_change") return `${objectiveId}:changed`;
  return `${objectiveId}:discovered`;
}

function buildBodyHe(
  item: NormalizedMonitorItem,
  kind: string,
): string {
  if (kind === "detect_change") {
    return `עדכון במעקב: ${item.title}${item.summary ? ` — ${item.summary}` : ""}`;
  }
  if (kind === "time_before_event" && item.eventAt) {
    return `תזכורת לפני אירוע: ${item.title} (${item.eventAt})`;
  }
  return `נמצא פריט חדש במעקב: ${item.title}${item.url ? `\n${item.url}` : ""}`;
}

/**
 * Run one UWM poll cycle for a web_monitor Reminder.
 */
export async function pollWebMonitor(
  input: PollWebMonitorInput,
): Promise<PollWebMonitorResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const condition = parseComposeCondition(input.composeCondition);
  const emptyNotify: UwmPollNotify = {
    shouldNotify: false,
    fingerprint: "",
    reason: "no_match",
  };
  if (!condition || condition.type !== "web_monitor") {
    return {
      notify: emptyNotify,
      monitorState: parseMonitorState(input.monitorState),
      discoveryUsed: false,
      boundPageUsed: false,
      itemsFound: 0,
      itemsMatched: 0,
      nextPrecise: null,
    };
  }
  const spec = condition;
  const preciseOnly = Boolean(input.preciseOnly);
  let state = parseMonitorState(input.monitorState);
  if (!state.sourcePlan) {
    state.sourcePlan = await selectSourcesForWatch(spec);
  }
  const plan = state.sourcePlan;
  const pageFetch = input.pageFetchImpl ?? defaultPageFetch;

  let discoveryUsed = false;
  let boundPageUsed = false;
  const allItems: NormalizedMonitorItem[] = [];

  // --- Bound page monitoring first (prefer refresh over re-search) ---
  const bound = [...(state.boundSources ?? [])].filter((b) => b.url);
  const needsRediscovery: string[] = [];
  for (const src of bound.slice(0, 6)) {
    boundPageUsed = true;
    const cacheKey = buildNormalizedCacheKey({
      provider: "web_page",
      scope: "monitor_url",
      query: src.url.toLowerCase(),
      region: "IL",
    });
    let pageText = "";
    let cacheHit = false;
    let ok = false;
    if (input.skipExternalCache) {
      const fetched = await pageFetch(src.url);
      ok = fetched.ok && !fetched.soft404;
      pageText = fetched.ok ? stripHtml(fetched.text) : "";
      recordUwmMetric("cache", {
        provider: "web_page",
        hit: false,
        skip: true,
      });
    } else {
      try {
        const cached = await withExternalCache({
          provider: "web_page",
          scope: "monitor_url",
          query: src.url.toLowerCase(),
          region: "IL",
          ttlTier: "DAILY",
          ttlSeconds: 30 * 60,
          fetcher: async () => {
            const fetched = await pageFetch(src.url);
            return {
              ok: fetched.ok && !fetched.soft404,
              text: fetched.ok ? stripHtml(fetched.text) : "",
              status: fetched.status ?? 0,
              soft404: Boolean(fetched.soft404),
              fetchedAt: nowIso,
            };
          },
        });
        cacheHit = cached.cacheHit;
        ok = Boolean(
          (cached.payload as { ok?: boolean }).ok &&
            !(cached.payload as { soft404?: boolean }).soft404,
        );
        pageText = String((cached.payload as { text?: string }).text ?? "");
        recordUwmMetric("cache", {
          provider: "web_page",
          hit: cacheHit,
          key: cacheKey.slice(0, 80),
        });
      } catch {
        ok = false;
      }
    }

    if (!ok || pageText.length < 20) {
      src.failCount = (src.failCount ?? 0) + 1;
      recordUwmMetric("source_memory", {
        op: "page_fail",
        url: src.url.slice(0, 80),
        failCount: src.failCount,
      });
      if (!input.skipExternalCache) {
        await writeSourceMemoryFailure({
          sourceId: src.sourceId || src.url,
          domain: (() => {
            try {
              return new URL(src.url).hostname;
            } catch {
              return src.url;
            }
          })(),
          accessNotes: "soft404_or_empty",
        }).catch(() => null);
      }
      if (src.failCount >= 2) {
        needsRediscovery.push(src.url);
      }
      continue;
    }

    src.failCount = 0;
    const fromPage = extractRawCandidates({
      text: pageText.includes("UWM_FIXTURE_ITEMS")
        ? pageText
        : `UWM_FIXTURE_ITEMS: ${JSON.stringify([
            {
              title: deriveTitle(pageText, src.url),
              url: src.url,
              sourceUrls: [src.url],
              summary: pageText.slice(0, 400),
              bodyFp: shaContent([pageText.slice(0, 4000)]),
              retrievalOk: true,
              eventAt: extractIsoDate(pageText),
              locationText: null,
            },
          ])}`,
      sources: [src.url],
    });
    const normalized = normalizeCandidates({
      candidates: fromPage,
      fetchedAt: nowIso,
      sourceKind: "web_page",
      sourceId: src.sourceId || "web_page",
      cacheHit,
      spec,
      existingItems: state.items,
    });
    allItems.push(...normalized);
    if (!input.skipExternalCache) {
      await writeSourceMemorySuccess({
        sourceId: src.sourceId || "web_page",
        url: src.url,
        domain: (() => {
          try {
            return new URL(src.url).hostname;
          } catch {
            return undefined;
          }
        })(),
        infoKinds: ["title", "contentFp"],
      }).catch(() => null);
    }
  }

  // Drop failed bound URLs marked for rediscovery
  if (needsRediscovery.length) {
    state.boundSources = (state.boundSources ?? []).filter(
      (b) => !needsRediscovery.includes(b.url),
    );
    recordUwmMetric("source_memory", {
      op: "rediscovery_needed",
      count: needsRediscovery.length,
    });
  }

  // --- Discovery: when plan says so, or no bound sources, or rediscovery ---
  // preciseOnly also forces discovery so we can re-verify eventAt / cancel
  // even when a stale bound URL soft-404s (failCount may still be 1).
  const wantsDiscover = spec.objectives.some((o) => o.kind === "discover_new");
  const boundFailedThisPoll = bound.some(
    (b) => (b.failCount ?? 0) > 0 && needsRediscovery.includes(b.url) === false,
  ) && allItems.length === 0 && boundPageUsed;
  const shouldDiscover =
    plan.useWebDiscovery &&
    (wantsDiscover ||
      preciseOnly ||
      (state.boundSources?.length ?? 0) === 0 ||
      needsRediscovery.length > 0 ||
      boundFailedThisPoll);

  if (shouldDiscover) {
    discoveryUsed = true;
    recordUwmMetric("web_search", {
      planned: true,
      executed: true,
      reason: plan.reason,
    });
    try {
      const search = await cachedHostedWebSearch({
        query: spec.canonicalQuery,
        userId: input.skipExternalCache ? undefined : input.userId,
        cacheScope: input.skipExternalCache ? "none" : "global",
        scope: "monitor",
        forceRefresh: needsRediscovery.length > 0,
        searchImpl: input.searchImpl,
      });
      recordUwmMetric("cache", {
        provider: "web_search",
        hit: search.cacheHit,
        quotaBlocked: search.quotaBlocked,
      });
      if (search.quotaBlocked) {
        state.lastErrorClass = "quota";
        state.lastPollAt = nowIso;
        return {
          notify: { ...emptyNotify, reason: "quota" },
          monitorState: state,
          discoveryUsed,
          boundPageUsed,
          itemsFound: 0,
          itemsMatched: 0,
          nextPrecise: state.nextPrecise ?? null,
        };
      }
      const text = search.payload.text ?? "";
      const sources = search.payload.sources ?? [];
      if (!text.trim() && sources.length === 0) {
        state.lastErrorClass = "empty";
      } else {
        const candidates = extractRawCandidates({ text, sources });
        const normalized = normalizeCandidates({
          candidates,
          fetchedAt: nowIso,
          sourceKind: "web",
          sourceId: "web_search",
          cacheHit: search.cacheHit,
          spec,
          existingItems: state.items,
        });
        allItems.push(...normalized);
        for (const it of normalized) {
          if (it.url && it.verified) {
            bindUrl(state, it.url, "web_search");
            if (!input.skipExternalCache) {
              await writeSourceMemorySuccess({
                sourceId: "web_search",
                url: it.url,
                domain: (() => {
                  try {
                    return new URL(it.url!).hostname;
                  } catch {
                    return undefined;
                  }
                })(),
                infoKinds: ["title", "url"],
              }).catch(() => null);
            }
          }
        }
      }
    } catch {
      state.lastErrorClass = "api_fail";
      recordUwmMetric("web_search", { executed: true, error: true });
    }
  } else if (!plan.useWebDiscovery && plan.primary.some((p) => p.kind === "api")) {
    // Phase 3: structured API adapters not yet emitting items — quiet.
    recordUwmMetric("api_call", {
      planned: true,
      executed: false,
      note: "adapter_pending_phase3",
      provider: plan.primary[0]?.id ?? "",
    });
  }

  // Merge same identityCore within this poll (cross-source dedupe), then by itemId.
  const byCore = new Map<string, NormalizedMonitorItem>();
  for (const it of allItems) {
    const core = it.identityCore || it.itemId;
    const prev = byCore.get(core);
    if (!prev) {
      byCore.set(core, it);
      continue;
    }
    const winner =
      rankGrade(it.evidenceGrade) > rankGrade(prev.evidenceGrade) ? it : prev;
    const loser = winner === it ? prev : it;
    byCore.set(core, {
      ...winner,
      itemId: prev.itemId,
      sourceUrls: [
        ...new Set([...winner.sourceUrls, ...loser.sourceUrls]),
      ],
      provenance: [...winner.provenance, ...loser.provenance].slice(0, 8),
    });
  }
  const byId = new Map<string, NormalizedMonitorItem>();
  for (const it of byCore.values()) {
    const prev = byId.get(it.itemId);
    if (!prev || rankGrade(it.evidenceGrade) > rankGrade(prev.evidenceGrade)) {
      byId.set(it.itemId, it);
    }
  }
  const items = [...byId.values()];
  recordUwmMetric("select", {
    itemsFound: items.length,
    discoveryUsed,
    boundPageUsed,
  });

  const matched = items.filter((it) => itemMatchesSpec(it, spec));
  let notify: UwmPollNotify = { ...emptyNotify };
  const lastSha = String(input.lastReportSha ?? "").trim();

  for (const obj of spec.objectives) {
    for (const item of matched) {
      // Cancelled from source
      if (
        String(item.attributes?.status ?? "")
          .toLowerCase()
          .includes("cancel")
      ) {
        const prev = state.items[item.itemId];
        state.items[item.itemId] = {
          ...(prev ?? {
            firstSeenAt: nowIso,
            lastSeenAt: nowIso,
            contentFp: item.contentFp,
            notified: {},
          }),
          status: "cancelled",
          lastSeenAt: nowIso,
          eventAt: item.eventAt ?? prev?.eventAt,
          contentFp: item.contentFp,
          identityCore: item.identityCore ?? prev?.identityCore,
          evidenceGrade: item.evidenceGrade,
        };
        if (state.nextPrecise?.itemId === item.itemId) {
          state.nextPrecise = null;
        }
        continue;
      }

      if (!meetsEvidenceMin(item, spec.evidenceMin)) {
        if (item.evidenceGrade === "disputed") {
          notify = {
            shouldNotify: false,
            fingerprint: "",
            reason: "disputed",
            item,
          };
          // Evidence lost on armed item → clear precise
          if (state.nextPrecise?.itemId === item.itemId) {
            state.nextPrecise = null;
          }
        } else if (item.evidenceGrade === "unverified") {
          notify = {
            shouldNotify: false,
            fingerprint: "",
            reason: "unverified",
            item,
          };
          if (state.nextPrecise?.itemId === item.itemId) {
            state.nextPrecise = null;
          }
        }
        continue;
      }
      if (item.retrievalOk === false) {
        continue;
      }
      if (isStaleUnverified(item, boundPageUsed && !needsRediscovery.length)) {
        notify = {
          shouldNotify: false,
          fingerprint: "",
          reason: "stale",
          item,
        };
        continue;
      }

      const prev = state.items[item.itemId];
      const st = prev ?? {
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        contentFp: item.contentFp,
        eventAt: item.eventAt,
        evidenceGrade: item.evidenceGrade,
        provenance: item.provenance,
        boundUrls: item.url ? [item.url] : [],
        notified: {},
        identityCore: item.identityCore,
        aspectFps: item.aspectFps,
        changeHistory: [],
      };

      // Reschedule: material eventAt move before pre-phase fires → clear phase only if unmet
      if (
        prev?.eventAt &&
        item.eventAt &&
        prev.eventAt !== item.eventAt
      ) {
        const delta = Math.abs(
          Date.parse(item.eventAt) - Date.parse(prev.eventAt),
        );
        if (Number.isFinite(delta) && delta >= UWM_REARM_SLACK_MS) {
          for (const o of spec.objectives) {
            if (o.kind !== "time_before_event") continue;
            const mins = o.minutesBefore ?? 60;
            const phase = phasePre(o.id, mins);
            // If already notified, do not re-notify; if not yet, keep clear for re-arm
            if (!st.notified[phase]) {
              // ensure precise recomputed later
            }
          }
          const hist: UwmChangeHistoryEntry = {
            at: nowIso,
            aspect: "eventAt",
            fromFp: aspectFingerprint(
              { ...item, eventAt: prev.eventAt, contentFp: prev.contentFp },
              "eventAt",
            ),
            toFp: aspectFingerprint(item, "eventAt"),
            fromEventAt: prev.eventAt,
            toEventAt: item.eventAt,
          };
          st.changeHistory = [...(st.changeHistory ?? []), hist].slice(-20);
        }
      }

      if (obj.kind === "discover_new" && !preciseOnly) {
        const phase = phaseFor(obj.id, obj.kind);
        const fp = `wm:${item.itemId}:${phase}`.slice(0, 64);
        const urlAlreadyNotified = Boolean(
          item.url &&
            Object.values(state.items).some(
              (s) =>
                (s.boundUrls ?? []).includes(item.url!) &&
                Boolean(s.notified[phase]),
            ),
        );
        if (!st.notified[phase] && !urlAlreadyNotified && fp !== lastSha) {
          notify = {
            shouldNotify: true,
            fingerprint: fp,
            bodyHe: buildBodyHe(item, obj.kind),
            item,
            phase,
          };
          st.notified[phase] = nowIso;
          state.items[item.itemId] = {
            ...st,
            lastSeenAt: nowIso,
            contentFp: item.contentFp,
            identityCore: item.identityCore ?? st.identityCore,
            eventAt: item.eventAt ?? st.eventAt,
            evidenceGrade: item.evidenceGrade,
            provenance: item.provenance,
            status: "active",
            boundUrls: [
              ...new Set([
                ...(st.boundUrls ?? []),
                ...(item.url ? [item.url] : []),
              ]),
            ],
          };
          break;
        }
      }

      if (obj.kind === "detect_change" && !preciseOnly) {
        const aspects = obj.changeAspects?.length
          ? obj.changeAspects
          : ["content"];
        const phase = phaseFor(obj.id, obj.kind);
        const changed: string[] = [];
        const newAspectFps: Record<string, string> = {
          ...(st.aspectFps ?? {}),
        };
        const history = [...(st.changeHistory ?? [])];
        for (const aspect of aspects) {
          const nextFp =
            item.aspectFps?.[aspect] ?? aspectFingerprint(item, aspect);
          const prevFp = st.aspectFps?.[aspect];
          if (prevFp && prevFp !== nextFp) {
            changed.push(aspect);
            history.push({
              at: nowIso,
              aspect,
              fromFp: prevFp,
              toFp: nextFp,
              fromEventAt: st.eventAt,
              toEventAt: item.eventAt,
            });
          }
          newAspectFps[aspect] = nextFp;
        }
        // Fallback: contentFp flip when no aspect fps seeded yet
        const contentChanged =
          Boolean(prev?.contentFp) &&
          prev!.contentFp !== item.contentFp &&
          aspects.includes("content");
        const fp = `wm:${item.itemId}:${phase}:${item.contentFp}`.slice(0, 64);
        if (
          (changed.length > 0 || contentChanged) &&
          !st.notified[fp] &&
          prev
        ) {
          notify = {
            shouldNotify: true,
            fingerprint: fp,
            bodyHe: buildBodyHe(item, obj.kind),
            item,
            phase,
          };
          st.notified[phase] = nowIso;
          st.notified[fp] = nowIso;
          state.items[item.itemId] = {
            ...st,
            lastSeenAt: nowIso,
            contentFp: item.contentFp,
            aspectFps: newAspectFps,
            changeHistory: history.slice(-20),
            eventAt: item.eventAt ?? st.eventAt,
            identityCore: item.identityCore ?? st.identityCore,
            evidenceGrade: item.evidenceGrade,
            provenance: item.provenance,
            status: "active",
          };
          break;
        }
        state.items[item.itemId] = {
          ...st,
          lastSeenAt: nowIso,
          contentFp: item.contentFp,
          aspectFps: newAspectFps,
          changeHistory: history.slice(-20),
          eventAt: item.eventAt ?? st.eventAt,
          identityCore: item.identityCore ?? st.identityCore,
          firstSeenAt: prev?.firstSeenAt ?? nowIso,
          status: "active",
        };
      }

      if (obj.kind === "time_before_event") {
        const mins = obj.minutesBefore ?? 60;
        const phase = phasePre(obj.id, mins);
        const missedPhase = phaseMissed(obj.id, mins);
        state.items[item.itemId] = {
          ...st,
          lastSeenAt: nowIso,
          eventAt: item.eventAt ?? st.eventAt,
          contentFp: item.contentFp,
          identityCore: item.identityCore ?? st.identityCore,
          evidenceGrade: item.evidenceGrade,
          provenance: item.provenance,
          firstSeenAt: prev?.firstSeenAt ?? nowIso,
          status: st.status === "cancelled" ? "cancelled" : "active",
          boundUrls: [
            ...new Set([
              ...(st.boundUrls ?? []),
              ...(item.url ? [item.url] : []),
            ]),
          ],
        };
        if (!item.eventAt || st.notified[phase] || st.notified[missedPhase]) {
          continue;
        }
        const preciseAt = computePreciseFireAt(item.eventAt, mins);
        if (!preciseAt) continue;

        if (isPastPreciseGrace({ now, eventAtIso: item.eventAt })) {
          state.items[item.itemId]!.notified[missedPhase] = nowIso;
          if (state.nextPrecise?.itemId === item.itemId) {
            state.nextPrecise = null;
          }
          notify = {
            shouldNotify: false,
            fingerprint: "",
            reason: "missed",
            item,
            phase: missedPhase,
          };
          continue;
        }

        if (
          isWithinPreciseCatchUp({
            now,
            preciseFireAt: preciseAt,
            eventAtIso: item.eventAt,
          })
        ) {
          const fp = `wm:${item.itemId}:${phase}`.slice(0, 64);
          if (fp !== lastSha) {
            notify = {
              shouldNotify: true,
              fingerprint: fp,
              bodyHe: buildBodyHe(item, obj.kind),
              item,
              phase,
              reason: "precise",
            };
            state.items[item.itemId]!.notified[phase] = nowIso;
            if (state.nextPrecise?.itemId === item.itemId) {
              state.nextPrecise = null;
            }
            break;
          }
        }
      }
    }
    if (notify.shouldNotify) break;
  }

  // Persist seen items that did not notify
  for (const item of matched) {
    if (!state.items[item.itemId]) {
      state.items[item.itemId] = {
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        contentFp: item.contentFp,
        identityCore: item.identityCore,
        eventAt: item.eventAt,
        evidenceGrade: item.evidenceGrade,
        provenance: item.provenance,
        boundUrls: item.url ? [item.url] : [],
        notified: {},
        aspectFps: item.aspectFps,
        changeHistory: [],
        status: "active",
      };
    } else {
      const cur = state.items[item.itemId]!;
      if (!cur.identityCore && item.identityCore) {
        cur.identityCore = item.identityCore;
      }
    }
  }

  // Mark missed on armed precise if past grace and item not refreshed
  if (state.nextPrecise) {
    const p = state.nextPrecise;
    if (isPastPreciseGrace({ now, eventAtIso: p.eventAtIso })) {
      const st = state.items[p.itemId];
      if (st) {
        const missed = phaseMissed(p.objectiveId, p.minutesBefore);
        if (!st.notified[missed] && !st.notified[phasePre(p.objectiveId, p.minutesBefore)]) {
          st.notified[missed] = nowIso;
        }
      }
      state.nextPrecise = null;
      if (!notify.shouldNotify) {
        notify = { ...notify, reason: "missed" };
      }
    }
  }

  // Arm earliest unmet precise across items
  state.nextPrecise = computeNextPrecise({
    items: state.items,
    objectives: spec.objectives,
    now,
  });

  state.lastPollAt = nowIso;
  if (notify.shouldNotify) {
    state.lastErrorClass = null;
    recordUwmMetric("select", {
      notified: true,
      fingerprint: notify.fingerprint.slice(0, 40),
      itemsMatched: matched.length,
      nextPrecise: state.nextPrecise?.fireAtIso?.slice(0, 19) ?? "",
    });
  } else if (!state.lastErrorClass) {
    state.lastErrorClass =
      matched.length === 0 && items.length === 0 ? "empty" : null;
  }

  recordUwmMetric("select", {
    nextPreciseArmed: Boolean(state.nextPrecise),
    itemCount: Object.keys(state.items).length,
  });

  return {
    notify,
    monitorState: state,
    discoveryUsed,
    boundPageUsed,
    itemsFound: items.length,
    itemsMatched: matched.length,
    nextPrecise: state.nextPrecise ?? null,
  };
}

function bindUrl(state: UwmMonitorState, url: string, sourceId: string): void {
  state.boundSources = state.boundSources ?? [];
  if (state.boundSources.some((b) => b.url === url)) return;
  state.boundSources.push({ url, sourceId, failCount: 0 });
}

/** Old publishedAt + only cacheHits without a successful bound refresh → no alert. */
function isStaleUnverified(
  item: NormalizedMonitorItem,
  hadFreshBound: boolean,
): boolean {
  if (hadFreshBound) return false;
  const pubs = item.provenance
    .map((p) => p.publishedAt)
    .filter((p): p is string => Boolean(p));
  if (pubs.length === 0) return false;
  const allCache = item.provenance.every((p) => p.cacheHit === true);
  if (!allCache) return false;
  const newest = Math.max(...pubs.map((p) => Date.parse(p)).filter(Number.isFinite));
  if (!Number.isFinite(newest)) return false;
  const ageMs = Date.now() - newest;
  return ageMs > 7 * 24 * 60 * 60 * 1000;
}

function rankGrade(g: string): number {
  switch (g) {
    case "corroborated":
      return 3;
    case "observed":
      return 2;
    case "disputed":
      return 1;
    default:
      return 0;
  }
}

function deriveTitle(text: string, url: string): string {
  const line = text
    .split(/\n|\.\s/)
    .map((l) => l.trim())
    .find((l) => l.length > 8 && l.length < 120);
  if (line) return line;
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 80);
  }
}

function extractIsoDate(text: string): string | null {
  const m = text.match(/\b(20\d{2}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2})?)/);
  return m?.[1] ?? null;
}
