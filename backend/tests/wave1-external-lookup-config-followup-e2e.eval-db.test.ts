/**
 * Wave 1 — Centralized external lookup config + follow-up / watch hooks
 * =====================================================================
 * Isolated eval-db ONLY (`workee_test` @ `:5436`). Never touches LIVE `:5435`.
 *
 * Run:
 *   npm run test:eval-db -- tests/wave1-external-lookup-config-followup-e2e.eval-db.test.ts
 *
 * ---------------------------------------------------------------------------
 * ASCII flow
 * ---------------------------------------------------------------------------
 *
 *  STEP 1 — Config + cacheScope routing
 *  global MISS→HIT shared │ user isolated by auth userId │ none skips write
 *
 *  STEP 2 — נתב״ג / TLV flights short TTL
 *  cold board ──► MISS + fetcher×1
 *  warm board ──► HIT + fetcher×1 (0 extra AviationStack)
 *
 *  STEP 3 — Follow-up reminder + sports watch dedupe
 *  fact → external_event reminder (1h before) persisted via applyReminders
 *  sports_match watch → fire when ≤threshold; same matchId quiet-skipped
 *
 *  STEP 4 — Jewish local still 0 cache writes
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/database/prisma.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  getExternalLookupConfig,
  getExternalLookupProviderConfig,
  providerTtlSeconds,
} from "../src/services/external-lookup.config.js";
import {
  buildWebLookupCacheQueryToken,
  cachedHostedWebSearch,
} from "../src/services/external-lookup.service.js";
import { fetchFlightsBoard } from "../src/services/flights.js";
import {
  buildExternalEventFollowUpReminder,
  buildSportsMatchWatchReminder,
  fireAtFromExternalEvent,
} from "../src/services/fact-followup.service.js";
import {
  fetchSportsSchedule,
  sportsMatchFingerprint,
  type SportsScheduleFacts,
} from "../src/services/sports-schedule.service.js";
import { evaluateComposeCondition } from "../src/services/compose-condition.js";
import { applyReminders } from "../src/services/reminder.service.js";
import { resolveLocalJewishInline } from "../src/services/jewish-calendar.service.js";
import { CAPABILITY_REGISTRY } from "../src/services/capabilities.registry.js";
import { parseComposeCondition, parseLlmMetadata } from "@workee/shared";

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, pass: boolean, detail = ""): void {
  checks.push({ name, pass, detail });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const USER_A = `cache-cfg-a-${randomUUID()}`;
const USER_B = `cache-cfg-b-${randomUUID()}`;
const RUN = randomUUID().slice(0, 8);

async function cleanup(): Promise<void> {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  await prisma.externalDataCache.deleteMany({
    where: {
      OR: [
        { cacheKey: { contains: USER_A } },
        { cacheKey: { contains: USER_B } },
        { cacheKey: { contains: "tlv|departures" } },
        { cacheKey: { contains: "real madrid" } },
        { cacheKey: { contains: `cfg-scope-${RUN}` } },
        { provider: "quota", scope: "external_lookup_daily" },
        { provider: "flights" },
        { provider: "sports" },
      ],
    },
  });
}

describe("wave1-external-lookup-config-followup-e2e (eval-db :5436)", () => {
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

  it("STEPS 1–4 — config, נתב״ג cache, follow-up + watch, jewish zero-cache", async () => {
    // ── STEP 1 — GIVEN centralized config
    //            WHEN reading provider TTL / quota
    //            THEN flights short TTL; jewish not a provider; cacheScope works
    const cfg = getExternalLookupConfig();
    check("Step1 dailyMissQuota centralized", cfg.dailyMissQuota >= 1, String(cfg.dailyMissQuota));
    const flightsCfg = getExternalLookupProviderConfig("flights");
    const { ttlSeconds: flightsTtl } = providerTtlSeconds("flights");
    check(
      "Step1 נתב״ג flights short TTL (≤180s)",
      flightsCfg.ttlTier === "REALTIME" && flightsTtl > 0 && flightsTtl <= 180,
      String(flightsTtl),
    );
    check(
      "Step1 jewish absent from external providers",
      !("jewish" in cfg.providers),
    );

    let fetches = 0;
    const searchImpl = async (q: string) => {
      fetches += 1;
      return {
        text: `Answer ${q}`,
        sources: ["https://example.com/cfg"],
        usage: null,
        raw: {},
      };
    };
    const globalQ = `cfg-scope-${RUN} opening hours bank leumi`;
    const g1 = await cachedHostedWebSearch({
      query: globalQ,
      userId: USER_A,
      cacheScope: "global",
      searchImpl,
      date: "2026-11-18",
    });
    const g2 = await cachedHostedWebSearch({
      query: globalQ,
      userId: USER_B,
      cacheScope: "global",
      searchImpl,
      date: "2026-11-18",
    });
    check("Step1 global MISS then shared HIT", g1.cacheHit === false && g2.cacheHit === true, `f=${fetches}`);
    check("Step1 global fetcher once", fetches === 1);

    const userQ = `cfg-scope-${RUN} user-private clinic hours`;
    const uaTok = buildWebLookupCacheQueryToken({
      query: userQ,
      cacheScope: "user",
      userId: USER_A,
    });
    const ubTok = buildWebLookupCacheQueryToken({
      query: userQ,
      cacheScope: "user",
      userId: USER_B,
    });
    check(
      "Step1 user scope keys differ by userId",
      uaTok !== ubTok && uaTok.includes(USER_A) && ubTok.includes(USER_B),
      `${uaTok} vs ${ubTok}`,
    );
    const ua1 = await cachedHostedWebSearch({
      query: userQ,
      userId: USER_A,
      cacheScope: "user",
      searchImpl,
      date: "2026-11-18",
    });
    const ub1 = await cachedHostedWebSearch({
      query: userQ,
      userId: USER_B,
      cacheScope: "user",
      searchImpl,
      date: "2026-11-18",
    });
    const ua2 = await cachedHostedWebSearch({
      query: userQ,
      userId: USER_A,
      cacheScope: "user",
      searchImpl,
      date: "2026-11-18",
    });
    check(
      "Step1 user scope no cross-user HIT",
      ua1.cacheHit === false && ub1.cacheHit === false && ua2.cacheHit === true,
      `ua=${ua1.cacheHit} ub=${ub1.cacheHit} ua2=${ua2.cacheHit}`,
    );

    const beforeNone = await prisma.externalDataCache.count();
    const noneRes = await cachedHostedWebSearch({
      query: `cfg-scope-${RUN} live score now ephemeral`,
      userId: USER_A,
      cacheScope: "none",
      searchImpl,
      date: "2026-11-18",
    });
    const afterNone = await prisma.externalDataCache.count();
    check(
      "Step1 none skips cache write",
      noneRes.cacheSkipped === true && afterNone === beforeNone,
      `before=${beforeNone} after=${afterNone}`,
    );
    check("Step1 none still executes search", noneRes.payload.text.includes("live score"));

    // ── STEP 2 — GIVEN mocked AviationStack for TLV
    //            WHEN board fetched twice
    //            THEN second is HIT with 0 extra HTTP
    let aviationCalls = 0;
    const flightFetchImpl: typeof fetch = async () => {
      aviationCalls += 1;
      return new Response(
        JSON.stringify({
          data: [
            {
              flight: { iata: "LY001", number: "001" },
              departure: {
                iata: "TLV",
                scheduled: "2026-11-18T18:00:00+00:00",
                estimated: "2026-11-18T18:00:00+00:00",
                gate: "A1",
                delay: null,
              },
              arrival: {
                iata: "CDG",
                scheduled: "2026-11-18T22:00:00+00:00",
                estimated: "2026-11-18T22:00:00+00:00",
              },
              airline: { name: "El Al", iata: "LY" },
              flight_status: "scheduled",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const board1 = await fetchFlightsBoard({
      airport: "TLV",
      direction: "departures",
      airline: "LY",
      userId: USER_A,
      cacheScope: "global",
      fetchImpl: flightFetchImpl,
      apiKey: "test-key",
      now: new Date("2026-11-18T10:00:00+02:00"),
    });
    const board2 = await fetchFlightsBoard({
      airport: "TLV",
      direction: "departures",
      airline: "LY",
      userId: USER_B,
      cacheScope: "global",
      fetchImpl: flightFetchImpl,
      apiKey: "test-key",
      now: new Date("2026-11-18T10:00:00+02:00"),
    });
    check(
      "Step2 נתב״ג board returns rows",
      board1.rows.length >= 1,
      String(board1.rows.length),
    );
    check(
      "Step2 HIT burns 0 extra AviationStack calls",
      aviationCalls === 1 && board2.rows.length === board1.rows.length,
      `calls=${aviationCalls}`,
    );
    const flightRow = await prisma.externalDataCache.findFirst({
      where: { provider: "flights", scope: "board" },
      orderBy: { fetchedAt: "desc" },
    });
    check(
      "Step2 flights ExternalDataCache row written",
      !!flightRow && flightRow.hitCount >= 1,
      `key=${flightRow?.cacheKey} hits=${flightRow?.hitCount}`,
    );

    // ── STEP 3 — Follow-up reminder + sports watch
    const kickoff = new Date("2026-11-20T22:00:00+02:00");
    const followUp = buildExternalEventFollowUpReminder({
      eventAtIso: kickoff.toISOString(),
      minutesBefore: 60,
      text: "תזכורת: משחק ריאל מדריד בעוד שעה",
      label: "Real Madrid vs Barca",
    });
    const expectedFire = fireAtFromExternalEvent(kickoff.toISOString(), -60);
    check(
      "Step3 external_event fireAt = kickoff−60m",
      !!expectedFire &&
        Math.abs(expectedFire.getTime() - (kickoff.getTime() - 60 * 60_000)) < 1000,
      expectedFire?.toISOString(),
    );

    // Persist via applyReminders needs real employees — use minimal in-memory path:
    // verify parse + compute; for DB persist use prisma.reminder.create with same fields.
    const parsed = parseLlmMetadata({
      reminders: [
        {
          action: "add",
          item: followUp.item,
          text: followUp.text,
          schedule_anchor: "external_event",
          compose_place: followUp.composePlace,
          minutes_before: 60,
          watch_once: true,
        },
      ],
    });
    const rem = parsed.reminders?.[0];
    check(
      "Step3 parse schedule_anchor external_event",
      rem?.scheduleAnchor === "external_event" &&
        (rem.scheduleOffsetMinutes ?? 0) === -60,
      JSON.stringify({
        anchor: rem?.scheduleAnchor,
        offset: rem?.scheduleOffsetMinutes,
      }),
    );

    const phone = `9725${String(Date.now()).slice(-8)}`;
    const user = await prisma.user.create({
      data: { username: `cfg_eval_${RUN}` },
    });
    const team = await prisma.team.create({
      data: { userId: user.id, name: `CfgEval ${RUN}` },
    });
    const actorRow = await prisma.employee.create({
      data: {
        userId: user.id,
        teamId: team.id,
        name: "טל",
        surname: "בדיקה",
        kind: "human",
        phone,
        isOwner: true,
      },
    });
    const lucyRow = await prisma.employee.create({
      data: {
        userId: user.id,
        teamId: team.id,
        name: "לוסי",
        surname: "",
        kind: "digital",
        isProtected: true,
      },
    });
    const actor = {
      id: actorRow.id,
      name: actorRow.name,
      surname: actorRow.surname,
      nickname: null,
      email: null,
      phone: actorRow.phone,
      kind: "human" as const,
    };
    const lucy = {
      id: lucyRow.id,
      name: lucyRow.name,
      surname: lucyRow.surname,
      nickname: null,
      email: null,
      phone: null,
      kind: "digital" as const,
      protected: true,
    };

    try {
      const followUpAction = {
        action: "add" as const,
        item: followUp.item,
        listType: "tasks" as const,
        date: "",
        time: "",
        repeat: "once" as const,
        ping: [] as string[],
        about: [] as string[],
        targets: [] as string[],
        text: followUp.text,
        inSeconds: null,
        everyCount: null,
        everyUnit: null,
        weekdays: null,
        confirmed: false,
        compose: false,
        composeSource: "" as const,
        composeLookbackHours: 0,
        composePlace: followUp.composePlace!,
        scheduleAnchor: "external_event" as const,
        scheduleOffsetMinutes: -60,
        watchOnce: true,
        reminderId: "",
      };
      const applied = await applyReminders({
        userId: user.id,
        actor,
        employees: [actor, lucy],
        reminders: [followUpAction],
        contacts: [],
      });
      const row = await prisma.reminder.findFirst({
        where: { userId: user.id, scheduleAnchor: "external_event" },
      });
      check(
        "Step3 follow-up reminder persisted (Action+apply)",
        !!row &&
          row.scheduleAnchor === "external_event" &&
          row.scheduleOffsetMinutes === -60 &&
          applied.saved.length >= 1,
        row?.fireAt?.toISOString() ?? JSON.stringify(applied.skipped),
      );
      if (row && expectedFire) {
        check(
          "Step3 persisted fireAt ≈ kickoff−1h",
          Math.abs(row.fireAt.getTime() - expectedFire.getTime()) < 2000,
          row.fireAt.toISOString(),
        );
      }

      const watchFields = buildSportsMatchWatchReminder({
        team: "Real Madrid",
        minutesBefore: 60,
        watchOnce: false,
      });
      const watchCond = parseComposeCondition(watchFields.composeCondition);
      check(
        "Step3 sports_match condition parsed",
        watchCond?.type === "sports_match" &&
          watchCond.team === "Real Madrid" &&
          watchCond.minutesBefore === 60,
        JSON.stringify(watchCond),
      );

      const scheduleImpl = async (): Promise<SportsScheduleFacts> => ({
        team: "Real Madrid",
        source: "test",
        matches: [
          {
            matchId: `rm-barca-${RUN}`,
            team: "Real Madrid",
            opponent: "Barcelona",
            competition: "La Liga",
            kickoffIso: new Date(Date.now() + 45 * 60_000).toISOString(),
          },
        ],
      });

      const sched1 = await fetchSportsSchedule({
        team: "Real Madrid",
        userId: user.id,
        fetchScheduleImpl: scheduleImpl,
      });
      let sportsFetches = 1; // counted via closure — re-wrap
      let implCalls = 0;
      const countingImpl = async () => {
        implCalls += 1;
        return scheduleImpl();
      };
      await fetchSportsSchedule({
        team: "Real Madrid",
        userId: user.id,
        fetchScheduleImpl: countingImpl,
        forceRefresh: true,
      });
      await fetchSportsSchedule({
        team: "Real Madrid",
        userId: user.id,
        fetchScheduleImpl: countingImpl,
      });
      check(
        "Step3 sports schedule HIT skips provider",
        implCalls === 1,
        `implCalls=${implCalls}`,
      );
      void sched1;
      void sportsFetches;

      const match = (
        await fetchSportsSchedule({
          team: "Real Madrid",
          userId: user.id,
          fetchScheduleImpl: countingImpl,
        })
      ).matches[0]!;
      const fp = sportsMatchFingerprint(match).slice(0, 64);
      const mins = 45;
      const gate1 = evaluateComposeCondition({
        condition: {
          type: "sports_match",
          team: "Real Madrid",
          minutesBefore: 60,
          competition: "",
        },
        facts: {
          sportsMatchEtaMinutes: mins,
          sportsMatchFingerprint: fp,
        },
        lastReportSha: "",
      });
      check(
        "Step3 sports watch fires when within window",
        gate1.skipSend === false && gate1.shaAfterSend === fp,
        JSON.stringify(gate1),
      );
      const gate2 = evaluateComposeCondition({
        condition: {
          type: "sports_match",
          team: "Real Madrid",
          minutesBefore: 60,
          competition: "",
        },
        facts: {
          sportsMatchEtaMinutes: mins,
          sportsMatchFingerprint: fp,
        },
        lastReportSha: fp,
      });
      check(
        "Step3 sports watch dedupes same matchId",
        gate2.skipSend === true,
        JSON.stringify(gate2),
      );

      const watchAction = {
        action: "add" as const,
        item: watchFields.item,
        listType: "tasks" as const,
        date: "",
        time: "",
        repeat: "interval" as const,
        ping: [] as string[],
        about: [] as string[],
        targets: [] as string[],
        text: watchFields.text ?? "",
        inSeconds: null,
        everyCount: 5,
        everyUnit: "minutes" as const,
        weekdays: null,
        confirmed: false,
        compose: true,
        composeSource: "sports" as const,
        composeLookbackHours: 0,
        composePlace: "Real Madrid",
        composeCondition: watchFields.composeCondition,
        watchOnce: false,
        recurrence: watchFields.recurrence ?? {
          freq: "interval" as const,
          interval: 5,
          unit: "minutes" as const,
        },
        reminderId: "",
      };
      const watchApplied = await applyReminders({
        userId: user.id,
        actor,
        employees: [actor, lucy],
        reminders: [watchAction],
        contacts: [],
      });
      const watchRow = await prisma.reminder.findFirst({
        where: {
          userId: user.id,
          composeSource: "sports",
        },
      });
      check(
        "Step3 sports watch rule persisted",
        !!watchRow &&
          watchRow.watchOnce === false &&
          (watchRow.composeCondition as { type?: string } | null)?.type ===
            "sports_match",
        JSON.stringify({
          id: watchRow?.id,
          skipped: watchApplied.skipped,
          cond: watchRow?.composeCondition,
        }),
      );
    } finally {
      await prisma.reminder.deleteMany({ where: { userId: user.id } });
      await prisma.employeeListItem
        .deleteMany({
          where: { list: { employeeId: { in: [actor.id, lucy.id] } } },
        })
        .catch(() => undefined);
      await prisma.employeeList
        .deleteMany({ where: { employeeId: { in: [actor.id, lucy.id] } } })
        .catch(() => undefined);
      await prisma.employee.deleteMany({ where: { userId: user.id } });
      await prisma.team.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    }

    // ── STEP 4 — Jewish still local
    const beforeJewish = await prisma.externalDataCache.count({
      where: { provider: { not: "quota" } },
    });
    const jewish = resolveLocalJewishInline({
      query: "מתי נכנסת שבת בפתח תקווה?",
      now: new Date("2026-11-20T10:00:00+02:00"),
    });
    const afterJewish = await prisma.externalDataCache.count({
      where: { provider: { not: "quota" } },
    });
    check(
      "Step4 jewish local 0 cache writes",
      !!jewish &&
        jewish.externalCalls === 0 &&
        jewish.cacheWrites === 0 &&
        afterJewish === beforeJewish,
      `before=${beforeJewish} after=${afterJewish}`,
    );

    const flightsCap = CAPABILITY_REGISTRY.find((c) => c.id === "flights");
    const sportsCfg = getExternalLookupProviderConfig("sports");
    check(
      "Step4 flights externalLookup; sports example has no liveRefresh",
      !!flightsCap?.externalLookup && sportsCfg.liveRefresh === false,
      `flights=${flightsCap?.externalLookup} sportsLive=${sportsCfg.liveRefresh}`,
    );
  });
});
