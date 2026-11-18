/**
 * UWM Phase 5 — Watch→Apply on workee_test (:5436).
 * Real fireDueReminders + P0 ledger; retrieval fixtures; WhatsApp mocked.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import {
  parseWatchTriggerExecLedger,
  parseWatchTriggerPackage,
} from "../src/services/watch-trigger-actions.service.js";
import {
  countUwmMetrics,
  resetUwmMetrics,
} from "../src/services/uwm-retrieval-metrics.js";

const RUN = randomUUID().slice(0, 8);

describe(`UWM Phase 5 Apply (eval-db :5436) ${RUN}`, () => {
  let userId = "";
  let ownerId = "";
  let lucyId = "";
  let listId = "";
  let phone = "";

  beforeAll(async () => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    phone = `+1559${RUN.slice(0, 7)}`;
    const user = await prisma.user.create({
      data: { username: `uwm_p5_${RUN}` },
    });
    userId = user.id;
    const team = await prisma.team.create({
      data: { userId: user.id, name: `uwm_p5_${RUN}` },
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
            items: [{ "שם פריט": `seed-p5-${RUN}` }],
            targets: [],
          },
        ],
      },
      {
        scope: "personal",
        addedById: ownerId,
        visibleTo: [ownerId],
      },
      ownerId,
    );
    const list = await prisma.employeeList.findFirst({
      where: { employeeId: ownerId, listType: "shopping", deletedAt: null },
    });
    listId = list?.id ?? "";
    expect(listId).toBeTruthy();
  });

  afterAll(async () => {
    setWebMonitorPollImplForTests(null);
    if (!userId) return;
    await prisma.deliveryAttempt.deleteMany({ where: { userId } }).catch(() => null);
    await prisma.reminder.deleteMany({ where: { userId } });
    await prisma.employeeListItem.deleteMany({
      where: { list: { employeeId: ownerId } },
    });
    await prisma.employeeList.deleteMany({ where: { employeeId: ownerId } });
    await prisma.chatMessage
      .deleteMany({ where: { conversation: { userId } } })
      .catch(() => null);
    await prisma.chatConversation.deleteMany({ where: { userId } }).catch(() => null);
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
  function lucy() {
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

  function fixtureSearch(title: string, url: string) {
    return async () => ({
      text: `UWM_FIXTURE_ITEMS: ${JSON.stringify([
        {
          title,
          url,
          sourceUrls: [url],
          summary: `${title} Real Madrid`,
          locationText: "Madrid",
          eventAt: "2026-07-01T20:00:00Z",
          retrievalOk: true,
        },
      ])}\n\n`,
      sources: [url],
      usage: null,
      raw: null,
    });
  }

  it("verified discover_new fires lists.add once; retry does not duplicate; WhatsApp independent", async () => {
    resetUwmMetrics();
    loadComposeFacts.mockResolvedValue({
      kind: "generic",
      fixedBody: "",
      eval: {},
      advanceLastReportSha: false,
      headSha: "",
    });
    const productTitle = `uwm-p5-item-${RUN}`;
    const itemLabel = `uwm-p5-watch-${RUN}`;
    const url = `https://p5-${RUN}.example/match`;

    const applied = await applyReminders({
      userId,
      actor: actor(),
      employees: [actor(), lucy()],
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
          text: "מעקב",
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
          composeCondition: parseComposeCondition({
            type: "web_monitor",
            intent: "גילוי משחק ריאל",
            canonical_query: "Real Madrid fixture",
            constraints: { entities: ["Real Madrid"] },
            objectives: [{ id: "d1", kind: "discover_new" }],
            evidence_min: "observed",
          }),
          recurrence: { freq: "interval", interval: 3, unit: "hours" },
          onTriggerActions: {
            lists: [
              {
                action: "add",
                listType: "shopping",
                listName: "",
                listId,
                items: [{ "שם פריט": productTitle }],
                targets: [],
                mode: "static",
              },
            ],
          },
          reminderId: "",
        } as Parameters<typeof applyReminders>[0]["reminders"][number],
      ],
    });
    expect(applied.skipped).toEqual([]);
    const row = await prisma.reminder.findFirstOrThrow({
      where: { userId, itemLabel },
    });
    expect(parseWatchTriggerPackage(row.onTriggerActions)?.actions).toHaveLength(
      1,
    );

    setWebMonitorPollImplForTests(async (input) =>
      pollWebMonitor({
        ...input,
        skipExternalCache: true,
        searchImpl: fixtureSearch("Real Madrid vs Opp", url),
      }),
    );

    await prisma.reminder.update({
      where: { id: row.id },
      data: {
        fireAt: new Date(Date.now() - 60_000),
        status: "active",
        sendStatus: "pending",
      },
    });

    const before = await prisma.employeeListItem.count({
      where: { listId, deletedAt: null },
    });
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date());

    const after = await prisma.employeeListItem.findMany({
      where: { listId, deletedAt: null },
      select: { data: true },
    });
    const added = after.filter(
      (r) =>
        String((r.data as Record<string, unknown>)["שם פריט"] ?? "") ===
        productTitle,
    );
    expect(added.length).toBe(1);
    expect(after.length).toBe(before + 1);
    expect(sendWhatsAppButtons).toHaveBeenCalled();
    expect(
      countUwmMetrics("action", (e) => e.fields.op === "executed"),
    ).toBeGreaterThan(0);

    const fired = await prisma.reminder.findUniqueOrThrow({
      where: { id: row.id },
    });
    const ledger = parseWatchTriggerExecLedger(fired.onTriggerExec);
    const fps = Object.keys(ledger.events);
    expect(fps.length).toBeGreaterThanOrEqual(1);
    const event = ledger.events[fps[0]!]!;
    expect(
      Object.values(event.actions).every((s) => s.status === "done"),
    ).toBe(true);
    expect(event.notified).toBe(true);

    // Second poll same finding — no duplicate Action
    await prisma.reminder.update({
      where: { id: row.id },
      data: {
        fireAt: new Date(Date.now() - 30_000),
        sendStatus: "pending",
        status: "active",
      },
    });
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date());
    const again = await prisma.employeeListItem.findMany({
      where: { listId, deletedAt: null },
      select: { data: true },
    });
    expect(
      again.filter(
        (r) =>
          String((r.data as Record<string, unknown>)["שם פריט"] ?? "") ===
          productTitle,
      ).length,
    ).toBe(1);
  });

  it("unverified / disputed never Apply; notify-only watch has no package", async () => {
    resetUwmMetrics();
    const itemLabel = `uwm-p5-bad-${RUN}`;
    await applyReminders({
      userId,
      actor: actor(),
      employees: [actor(), lucy()],
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
          text: "מעקב",
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
          composeCondition: parseComposeCondition({
            type: "web_monitor",
            intent: "גילוי",
            canonical_query: "Real Madrid",
            constraints: { entities: ["Real Madrid"] },
            objectives: [{ id: "d1", kind: "discover_new" }],
            evidence_min: "observed",
          }),
          recurrence: { freq: "interval", interval: 3, unit: "hours" },
          onTriggerActions: {
            lists: [
              {
                action: "add",
                listType: "shopping",
                listName: "",
                listId,
                items: [{ "שם פריט": `should-not-${RUN}` }],
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

    setWebMonitorPollImplForTests(async (input) =>
      pollWebMonitor({
        ...input,
        skipExternalCache: true,
        searchImpl: async () => ({
          text: `UWM_FIXTURE_ITEMS: ${JSON.stringify([
            {
              title: "Real Madrid rumor",
              summary: "Real Madrid",
              eventAt: "2026-07-01",
              conflictEventAt: "2026-08-01",
              url: "https://a.example/1",
              sourceUrls: ["https://a.example/1"],
              retrievalOk: true,
            },
          ])}\n\n`,
          sources: ["https://a.example/1"],
          usage: null,
          raw: null,
        }),
      }),
    );

    const before = await prisma.employeeListItem.count({
      where: {
        listId,
        deletedAt: null,
      },
    });
    await prisma.reminder.update({
      where: { id: row.id },
      data: {
        fireAt: new Date(Date.now() - 60_000),
        status: "active",
        sendStatus: "pending",
      },
    });
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date());
    expect(sendWhatsAppButtons).not.toHaveBeenCalled();
    const after = await prisma.employeeListItem.count({
      where: { listId, deletedAt: null },
    });
    expect(after).toBe(before);

    // Notify-only: no on_trigger_actions
    const notifyLabel = `uwm-p5-notify-${RUN}`;
    await applyReminders({
      userId,
      actor: actor(),
      employees: [actor(), lucy()],
      reminders: [
        {
          action: "add",
          item: notifyLabel,
          listType: "tasks",
          date: "",
          time: "",
          repeat: "hourly",
          ping: ["טל"],
          about: [],
          targets: [],
          text: "מעקב",
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
          composeCondition: parseComposeCondition({
            type: "web_monitor",
            intent: "גילוי",
            canonical_query: "Real Madrid",
            constraints: { entities: ["Real Madrid"] },
            objectives: [{ id: "d1", kind: "discover_new" }],
          }),
          recurrence: { freq: "interval", interval: 3, unit: "hours" },
          reminderId: "",
        } as Parameters<typeof applyReminders>[0]["reminders"][number],
      ],
    });
    const notifyRow = await prisma.reminder.findFirstOrThrow({
      where: { userId, itemLabel: notifyLabel },
    });
    expect(parseWatchTriggerPackage(notifyRow.onTriggerActions)).toBeNull();

    setWebMonitorPollImplForTests(async (input) =>
      pollWebMonitor({
        ...input,
        skipExternalCache: true,
        searchImpl: fixtureSearch(
          "Real Madrid vs NotifyOnly",
          `https://p5-n-${RUN}.example/m`,
        ),
      }),
    );
    await prisma.reminder.update({
      where: { id: notifyRow.id },
      data: {
        fireAt: new Date(Date.now() - 60_000),
        status: "active",
        sendStatus: "pending",
      },
    });
    const beforeN = await prisma.employeeListItem.count({
      where: { listId, deletedAt: null },
    });
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date());
    expect(sendWhatsAppButtons).toHaveBeenCalled();
    expect(
      await prisma.employeeListItem.count({
        where: { listId, deletedAt: null },
      }),
    ).toBe(beforeN);
  });

  it("WhatsApp failure does not re-run completed Action", async () => {
    const productTitle = `uwm-p5-wa-fail-${RUN}`;
    const itemLabel = `uwm-p5-wa-${RUN}`;
    const url = `https://p5-wa-${RUN}.example/m`;
    await applyReminders({
      userId,
      actor: actor(),
      employees: [actor(), lucy()],
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
          text: "מעקב",
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
          composeCondition: parseComposeCondition({
            type: "web_monitor",
            intent: "גילוי",
            canonical_query: "Real Madrid",
            constraints: { entities: ["Real Madrid"] },
            objectives: [{ id: "d1", kind: "discover_new" }],
          }),
          recurrence: { freq: "interval", interval: 3, unit: "hours" },
          onTriggerActions: {
            lists: [
              {
                action: "add",
                listType: "shopping",
                listName: "",
                listId,
                items: [{ "שם פריט": productTitle }],
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

    setWebMonitorPollImplForTests(async (input) =>
      pollWebMonitor({
        ...input,
        skipExternalCache: true,
        searchImpl: fixtureSearch("Real Madrid vs WA", url),
      }),
    );

    // First fire: Action succeeds, WhatsApp mocked fail
    sendWhatsAppButtons.mockResolvedValueOnce("failed" as never);
    await prisma.reminder.update({
      where: { id: row.id },
      data: {
        fireAt: new Date(Date.now() - 60_000),
        status: "active",
        sendStatus: "pending",
      },
    });
    await fireDueReminders(new Date());

    const mid = await prisma.reminder.findUniqueOrThrow({ where: { id: row.id } });
    const ledger = parseWatchTriggerExecLedger(mid.onTriggerExec);
    const fps = Object.keys(ledger.events);
    expect(fps.length).toBeGreaterThanOrEqual(1);
    const ev = ledger.events[fps[0]!]!;
    expect(Object.values(ev.actions).every((s) => s.status === "done")).toBe(
      true,
    );

    const count = async () =>
      (
        await prisma.employeeListItem.findMany({
          where: { listId, deletedAt: null },
          select: { data: true },
        })
      ).filter(
        (r) =>
          String((r.data as Record<string, unknown>)["שם פריט"] ?? "") ===
          productTitle,
      ).length;

    const afterFail = await count();
    expect(afterFail).toBe(1);

    // Recovery fire: WhatsApp may retry notify; Action must not duplicate
    sendWhatsAppButtons.mockResolvedValue("sent" as never);
    await prisma.reminder.update({
      where: { id: row.id },
      data: {
        fireAt: new Date(Date.now() - 20_000),
        status: "active",
        sendStatus: "pending",
      },
    });
    await fireDueReminders(new Date());
    expect(await count()).toBe(1);
  });
});
