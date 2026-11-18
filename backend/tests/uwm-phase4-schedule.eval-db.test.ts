/**
 * UWM Phase 4 — dual schedule fireAt on workee_test (fixtures + real settle).
 * WhatsApp mocked. No LIVE.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

import { parseComposeCondition } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { applyReminders } from "../src/services/reminder.service.js";
import {
  fireDueReminders,
  setWebMonitorPollImplForTests,
} from "../src/services/reminder-fire.js";
import { pollWebMonitor } from "../src/services/semantic-web-monitor.service.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const RUN = randomUUID().slice(0, 8);

describe(`UWM Phase 4 dual schedule (eval-db) ${RUN}`, () => {
  let account: HarnessAccount | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  beforeEach(() => {
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
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  it("C1-ish: after discovery poll, fireAt = min(discovery+3h, precise)", async () => {
    account = await createHarnessAccount("טל");
    const phone = `+1558${RUN.replace(/\D/g, "").padEnd(7, "0").slice(0, 7)}`;
    await prisma.employee.update({
      where: { id: account.employeeId },
      data: { phone },
    });
    const actorRow = await prisma.employee.findUniqueOrThrow({
      where: { id: account.employeeId },
    });
    const actor = {
      id: actorRow.id,
      name: actorRow.name,
      surname: actorRow.surname,
      nickname: actorRow.nickname,
      email: null,
      phone: actorRow.phone,
      kind: actorRow.kind as "human" | "digital",
    };

    const now = new Date("2026-06-01T12:00:00.000Z");
    const eventAt = "2026-06-01T17:00:00.000Z";
    const condition = parseComposeCondition({
      type: "web_monitor",
      intent: "שעה לפני משחק ריאל",
      canonical_query: "Real Madrid league fixture",
      constraints: { entities: ["Real Madrid"] },
      objectives: [
        { id: "d1", kind: "discover_new" },
        { id: "p1", kind: "time_before_event", minutes_before: 60 },
      ],
      evidence_min: "observed",
    });

    const item = `uwm-p4-c1-${RUN}`;
    await applyReminders({
      userId: account.userId,
      actor,
      employees: [actor],
      reminders: [
        {
          action: "add",
          item,
          listType: "tasks",
          date: "",
          time: "",
          repeat: "hourly",
          ping: [actor.nickname ?? actor.name],
          about: [],
          targets: [],
          text: item,
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
      where: { userId: account.userId, itemLabel: item },
    });

    setWebMonitorPollImplForTests(async (input) =>
      pollWebMonitor({
        ...input,
        now,
        skipExternalCache: true,
        searchImpl: async () => ({
          text: `UWM_FIXTURE_ITEMS: ${JSON.stringify([
            {
              title: "Real Madrid vs Opp",
              url: `https://p4-${RUN}.example/m`,
              sourceUrls: [`https://p4-${RUN}.example/m`],
              summary: "Real Madrid league",
              locationText: "Madrid",
              eventAt,
              retrievalOk: true,
            },
          ])}\n\n`,
          sources: [`https://p4-${RUN}.example/m`],
          usage: null,
          raw: null,
        }),
      }),
    );

    await prisma.reminder.update({
      where: { id: row.id },
      data: {
        fireAt: new Date(now.getTime() - 60_000),
        status: "active",
        sendStatus: "pending",
      },
    });

    await fireDueReminders(now);

    const after = await prisma.reminder.findUniqueOrThrow({ where: { id: row.id } });
    const state = after.monitorState as {
      nextPrecise?: { fireAtIso: string; eventAtIso: string };
    };
    expect(state.nextPrecise?.eventAtIso).toBe(eventAt);
    expect(state.nextPrecise?.fireAtIso).toBe(
      new Date("2026-06-01T16:00:00.000Z").toISOString(),
    );
    // Dual schedule: discovery recurrence (~+3h from prior fireAt) beats precise (16:00).
    const fireAtMs = after.fireAt.getTime();
    const preciseMs = Date.parse(state.nextPrecise!.fireAtIso);
    expect(fireAtMs).toBeGreaterThan(now.getTime());
    expect(fireAtMs).toBeLessThan(preciseMs);
    // ~3h cadence, not jumping straight to precise-only
    expect(fireAtMs).toBeLessThan(now.getTime() + 3.5 * 60 * 60_000);
  });
});
