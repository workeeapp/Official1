/**
 * Wave 1 — Local Jewish calendar + semantic web_lookup cacheScope
 * ================================================================
 * Isolated eval-db ONLY (`workee_test` @ `:5436`). Never touches LIVE `:5435`.
 *
 * Run:
 *   npm run test:eval-db -- tests/wave1-jewish-cache-scope-e2e.eval-db.test.ts
 *
 * ---------------------------------------------------------------------------
 * STEP 1 — GIVEN local @hebcal/core
 *          WHEN Shabbat / holiday ask for פתח תקווה / פ״ת / חנוכה
 *          THEN exact times offline; externalCalls=0; webSearch=0; 0 cache writes
 *
 * STEP 2 — GIVEN web_lookup cacheScope hints
 *          WHEN global / user / none
 *          THEN shared HIT across users; user isolation; none skips cache write
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/database/prisma.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  computeShabbatTimes,
  computeUpcomingHolidays,
  resolveClassicIlCityName,
  resolveLocalJewishInline,
} from "../src/services/jewish-calendar.service.js";
import {
  buildWebLookupCacheQueryToken,
  cachedHostedWebSearch,
  resolveInlineWebLookup,
} from "../src/services/external-lookup.service.js";
import { CAPABILITY_REGISTRY } from "../src/services/capabilities.registry.js";
import { parseLlmMetadata, parseWebLookupAction } from "@workee/shared";
import { randomUUID } from "node:crypto";

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, pass: boolean, detail = ""): void {
  checks.push({ name, pass, detail });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const USER_A = `cache-scope-a-${randomUUID()}`;
const USER_B = `cache-scope-b-${randomUUID()}`;

async function cleanup(): Promise<void> {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  await prisma.externalDataCache.deleteMany({
    where: {
      OR: [
        { cacheKey: { contains: "opening hours bank" } },
        { cacheKey: { contains: "live score now" } },
        { cacheKey: { contains: USER_A } },
        { cacheKey: { contains: USER_B } },
        { provider: "quota", scope: "external_lookup_daily" },
      ],
    },
  });
}

async function countCacheRows(): Promise<number> {
  return prisma.externalDataCache.count({
    where: { provider: "web_search" },
  });
}

describe("wave1-jewish-cache-scope-e2e (eval-db :5436)", () => {
  beforeAll(async () => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    expect(new URL(process.env.DATABASE_URL!).port).toBe("5436");
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
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

  it("STEPS 1–2 — local Jewish + cacheScope enforcement", async () => {
    // STEP 1 — Zero-network Shabbat / holiday
    const before = await countCacheRows();
    check(
      "Step1 alias פ״ת → Petach Tikvah",
      resolveClassicIlCityName("פ״ת") === "Petach Tikvah",
      String(resolveClassicIlCityName("פ״ת")),
    );
    check(
      "Step1 alias פתח תקווה resolves",
      resolveClassicIlCityName("פתח תקווה") === "Petach Tikvah",
    );

    const shabbat = computeShabbatTimes({
      place: "פתח תקווה",
      date: "2026-11-20",
    });
    check("Step1 Shabbat candles present", !!shabbat?.candles?.clock, shabbat?.candles?.clock);
    check("Step1 Shabbat Havdalah present", !!shabbat?.havdalah?.clock, shabbat?.havdalah?.clock);
    check(
      "Step1 Parasha present",
      !!shabbat?.parasha?.title &&
        /ויצא|vayetzei/i.test(
          shabbat.parasha.title.normalize("NFKD").replace(/[\u0591-\u05C7]/g, ""),
        ),
      shabbat?.parasha?.title,
    );
    check(
      "Step1 computeShabbatTimes externalCalls=0",
      shabbat?.externalCalls === 0 && shabbat.webSearchCalls === 0,
    );

    const alias = computeShabbatTimes({ place: "פ״ת", date: "2026-11-20" });
    check(
      "Step1 פ״ת matches פתח תקווה clocks",
      alias?.candles?.clock === shabbat?.candles?.clock &&
        alias?.havdalah?.clock === shabbat?.havdalah?.clock,
      `pt=${shabbat?.candles?.clock} alias=${alias?.candles?.clock}`,
    );

    const inline = resolveLocalJewishInline({
      query: "מתי נכנסת ומתי יוצאת שבת בפתח תקווה?",
      now: new Date("2026-11-20T10:00:00+02:00"),
    });
    check("Step1 inline Shabbat text has candles+havdalah", !!inline?.text.includes("הדלקת נרות") && !!inline.text.includes("הבדלה"), inline?.text);
    check(
      "Step1 inline zero network counters",
      inline?.externalCalls === 0 &&
        inline.webSearchCalls === 0 &&
        inline.cacheWrites === 0,
    );

    const viaResolver = await resolveInlineWebLookup({
      query: "מתי נכנסת ומתי יוצאת שבת בפתח תקווה?",
      userId: USER_A,
      speakerMessage: "מתי נכנסת ומתי יוצאת שבת בפתח תקווה?",
      now: new Date("2026-11-20T10:00:00+02:00"),
      searchImpl: async () => {
        throw new Error("web search must not run for Shabbat");
      },
    });
    check(
      "Step1 resolveInlineWebLookup uses local Jewish",
      viaResolver.localJewish === true && viaResolver.webSearchCalls === 0,
      JSON.stringify({
        local: viaResolver.localJewish,
        web: viaResolver.webSearchCalls,
      }),
    );
    check(
      "Step1 inline reply includes times",
      viaResolver.text.includes("הדלקת נרות") && viaResolver.verified,
      viaResolver.text.slice(0, 120),
    );

    const holidays = computeUpcomingHolidays({
      place: "ירושלים",
      startYmd: "2026-11-01",
      lookaheadDays: 60,
      collectCap: 40,
    });
    const hanukkah = holidays.holidays.find((h) =>
      /חנוכ|hanuk|chanukah/i.test(
        h.title.normalize("NFKD").replace(/[\u0591-\u05C7]/g, ""),
      ),
    );
    check("Step1 Hanukkah resolved offline", !!hanukkah, hanukkah?.title);
    check(
      "Step1 holidays externalCalls=0",
      holidays.externalCalls === 0 && holidays.webSearchCalls === 0,
    );

    const afterJewish = await countCacheRows();
    check(
      "Step1 zero ExternalDataCache writes from Jewish",
      afterJewish === before,
      `before=${before} after=${afterJewish}`,
    );

    const jewishCap = CAPABILITY_REGISTRY.find((c) => c.id === "jewish");
    check(
      "Step1 capability lists local Shabbat (not externalLookup)",
      !!jewishCap &&
        jewishCap.externalLookup !== true &&
        /מקומי|דטרמיניסטי|בלי רשת/.test(jewishCap.labelHe),
      jewishCap?.labelHe,
    );

    // STEP 2 — cacheScope
    const parsed = parseWebLookupAction({
      web_lookup: {
        query: "ומתי הם סוגרים?",
        canonical_query: "שעות פתיחה בנק הפועלים פתח תקווה",
        cache_scope: "global",
      },
    });
    check(
      "Step2 parse canonicalQuery + cacheScope",
      parsed?.canonicalQuery === "שעות פתיחה בנק הפועלים פתח תקווה" &&
        parsed.cacheScope === "global",
      JSON.stringify(parsed),
    );
    check(
      "Step2 parseLlmMetadata carries cacheScope",
      parseLlmMetadata({
        web_lookup: { query: "x", cache_scope: "user" },
      }).webLookup?.cacheScope === "user",
    );

    let fetches = 0;
    const searchImpl = async (q: string) => {
      fetches += 1;
      return {
        text: `Answer for ${q}`,
        sources: ["https://example.com"],
        usage: null,
        raw: {},
      };
    };

    const g1 = await cachedHostedWebSearch({
      query: "opening hours bank leumi",
      userId: USER_A,
      cacheScope: "global",
      date: "2026-11-18",
      searchImpl,
    });
    const g2 = await cachedHostedWebSearch({
      query: "opening hours bank leumi",
      userId: USER_B,
      cacheScope: "global",
      date: "2026-11-18",
      searchImpl,
    });
    check("Step2 global MISS then HIT across users", g1.cacheHit === false && g2.cacheHit === true, `f=${fetches}`);
    check("Step2 global shared key", g1.cacheKey === g2.cacheKey, g1.cacheKey);
    check("Step2 global fetcher once", fetches === 1, `fetches=${fetches}`);

    const uQuery = "user-private clinic hours near me";
    const ua = await cachedHostedWebSearch({
      query: uQuery,
      userId: USER_A,
      cacheScope: "user",
      date: "2026-11-18",
      searchImpl,
    });
    const ub = await cachedHostedWebSearch({
      query: uQuery,
      userId: USER_B,
      cacheScope: "user",
      date: "2026-11-18",
      searchImpl,
    });
    const ua2 = await cachedHostedWebSearch({
      query: uQuery,
      userId: USER_A,
      cacheScope: "user",
      date: "2026-11-18",
      searchImpl,
    });
    check(
      "Step2 user scope keys differ by userId",
      ua.cacheKey !== ub.cacheKey &&
        buildWebLookupCacheQueryToken({
          query: uQuery,
          cacheScope: "user",
          userId: USER_A,
        }).includes(USER_A),
      `${ua.cacheKey} vs ${ub.cacheKey}`,
    );
    check(
      "Step2 user scope no cross-user HIT",
      ua.cacheHit === false && ub.cacheHit === false && ua2.cacheHit === true,
      `ua=${ua.cacheHit} ub=${ub.cacheHit} ua2=${ua2.cacheHit}`,
    );

    const beforeNone = await countCacheRows();
    const none = await cachedHostedWebSearch({
      query: "live score now ephemeral",
      userId: USER_A,
      cacheScope: "none",
      date: "2026-11-18",
      searchImpl,
    });
    const afterNone = await countCacheRows();
    check("Step2 none skips cache write", none.cacheSkipped === true && afterNone === beforeNone, `before=${beforeNone} after=${afterNone}`);
    check("Step2 none still executes search", none.payload.text.includes("live score now"), none.payload.text);

    const viaCanonical = await resolveInlineWebLookup({
      query: "ומתי הם סוגרים?",
      canonicalQuery: "opening hours bank leumi",
      cacheScope: "global",
      userId: USER_A,
      searchImpl,
      now: new Date("2026-11-18T12:00:00Z"),
    });
    check(
      "Step2 canonicalQuery used for lookup",
      viaCanonical.verified &&
        viaCanonical.searchTopic.includes("opening hours bank leumi"),
      viaCanonical.searchTopic,
    );
  });
});
