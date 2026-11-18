/**
 * Wave 1 — External lookup cache + capability registry + dynamic tips
 * ====================================================================
 * Isolated eval-db ONLY (`workee_test` @ `:5436`). Never touches LIVE `:5435`.
 *
 * Run:
 *   npm run test:eval-db -- tests/wave1-external-lookup-tips-e2e.eval-db.test.ts
 *
 * ---------------------------------------------------------------------------
 * ASCII flow
 * ---------------------------------------------------------------------------
 *
 *  STEP 1 — Cache MISS → HIT (web + places)
 *  cold lookup ──► MISS + quota+1 + fetcher×1
 *  repeat (messy case) ──► HIT + quota unchanged + fetcher×1
 *  forceRefresh ──► MISS path + fetcher×2
 *
 *  STEP 2 — Grounding fallback
 *  empty search payload ──► WEB_LOOKUP_EMPTY_HE (no invented facts)
 *
 *  STEP 3 — Capability sync + dynamic tip facts
 *  registry includes web_lookup / events_cinema
 *  tip-compose tokens render {reminder_title}/{search_topic}/{item_label}
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/database/prisma.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  buildNormalizedCacheKey,
  getExternalCacheRow,
  purgeExpiredCache,
} from "../src/services/external-cache.service.js";
import {
  WEB_LOOKUP_EMPTY_HE,
  cachedHostedWebSearch,
  formatInlineWebLookupReply,
  getExternalLookupQuotaUsed,
  resolveInlineWebLookup,
} from "../src/services/external-lookup.service.js";
import {
  CAPABILITY_REGISTRY,
  formatCapabilityRegistryPromptBlock,
  formatMemberCapabilityCatalogHe,
} from "../src/services/capabilities.registry.js";
import {
  renderStaticTipText,
  formatTipComposeFacts,
} from "../src/services/tip-compose.js";
import { fetchPlacesFacts } from "../src/services/places.js";
import { parseLlmMetadata, parseWebLookupAction } from "@workee/shared";
import { randomUUID } from "node:crypto";

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, pass: boolean, detail = ""): void {
  checks.push({ name, pass, detail });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const TEST_USER = `eval-cache-user-${randomUUID()}`;

async function cleanup(): Promise<void> {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  await prisma.externalDataCache.deleteMany({
    where: {
      OR: [
        { cacheKey: { contains: "cinema city" } },
        { cacheKey: { contains: "חשמלאי" } },
        { cacheKey: { contains: "unverified" } },
        { cacheKey: { contains: TEST_USER } },
        { provider: "quota", scope: "external_lookup_daily" },
      ],
    },
  });
}

describe("wave1-external-lookup-tips-e2e (eval-db :5436)", () => {
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

  it("STEPS 1–3 — cache, grounding fallback, capability + tip facts", async () => {
    // STEP 1 — GIVEN empty cache
    //          WHEN cold web search then messy repeat then forceRefresh
    //          THEN MISS/HIT/force paths + quota only on uncached
    let webFetches = 0;
    const searchImpl = async (query: string) => {
      webFetches += 1;
      return {
        text: `Verified: ${query}`,
        sources: ["https://example.com/a"],
        usage: null,
        raw: {},
      };
    };

    const q1 = await cachedHostedWebSearch({
      query: "Tonight Cinema City showtimes",
      userId: TEST_USER,
      searchImpl,
      date: "2026-11-18",
    });
    const quotaAfterMiss = await getExternalLookupQuotaUsed(TEST_USER);
    check("Step1 web cold is MISS", q1.cacheHit === false, `hit=${q1.cacheHit}`);
    check("Step1 web fetcher once", webFetches === 1, `fetches=${webFetches}`);
    check("Step1 quota burned on MISS", quotaAfterMiss === 1 && q1.quotaBurned, `quota=${quotaAfterMiss}`);

    const q2 = await cachedHostedWebSearch({
      query: "  Tonight   Cinema City showtimes ",
      userId: TEST_USER,
      searchImpl,
      date: "2026-11-18",
    });
    const quotaAfterHit = await getExternalLookupQuotaUsed(TEST_USER);
    check("Step1 messy repeat is HIT", q2.cacheHit === true, `hit=${q2.cacheHit}`);
    check("Step1 HIT same key", q2.cacheKey === q1.cacheKey, q2.cacheKey);
    check("Step1 HIT burns 0 quota", quotaAfterHit === 1 && !q2.quotaBurned, `quota=${quotaAfterHit}`);
    check("Step1 fetcher still once after HIT", webFetches === 1, `fetches=${webFetches}`);

    const q3 = await cachedHostedWebSearch({
      query: "Tonight Cinema City showtimes",
      userId: TEST_USER,
      forceRefresh: true,
      searchImpl,
      date: "2026-11-18",
    });
    const quotaAfterForce = await getExternalLookupQuotaUsed(TEST_USER);
    check("Step1 forceRefresh bypasses cache", q3.cacheHit === false, `hit=${q3.cacheHit}`);
    check("Step1 forceRefresh fetches again", webFetches === 2, `fetches=${webFetches}`);
    check("Step1 forceRefresh burns quota", quotaAfterForce === 2, `quota=${quotaAfterForce}`);

    // Places cache — mock Google Places HTTP
    let placesHttp = 0;
    const placesFetch: typeof fetch = async () => {
      placesHttp += 1;
      return new Response(
        JSON.stringify({
          places: [
            {
              id: "places/x1",
              displayName: { text: "חשמלאי דני" },
              formattedAddress: "פתח תקווה",
              nationalPhoneNumber: "03-1234567",
              currentOpeningHours: {
                openNow: true,
                weekdayDescriptions: ["Sunday: 8–17"],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const placesUser = `${TEST_USER}-places`;
    const p1 = await fetchPlacesFacts({
      query: "חשמלאי",
      place: "פתח תקווה",
      aspects: ["summary", "phone", "hours"],
      lat: 32.085,
      lng: 34.782,
      fetchImpl: placesFetch,
      apiKey: "test-key",
      userId: placesUser,
    });
    check("Step1 places cold returns row", p1.results.length >= 1, `n=${p1.results.length}`);
    check("Step1 places HTTP once on MISS", placesHttp === 1, `http=${placesHttp}`);

    const p2 = await fetchPlacesFacts({
      query: "חשמלאי",
      place: "פתח תקווה",
      aspects: ["summary", "phone", "hours"],
      lat: 32.0854,
      lng: 34.7823,
      fetchImpl: placesFetch,
      apiKey: "test-key",
      userId: placesUser,
    });
    check("Step1 places geo-offset HIT (0 extra HTTP)", placesHttp === 1, `http=${placesHttp}`);
    check(
      "Step1 places HIT preserves phone",
      (p2.results[0] as { nationalPhoneNumber?: string } | undefined)
        ?.nationalPhoneNumber === "03-1234567" ||
        JSON.stringify(p2.results[0] ?? {}).includes("03-1234567"),
      JSON.stringify(p2.results[0] ?? {}).slice(0, 120),
    );

    const p3 = await fetchPlacesFacts({
      query: "חשמלאי",
      place: "פתח תקווה",
      aspects: ["summary", "phone", "hours"],
      lat: 32.085,
      lng: 34.782,
      fetchImpl: placesFetch,
      apiKey: "test-key",
      userId: placesUser,
      forceRefresh: true,
    });
    check("Step1 places forceRefresh hits HTTP again", placesHttp === 2, `http=${placesHttp}`);
    void p1;
    void p3;

    // STEP 2 — GIVEN empty/unverified search
    //          WHEN formatInlineWebLookupReply / resolveInlineWebLookup
    //          THEN honest Hebrew fallback, zero invented facts
    const empty = formatInlineWebLookupReply(
      {
        payload: { text: "", sources: [], model: "test" },
        cacheHit: false,
        ageSeconds: 0,
        cacheKey: "x",
        quotaBurned: false,
        quotaBlocked: false,
      },
      "unverified topic",
    );
    check(
      "Step2 empty search uses honest Hebrew fallback",
      empty.text === WEB_LOOKUP_EMPTY_HE && !empty.verified,
      empty.text,
    );

    const emptyResolve = await resolveInlineWebLookup({
      query: "unverified nonsense xyzzy",
      userId: `${TEST_USER}-empty`,
      searchImpl: async () => ({
        text: "   ",
        sources: [],
        usage: null,
        raw: {},
      }),
    });
    check(
      "Step2 resolveInlineWebLookup empty → fallback",
      emptyResolve.text === WEB_LOOKUP_EMPTY_HE && !emptyResolve.verified,
      emptyResolve.text,
    );

    // STEP 3 — Capability sync + tip compose facts
    const memberBlock = formatCapabilityRegistryPromptBlock("member");
    const guestBlock = formatCapabilityRegistryPromptBlock("guest");
    const catalog = formatMemberCapabilityCatalogHe();
    check(
      "Step3 registry includes web_lookup",
      CAPABILITY_REGISTRY.some((c) => c.id === "web_lookup"),
    );
    check(
      "Step3 registry includes events_cinema",
      CAPABILITY_REGISTRY.some((c) => c.id === "events_cinema"),
    );
    check(
      "Step3 member prompt reflects web search/events",
      memberBlock.includes("חיפוש מאומת") && memberBlock.includes("קולנוע"),
      memberBlock.slice(0, 160),
    );
    check(
      "Step3 guest prompt stays guest-scoped",
      guestBlock.includes("לוסי-אורח") && !guestBlock.includes("חיפוש מאומת"),
      guestBlock.slice(0, 120),
    );
    check("Step3 catalog lead present", catalog.includes("אני יודעת לנהל כל רשימה"));

    const parsed = parseLlmMetadata({
      web_lookup: { query: "שעות פתיחה סופר", force_refresh: true },
    });
    check(
      "Step3 parseWebLookupAction from metadata",
      parsed.webLookup?.query === "שעות פתיחה סופר" &&
        parsed.webLookup.forceRefresh === true,
      JSON.stringify(parsed.webLookup),
    );
    check(
      "Step3 parseWebLookupAction helper",
      parseWebLookupAction({
        web_lookup: { query: "קולנוע הערב" },
      })?.query === "קולנוע הערב",
    );

    const tipStatic = renderStaticTipText(
      "אפשר לשתף את רשימת ה{list_type} אחרי שערכת את «{item_label}».",
      { list_type: "קניות", item_label: "חלב", op: "add" },
    );
    check(
      "Step3 dynamic-ready static tokens render entity",
      tipStatic === "אפשר לשתף את רשימת הקניות אחרי שערכת את «חלב».",
      tipStatic ?? "null",
    );

    const tipReminder = renderStaticTipText(
      "אפשר להפוך את «{reminder_title}» לתזכורת חוזרת.",
      { reminder_title: "לקנות לחם" },
    );
    check(
      "Step3 reminder_title token renders",
      tipReminder === "אפשר להפוך את «לקנות לחם» לתזכורת חוזרת.",
      tipReminder ?? "null",
    );

    const tipSearch = renderStaticTipText(
      "אחרי החיפוש על «{search_topic}» אפשר לשמור תזכורת.",
      { search_topic: "קולנוע סינמה סיטי" },
    );
    check(
      "Step3 search_topic tip references turn entity",
      tipSearch === "אחרי החיפוש על «קולנוע סינמה סיטי» אפשר לשמור תזכורת.",
      tipSearch ?? "null",
    );

    const factsBlock = formatTipComposeFacts({
      list_type: "shopping",
      item_label: "חלב",
      reminder_title: "לקנות לחם",
      search_topic: "שעות פתיחה",
    });
    check(
      "Step3 tip FACTS include extended entities",
      factsBlock.includes("reminder_title:") &&
        factsBlock.includes("search_topic:") &&
        factsBlock.includes("item_label:"),
      factsBlock,
    );

    // Smoke: purge does not throw on eval rows.
    const purged = await purgeExpiredCache(new Date(0));
    check("Step3 purgeExpiredCache callable", purged >= 0, `purged=${purged}`);

    const row = await getExternalCacheRow(q1.cacheKey);
    check("Step3 web cache row persisted", !!row, q1.cacheKey);
    void buildNormalizedCacheKey;
  });
});
