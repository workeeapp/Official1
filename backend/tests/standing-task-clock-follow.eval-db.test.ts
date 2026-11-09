/**
 * B1 — moving a standing task moves its linked repeating WhatsApp reminder on
 * the server, without asking (owner decision 2026-11-09). Real production
 * path: sendChatMessage with a scripted model (lists.update only) on
 * approved workee_test. No OpenAI / WhatsApp / reminder fire.
 *
 * Run: npm run test:eval-db -- tests/standing-task-clock-follow.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  firstOccurrence,
  formatJerusalemDateTime,
  legacyRepeatFor,
  parseRecurrence,
  serializeRecurrence,
  type Recurrence,
} from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { shapeItemRecurrence } from "../src/services/list-recurrence.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  stubLlmReply,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
});

const weekly = (weekdays: number[], time: string): Recurrence => ({ freq: "weekly", interval: 1, weekdays, time });

describe("B1: standing task moves → linked repeating reminder follows (server, no ask)", () => {
  let account: HarnessAccount | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (account) {
      await prisma.reminder.deleteMany({ where: { userId: account.userId } }).catch(() => undefined);
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  async function setup() {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);
    const list = await prisma.employeeList.create({
      data: {
        employeeId: account.employeeId,
        listType: "tasks",
        name: "",
        scope: "personal",
        visibleTo: [account.employeeId],
      },
      select: { id: true },
    });
    const taskId = randomUUID();
    const shaped = shapeItemRecurrence({ "שם משימה": "חוג שחייה", recurrence: weekly([1], "17:00") }).item;
    await prisma.employeeListItem.create({
      data: {
        id: taskId,
        listId: list.id,
        itemKey: `חוג שחייה-${taskId.slice(0, 8)}`,
        data: shaped as Prisma.InputJsonValue,
        scope: "personal",
        addedById: account.employeeId,
        visibleTo: [account.employeeId],
      },
    });
    const seedClock = async (rule: Recurrence, label: string) => {
      const id = randomUUID();
      await prisma.reminder.create({
        data: {
          id,
          userId: account!.userId,
          ownerId: account!.employeeId,
          actorId: account!.employeeId,
          itemKey: `${label}-${id.slice(0, 8)}`,
          itemLabel: label,
          listType: "tasks",
          fireAt: firstOccurrence(rule, new Date()),
          repeat: legacyRepeatFor(rule),
          recurrence: serializeRecurrence(rule) as Prisma.InputJsonValue,
          status: "active",
        },
      });
      await prisma.employeeListItemReminderLink.create({ data: { listItemId: taskId, reminderId: id } });
      return id;
    };
    /** One turn where the (scripted) model only updates the standing row. */
    const moveTask = async (recurrence: Recurrence) => {
      setLlmClientForTests(
        stubLlmReply({
          responses: [{ text: "עדכנתי את חוג השחייה.", buttons: [] }],
          metadata: {
            lists: [{ action: "update", list_type: "tasks", list_name: "", items: [{ item_id: taskId, recurrence }] }],
          },
        }),
      );
      return sendChatMessage({
        userId: account!.userId,
        employeeId: account!.employeeId,
        digitalEmployeeId: lucyId,
        message: "תזיזי את חוג השחייה",
      });
    };
    const clock = async (id: string) => {
      const row = await prisma.reminder.findUniqueOrThrow({ where: { id } });
      return { rule: parseRecurrence(row.recurrence), fireAt: row.fireAt, status: row.status, repeat: row.repeat };
    };
    return { taskId, seedClock, moveTask, clock };
  }

  it("Monday 17:00 → Wednesday 18:00: the 30-min-before clock becomes Wednesday 17:30; an unrelated daily clock stays", async () => {
    const t = await setup();
    const tracking = await t.seedClock(weekly([1], "16:30"), "חוג שחייה");
    const daily = await t.seedClock({ freq: "daily", interval: 1, time: "08:00" }, "לארוז תיק");
    const dailyBefore = await t.clock(daily);

    await t.moveTask(weekly([3], "18:00"));

    const moved = await t.clock(tracking);
    expect(moved.status).toBe("active");
    expect(moved.rule).toMatchObject({ freq: "weekly", weekdays: [3], time: "17:30" });
    const fire = formatJerusalemDateTime(moved.fireAt);
    expect(fire.slice(11)).toBe("17:30");
    expect(new Date(`${fire.slice(0, 10)}T12:00:00Z`).getUTCDay()).toBe(3);
    expect(moved.fireAt.getTime()).toBeGreaterThan(Date.now());
    expect(moved.repeat).toBe(legacyRepeatFor(moved.rule!));

    expect(await t.clock(daily), "a clock that does not track the series is untouched").toEqual(dailyBefore);
  });

  it("time-only move (same days) → the linked clock keeps its offset", async () => {
    const t = await setup();
    const tracking = await t.seedClock(weekly([1], "16:00"), "חוג שחייה");

    await t.moveTask(weekly([1], "19:00"));

    const moved = await t.clock(tracking);
    expect(moved.rule).toMatchObject({ weekdays: [1], time: "18:00" });
    expect(formatJerusalemDateTime(moved.fireAt).slice(11)).toBe("18:00");
  });

  it("an update that does not move the series (same days and time) leaves the clock exactly as it was", async () => {
    const t = await setup();
    const tracking = await t.seedClock(weekly([1], "16:30"), "חוג שחייה");
    const before = await t.clock(tracking);

    await t.moveTask(weekly([1], "17:00"));

    expect(await t.clock(tracking)).toEqual(before);
  });
});
