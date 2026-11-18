/**
 * External Data Caching — Phase 1 foundation (eval-db ONLY)
 * ==========================================================
 * Isolated `workee_test` @ `:5436`. Never touches LIVE `:5435`.
 *
 * Run:
 *   npm run test:eval-db -- tests/external-data-cache-e2e.eval-db.test.ts
 *
 * ---------------------------------------------------------------------------
 * Business rules
 * ---------------------------------------------------------------------------
 * - Open `provider` / `scope` strings (no rigid DB enums) so cinema/TMDB,
 *   TV, events, transit, Hebcal, web search, places share one table.
 * - `buildNormalizedCacheKey` collapses whitespace/case, defaults region=IL,
 *   formats dates YYYY-MM-DD, rounds lat/lng to 3 decimals (~110m).
 * - `withExternalCache` read-through: HIT increments hitCount; MISS/EXPIRED
 *   or forceRefresh invokes fetcher and upserts with tier TTL
 *   (STATIC 14d / DAILY 12h / REALTIME 60s, overridable).
 *
 * ---------------------------------------------------------------------------
 * ASCII flow
 * ---------------------------------------------------------------------------
 *
 *  STEP 1 — Dedup / normalize
 *  cold withExternalCache ──► MISS + store
 *  2nd call (messy whitespace/case) ──► HIT, fetcher×1, hitCount=1
 *
 *  STEP 2 — Multi-domain geo/date keys
 *  cinema @ (lat,lng) ≡ cinema @ (~50m offset) ──► same key / HIT
 *  tv_guide + date+region ──► distinct domain key, also HIT on repeat
 *
 *  STEP 3 — TTL expiry
 *  row expiresAt < now ──► fresh fetch + new expiresAt
 *
 *  STEP 4 — forceRefresh
 *  valid cache + forceRefresh:true ──► fetcher again, payload updated
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/database/prisma.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  buildNormalizedCacheKey,
  getExternalCacheRow,
  purgeExpiredCache,
  withExternalCache,
  type ExternalCacheTtlTier,
} from "../src/services/external-cache.service.js";

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, pass: boolean, detail = ""): void {
  checks.push({ name, pass, detail });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const TEST_KEY_PREFIXES = [
  "tmdb|cinema_showtimes|",
  "tv_schedule|tv_guide|",
  "web_search|grounding|",
];

async function cleanupTestRows(): Promise<void> {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  for (const prefix of TEST_KEY_PREFIXES) {
    await prisma.externalDataCache.deleteMany({
      where: { cacheKey: { startsWith: prefix } },
    });
  }
}

describe("external-data-cache-e2e (eval-db :5436)", () => {
  beforeAll(async () => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    expect(new URL(process.env.DATABASE_URL!).port).toBe("5436");
    expect(new URL(process.env.DATABASE_URL!).pathname).toContain("workee_test");
    await cleanupTestRows();
  });

  afterAll(async () => {
    await cleanupTestRows();
    console.log("\n========== SUMMARY ==========");
    for (let i = 0; i < checks.length; i++) {
      const c = checks[i]!;
      console.log(
        `| ${i + 1} | ${c.pass ? "PASS" : "FAIL"} | ${c.name}${c.detail ? ` (${c.detail})` : ""} |`,
      );
    }
    const pass = checks.filter((c) => c.pass).length;
    const fail = checks.length - pass;
    console.log(`\nTOTAL: ${pass} PASS / ${fail} FAIL / ${checks.length} checks`);
    expect(fail).toBe(0);
  });

  it("STEPS 1–4 — normalize, multi-domain keys, TTL, forceRefresh", async () => {
    // STEP 1 — GIVEN empty cache for cinema showtimes query
    //          WHEN cold withExternalCache then immediate 2nd call with messy text
    //          THEN first MISS stores; second HIT; fetcher once; hitCount===1
    let cinemaFetches = 0;
    const cinemaBase = {
      provider: "tmdb",
      scope: "cinema_showtimes",
      query: "Tonight at Cinema City",
      region: "IL",
      date: "2026-11-18",
      // Already on 3-decimal grid so a ~50m nudge stays in-cell.
      lat: 32.085,
      lng: 34.782,
      ttlTier: "DAILY" as ExternalCacheTtlTier,
    };

    const cold = await withExternalCache({
      ...cinemaBase,
      fetcher: async () => {
        cinemaFetches += 1;
        return { movies: ["Dune"], venue: "Cinema City", v: 1 };
      },
    });
    check("Step1 cold fetch is cache miss", cold.cacheHit === false, `hit=${cold.cacheHit}`);
    check("Step1 cold fetch invoked fetcher once", cinemaFetches === 1, `fetches=${cinemaFetches}`);

    const messyHit = await withExternalCache({
      ...cinemaBase,
      query: "  Tonight   at   Cinema City  ",
      provider: " TMDB ",
      scope: " Cinema_Showtimes ",
      region: " il ",
      fetcher: async () => {
        cinemaFetches += 1;
        return { movies: ["SHOULD_NOT_RUN"], venue: "x", v: 99 };
      },
    });
    const afterHit = await getExternalCacheRow(cold.cacheKey);
    check(
      "Step1 messy whitespace/case resolves to same key",
      messyHit.cacheKey === cold.cacheKey,
      `cold=${cold.cacheKey} messy=${messyHit.cacheKey}`,
    );
    check("Step1 second call is cache hit", messyHit.cacheHit === true, `hit=${messyHit.cacheHit}`);
    check(
      "Step1 fetcher still invoked only once",
      cinemaFetches === 1,
      `fetches=${cinemaFetches}`,
    );
    check(
      "Step1 hitCount incremented to 1",
      afterHit?.hitCount === 1,
      `hitCount=${afterHit?.hitCount}`,
    );
    check(
      "Step1 cached payload preserved",
      Array.isArray((messyHit.payload as { movies?: string[] }).movies) &&
        (messyHit.payload as { movies: string[] }).movies[0] === "Dune",
      JSON.stringify(messyHit.payload),
    );

    // STEP 2 — GIVEN cinema key at base coords + tv_guide date/region domain
    //          WHEN ~50m geo offset cinema query and repeated tv_guide query
    //          THEN cinema shares HIT; tv_guide has distinct deterministic key + HIT
    const offsetLat = 32.085 + 0.0004; // ~44m north, still rounds to 32.085
    const offsetLng = 34.782 + 0.0003; // ~28m east, still rounds to 34.782
    const offsetKey = buildNormalizedCacheKey({
      provider: "tmdb",
      scope: "cinema_showtimes",
      query: "Tonight at Cinema City",
      region: "IL",
      date: "2026-11-18",
      lat: offsetLat,
      lng: offsetLng,
    });
    check(
      "Step2 ~50m geo offset rounds to same cinema key",
      offsetKey === cold.cacheKey,
      `base=${cold.cacheKey} offset=${offsetKey}`,
    );

    const geoHit = await withExternalCache({
      ...cinemaBase,
      lat: offsetLat,
      lng: offsetLng,
      fetcher: async () => {
        cinemaFetches += 1;
        return { movies: ["NOPE"], venue: "x", v: 2 };
      },
    });
    check("Step2 geo-offset cinema call is HIT", geoHit.cacheHit === true);
    check(
      "Step2 cinema fetcher still once after geo HIT",
      cinemaFetches === 1,
      `fetches=${cinemaFetches}`,
    );

    let tvFetches = 0;
    const tvBase = {
      provider: "tv_schedule",
      scope: "tv_guide",
      query: "Channel 11 tonight",
      region: "IL",
      date: "2026-11-18",
      ttlTier: "DAILY" as ExternalCacheTtlTier,
    };
    const tvCold = await withExternalCache({
      ...tvBase,
      fetcher: async () => {
        tvFetches += 1;
        return { channel: 11, shows: ["News"] };
      },
    });
    const tvKeyExpected = buildNormalizedCacheKey({
      provider: "tv_schedule",
      scope: "tv_guide",
      query: "Channel 11 tonight",
      region: "IL",
      date: "2026-11-18",
    });
    check(
      "Step2 tv_guide key is deterministic and domain-distinct",
      tvCold.cacheKey === tvKeyExpected && tvCold.cacheKey !== cold.cacheKey,
      `tv=${tvCold.cacheKey}`,
    );
    check("Step2 tv_guide cold is miss", tvCold.cacheHit === false);

    const tvHit = await withExternalCache({
      ...tvBase,
      query: "channel 11   tonight",
      fetcher: async () => {
        tvFetches += 1;
        return { channel: 11, shows: ["NOPE"] };
      },
    });
    check("Step2 tv_guide repeat is HIT", tvHit.cacheHit === true);
    check("Step2 tv_guide fetcher once", tvFetches === 1, `fetches=${tvFetches}`);

    // STEP 3 — GIVEN a REALTIME row forced expired
    //          WHEN withExternalCache again
    //          THEN fresh fetch and expiresAt updated forward
    let webFetches = 0;
    const webBase = {
      provider: "web_search",
      scope: "grounding",
      query: "שעות פתיחה סופרמרקט תל אביב",
      ttlTier: "REALTIME" as ExternalCacheTtlTier,
      ttlSeconds: 30,
    };
    const webCold = await withExternalCache({
      ...webBase,
      fetcher: async () => {
        webFetches += 1;
        return { snippets: ["open 08:00"], v: 1 };
      },
    });
    const beforeExpire = await getExternalCacheRow(webCold.cacheKey);
    expect(beforeExpire).toBeTruthy();
    const expiredAt = new Date(Date.now() - 5_000);
    await prisma.externalDataCache.update({
      where: { cacheKey: webCold.cacheKey },
      data: { expiresAt: expiredAt },
    });

    const webRefresh = await withExternalCache({
      ...webBase,
      fetcher: async () => {
        webFetches += 1;
        return { snippets: ["open 09:00"], v: 2 };
      },
    });
    const afterExpire = await getExternalCacheRow(webCold.cacheKey);
    check("Step3 expired entry re-fetches", webRefresh.cacheHit === false && webFetches === 2, `fetches=${webFetches}`);
    check(
      "Step3 payload updated after expiry",
      (webRefresh.payload as { v: number }).v === 2,
      JSON.stringify(webRefresh.payload),
    );
    check(
      "Step3 expiresAt moved forward past now",
      !!afterExpire && afterExpire.expiresAt.getTime() > Date.now(),
      `expiresAt=${afterExpire?.expiresAt.toISOString()}`,
    );

    // STEP 4 — GIVEN valid (non-expired) cache
    //          WHEN forceRefresh:true
    //          THEN fetcher runs again and stored payload updates
    const forced = await withExternalCache({
      ...webBase,
      forceRefresh: true,
      fetcher: async () => {
        webFetches += 1;
        return { snippets: ["open 10:00"], v: 3 };
      },
    });
    const afterForce = await getExternalCacheRow(webCold.cacheKey);
    check("Step4 forceRefresh bypasses valid cache", forced.cacheHit === false, `hit=${forced.cacheHit}`);
    check("Step4 forceRefresh invoked fetcher", webFetches === 3, `fetches=${webFetches}`);
    check(
      "Step4 stored payload updated by forceRefresh",
      (afterForce?.payload as { v?: number })?.v === 3,
      JSON.stringify(afterForce?.payload),
    );

    // Maintenance smoke: expired-only purge does not remove fresh rows.
    await prisma.externalDataCache.update({
      where: { cacheKey: webCold.cacheKey },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const purged = await purgeExpiredCache();
    const cinemaStill = await getExternalCacheRow(cold.cacheKey);
    const webGone = await getExternalCacheRow(webCold.cacheKey);
    check("Step4 purgeExpiredCache deleted expired web row", purged >= 1 && !webGone, `purged=${purged}`);
    check("Step4 purge left valid cinema row", !!cinemaStill, `cinema=${!!cinemaStill}`);
  });
});
