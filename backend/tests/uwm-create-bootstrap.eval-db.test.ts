/**
 * UWM Create-turn bootstrap — workee_test (:5436).
 * Create → bootstrap → reschedule → single precise fire.
 * WhatsApp mocked. Fixture search only (no LIVE).
 *
 *   npm run test:eval-db -- tests/uwm-create-bootstrap.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";

assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
expect(new URL(process.env.DATABASE_URL!).port).toBe("5436");

const sendWhatsAppButtons = vi.fn(async () => "sent" as const);
const loadComposeFacts = vi.fn(async () => ({
  kind: "generic",
  fixedBody: "",
  eval: {},
  advanceLastReportSha: false,
  headSha: "",
}));
const composeScheduledOutbound = vi.fn(async () => "uwm-bootstrap-notify");

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
import {
  applyReminders,
  formatReminderApplyNotice,
} from "../src/services/reminder.service.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  fireDueReminders,
  setWebMonitorPollImplForTests,
} from "../src/services/reminder-fire.js";
import { pollWebMonitor } from "../src/services/semantic-web-monitor.service.js";
import { setUwmCreateBootstrapSearchImplForTests } from "../src/services/uwm-create-bootstrap.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const RUN = randomUUID().slice(0, 8);

// NODE_ENV is forced to development so fireDueReminders runs; suppress
// scheduleSoon side-effects that would race with frozen test clocks.
vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);

function fixtureSearch(title: string, url: string, eventAt: string) {
  return async () => ({
    text: `UWM_FIXTURE_ITEMS: ${JSON.stringify([
      {
        title,
        url,
        sourceUrls: [url],
        summary: title,
        locationText: "Madrid",
        eventAt,
        retrievalOk: true,
      },
    ])}\n\n`,
    sources: [url],
    usage: null,
    raw: null,
  });
}

describe(`UWM create-turn bootstrap ${RUN}`, () => {
  let account: HarnessAccount | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  afterEach(async () => {
    setUwmCreateBootstrapSearchImplForTests(null);
    setWebMonitorPollImplForTests(null);
    vi.clearAllMocks();
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  async function setupActor() {
    account = await createHarnessAccount("טל");
    await ensureLucy(account);
    const phone = `+1555${RUN.replace(/\D/g, "").padEnd(7, "0").slice(0, 7)}`;
    await prisma.employee.update({
      where: { id: account.employeeId },
      data: { phone },
    });
    await applyEmployeeRecords(
      account.employeeId,
      {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם משימה": `seed-boot-${RUN}` }],
            targets: [],
          },
        ],
      },
      {
        scope: "personal",
        addedById: account.employeeId,
        visibleTo: [account.employeeId],
      },
      account.employeeId,
    );
    const actorRow = await prisma.employee.findUniqueOrThrow({
      where: { id: account.employeeId },
    });
    return {
      actor: {
        id: actorRow.id,
        name: actorRow.name,
        surname: actorRow.surname,
        nickname: actorRow.nickname,
        email: null,
        phone: actorRow.phone,
        kind: actorRow.kind as "human" | "digital",
      },
    };
  }

  function watchPayload(item: string, minutesBefore = 60) {
    return {
      action: "add" as const,
      item,
      listType: "tasks" as const,
      date: "",
      time: "",
      repeat: "hourly",
      ping: ["טל"],
      about: [],
      targets: [],
      text: item,
      inSeconds: null,
      everyCount: 3,
      everyUnit: "hours" as const,
      weekdays: null,
      confirmed: false,
      compose: true,
      composeSource: "",
      composeLookbackHours: 0,
      composePlace: "",
      watchOnce: false,
      composeCondition: parseComposeCondition({
        type: "web_monitor",
        intent: "שעה לפני האירוע הבא",
        canonical_query: "Real Madrid next league match kickoff",
        constraints: { entities: ["Real Madrid"] },
        objectives: [
          { id: "d1", kind: "discover_new" },
          { id: "p1", kind: "time_before_event", minutes_before: minutesBefore },
        ],
        evidence_min: "observed",
      }),
      recurrence: { freq: "interval" as const, interval: 3, unit: "hours" as const },
      reminderId: "",
    };
  }

  it("Create → bootstrap arms nextPrecise; notice reflects DB; reschedule updates; single fire", async () => {
    const { actor } = await setupActor();
    const now = new Date("2026-06-01T12:00:00.000Z");
    const eventAt = "2026-06-01T17:00:00.000Z";
    const eventAtMoved = "2026-06-01T18:00:00.000Z";
    const url = `https://boot-${RUN}.example/m`;
    const item = `uwm-boot-arm-${RUN}`;

    setUwmCreateBootstrapSearchImplForTests(
      fixtureSearch("Real Madrid vs Opp", url, eventAt),
    );

    const applied = await applyReminders({
      userId: account!.userId,
      actor,
      employees: [actor],
      now,
      reminders: [
        watchPayload(item) as Parameters<typeof applyReminders>[0]["reminders"][number],
      ],
    });
    expect(applied.skipped).toEqual([]);
    expect(applied.saved).toHaveLength(1);
    const boot = applied.saved[0]!.uwmBootstrap;
    expect(boot?.armStatus).toBe("armed");
    expect(boot?.eventAtIso).toBe(eventAt);
    expect(boot?.preciseFireAtIso).toBe("2026-06-01T16:00:00.000Z");

    const notice = formatReminderApplyNotice(applied);
    expect(notice).toContain("שמרתי מעקב");
    // Jerusalem wall clock for 17:00Z / 16:00Z (UTC+3 in June)
    expect(notice).toMatch(/20:00|19:00|17:00|16:00/);
    expect(notice).toContain("אזכיר ב־");

    const row = await prisma.reminder.findFirstOrThrow({
      where: { userId: account!.userId, itemLabel: item },
    });
    const state = row.monitorState as {
      nextPrecise?: { fireAtIso: string; eventAtIso: string };
      items?: Record<string, unknown>;
    };
    expect(state.nextPrecise?.eventAtIso).toBe(eventAt);
    expect(state.nextPrecise?.fireAtIso).toBe("2026-06-01T16:00:00.000Z");
    expect(Object.keys(state.items ?? {}).length).toBeGreaterThan(0);

    // Reschedule via later poll (same Watch)
    setWebMonitorPollImplForTests(async (input) =>
      pollWebMonitor({
        ...input,
        now: new Date("2026-06-01T12:30:00.000Z"),
        skipExternalCache: true,
        searchImpl: fixtureSearch("Real Madrid vs Opp", url, eventAtMoved),
      }),
    );
    await prisma.reminder.update({
      where: { id: row.id },
      data: {
        fireAt: new Date("2026-06-01T12:29:00.000Z"),
        sendStatus: "pending",
        status: "active",
      },
    });
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date("2026-06-01T12:30:00.000Z"));
    const afterMove = await prisma.reminder.findUniqueOrThrow({
      where: { id: row.id },
    });
    const movedState = afterMove.monitorState as {
      nextPrecise?: { fireAtIso: string; eventAtIso: string };
    };
    expect(movedState.nextPrecise?.eventAtIso).toBe(eventAtMoved);
    expect(movedState.nextPrecise?.fireAtIso).toBe(
      "2026-06-01T17:00:00.000Z",
    );
    const count = await prisma.reminder.count({
      where: { userId: account!.userId, status: "active" },
    });
    expect(count).toBe(1);

    // Precise fire once at T−60 of moved event
    setWebMonitorPollImplForTests(async (input) =>
      pollWebMonitor({
        ...input,
        now: new Date("2026-06-01T17:00:00.000Z"),
        skipExternalCache: true,
        searchImpl: fixtureSearch("Real Madrid vs Opp", url, eventAtMoved),
      }),
    );
    await prisma.reminder.update({
      where: { id: row.id },
      data: {
        fireAt: new Date("2026-06-01T16:59:00.000Z"),
        sendStatus: "pending",
        status: "active",
      },
    });
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date("2026-06-01T17:00:00.000Z"));
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(1);
    const afterFire = await prisma.reminder.findUniqueOrThrow({
      where: { id: row.id },
    });
    const firedState = afterFire.monitorState as {
      items?: Record<string, { notified?: Record<string, string> }>;
      nextPrecise?: unknown;
    };
    const notifiedPhases = Object.values(firedState.items ?? {}).flatMap((it) =>
      Object.keys(it.notified ?? {}),
    );
    expect(notifiedPhases.some((p) => p.includes("pre:60"))).toBe(true);

    // Second fire same phase — no duplicate notify
    await prisma.reminder.update({
      where: { id: row.id },
      data: {
        fireAt: new Date("2026-06-01T17:01:00.000Z"),
        sendStatus: "pending",
        status: "active",
      },
    });
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date("2026-06-01T17:02:00.000Z"));
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(0);
  });

  it("poll failure keeps Watch and discovery cadence; no dated reminder claim", async () => {
    const { actor } = await setupActor();
    const item = `uwm-boot-fail-${RUN}`;
    const now = new Date("2026-06-01T12:00:00.000Z");
    setUwmCreateBootstrapSearchImplForTests(async () => {
      throw new Error("web_search_timeout");
    });
    const applied = await applyReminders({
      userId: account!.userId,
      actor,
      employees: [actor],
      now,
      reminders: [
        watchPayload(item) as Parameters<typeof applyReminders>[0]["reminders"][number],
      ],
    });
    expect(applied.saved).toHaveLength(1);
    expect(applied.saved[0]!.uwmBootstrap?.armStatus).toBe("poll_failed");
    const notice = formatReminderApplyNotice(applied);
    expect(notice).toContain("שמרתי מעקב");
    expect(notice).not.toMatch(/אזכיר ב־/);
    const row = await prisma.reminder.findFirstOrThrow({
      where: { userId: account!.userId, itemLabel: item },
    });
    expect(row.status).toBe("active");
    const state = row.monitorState as { lastErrorClass?: string | null };
    expect(state.lastErrorClass).toBe("api_fail");
  });

  it("too-late eventAt does not claim a future dated reminder", async () => {
    const { actor } = await setupActor();
    const item = `uwm-boot-late-${RUN}`;
    const now = new Date("2026-06-01T12:00:00.000Z");
    // Event already past T−60 + grace relative to now
    const pastEvent = "2026-06-01T08:00:00.000Z";
    setUwmCreateBootstrapSearchImplForTests(
      fixtureSearch(
        "Real Madrid Past Match",
        `https://boot-late-${RUN}.example/m`,
        pastEvent,
      ),
    );
    const applied = await applyReminders({
      userId: account!.userId,
      actor,
      employees: [actor],
      now,
      reminders: [
        watchPayload(item) as Parameters<typeof applyReminders>[0]["reminders"][number],
      ],
    });
    const boot = applied.saved[0]!.uwmBootstrap;
    expect(boot?.armStatus).toBe("too_late");
    expect(boot?.armStatus).not.toBe("armed");
    const notice = formatReminderApplyNotice(applied);
    expect(notice).not.toMatch(/אזכיר ב־/);
    // Prefer explicit too_late copy when eventAt is known
    expect(notice).toMatch(/כבר עבר|לא קבעתי תזכורת/);
  });

  it("suppressNotify: poll would notify but bootstrap returns shouldNotify false", async () => {
    const { actor } = await setupActor();
    const item = `uwm-boot-suppress-${RUN}`;
    const now = new Date("2026-06-01T12:00:00.000Z");
    const eventAt = "2026-06-01T17:00:00.000Z";
    setUwmCreateBootstrapSearchImplForTests(
      fixtureSearch(
        "Real Madrid Future Match",
        `https://boot-sup-${RUN}.example/m`,
        eventAt,
      ),
    );
    sendWhatsAppButtons.mockClear();
    await applyReminders({
      userId: account!.userId,
      actor,
      employees: [actor],
      now,
      reminders: [
        watchPayload(item) as Parameters<typeof applyReminders>[0]["reminders"][number],
      ],
    });
    expect(sendWhatsAppButtons).not.toHaveBeenCalled();
  });
});
