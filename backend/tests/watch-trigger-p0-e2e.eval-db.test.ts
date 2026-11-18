/**
 * P0 Watch→Action E2E on workee_test (:5436):
 * applyReminders (capture package) → fireDueReminders (condition match with
 * controlled compose facts) → applyEmployeeRecords → independent WhatsApp ledger.
 *
 * LIVE :5435 never touched.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";

assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
expect(new URL(process.env.DATABASE_URL!).port).toBe("5436");

const sendWhatsAppButtons = vi.fn(async () => "sent" as const);
const loadComposeFacts = vi.fn();
const composeScheduledOutbound = vi.fn(async () => "המחיר ירד מתחת לסף");

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
    }),
  };
});

import { emptyLlmMetadata } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { applyEmployeeRecords } from "../src/services/employee-records.service.js";
import { applyReminders } from "../src/services/reminder.service.js";
import { fireDueReminders } from "../src/services/reminder-fire.js";
import {
  parseWatchTriggerExecLedger,
  parseWatchTriggerPackage,
} from "../src/services/watch-trigger-actions.service.js";

const RUN = randomUUID().slice(0, 8);

describe(`watch-trigger-p0-e2e (eval-db :5436) ${RUN}`, () => {
  let userId = "";
  let ownerId = "";
  let lucyId = "";
  let listId = "";
  let phone = "";

  beforeAll(async () => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    expect(new URL(process.env.DATABASE_URL!).port).toBe("5436");
    phone = `+1556${RUN.slice(0, 7)}`;

    const user = await prisma.user.create({
      data: { username: `wt_e2e_${RUN}` },
    });
    userId = user.id;
    const team = await prisma.team.create({
      data: { userId: user.id, name: `wt_e2e_${RUN}` },
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
    if (!userId) {
      return;
    }
    await prisma.deliveryAttempt.deleteMany({ where: { userId } }).catch(() => null);
    await prisma.reminder.deleteMany({ where: { userId } });
    await prisma.employeeListItem.deleteMany({
      where: { list: { employeeId: ownerId } },
    });
    await prisma.employeeList.deleteMany({ where: { employeeId: ownerId } });
    await prisma.chatMessage.deleteMany({
      where: { conversation: { userId } },
    }).catch(() => null);
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
      nickname: null,
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
      protected: true,
    };
  }

  it("E2E: capture → fire condition → list add → notify ledger independent", async () => {
    const itemLabel = `e2e-watch-${RUN}`;
    const productTitle = `מוצר-e2e-${RUN}`;

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
          text: "כשהמחיר יורד",
          inSeconds: null,
          everyCount: 1,
          everyUnit: "hours",
          weekdays: null,
          confirmed: false,
          compose: true,
          composeSource: "market",
          composeLookbackHours: 0,
          composePlace: "E2E.TICKER",
          composeCondition: {
            type: "market_price",
            op: "lt",
            value: 100,
          },
          watchOnce: false,
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
        },
      ],
    });
    expect(applied.skipped).toEqual([]);
    const row = await prisma.reminder.findFirst({
      where: { userId, itemLabel },
    });
    expect(row).toBeTruthy();
    expect(parseWatchTriggerPackage(row!.onTriggerActions)?.actions).toHaveLength(
      1,
    );

    await prisma.reminder.update({
      where: { id: row!.id },
      data: {
        fireAt: new Date(Date.now() - 120_000),
        lastReportSha: "market:above",
        sendStatus: "pending",
        status: "active",
      },
    });

    loadComposeFacts.mockResolvedValue({
      kind: "market",
      fixedBody: "E2E.TICKER = 90",
      eval: { marketPrice: 90 },
      advanceLastReportSha: false,
      headSha: "",
    });
    sendWhatsAppButtons.mockClear();

    const before = await prisma.employeeListItem.count({
      where: { listId, deletedAt: null },
    });
    await fireDueReminders(new Date());

    const after = await prisma.employeeListItem.findMany({
      where: { listId, deletedAt: null },
      select: { data: true },
    });
    const added = after.filter(
      (r) => String((r.data as Record<string, unknown>)["שם פריט"] ?? "") === productTitle,
    );
    expect(added.length).toBe(1);
    expect(after.length).toBe(before + 1);
    expect(sendWhatsAppButtons).toHaveBeenCalled();

    const fired = await prisma.reminder.findUniqueOrThrow({
      where: { id: row!.id },
    });
    const ledger = parseWatchTriggerExecLedger(fired.onTriggerExec);
    const fps = Object.keys(ledger.events);
    expect(fps.length).toBeGreaterThanOrEqual(1);
    const event = ledger.events[fps[0]!]!;
    expect(
      Object.values(event.actions).every((s) => s.status === "done"),
    ).toBe(true);
    expect(event.notified).toBe(true);

    // Second fire with same holding state must not duplicate the item.
    await prisma.reminder.update({
      where: { id: row!.id },
      data: {
        fireAt: new Date(Date.now() - 60_000),
        sendStatus: "pending",
        status: "active",
      },
    });
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date());
    const afterRetry = await prisma.employeeListItem.findMany({
      where: { listId, deletedAt: null },
      select: { data: true },
    });
    expect(
      afterRetry.filter(
        (r) =>
          String((r.data as Record<string, unknown>)["שם פריט"] ?? "") ===
          productTitle,
      ).length,
    ).toBe(1);
  });

  it("package edit preserves incomplete older event ledger entries", async () => {
    const itemLabel = `e2e-edit-${RUN}`;
    const created = await applyReminders({
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
          text: "watch",
          inSeconds: null,
          everyCount: 1,
          everyUnit: "hours",
          weekdays: null,
          confirmed: false,
          compose: true,
          composeSource: "market",
          composeLookbackHours: 0,
          composePlace: "EDIT.TICKER",
          composeCondition: {
            type: "market_price",
            op: "lt",
            value: 80,
          },
          watchOnce: false,
          onTriggerActions: {
            lists: [
              {
                action: "add",
                listType: "shopping",
                listName: "",
                listId,
                items: [{ "שם פריט": `ישן-${RUN}` }],
                targets: [],
                mode: "static",
              },
            ],
          },
          reminderId: "",
        },
      ],
    });
    const row = await prisma.reminder.findFirstOrThrow({
      where: { userId, itemLabel },
    });
    const pkg = parseWatchTriggerPackage(row.onTriggerActions)!;
    const incompleteLedger = {
      version: 1 as const,
      events: {
        "fp-old-incomplete": {
          firstSeenAt: new Date().toISOString(),
          notified: false as boolean | null,
          actions: {
            [pkg.actions[0]!.key]: {
              status: "failed" as const,
              attempts: 1,
              lastError: "boom",
            },
          },
        },
      },
    };
    await prisma.reminder.update({
      where: { id: row.id },
      data: { onTriggerExec: incompleteLedger },
    });

    await applyReminders({
      userId,
      actor: actor(),
      employees: [actor(), lucy()],
      reminders: [
        {
          action: "update",
          item: itemLabel,
          listType: "tasks",
          date: "",
          time: "",
          repeat: "hourly",
          ping: ["טל"],
          about: [],
          targets: [],
          text: "watch updated",
          inSeconds: null,
          everyCount: 1,
          everyUnit: "hours",
          weekdays: null,
          confirmed: false,
          compose: true,
          composeSource: "market",
          composeLookbackHours: 0,
          composePlace: "EDIT.TICKER",
          composeCondition: {
            type: "market_price",
            op: "lt",
            value: 70,
          },
          watchOnce: false,
          onTriggerActions: {
            lists: [
              {
                action: "add",
                listType: "shopping",
                listName: "",
                listId,
                items: [{ "שם פריט": `חדש-${RUN}` }],
                targets: [],
                mode: "static",
              },
            ],
          },
          reminderId: row.id,
        },
      ],
    });
    void created;

    const updated = await prisma.reminder.findUniqueOrThrow({
      where: { id: row.id },
    });
    const ledger = parseWatchTriggerExecLedger(updated.onTriggerExec);
    expect(ledger.events["fp-old-incomplete"]).toBeTruthy();
    expect(
      ledger.events["fp-old-incomplete"]!.actions[pkg.actions[0]!.key]!.status,
    ).toBe("failed");
    const newPkg = parseWatchTriggerPackage(updated.onTriggerActions)!;
    expect(newPkg.actions[0]!.list.items[0]!["שם פריט"]).toBe(`חדש-${RUN}`);
  });
});
