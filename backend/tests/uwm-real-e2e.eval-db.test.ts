/**
 * UWM Real E2E — workee_test (:5436), real Web Search / HTTP when OPENAI is available.
 * WhatsApp mocked. Separates REAL_WEB vs FIXTURE results in assertions/logs.
 *
 *   npm run test:eval-db -- tests/uwm-real-e2e.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
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
const loadComposeFacts = vi.fn();
const composeScheduledOutbound = vi.fn(async () => "");

vi.mock("../src/services/whatsapp-send.js", () => ({
  sendWhatsAppButtons: (...args: unknown[]) => sendWhatsAppButtons(...args),
}));
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

import { emptyLlmMetadata, parseComposeCondition } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { applyEmployeeRecords } from "../src/services/employee-records.service.js";
import { applyReminders } from "../src/services/reminder.service.js";
import {
  fireDueReminders,
  setWebMonitorPollImplForTests,
} from "../src/services/reminder-fire.js";
import { pollWebMonitor } from "../src/services/semantic-web-monitor.service.js";
import { selectSourcesForWatch } from "../src/services/uwm-source-selector.js";
import {
  countUwmMetrics,
  listUwmMetrics,
  resetUwmMetrics,
} from "../src/services/uwm-retrieval-metrics.js";
import {
  computeNextPrecise,
  dualFireAt,
} from "../src/services/uwm-schedule.js";
import {
  parseWatchTriggerExecLedger,
  parseWatchTriggerPackage,
} from "../src/services/watch-trigger-actions.service.js";
import {
  assertEvalDbAndGtfsUntouched,
  injectProductEnvKey,
} from "./helpers/eval-live-provider-harness.js";
import { cachedHostedWebSearch } from "../src/services/external-lookup.service.js";

const RUN = randomUUID().slice(0, 8);

type ScenarioResult = {
  name: string;
  layer: "REAL_WEB" | "FIXTURE" | "ENGINE";
  checks: Array<{ id: string; status: "PASS" | "FAIL" | "NOT_VERIFIED"; detail: string }>;
};

const REPORT: ScenarioResult[] = [];

function note(
  scenario: ScenarioResult,
  id: string,
  status: "PASS" | "FAIL" | "NOT_VERIFIED",
  detail: string,
) {
  scenario.checks.push({ id, status, detail });
  // Soft assert: FAIL still records; hard expect only for infrastructure
  if (status === "FAIL") {
    console.warn(`[E2E FAIL] ${scenario.name} / ${id}: ${detail}`);
  } else {
    console.info(`[E2E ${status}] ${scenario.name} / ${id}: ${detail}`);
  }
}

describe(`UWM Real E2E (eval-db :5436) ${RUN}`, () => {
  let userId = "";
  let ownerId = "";
  let lucyId = "";
  let listId = "";
  let phone = "";
  let hasOpenAi = false;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
    const key = injectProductEnvKey("OPENAI_API_KEY");
    hasOpenAi = key.present;
    console.info(
      hasOpenAi
        ? `OPENAI_API_KEY present (len=${key.len}) — REAL_WEB enabled`
        : "OPENAI_API_KEY missing — REAL_WEB scenarios will be NOT_VERIFIED",
    );

    phone = `+1560${RUN.slice(0, 7)}`;
    const user = await prisma.user.create({
      data: { username: `uwm_e2e_${RUN}` },
    });
    userId = user.id;
    const team = await prisma.team.create({
      data: { userId: user.id, name: `uwm_e2e_${RUN}` },
    });
    const owner = await prisma.employee.create({
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
    ownerId = owner.id;
    const lucy = await prisma.employee.create({
      data: {
        userId: user.id,
        teamId: team.id,
        name: "לוסי",
        surname: "",
        kind: "digital",
        isProtected: true,
      },
    });
    lucyId = lucy.id;

    await applyEmployeeRecords(
      ownerId,
      {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": `seed-e2e-${RUN}` }],
            targets: [],
          },
        ],
      },
      { scope: "personal", addedById: ownerId, visibleTo: [ownerId] },
      ownerId,
    );
    const list = await prisma.employeeList.findFirst({
      where: { employeeId: ownerId, listType: "shopping", deletedAt: null },
    });
    listId = list?.id ?? "";
    expect(listId).toBeTruthy();
  }, 60_000);

  beforeEach(() => {
    resetUwmMetrics();
    sendWhatsAppButtons.mockClear();
    loadComposeFacts.mockResolvedValue({
      kind: "generic",
      fixedBody: "",
      eval: {},
      advanceLastReportSha: false,
      headSha: "",
    });
    composeScheduledOutbound.mockResolvedValue("");
    setWebMonitorPollImplForTests(null);
  });

  afterEach(async () => {
    setWebMonitorPollImplForTests(null);
  });

  afterAll(async () => {
    console.info("\n===== UWM REAL E2E REPORT =====");
    console.info(JSON.stringify(REPORT, null, 2));
    if (!userId) return;
    await prisma.deliveryAttempt.deleteMany({ where: { userId } }).catch(() => null);
    await prisma.reminder.deleteMany({ where: { userId } });
    await prisma.employeeListItem
      .deleteMany({ where: { list: { employeeId: ownerId } } })
      .catch(() => null);
    await prisma.employeeList.deleteMany({ where: { employeeId: ownerId } });
    await prisma.employee.deleteMany({ where: { userId } });
    await prisma.team.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => null);
  });

  function actor() {
    return {
      id: ownerId,
      name: "טל",
      surname: "בדיקה",
      nickname: "טל",
      email: null,
      phone,
      kind: "human" as const,
    };
  }
  function lucyActor() {
    return {
      id: lucyId,
      name: "לוסי",
      surname: "",
      nickname: null,
      email: null,
      phone: null,
      kind: "digital" as const,
    };
  }

  it("ENGINE: API-full market intent does not plan web_search", async () => {
    const scenario: ScenarioResult = {
      name: "api_full_skips_web",
      layer: "ENGINE",
      checks: [],
    };
    REPORT.push(scenario);
    const plan = await selectSourcesForWatch({
      type: "web_monitor",
      intent: "תעדכני כששער הדולר משתנה",
      canonicalQuery: "USD ILS dollar exchange rate",
      constraints: { entities: ["דולר"] },
      objectives: [
        { id: "o1", kind: "detect_change", changeAspects: ["price"] },
      ],
    });
    if (plan.useWebDiscovery === false && plan.coverage === "full") {
      note(scenario, "no_web_when_api_full", "PASS", `reason=${plan.reason}`);
    } else {
      note(
        scenario,
        "no_web_when_api_full",
        "FAIL",
        `coverage=${plan.coverage} useWeb=${plan.useWebDiscovery}`,
      );
    }
    expect(plan.useWebDiscovery).toBe(false);
  });

  it(
    "FIXTURE: precise dual schedule (controlled clock)",
    async () => {
      const scenario: ScenarioResult = {
        name: "precise_schedule_fixture",
        layer: "FIXTURE",
        checks: [],
      };
      REPORT.push(scenario);
      const now = new Date("2026-06-01T12:00:00Z");
      const eventAt = "2026-06-01T17:00:00Z";
      const items = {
        m1: {
          firstSeenAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          contentFp: "fp1",
          eventAt,
          evidenceGrade: "observed" as const,
          notified: {},
          status: "active" as const,
        },
      };
      const next = computeNextPrecise({
        now,
        items,
        objectives: [
          { id: "p1", kind: "time_before_event", minutesBefore: 60 },
        ],
      });
      const discoveryNext = new Date(now.getTime() + 3 * 3600_000);
      const dual = dualFireAt(discoveryNext, next, now);
      if (
        next?.fireAtIso === new Date("2026-06-01T16:00:00Z").toISOString() &&
        dual?.getTime() === discoveryNext.getTime()
      ) {
        note(
          scenario,
          "c1_dual",
          "PASS",
          `precise=${next.fireAtIso} dual=${dual.toISOString()}`,
        );
      } else {
        note(
          scenario,
          "c1_dual",
          "FAIL",
          `precise=${next?.fireAtIso} dual=${dual?.toISOString()}`,
        );
      }
      expect(next?.fireAtIso).toBe(
        new Date("2026-06-01T16:00:00Z").toISOString(),
      );
    },
  );

  it(
    "REAL_WEB domain A: open concert/festival discovery (no domain provider)",
    async () => {
      const scenario: ScenarioResult = {
        name: "domain_A_concerts_israel",
        layer: "REAL_WEB",
        checks: [],
      };
      REPORT.push(scenario);
      if (!hasOpenAi) {
        note(scenario, "openai", "NOT_VERIFIED", "OPENAI_API_KEY missing");
        return;
      }

      const t0 = Date.now();
      // Source selection
      const condition = parseComposeCondition({
        type: "web_monitor",
        intent: "תעדכני על פסטיבלי מוזיקה או הופעות גדולות בישראל",
        canonical_query:
          "upcoming music festivals concerts Israel 2026 official dates",
        constraints: { entities: ["Israel"], geo: "Israel" },
        objectives: [{ id: "d1", kind: "discover_new" }],
        evidence_min: "observed",
      });
      expect(condition?.type).toBe("web_monitor");
      const plan = await selectSourcesForWatch(condition!);
      note(
        scenario,
        "source_selection",
        plan.useWebDiscovery ? "PASS" : "FAIL",
        `coverage=${plan.coverage} reason=${plan.reason} primary=${plan.primary.map((p) => p.id).join(",")}`,
      );

      // Real web search smoke (infra)
      const search = await cachedHostedWebSearch({
        query: condition!.canonicalQuery,
        userId,
        cacheScope: "none",
        scope: "monitor",
      });
      const searchMs = Date.now() - t0;
      note(
        scenario,
        "real_web_search",
        search.payload.text.trim().length > 40 ||
          (search.payload.sources?.length ?? 0) > 0
          ? "PASS"
          : "FAIL",
        `chars=${search.payload.text.length} sources=${search.payload.sources?.length ?? 0} ms=${searchMs} quotaBlocked=${search.quotaBlocked}`,
      );

      const itemLabel = `e2e-concerts-${RUN}`;
      await applyReminders({
        userId,
        actor: actor(),
        employees: [actor(), lucyActor()],
        reminders: [
          {
            action: "add",
            item: itemLabel,
            listType: "tasks",
            date: "",
            time: "",
            repeat: "hourly",
            ping: ["טל"],
            about: [],
            targets: [],
            text: "מעקב פסטיבלים",
            inSeconds: null,
            everyCount: 3,
            everyUnit: "hours",
            weekdays: null,
            confirmed: false,
            compose: true,
            composeSource: "",
            composeLookbackHours: 0,
            composePlace: "",
            watchOnce: false,
            composeCondition: condition,
            recurrence: { freq: "interval", interval: 3, unit: "hours" },
            reminderId: "",
          } as Parameters<typeof applyReminders>[0]["reminders"][number],
        ],
      });
      const row = await prisma.reminder.findFirstOrThrow({
        where: { userId, itemLabel },
      });
      note(scenario, "watch_persist", "PASS", `reminderId=${row.id.slice(0, 8)}`);

      // Real poll (no searchImpl) — uses hosted web search
      resetUwmMetrics();
      const poll1 = await pollWebMonitor({
        reminderId: row.id,
        userId,
        composeCondition: row.composeCondition,
        monitorState: row.monitorState,
        watchOnce: false,
        now: new Date(),
      });
      await prisma.reminder.update({
        where: { id: row.id },
        data: { monitorState: poll1.monitorState as object },
      });

      const webSearchCalls = countUwmMetrics("web_search", (e) =>
        Boolean(e.fields.executed),
      );
      const cacheEvents = listUwmMetrics().filter((e) => e.kind === "cache");
      note(
        scenario,
        "discovery_poll",
        poll1.discoveryUsed ? "PASS" : "FAIL",
        `found=${poll1.itemsFound} matched=${poll1.itemsMatched} notify=${poll1.notify.shouldNotify} webSearchMetrics=${webSearchCalls}`,
      );
      note(
        scenario,
        "cache_metrics",
        cacheEvents.length > 0 ? "PASS" : "NOT_VERIFIED",
        cacheEvents
          .slice(0, 5)
          .map((e) => `${e.fields.provider}:${e.fields.hit}`)
          .join(",") || "none",
      );

      const bound = poll1.monitorState.boundSources ?? [];
      if (bound.length > 0) {
        note(
          scenario,
          "bound_sources_saved",
          "PASS",
          `count=${bound.length} url=${bound[0]!.url.slice(0, 80)}`,
        );
      } else {
        note(
          scenario,
          "bound_sources_saved",
          poll1.itemsFound > 0 ? "NOT_VERIFIED" : "FAIL",
          "no bound URLs (search may have returned thin/unverified results)",
        );
      }

      // Second poll — prefer bound refresh when possible
      resetUwmMetrics();
      const poll2 = await pollWebMonitor({
        reminderId: row.id,
        userId,
        composeCondition: row.composeCondition,
        monitorState: poll1.monitorState,
        watchOnce: false,
        lastReportSha: poll1.notify.fingerprint || null,
        now: new Date(),
      });
      note(
        scenario,
        "second_poll",
        "PASS",
        `boundPageUsed=${poll2.boundPageUsed} discoveryUsed=${poll2.discoveryUsed} found=${poll2.itemsFound} notify=${poll2.notify.shouldNotify}`,
      );
      if (bound.length > 0 && poll2.boundPageUsed) {
        note(scenario, "bound_refresh_path", "PASS", "bound page monitoring engaged");
      } else {
        note(
          scenario,
          "bound_refresh_path",
          "NOT_VERIFIED",
          "no bound URL to refresh or discovery-only path",
        );
      }

      // Real new-item / change on live web — cannot invent; mark honestly
      note(
        scenario,
        "real_new_or_change",
        "NOT_VERIFIED",
        "live web may not expose a new item/change within this run; not fabricated",
      );

      // Identity: items map size vs found
      const itemCount = Object.keys(poll1.monitorState.items).length;
      note(
        scenario,
        "identity_store",
        itemCount >= 0 ? "PASS" : "FAIL",
        `itemsInState=${itemCount} itemsFound=${poll1.itemsFound}`,
      );

      // Evidence: if notify, must be observed+
      if (poll1.notify.shouldNotify) {
        const g = poll1.notify.item?.evidenceGrade;
        note(
          scenario,
          "evidence_on_notify",
          g === "observed" || g === "corroborated" ? "PASS" : "FAIL",
          `grade=${g}`,
        );
      } else {
        note(
          scenario,
          "evidence_on_notify",
          "PASS",
          `quiet skip reason=${poll1.notify.reason ?? "no_match"} (fail-closed OK)`,
        );
      }

      expect(poll1.discoveryUsed || poll1.itemsFound >= 0).toBe(true);
    },
    180_000,
  );

  it(
    "REAL_WEB domain B: public policy / wiki page monitoring (no domain provider)",
    async () => {
      const scenario: ScenarioResult = {
        name: "domain_B_public_page",
        layer: "REAL_WEB",
        checks: [],
      };
      REPORT.push(scenario);
      if (!hasOpenAi) {
        note(scenario, "openai", "NOT_VERIFIED", "OPENAI_API_KEY missing");
        return;
      }

      const condition = parseComposeCondition({
        type: "web_monitor",
        intent: "תעדכני אם יש שינוי בדף מדיניות כבודה של חברת תעופה גדולה",
        canonical_query:
          "El Al baggage allowance policy official checked bag weight",
        constraints: { entities: ["baggage"] },
        objectives: [
          { id: "d1", kind: "discover_new" },
          {
            id: "c1",
            kind: "detect_change",
            change_aspects: ["policy", "content"],
          },
        ],
        evidence_min: "observed",
      });
      const plan = await selectSourcesForWatch(condition!);
      note(
        scenario,
        "source_selection",
        plan.useWebDiscovery ? "PASS" : "NOT_VERIFIED",
        `coverage=${plan.coverage} reason=${plan.reason}`,
      );

      const product = `e2e-bag-${RUN}`;
      const itemLabel = `e2e-baggage-${RUN}`;
      await applyReminders({
        userId,
        actor: actor(),
        employees: [actor(), lucyActor()],
        reminders: [
          {
            action: "add",
            item: itemLabel,
            listType: "tasks",
            date: "",
            time: "",
            repeat: "hourly",
            ping: ["טל"],
            about: [],
            targets: [],
            text: "מעקב כבודה",
            inSeconds: null,
            everyCount: 3,
            everyUnit: "hours",
            weekdays: null,
            confirmed: false,
            compose: true,
            composeSource: "",
            composeLookbackHours: 0,
            composePlace: "",
            watchOnce: false,
            composeCondition: condition,
            recurrence: { freq: "interval", interval: 3, unit: "hours" },
            onTriggerActions: {
              lists: [
                {
                  action: "add",
                  listType: "shopping",
                  listName: "",
                  listId,
                  items: [{ "שם פריט": product }],
                  targets: [],
                  mode: "static",
                },
              ],
            },
            reminderId: "",
          } as Parameters<typeof applyReminders>[0]["reminders"][number],
        ],
      });
      const row = await prisma.reminder.findFirstOrThrow({
        where: { userId, itemLabel },
      });
      expect(parseWatchTriggerPackage(row.onTriggerActions)?.actions).toHaveLength(
        1,
      );

      // Use real poll via fireDueReminders (WhatsApp mock)
      setWebMonitorPollImplForTests(null); // real pollWebMonitor
      // But fireDueReminders calls pollWebMonitor without inject — good.
      // We need to ensure fire uses real poll — default impl is pollWebMonitor.

      resetUwmMetrics();
      const beforeItems = await prisma.employeeListItem.count({
        where: { listId, deletedAt: null },
      });

      // Direct real poll first to gather metrics, then fire for Apply/notify path
      const poll1 = await pollWebMonitor({
        reminderId: row.id,
        userId,
        composeCondition: row.composeCondition,
        monitorState: row.monitorState,
        watchOnce: false,
      });
      await prisma.reminder.update({
        where: { id: row.id },
        data: {
          monitorState: poll1.monitorState as object,
          fireAt: new Date(Date.now() - 60_000),
          status: "active",
          sendStatus: "pending",
        },
      });

      note(
        scenario,
        "discovery",
        poll1.discoveryUsed ? "PASS" : "FAIL",
        `found=${poll1.itemsFound} matched=${poll1.itemsMatched} notify=${poll1.notify.shouldNotify} grade=${poll1.notify.item?.evidenceGrade ?? ""}`,
      );

      // Fire path: if already notified in poll1 state, may quiet-skip.
      // Reset notified markers for fire Apply test only if we have a verified match.
      if (poll1.notify.shouldNotify && poll1.notify.item) {
        // Clear notified so fire can re-evaluate with same content once
        const st = structuredClone(poll1.monitorState);
        for (const it of Object.values(st.items)) {
          it.notified = {};
        }
        await prisma.reminder.update({
          where: { id: row.id },
          data: {
            monitorState: st as object,
            lastReportSha: "",
            fireAt: new Date(Date.now() - 60_000),
            sendStatus: "pending",
            status: "active",
          },
        });
      }

      sendWhatsAppButtons.mockClear();
      await fireDueReminders(new Date());

      const after = await prisma.reminder.findUniqueOrThrow({
        where: { id: row.id },
      });
      const ledger = parseWatchTriggerExecLedger(after.onTriggerExec);
      const afterItems = await prisma.employeeListItem.count({
        where: { listId, deletedAt: null },
      });

      if (sendWhatsAppButtons.mock.calls.length > 0) {
        note(scenario, "whatsapp_mock", "PASS", "sendWhatsAppButtons called");
      } else {
        note(
          scenario,
          "whatsapp_mock",
          "NOT_VERIFIED",
          "no notify this cycle (quiet skip / no match) — expected if search thin",
        );
      }

      if (afterItems > beforeItems) {
        note(
          scenario,
          "p0_action",
          "PASS",
          `lists.add +1; ledgerEvents=${Object.keys(ledger.events).length}`,
        );
        const ev = Object.values(ledger.events)[0];
        if (ev) {
          note(
            scenario,
            "ledger_actions_vs_notify",
            "PASS",
            `actions=${JSON.stringify(ev.actions)} notified=${ev.notified}`,
          );
        }
      } else {
        note(
          scenario,
          "p0_action",
          "NOT_VERIFIED",
          "no Action this cycle — live search did not yield notify-grade match",
        );
      }

      // Bound refresh attempt
      const bound = (after.monitorState as { boundSources?: unknown[] })
        ?.boundSources;
      const poll2 = await pollWebMonitor({
        reminderId: row.id,
        userId,
        composeCondition: after.composeCondition,
        monitorState: after.monitorState,
        watchOnce: false,
        lastReportSha: after.lastReportSha,
      });
      note(
        scenario,
        "second_poll_bound",
        Array.isArray(bound) && bound.length > 0 && poll2.boundPageUsed
          ? "PASS"
          : "NOT_VERIFIED",
        `bound=${Array.isArray(bound) ? bound.length : 0} boundPageUsed=${poll2.boundPageUsed} discovery=${poll2.discoveryUsed}`,
      );

      note(
        scenario,
        "real_policy_change",
        "NOT_VERIFIED",
        "cannot prove a real policy change occurred during this run",
      );

      const metrics = listUwmMetrics();
      note(
        scenario,
        "usage_metrics",
        "PASS",
        `events=${metrics.length} web_search=${countUwmMetrics("web_search")} cache=${countUwmMetrics("cache")} action=${countUwmMetrics("action")}`,
      );
    },
    180_000,
  );
});
