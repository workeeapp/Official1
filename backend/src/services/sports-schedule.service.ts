/**
 * Sports schedules via ExternalDataCache (short/DAILY TTL).
 * Provider HTTP is injected (`fetchScheduleImpl`) so E2E can stay offline;
 * production can wire a real feed or hosted web search later.
 *
 * Watches (`sports_match` compose_condition) and follow-up reminders read
 * through this path — never a cache-write Action.
 */
import type { LlmWebLookupCacheScope } from "@workee/shared";
import { withExternalCache } from "./external-cache.service.js";
import {
  getExternalLookupProviderConfig,
  providerTtlSeconds,
} from "./external-lookup.config.js";
import {
  burnExternalLookupQuota,
  buildWebLookupCacheQueryToken,
} from "./external-lookup.service.js";

export type SportsMatchFact = {
  /** Stable id for dedupe (fingerprint / lastReportSha). */
  matchId: string;
  team: string;
  opponent: string;
  competition: string;
  /** Kickoff instant (ISO). */
  kickoffIso: string;
  venue?: string;
};

export type SportsScheduleFacts = {
  team: string;
  matches: SportsMatchFact[];
  source: string;
};

export type FetchSportsScheduleOptions = {
  team: string;
  competition?: string | null;
  userId?: string | null;
  cacheScope?: LlmWebLookupCacheScope;
  forceRefresh?: boolean;
  skipExternalCache?: boolean;
  now?: Date;
  /**
   * Test / provider seam. When omitted, returns empty schedule
   * (no invented matches; no ambient HTTP).
   */
  fetchScheduleImpl?: (input: {
    team: string;
    competition: string;
    now: Date;
  }) => Promise<SportsScheduleFacts>;
};

function normTeam(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export function sportsMatchFingerprint(match: SportsMatchFact): string {
  return `sports:${match.matchId}:${match.kickoffIso}`;
}

export function minutesUntilKickoff(
  kickoffIso: string,
  now = new Date(),
): number | null {
  const ms = Date.parse(kickoffIso);
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms - now.getTime()) / 60_000);
}

/** Next upcoming match for team (kickoff >= now - 5m). */
export function nextUpcomingMatch(
  facts: SportsScheduleFacts,
  now = new Date(),
): SportsMatchFact | null {
  const upcoming = facts.matches
    .map((m) => ({ m, mins: minutesUntilKickoff(m.kickoffIso, now) }))
    .filter((x) => x.mins != null && x.mins >= -5)
    .sort((a, b) => (a.mins ?? 0) - (b.mins ?? 0));
  return upcoming[0]?.m ?? null;
}

export async function fetchSportsSchedule(
  options: FetchSportsScheduleOptions,
): Promise<SportsScheduleFacts> {
  const team = options.team.trim();
  const competition = String(options.competition ?? "").trim();
  const now = options.now ?? new Date();
  const empty: SportsScheduleFacts = { team, matches: [], source: "none" };
  if (!team) return empty;

  const cfg = getExternalLookupProviderConfig("sports");
  if (!cfg.enabled) return empty;

  const baseQuery = `${normTeam(team)}|${normTeam(competition)}`;
  const scope = options.cacheScope ?? cfg.defaultCacheScope;
  const cacheQuery = buildWebLookupCacheQueryToken({
    query: baseQuery,
    cacheScope: scope,
    userId: options.userId,
  });

  const runFetch = async (): Promise<SportsScheduleFacts> => {
    if (options.fetchScheduleImpl) {
      return options.fetchScheduleImpl({ team, competition, now });
    }
    return empty;
  };

  if (options.skipExternalCache) {
    return runFetch();
  }

  if (scope === "none") {
    if (options.userId && cfg.burnsQuota) {
      const gate = await burnExternalLookupQuota(options.userId, now);
      if (!gate.allowed) return empty;
    }
    return runFetch();
  }

  const { ttlTier, ttlSeconds } = providerTtlSeconds("sports");
  let quotaBurned = false;
  const cached = await withExternalCache<SportsScheduleFacts>({
    provider: cfg.provider,
    scope: cfg.scope,
    query: cacheQuery,
    region: "IL",
    ttlTier,
    ttlSeconds,
    forceRefresh: options.forceRefresh === true,
    fetcher: async () => {
      if (options.userId && cfg.burnsQuota && !quotaBurned) {
        const gate = await burnExternalLookupQuota(options.userId, now);
        quotaBurned = true;
        if (!gate.allowed) return empty;
      }
      return runFetch();
    },
  });
  return cached.payload;
}

export function formatSportsScheduleHe(facts: SportsScheduleFacts): string {
  if (facts.matches.length === 0) {
    return `לא מצאתי משחקים קרובים עבור ${facts.team}.`;
  }
  const lines = facts.matches.slice(0, 5).map((m) => {
    const when = new Date(m.kickoffIso).toLocaleString("he-IL", {
      timeZone: "Asia/Jerusalem",
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `• ${facts.team} נגד ${m.opponent} — ${when}${m.competition ? ` (${m.competition})` : ""}`;
  });
  return `לוח משחקים ל${facts.team}:\n${lines.join("\n")}`;
}
