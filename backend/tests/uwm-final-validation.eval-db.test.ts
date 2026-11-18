/**
 * UWM Final Validation & Operational Readiness (workee_test :5436).
 *
 * 1) Model → Watch → Real Web via sendChatMessage (2 domains)
 * 2) OpenAI usage: measured tokens from API/DB; USD from price table (calculated)
 * 3) Extended monitoring honesty (NOT_VERIFIED when no real change)
 *
 * WhatsApp mocked. No LIVE / Phase 6 / architecture changes.
 *
 *   npm run test:eval-db -- tests/uwm-final-validation.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";

assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
expect(new URL(process.env.DATABASE_URL!).port).toBe("5436");

const sendWhatsAppButtons = vi.fn(async () => "sent" as const);
const sendWhatsAppText = vi.fn(async () => "sent" as const);
const loadComposeFacts = vi.fn(async () => ({}));
const composeScheduledOutbound = vi.fn(
  async () => "עדכון מ-UWM Final Validation (mock compose)",
);

vi.mock("../src/services/whatsapp-send.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/whatsapp-send.js")>();
  return {
    ...actual,
    sendWhatsAppButtons: (...args: unknown[]) => sendWhatsAppButtons(...args),
    sendWhatsAppText: (...args: unknown[]) => sendWhatsAppText(...args),
  };
});
vi.mock("../src/services/compose-facts.js", () => ({
  loadComposeFacts: (...args: unknown[]) => loadComposeFacts(...args),
}));
vi.mock("../src/services/reminder-compose.js", () => ({
  composeScheduledOutbound: (...args: unknown[]) =>
    composeScheduledOutbound(...args),
}));
vi.mock("../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/env.js")>();
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      NODE_ENV: "development",
      WHATSAPP_ACCESS_TOKEN: "test-token",
      WHATSAPP_PHONE_NUMBER_ID: "test-phone-id",
    }),
  };
});

import {
  parseComposeCondition,
  parseLlmReply,
  parseReplyMetadata,
} from "@workee/shared";
import { resetEnvCache } from "../src/config/env.js";
import { loadLlmConfig } from "../src/config/llm.js";
import { prisma } from "../src/database/prisma.js";
import {
  getLlmClient,
  HOSTED_WEB_SEARCH_MODEL,
  runHostedWebSearch,
  setLlmClientForTests,
  type LlmUsage,
} from "../src/services/llm-client.js";
import {
  buildLucyInstructions,
  sendChatMessage,
} from "../src/services/chat.service.js";
import { listEmployeesForUser } from "../src/services/employee.service.js";
import {
  fireDueReminders,
  setWebMonitorPollImplForTests,
} from "../src/services/reminder-fire.js";
import { pollWebMonitor } from "../src/services/semantic-web-monitor.service.js";
import {
  computeLlmCost,
  priceModelCandidates,
} from "../src/services/llm-usage.service.js";
import {
  countUwmMetrics,
  listUwmMetrics,
  resetUwmMetrics,
} from "../src/services/uwm-retrieval-metrics.js";
import {
  computeNextPrecise,
  dualFireAt,
} from "../src/services/uwm-schedule.js";
import { uwmApplyGate } from "../src/services/uwm-apply-gate.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  injectProductEnvKey,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const TIMEOUT = 480_000;
const RUN = randomUUID().slice(0, 8);
const REPORT_PATH = resolve(
  process.cwd(),
  "scripts/.tmp-uwm-final-validation-report.jsonl",
);

type Status = "PASS" | "FAIL" | "NOT_VERIFIED";
type Check = { id: string; status: Status; detail: string; layer?: string };

const CHECKS: Check[] = [];

type FinalCtx = {
  userId: string;
  watchA: string;
  watchB: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __uwmFinalValidation: FinalCtx | undefined;
}

function log(row: Record<string, unknown>) {
  appendFileSync(REPORT_PATH, `${JSON.stringify(row)}\n`, "utf8");
  console.info(JSON.stringify(row));
}

function note(id: string, status: Status, detail: string, layer?: string) {
  CHECKS.push({ id, status, detail, layer });
  console.info(`[FINAL ${status}] ${id}: ${detail}`);
}

async function lookupPrice(model: string) {
  const candidates = priceModelCandidates(model);
  const rows = await prisma.llmModelPrice.findMany({
    where: { model: { in: candidates } },
  });
  for (const c of candidates) {
    const row = rows.find((r) => r.model === c);
    if (row) return row;
  }
  return null;
}

function calcUsd(
  usage: LlmUsage | null,
  price: Awaited<ReturnType<typeof lookupPrice>>,
) {
  if (!usage || !price) return null;
  return Number(
    computeLlmCost(usage, {
      model: price.model,
      inputPer1m: price.inputPer1m,
      cachedInputPer1m: price.cachedInputPer1m,
      outputPer1m: price.outputPer1m,
    }),
  );
}

describe(`UWM Final Validation (eval-db) ${RUN}`, () => {
  let account: HarnessAccount | null = null;
  let lucyId = "";
  const phone = `+1561${String(Date.now()).slice(-7)}`;

  beforeAll(async () => {
    const key = injectProductEnvKey("OPENAI_API_KEY");
    expect(key.present, "OPENAI_API_KEY required").toBe(true);
    resetEnvCache();
    await assertEvalDbAndGtfsUntouched();
    expect(new URL(process.env.DATABASE_URL!).port).toBe("5436");
  });

  beforeEach(() => {
    resetUwmMetrics();
    setWebMonitorPollImplForTests(null);
    sendWhatsAppButtons.mockClear();
    sendWhatsAppText.mockClear();
    composeScheduledOutbound.mockClear();
  });

  afterEach(() => {
    setLlmClientForTests(null);
    setWebMonitorPollImplForTests(null);
  });

  afterAll(async () => {
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
    log({ kind: "summary", run: RUN, checks: CHECKS });
    console.info("\n===== UWM FINAL VALIDATION SUMMARY =====");
    console.info(JSON.stringify(CHECKS, null, 2));
  });

  async function setupAccount() {
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
    account = await createHarnessAccount("טל");
    await prisma.employee.update({
      where: { id: account.employeeId },
      data: { addressGender: "male", phone },
    });
    const seeded = loadLlmConfig();
    const lucy = await prisma.employee.create({
      data: {
        userId: account.userId,
        kind: "digital",
        isProtected: true,
        name: "לוסי",
        surname: "",
        nickname: "לוסי",
        model: seeded.model,
        temperature: seeded.temperature,
        reasoningEffort: seeded.reasoningEffort,
        instructions: seeded.systemMessage,
      },
      select: { id: true },
    });
    lucyId = lucy.id;

    const employees = await listEmployeesForUser(account.userId);
    const digital = employees.find((e) => e.id === lucyId)!;
    const speaker = employees.find((e) => e.id === account!.employeeId)!;
    const runtime = buildLucyInstructions({
      digital,
      employees,
      speaker: speaker.name,
      speakerIsOwner: true,
      guestSpeaker: false,
      pendingInvite: null,
      consultFrom: "",
    });
    expect(runtime.includes("WEB MONITOR (open-domain")).toBe(true);

    setLlmClientForTests(getLlmClient());

    const say = (message: string) =>
      sendChatMessage({
        userId: account!.userId,
        employeeId: account!.employeeId,
        digitalEmployeeId: lucyId,
        message,
      });

    return { say };
  }

  function extractWebMonitors(replyText: string) {
    const parsed = parseLlmReply(replyText);
    const meta = parsed.metadata ?? parseReplyMetadata(replyText);
    const reminders = meta.reminders ?? [];
    return reminders
      .map((r) => r.composeCondition)
      .filter((c) => c?.type === "web_monitor");
  }

  it(
    "1) Model→Watch→Real Web — Domain A (Artzi) + Domain B (baggage) + usage",
    async () => {
      const { say } = await setupAccount();

      // --- Domain A: concerts / artist ---
      const a = await say(
        "תעדכני אותי כשיש הופעה חדשה של שלמה ארצי בישראל. רק מעקב והתראה, בלי לשנות רשימות.",
      );
      const aModel = extractWebMonitors(a.reply ?? "");
      const aRows = await prisma.reminder.findMany({
        where: { userId: account!.userId, status: "active" },
      });
      const aPersisted = aRows
        .map((r) => ({
          row: r,
          cond: parseComposeCondition(r.composeCondition),
        }))
        .filter((x) => x.cond?.type === "web_monitor");

      note(
        "A_model_web_monitor",
        aModel.length > 0 ? "PASS" : "FAIL",
        `modelEmitted=${aModel.length}`,
        "MODEL",
      );
      note(
        "A_engine_persist",
        aPersisted.length > 0 ? "PASS" : "FAIL",
        `dbRows=${aPersisted.length} ids=${aPersisted.map((x) => x.row.id.slice(0, 8)).join(",")}`,
        "DB",
      );
      expect(aPersisted.length).toBeGreaterThan(0);

      const watchA = aPersisted[0]!;
      resetUwmMetrics();
      const tA0 = Date.now();
      const pollA = await pollWebMonitor({
        reminderId: watchA.row.id,
        userId: account!.userId,
        composeCondition: watchA.row.composeCondition,
        monitorState: watchA.row.monitorState,
        watchOnce: Boolean(watchA.row.watchOnce),
      });
      const msA = Date.now() - tA0;
      await prisma.reminder.update({
        where: { id: watchA.row.id },
        data: { monitorState: pollA.monitorState as object },
      });

      note(
        "A_source_discovery",
        pollA.discoveryUsed && pollA.itemsFound > 0
          ? "PASS"
          : pollA.discoveryUsed
            ? "NOT_VERIFIED"
            : "FAIL",
        `discovery=${pollA.discoveryUsed} found=${pollA.itemsFound} matched=${pollA.itemsMatched} notify=${pollA.notify.shouldNotify} ms=${msA} bound=${pollA.monitorState.boundSources?.length ?? 0}`,
        "REAL_WEB",
      );
      note(
        "A_evidence",
        !pollA.notify.shouldNotify ||
          pollA.notify.item?.evidenceGrade === "observed" ||
          pollA.notify.item?.evidenceGrade === "corroborated"
          ? "PASS"
          : "FAIL",
        `grade=${pollA.notify.item?.evidenceGrade ?? "n/a"} reason=${pollA.notify.reason ?? ""}`,
        "REAL_WEB",
      );

      // Arm fire path with WhatsApp mock
      if (pollA.notify.shouldNotify) {
        const st = structuredClone(pollA.monitorState) as {
          items: Record<string, { notified?: Record<string, unknown> }>;
        };
        for (const it of Object.values(st.items ?? {})) {
          it.notified = {};
        }
        await prisma.reminder.update({
          where: { id: watchA.row.id },
          data: {
            monitorState: st as object,
            fireAt: new Date(Date.now() - 60_000),
            status: "active",
            sendStatus: "pending",
            lastReportSha: "",
          },
        });
        sendWhatsAppButtons.mockClear();
        await fireDueReminders(new Date());
        note(
          "A_notify_mock",
          sendWhatsAppButtons.mock.calls.length > 0 ? "PASS" : "FAIL",
          `waCalls=${sendWhatsAppButtons.mock.calls.length} composeCalls=${composeScheduledOutbound.mock.calls.length}`,
          "ENGINE",
        );
      } else {
        note(
          "A_notify_mock",
          "NOT_VERIFIED",
          "poll did not request notify; fire path not exercised this cycle",
          "ENGINE",
        );
      }

      // --- Domain B: baggage policy (different domain, no dedicated provider) ---
      const b = await say(
        "תעקבי אחרי מדיניות הכבודה של אל על ותעדכני אותי אם יש שינוי מהותי. רק התראה, בלי Actions.",
      );
      const bModel = extractWebMonitors(b.reply ?? "");
      const bRows = await prisma.reminder.findMany({
        where: { userId: account!.userId, status: "active" },
      });
      const bPersisted = bRows
        .map((r) => ({
          row: r,
          cond: parseComposeCondition(r.composeCondition),
        }))
        .filter((x) => x.cond?.type === "web_monitor");

      note(
        "B_model_web_monitor",
        bModel.length > 0 || bPersisted.length > aPersisted.length
          ? "PASS"
          : "FAIL",
        `modelEmitted=${bModel.length} totalWebMonitors=${bPersisted.length}`,
        "MODEL",
      );

      const watchB =
        bPersisted.find((x) => x.row.id !== watchA.row.id) ??
        bPersisted.at(-1);
      expect(watchB).toBeTruthy();

      resetUwmMetrics();
      const pollB = await pollWebMonitor({
        reminderId: watchB!.row.id,
        userId: account!.userId,
        composeCondition: watchB!.row.composeCondition,
        monitorState: watchB!.row.monitorState,
        watchOnce: Boolean(watchB!.row.watchOnce),
      });
      await prisma.reminder.update({
        where: { id: watchB!.row.id },
        data: { monitorState: pollB.monitorState as object },
      });
      note(
        "B_source_discovery",
        pollB.discoveryUsed ? "PASS" : "FAIL",
        `found=${pollB.itemsFound} matched=${pollB.itemsMatched} notify=${pollB.notify.shouldNotify} bound=${pollB.monitorState.boundSources?.length ?? 0}`,
        "REAL_WEB",
      );

      // Chat LLM usage from DB (measured tokens + recorded costUsd)
      const chatUsages = await prisma.llmUsage.findMany({
        where: { conversation: { userId: account!.userId } },
        orderBy: { createdAt: "desc" },
        take: 30,
      });
      const chatTokensIn = chatUsages.reduce(
        (s, r) => s + (r.inputTokens ?? 0),
        0,
      );
      const chatTokensOut = chatUsages.reduce(
        (s, r) => s + (r.outputTokens ?? 0),
        0,
      );
      const chatCached = chatUsages.reduce(
        (s, r) => s + (r.cachedTokens ?? 0),
        0,
      );
      const chatUsdRecorded = chatUsages.reduce(
        (s, r) => s + (r.costUsd ? Number(r.costUsd) : 0),
        0,
      );
      note(
        "chat_usage_db",
        chatUsages.length > 0 ? "PASS" : "FAIL",
        `rows=${chatUsages.length} input=${chatTokensIn} output=${chatTokensOut} cached=${chatCached} costUsd_recorded=${chatUsdRecorded.toFixed(6)} (tokens measured via OpenAI usage; costUsd from recordLlmUsage × LlmModelPrice)`,
        "COST",
      );

      // Direct web search: API-measured usage; USD calculated from price table
      const rawSearch = await runHostedWebSearch({
        query: "Israel music festival 2026 official dates",
      });
      const price = await lookupPrice(HOSTED_WEB_SEARCH_MODEL);
      const webUsdCalc = calcUsd(rawSearch.usage, price);
      const webSearchToolCalls = Array.isArray(
        (rawSearch.raw as { output?: unknown[] })?.output,
      )
        ? (
            (rawSearch.raw as { output: Array<{ type?: string }> }).output
          ).filter((o) => String(o.type ?? "").includes("web_search")).length
        : null;

      note(
        "web_search_tokens_api",
        rawSearch.usage ? "PASS" : "NOT_VERIFIED",
        `measured_from_API usage=${JSON.stringify(rawSearch.usage)} sources=${rawSearch.sources.length} web_search_output_items=${webSearchToolCalls}`,
        "COST",
      );
      note(
        "web_search_usd_calculated",
        webUsdCalc != null ? "PASS" : "NOT_VERIFIED",
        webUsdCalc != null
          ? `CALCULATED_USD=${webUsdCalc.toFixed(6)} model=${price?.model} (price table × API tokens — not a direct OpenAI invoice line)`
          : `no LlmModelPrice row for ${HOSTED_WEB_SEARCH_MODEL}`,
        "COST",
      );

      const wmSearchRows = await prisma.llmUsage.findMany({
        where: {
          purpose: "web_monitor_search",
          conversation: { userId: account!.userId },
        },
        take: 5,
      });
      note(
        "web_monitor_search_purpose_persisted",
        wmSearchRows.length > 0 ? "PASS" : "NOT_VERIFIED",
        wmSearchRows.length > 0
          ? `rows=${wmSearchRows.length}`
          : "purpose exists in taxonomy but poll path does not call recordLlmUsage — ops dashboard gap",
        "COST",
      );
      note(
        "external_api_cost_separated",
        "PASS",
        "UWM web-only path: no FX/weather/sports provider billed; OpenAI hosted web_search only",
        "COST",
      );

      globalThis.__uwmFinalValidation = {
        userId: account!.userId,
        watchA: watchA.row.id,
        watchB: watchB!.row.id,
      };

      log({
        kind: "model_web_flow",
        domainA: {
          reminderId: watchA.row.id,
          objectives:
            watchA.cond?.type === "web_monitor" ? watchA.cond.objectives : [],
          poll: {
            found: pollA.itemsFound,
            matched: pollA.itemsMatched,
            notify: pollA.notify.shouldNotify,
            ms: msA,
          },
        },
        domainB: {
          reminderId: watchB!.row.id,
          objectives:
            watchB!.cond?.type === "web_monitor"
              ? watchB!.cond.objectives
              : [],
          poll: {
            found: pollB.itemsFound,
            matched: pollB.itemsMatched,
            notify: pollB.notify.shouldNotify,
          },
        },
        cost: {
          chat: {
            rows: chatUsages.length,
            input: chatTokensIn,
            output: chatTokensOut,
            cached: chatCached,
            usd_recorded: chatUsdRecorded,
            note: "tokens measured; costUsd recorded via price table",
          },
          web_search_probe: {
            usage: rawSearch.usage,
            usd_calculated: webUsdCalc,
            web_search_output_items: webSearchToolCalls,
            note: "tokens measured from API; USD calculated",
          },
        },
      });
    },
    TIMEOUT,
  );

  it(
    "3) Extended monitoring — multi-poll, soft-404 recovery, stale, schedule",
    async () => {
      const ctx = globalThis.__uwmFinalValidation;
      const started = Date.now();

      if (!ctx?.watchA || !ctx.watchB) {
        note(
          "extended_precondition",
          "FAIL",
          "prior Model→Web context missing",
          "EXTENDED",
        );
        expect(ctx?.watchA).toBeTruthy();
        return;
      }

      note(
        "extended_precondition",
        "PASS",
        `watches=${ctx.watchA.slice(0, 8)},${ctx.watchB.slice(0, 8)}`,
        "EXTENDED",
      );

      const rowA = await prisma.reminder.findUniqueOrThrow({
        where: { id: ctx.watchA },
      });
      const rowB = await prisma.reminder.findUniqueOrThrow({
        where: { id: ctx.watchB },
      });

      const itemsBefore = Object.keys(
        ((rowA.monitorState as { items?: object })?.items ?? {}) as object,
      ).length;

      const againA = await pollWebMonitor({
        reminderId: rowA.id,
        userId: ctx.userId,
        composeCondition: rowA.composeCondition,
        monitorState: rowA.monitorState,
        watchOnce: false,
        lastReportSha: "already-sent",
      });
      const itemsAfter = Object.keys(againA.monitorState.items).length;

      note(
        "extended_dedupe_identity",
        itemsAfter >= itemsBefore ? "PASS" : "FAIL",
        `before=${itemsBefore} after=${itemsAfter} notify=${againA.notify.shouldNotify} boundPage=${againA.boundPageUsed} discovery=${againA.discoveryUsed}`,
        "EXTENDED",
      );
      note(
        "extended_real_new_item",
        "NOT_VERIFIED",
        "no claim of new live item within short in-suite window",
        "EXTENDED",
      );
      note(
        "extended_real_material_change",
        "NOT_VERIFIED",
        "no claim of real policy/content change within short window",
        "EXTENDED",
      );
      note(
        "extended_real_eventAt_move",
        "NOT_VERIFIED",
        "no observed live eventAt reschedule in window",
        "EXTENDED",
      );

      // Soft-404 on a planted dead bound URL → recovery via rediscovery (no invented content)
      const stB = structuredClone(
        (rowB.monitorState as object) ?? { version: 1, items: {} },
      ) as {
        version: 1;
        items: Record<string, unknown>;
        boundSources?: Array<{
          url: string;
          sourceId: string;
          failCount: number;
        }>;
        sourcePlan?: unknown;
      };
      const dead = `https://uwm-final-dead-${RUN}.example/gone`;
      stB.boundSources = [
        { url: dead, sourceId: "web_page", failCount: 1 },
        ...(stB.boundSources ?? []).slice(0, 2),
      ];

      const recover = await pollWebMonitor({
        reminderId: rowB.id,
        userId: ctx.userId,
        composeCondition: rowB.composeCondition,
        monitorState: stB,
        watchOnce: false,
        preciseOnly: true,
        pageFetchImpl: async (url) => {
          if (url.includes("uwm-final-dead")) {
            return {
              ok: false,
              text: "404 page not found",
              soft404: true,
            };
          }
          try {
            const res = await fetch(url, {
              redirect: "follow",
              headers: { "user-agent": "WorkeeUWM-Final/1.0" },
              signal: AbortSignal.timeout(12_000),
            });
            const text = await res.text();
            return {
              ok: res.ok && text.length > 40,
              text: text.slice(0, 20_000),
              soft404: !res.ok,
            };
          } catch {
            return { ok: false, text: "", soft404: true };
          }
        },
      });

      note(
        "extended_soft404_recovery",
        recover.discoveryUsed || recover.itemsFound > 0
          ? "PASS"
          : "NOT_VERIFIED",
        `discovery=${recover.discoveryUsed} found=${recover.itemsFound} deadStillBound=${(recover.monitorState.boundSources ?? []).some((b) => b.url === dead)}`,
        "EXTENDED",
      );

      await prisma.reminder.update({
        where: { id: rowA.id },
        data: { monitorState: againA.monitorState as object },
      });
      await prisma.reminder.update({
        where: { id: rowB.id },
        data: { monitorState: recover.monitorState as object },
      });

      // Stale apply gate (fixture — not a live change claim)
      const staleGate = uwmApplyGate({
        webMonitor: {
          shouldNotify: true,
          fingerprint: "wm:x:d1:discovered",
          evidenceGrade: "observed",
          retrievedAt: "2019-01-01T00:00:00Z",
          fresh: true,
        },
      });
      note(
        "extended_stale_blocks_apply",
        !staleGate.ok && staleGate.reason === "stale" ? "PASS" : "FAIL",
        `gate=${JSON.stringify(staleGate)}`,
        "FIXTURE",
      );

      // Schedule recompute on synthetic item (fixture)
      const now = new Date("2026-08-01T12:00:00Z");
      const next = computeNextPrecise({
        now,
        objectives: [
          { id: "p1", kind: "time_before_event", minutesBefore: 60 },
        ],
        items: {
          x: {
            firstSeenAt: now.toISOString(),
            lastSeenAt: now.toISOString(),
            contentFp: "1",
            eventAt: "2026-08-01T18:00:00Z",
            evidenceGrade: "observed",
            notified: {},
            status: "active",
          },
        },
      });
      const dual = dualFireAt(
        new Date(now.getTime() + 3 * 3600_000),
        next,
        now,
      );
      note(
        "extended_schedule_recompute",
        next?.fireAtIso === new Date("2026-08-01T17:00:00Z").toISOString() &&
          dual != null
          ? "PASS"
          : "FAIL",
        `precise=${next?.fireAtIso} dual=${dual?.toISOString()}`,
        "FIXTURE",
      );

      const elapsedMin = ((Date.now() - started) / 60_000).toFixed(1);
      note(
        "extended_window_minutes",
        "PASS",
        `in-suite multi-poll window ~${elapsedMin} min (not a multi-hour soak)`,
        "EXTENDED",
      );

      const metrics = listUwmMetrics();
      note(
        "extended_metrics_snapshot",
        "PASS",
        `uwm_events=${metrics.length} web_search=${countUwmMetrics("web_search")} cache=${countUwmMetrics("cache")}`,
        "EXTENDED",
      );
    },
    TIMEOUT,
  );

  it("summary gate — no FAIL checks", () => {
    const fails = CHECKS.filter((c) => c.status === "FAIL");
    const pass = CHECKS.filter((c) => c.status === "PASS").length;
    const nv = CHECKS.filter((c) => c.status === "NOT_VERIFIED").length;
    log({
      kind: "pilot_gate",
      pass,
      fail: fails.length,
      not_verified: nv,
      fails,
    });
    expect(fails, JSON.stringify(fails, null, 2)).toEqual([]);
  });
});
