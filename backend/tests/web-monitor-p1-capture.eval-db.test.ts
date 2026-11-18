/**
 * UWM Phase 1 — capture/persist web_monitor on workee_test (:5436).
 * Engine path (no live model). Real-model coverage is in
 * web-monitor-p1-model.live-sendchat.eval-db.test.ts
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseComposeCondition } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { evaluateComposeCondition } from "../src/services/compose-condition.js";
import { applyReminders } from "../src/services/reminder.service.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

describe("UWM Phase 1 web_monitor capture (eval-db)", () => {
  let account: HarnessAccount | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
    const url = new URL(process.env.DATABASE_URL!);
    expect(url.port).toBe("5436");
    expect(url.pathname.endsWith("/workee_test")).toBe(true);
  });

  afterEach(async () => {
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

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
      everyCount: 3,
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

  it("persists multi-objective web_monitor + monitorState shell", async () => {
    account = await createHarnessAccount("טל");
    const actorRow = await prisma.employee.findUniqueOrThrow({
      where: { id: account.employeeId },
    });
    const actor = actorFrom(actorRow);
    const condition = parseComposeCondition({
      type: "web_monitor",
      intent: "גילוי הופעות + שינוי מועד",
      canonical_query: "שלמה ארצי הופעות",
      objectives: [
        { id: "o_discover", kind: "discover_new" },
        {
          id: "o_change",
          kind: "detect_change",
          change_aspects: ["eventAt"],
        },
      ],
    });
    expect(condition?.type).toBe("web_monitor");

    const result = await applyReminders({
      userId: account.userId,
      actor,
      employees: [actor],
      reminders: [
        baseReminder({
          item: "מעקב הופעות ארצי",
          text: "מעקב הופעות",
          composeCondition: condition,
          recurrence: {
            freq: "interval",
            interval: 3,
            unit: "hours",
          },
        }),
      ],
    });
    expect(result.saved.length).toBeGreaterThan(0);

    const row = await prisma.reminder.findFirst({
      where: { userId: account.userId, status: "active" },
      orderBy: { createdAt: "desc" },
    });
    expect(row).toBeTruthy();
    const stored = parseComposeCondition(row!.composeCondition);
    expect(stored?.type).toBe("web_monitor");
    if (stored?.type === "web_monitor") {
      expect(stored.objectives).toHaveLength(2);
      expect(stored.objectives.map((o) => o.kind).sort()).toEqual([
        "detect_change",
        "discover_new",
      ]);
    }
    expect(row!.watchOnce).toBe(false);
    expect(row!.onTriggerActions).toBeNull();
    expect(row!.monitorState).toMatchObject({ version: 1, items: {} });

    const gate = evaluateComposeCondition({
      condition: stored!,
      facts: {},
    });
    expect(gate.skipSend).toBe(true);
  });

  it("does not invent on_trigger_actions for notify-only web_monitor", async () => {
    account = await createHarnessAccount("טל");
    const actorRow = await prisma.employee.findUniqueOrThrow({
      where: { id: account.employeeId },
    });
    const actor = actorFrom(actorRow);
    const condition = parseComposeCondition({
      type: "web_monitor",
      intent: "שעה לפני משחק",
      canonical_query: "Real Madrid league match",
      objectives: [
        { id: "o_pre", kind: "time_before_event", minutes_before: 60 },
        { id: "o_new", kind: "discover_new" },
      ],
    });
    await applyReminders({
      userId: account.userId,
      actor,
      employees: [actor],
      reminders: [
        baseReminder({
          item: "ריאל מדריד",
          composeCondition: condition,
          recurrence: { freq: "interval", interval: 3, unit: "hours" },
        }),
      ],
    });
    const row = await prisma.reminder.findFirst({
      where: { userId: account.userId, status: "active" },
    });
    expect(row?.onTriggerActions).toBeNull();
  });

  it("typed market_price watch still persists (no regression)", async () => {
    account = await createHarnessAccount("טל");
    const actorRow = await prisma.employee.findUniqueOrThrow({
      where: { id: account.employeeId },
    });
    const actor = actorFrom(actorRow);
    await applyReminders({
      userId: account.userId,
      actor,
      employees: [actor],
      reminders: [
        baseReminder({
          item: "שער הדולר",
          composeSource: "market",
          composePlace: "דולר",
          composeCondition: { type: "market_price", op: "gt", value: 3.5 },
          watchOnce: true,
          everyCount: 5,
          everyUnit: "minutes",
          recurrence: { freq: "interval", interval: 5, unit: "minutes" },
        }),
      ],
    });
    const row = await prisma.reminder.findFirst({
      where: { userId: account.userId, status: "active" },
    });
    const stored = parseComposeCondition(row!.composeCondition);
    expect(stored?.type).toBe("market_price");
    expect(row!.monitorState).toBeNull();
  });
});
