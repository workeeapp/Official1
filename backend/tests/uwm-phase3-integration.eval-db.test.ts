/**
 * UWM Phase 3 — Integration verification on workee_test (:5436).
 *
 * Layer: real DB + real reminder-fire engine + retrieval fixtures (injected).
 * WhatsApp: mocked module (no Meta Graph). No LIVE. No real web/API in this file.
 *
 *   npm run test:eval-db -- tests/uwm-phase3-integration.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";

assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
expect(new URL(process.env.DATABASE_URL!).port).toBe("5436");
expect(new URL(process.env.DATABASE_URL!).pathname.endsWith("/workee_test")).toBe(
  true,
);

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

import { parseComposeCondition } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { applyReminders } from "../src/services/reminder.service.js";
import {
  fireDueReminders,
  setWebMonitorPollImplForTests,
} from "../src/services/reminder-fire.js";
import {
  pollWebMonitor,
  type PollWebMonitorInput,
} from "../src/services/semantic-web-monitor.service.js";
import { resetUwmMetrics, listUwmMetrics } from "../src/services/uwm-retrieval-metrics.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const RUN = randomUUID().slice(0, 8);

function fixtureSearch(items: unknown[], sources: string[]) {
  return async () => ({
    text: `UWM_FIXTURE_ITEMS: ${JSON.stringify(items)}\n\n`,
    sources,
    usage: null,
    raw: null,
  });
}

function actorFrom(row: {
  id: string;
  name: string;
  surname: string | null;
  nickname: string | null;
  phone: string | null;
  kind: string;
}) {
  return {
    id: row.id,
    name: row.name,
    surname: row.surname,
    nickname: row.nickname,
    email: null,
    phone: row.phone,
    kind: row.kind as "human" | "digital",
  };
}

function baseReminder(
  overrides: Record<string, unknown>,
): Parameters<typeof applyReminders>[0]["reminders"][number] {
  return {
    action: "add",
    item: "מעקב",
    listType: "tasks",
    date: "",
    time: "",
    repeat: "hourly",
    ping: [],
    about: [],
    targets: [],
    text: "",
    inSeconds: null,
    everyCount: 1,
    everyUnit: "hours",
    weekdays: null,
    confirmed: false,
    compose: true,
    composeSource: "",
    composeLookbackHours: 0,
    composePlace: "",
    watchOnce: false,
    reminderId: "",
    ...overrides,
  } as Parameters<typeof applyReminders>[0]["reminders"][number];
}

describe(`UWM Phase 3 integration (eval-db :5436) ${RUN}`, () => {
  let account: HarnessAccount | null = null;
  const cacheKeysCreated: string[] = [];

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  });

  beforeEach(() => {
    resetUwmMetrics();
    sendWhatsAppButtons.mockClear();
    loadComposeFacts.mockReset();
    composeScheduledOutbound.mockReset();
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
    if (cacheKeysCreated.length) {
      await prisma.externalDataCache.deleteMany({
        where: { cacheKey: { in: [...cacheKeysCreated] } },
      });
      cacheKeysCreated.length = 0;
    }
    await prisma.externalDataCache
      .deleteMany({
        where: {
          cacheKey: { contains: `uwm-p3-cache-${RUN}` },
        },
      })
      .catch(() => null);
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  async function ensureEmployeePhone(employeeId: string): Promise<string> {
    const phone = `+1557${RUN.replace(/\D/g, "").padEnd(7, "0").slice(0, 7)}`;
    await prisma.employee.update({
      where: { id: employeeId },
      data: { phone },
    });
    return phone;
  }

  async function createWebMonitorReminder(input: {
    item: string;
    condition: Record<string, unknown>;
    pingName?: string;
  }) {
    account = await createHarnessAccount("טל");
    await ensureEmployeePhone(account.employeeId);
    const actorRow = await prisma.employee.findUniqueOrThrow({
      where: { id: account.employeeId },
    });
    const actor = actorFrom(actorRow);
    const condition = parseComposeCondition(input.condition);
    expect(condition?.type).toBe("web_monitor");

    const applied = await applyReminders({
      userId: account.userId,
      actor,
      employees: [actor],
      reminders: [
        baseReminder({
          item: input.item,
          text: input.item,
          ping: [input.pingName ?? actor.nickname ?? actor.name],
          composeCondition: condition,
          recurrence: { freq: "interval", interval: 1, unit: "hours" },
        }),
      ],
    });
    expect(applied.skipped).toEqual([]);
    const row = await prisma.reminder.findFirst({
      where: { userId: account.userId, itemLabel: input.item },
    });
    expect(row).toBeTruthy();
    return row!;
  }

  async function makeDue(reminderId: string) {
    await prisma.reminder.update({
      where: { id: reminderId },
      data: {
        fireAt: new Date(Date.now() - 60_000),
        status: "active",
        sendStatus: "pending",
      },
    });
  }

  it("1+2+3+7: persist web_monitor → real fireDueReminders → monitorState + WhatsApp mock", async () => {
    const url = `https://uwm-p3-${RUN}.example/artzi-show`;
    const row = await createWebMonitorReminder({
      item: `uwm-p3-discover-${RUN}`,
      condition: {
        type: "web_monitor",
        intent: "גילוי הופעות ארצי",
        canonical_query: "Artzi concert Israel",
        constraints: { entities: ["ארצי"], geo: "ישראל" },
        objectives: [{ id: "o1", kind: "discover_new" }],
        evidence_min: "observed",
      },
    });

    setWebMonitorPollImplForTests(async (input: PollWebMonitorInput) =>
      pollWebMonitor({
        ...input,
        skipExternalCache: true,
        searchImpl: fixtureSearch(
          [
            {
              title: "הופעת ארצי בתל אביב",
              url,
              sourceUrls: [url],
              summary: "ארצי ישראל",
              locationText: "ישראל",
              retrievalOk: true,
            },
          ],
          [url],
        ),
      }),
    );

    await makeDue(row.id);
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date());

    const after1 = await prisma.reminder.findUniqueOrThrow({
      where: { id: row.id },
    });
    const state1 = after1.monitorState as Record<string, unknown>;
    expect(state1).toBeTruthy();
    expect(state1.version).toBe(1);
    expect(state1.lastPollAt).toBeTruthy();
    const bound = state1.boundSources as Array<{ url: string }> | undefined;
    expect(bound?.some((b) => b.url === url)).toBe(true);
    expect(Object.keys((state1.items as object) ?? {}).length).toBeGreaterThan(
      0,
    );
    expect(sendWhatsAppButtons).toHaveBeenCalled();
    const sentText = String(
      (sendWhatsAppButtons.mock.calls[0] as unknown[])?.[1] ?? "",
    );
    expect(sentText).toMatch(/ארצי|פריט|מעקב/);
    expect(after1.lastReportSha).toBeTruthy();
  });

  it(
    "3+5: second poll updates monitorState; detect_change uses bound page refresh",
    async () => {
    const url = `https://uwm-p3-bound-${RUN}.example/policy`;
    const row = await createWebMonitorReminder({
      item: `uwm-p3-change-${RUN}`,
      condition: {
        type: "web_monitor",
        intent: "שינוי מדיניות כבודה",
        canonical_query: "airline baggage policy",
        constraints: { entities: ["baggage"] },
        objectives: [
          { id: "o1", kind: "detect_change", change_aspects: ["policy"] },
        ],
        evidence_min: "observed",
      },
    });

    // Seed bound source in DB (as Discovery would leave it).
    await prisma.reminder.update({
      where: { id: row.id },
      data: {
        monitorState: {
          version: 1,
          items: {},
          boundSources: [{ url, sourceId: "web_page", failCount: 0 }],
          sourcePlan: {
            coverage: "none",
            reason: "web_only",
            useWebDiscovery: true,
            primary: [{ id: "web_search", kind: "web_search", score: 1 }],
            secondary: [],
            requiredFacets: ["contentFp"],
            facetCoverage: { contentFp: "web" },
            reliabilityExpect: "low",
            decidedAt: new Date().toISOString(),
          },
        },
      },
    });

    let searches = 0;
    let pageFetches = 0;
    setWebMonitorPollImplForTests(async (input) =>
      pollWebMonitor({
        ...input,
        skipExternalCache: true,
        searchImpl: async () => {
          searches += 1;
          return { text: "", sources: [], usage: null, raw: null };
        },
        pageFetchImpl: async () => {
          pageFetches += 1;
          return {
            ok: true,
            text: "Baggage allowance 23kg checked policy baggage",
          };
        },
      }),
    );

    await makeDue(row.id);
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date());
    expect(pageFetches).toBe(1);
    expect(searches).toBe(0);
    expect(sendWhatsAppButtons).not.toHaveBeenCalled(); // seed only

    const mid = await prisma.reminder.findUniqueOrThrow({ where: { id: row.id } });
    const midState = mid.monitorState as {
      lastPollAt?: string;
      items?: Record<string, { contentFp?: string }>;
    };
    const fp1 = Object.values(midState.items ?? {})[0]?.contentFp;
    expect(fp1).toBeTruthy();
    const pollAt1 = midState.lastPollAt;

    // Cycle 2: content change → notify
    setWebMonitorPollImplForTests(async (input) =>
      pollWebMonitor({
        ...input,
        skipExternalCache: true,
        searchImpl: async () => {
          searches += 1;
          return { text: "", sources: [], usage: null, raw: null };
        },
        pageFetchImpl: async () => {
          pageFetches += 1;
          return {
            ok: true,
            text: "Baggage allowance 20kg checked UPDATED policy baggage",
          };
        },
      }),
    );
    await makeDue(row.id);
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date());

    expect(pageFetches).toBe(2);
    expect(searches).toBe(0);
    expect(sendWhatsAppButtons).toHaveBeenCalled();

    const end = await prisma.reminder.findUniqueOrThrow({ where: { id: row.id } });
    const endState = end.monitorState as {
      lastPollAt?: string;
      items?: Record<string, { contentFp?: string }>;
    };
    expect(endState.lastPollAt).not.toBe(pollAt1);
    const fp2 = Object.values(endState.items ?? {})[0]?.contentFp;
    expect(fp2).toBeTruthy();
    expect(fp2).not.toBe(fp1);
  },
    20_000,
  );

  it("4: ExternalDataCache used for bound page monitoring (real cache write)", async () => {
    const url = `https://uwm-p3-cache-${RUN}.example/page`;
    account = await createHarnessAccount("טל");
    await ensureEmployeePhone(account.employeeId);
    const before = await prisma.externalDataCache.count({
      where: { provider: "web_page", scope: "monitor_url" },
    });

    const result = await pollWebMonitor({
      reminderId: `cache-${RUN}`,
      userId: account.userId,
      composeCondition: {
        type: "web_monitor",
        intent: "רענון דף",
        canonicalQuery: "page refresh",
        constraints: { entities: ["baggage"] },
        objectives: [
          { id: "o1", kind: "detect_change", changeAspects: ["content"] },
        ],
        evidenceMin: "observed",
      },
      monitorState: {
        version: 1,
        items: {},
        boundSources: [{ url, sourceId: "web_page", failCount: 0 }],
        sourcePlan: {
          coverage: "none",
          reason: "web_only",
          useWebDiscovery: false,
          primary: [],
          secondary: [],
          requiredFacets: ["contentFp"],
          facetCoverage: { contentFp: "web" },
          reliabilityExpect: "low",
          decidedAt: new Date().toISOString(),
        },
      },
      watchOnce: false,
      // real ExternalDataCache path
      pageFetchImpl: async () => ({
        ok: true,
        text: "Baggage policy page content for cache write test",
      }),
    });

    expect(result.boundPageUsed).toBe(true);
    const after = await prisma.externalDataCache.findMany({
      where: { provider: "web_page", scope: "monitor_url" },
      orderBy: { fetchedAt: "desc" },
      take: 5,
    });
    const hit = after.find((r) => {
      const payload = r.payload as { text?: string } | null;
      return String(payload?.text ?? "").includes("cache write test");
    });
    expect(hit).toBeTruthy();
    if (hit) cacheKeysCreated.push(hit.cacheKey);
    expect(after.length).toBeGreaterThanOrEqual(before);
    expect(
      listUwmMetrics().some(
        (e) => e.kind === "cache" && e.fields.provider === "web_page",
      ),
    ).toBe(true);
  });

  it("6: soft-404 → rediscovery, no WhatsApp on fail-only path then alternate notifies", async () => {
    const bad = `https://uwm-p3-dead-${RUN}.example/gone`;
    const good = `https://uwm-p3-alive-${RUN}.example/artzi`;
    const row = await createWebMonitorReminder({
      item: `uwm-p3-soft404-${RUN}`,
      condition: {
        type: "web_monitor",
        intent: "גילוי הופעות ארצי",
        canonical_query: "Artzi show",
        constraints: { entities: ["ארצי"], geo: "ישראל" },
        objectives: [{ id: "o1", kind: "discover_new" }],
        evidence_min: "observed",
      },
    });

    await prisma.reminder.update({
      where: { id: row.id },
      data: {
        monitorState: {
          version: 1,
          items: {},
          boundSources: [{ url: bad, sourceId: "web_page", failCount: 1 }],
          sourcePlan: {
            coverage: "none",
            reason: "web_only",
            useWebDiscovery: true,
            primary: [{ id: "web_search", kind: "web_search", score: 1 }],
            secondary: [],
            requiredFacets: ["title"],
            facetCoverage: { title: "web" },
            reliabilityExpect: "low",
            decidedAt: new Date().toISOString(),
          },
        },
      },
    });

    setWebMonitorPollImplForTests(async (input) =>
      pollWebMonitor({
        ...input,
        skipExternalCache: true,
        pageFetchImpl: async () => ({
          ok: false,
          text: "soft-404 page not found",
          soft404: true,
        }),
        searchImpl: fixtureSearch(
          [
            {
              title: "ארצי alternate listing",
              url: good,
              sourceUrls: [good],
              summary: "ארצי ישראל",
              locationText: "ישראל",
              retrievalOk: true,
            },
          ],
          [good],
        ),
      }),
    );

    await makeDue(row.id);
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date());

    const after = await prisma.reminder.findUniqueOrThrow({ where: { id: row.id } });
    const state = after.monitorState as {
      boundSources?: Array<{ url: string }>;
    };
    expect(state.boundSources?.some((b) => b.url === bad)).toBe(false);
    expect(state.boundSources?.some((b) => b.url === good)).toBe(true);
    // Rediscovery found alternate with evidence → WhatsApp allowed
    expect(sendWhatsAppButtons).toHaveBeenCalled();
  });

  it("8: disputed / unverified do not hit WhatsApp via fire path", async () => {
    const row = await createWebMonitorReminder({
      item: `uwm-p3-evidence-${RUN}`,
      condition: {
        type: "web_monitor",
        intent: "גילוי הופעות ארצי",
        canonical_query: "Artzi",
        constraints: { entities: ["ארצי"] },
        objectives: [{ id: "o1", kind: "discover_new" }],
        evidence_min: "observed",
      },
    });

    setWebMonitorPollImplForTests(async (input) =>
      pollWebMonitor({
        ...input,
        skipExternalCache: true,
        searchImpl: fixtureSearch(
          [
            {
              title: "ארצי show conflict",
              url: "https://a.example/1",
              sourceUrls: ["https://a.example/1"],
              summary: "ארצי",
              eventAt: "2026-07-01",
              conflictEventAt: "2026-08-01",
              retrievalOk: true,
            },
          ],
          ["https://a.example/1"],
        ),
      }),
    );

    await makeDue(row.id);
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date());
    expect(sendWhatsAppButtons).not.toHaveBeenCalled();

    // unverified (no URL)
    setWebMonitorPollImplForTests(async (input) =>
      pollWebMonitor({
        ...input,
        skipExternalCache: true,
        searchImpl: fixtureSearch(
          [
            {
              title: "ארצי rumor only",
              summary: "ארצי",
              retrievalOk: true,
            },
          ],
          [],
        ),
      }),
    );
    await makeDue(row.id);
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date());
    expect(sendWhatsAppButtons).not.toHaveBeenCalled();
  });

  it("9: existing market_price watch still fires via same engine (regression)", async () => {
    account = await createHarnessAccount("טל");
    await ensureEmployeePhone(account.employeeId);
    const actorRow = await prisma.employee.findUniqueOrThrow({
      where: { id: account.employeeId },
    });
    const actor = actorFrom(actorRow);
    const item = `uwm-p3-market-reg-${RUN}`;
    const applied = await applyReminders({
      userId: account.userId,
      actor,
      employees: [actor],
      reminders: [
        baseReminder({
          item,
          text: "מחיר",
          ping: [actor.nickname ?? actor.name],
          composeCondition: {
            type: "market_price",
            op: "lt",
            value: 100,
          },
          watchOnce: false,
        }),
      ],
    });
    expect(applied.skipped).toEqual([]);
    const row = await prisma.reminder.findFirstOrThrow({
      where: { userId: account.userId, itemLabel: item },
    });
    await prisma.reminder.update({
      where: { id: row.id },
      data: {
        fireAt: new Date(Date.now() - 60_000),
        lastReportSha: "market:above",
        status: "active",
        sendStatus: "pending",
      },
    });
    loadComposeFacts.mockResolvedValue({
      kind: "market",
      fixedBody: "TICKER = 90",
      eval: { marketPrice: 90 },
      advanceLastReportSha: false,
      headSha: "",
    });
    composeScheduledOutbound.mockResolvedValue("המחיר ירד");
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date());
    expect(sendWhatsAppButtons).toHaveBeenCalled();
  });
});
