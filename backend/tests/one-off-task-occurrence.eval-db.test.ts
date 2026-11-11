/**
 * One-off timed task identity + post-save reminder offer.
 * Real path: sendChatMessage + persisted rows on workee_test. Stubbed model.
 *
 * Run: npm run test:eval-db -- tests/one-off-task-occurrence.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { formatJerusalemDateTime, parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { getEmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import { POST_SAVE_REMINDER_OFFER_TEXT } from "../src/services/post-save-reminder-offer.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

function stubLlmQueue(payloads: unknown[]) {
  let i = 0;
  return {
    async createConversation() {
      return `conv-${randomUUID()}`;
    },
    async createResponse() {
      const payload = payloads[Math.min(i, payloads.length - 1)]!;
      i += 1;
      return { reply: JSON.stringify(payload), raw: {} };
    },
  };
}

function silenceOutbound() {
  vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent");
  vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent");
  vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
}

async function ownedTasks(employeeId: string) {
  return prisma.employeeListItem.findMany({
    where: {
      deletedAt: null,
      list: { employeeId, listType: "tasks" },
    },
    select: { id: true, data: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: "asc" },
  });
}

function rowTitle(row: { data: unknown }): string {
  const data =
    row.data && typeof row.data === "object" && !Array.isArray(row.data)
      ? (row.data as Record<string, unknown>)
      : {};
  return typeof data["שם משימה"] === "string" ? data["שם משימה"].trim() : "";
}

function rowYmd(row: { data: unknown }): string {
  const data =
    row.data && typeof row.data === "object" && !Array.isArray(row.data)
      ? (row.data as Record<string, unknown>)
      : {};
  return typeof data["תאריך לביצוע"] === "string"
    ? data["תאריך לביצוע"].trim()
    : "";
}

function rowTime(row: { data: unknown }): string {
  const data =
    row.data && typeof row.data === "object" && !Array.isArray(row.data)
      ? (row.data as Record<string, unknown>)
      : {};
  return typeof data["שעה לביצוע"] === "string"
    ? data["שעה לביצוע"].trim()
    : "";
}

function hasSoftOffer(reply: string): boolean {
  const bubbles = parseLlmReply(reply).responseBubbles;
  return bubbles.some((bubble) => {
    const buttons = bubble.buttons ?? [];
    const yes = buttons.some((b) => b.label === "כן" && b.command === "כן");
    const no = buttons.some((b) => b.label === "לא" && b.command === "לא");
    return yes && no;
  });
}

describe("one-off timed task identity (eval-db)", () => {
  let account: HarnessAccount | undefined;
  const tomorrow = formatJerusalemDateTime(
    new Date(Date.now() + 24 * 3600_000),
  ).slice(0, 10);
  const nextWeek = formatJerusalemDateTime(
    new Date(Date.now() + 7 * 24 * 3600_000),
  ).slice(0, 10);
  const yesterday = formatJerusalemDateTime(
    new Date(Date.now() - 24 * 3600_000),
  ).slice(0, 10);

  beforeAll(() => {
    assertEvalDbAndGtfsUntouched();
  });

  afterEach(async () => {
    setLlmClientForTests(null);
    vi.restoreAllMocks();
    if (account) {
      await cleanupHarnessAccount(account);
      account = undefined;
    }
  });

  it("1) past one-off + future date → add new row; soft reminder offer", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const list = await prisma.employeeList.create({
      data: {
        employeeId: account.employeeId,
        listType: "tasks",
        name: "",
      },
    });
    const past = await prisma.employeeListItem.create({
      data: {
        listId: list.id,
        itemKey: "משימה לדוגמה",
        data: {
          "שם משימה": "משימה לדוגמה",
          "תאריך לביצוע": yesterday,
          "שעה לביצוע": "10:00",
        },
        scope: "personal",
        addedById: account.employeeId,
        visibleTo: [account.employeeId],
      },
    });

    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "עדכנתי את המשימה." }],
          metadata: {
            lists: [
              {
                action: "update",
                list_type: "tasks",
                list_name: "",
                items: [
                  {
                    item_id: past.id,
                    "שם משימה": "משימה לדוגמה",
                    "תאריך לביצוע": tomorrow,
                    "שעה לביצוע": "13:30",
                  },
                ],
              },
            ],
          },
        },
      ]),
    );

    const saved = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: `${tomorrow} שעה 1330 משימה לדוגמה`,
    });

    const rows = await ownedTasks(account.employeeId);
    expect(rows).toHaveLength(2);
    const pastRow = rows.find((row) => row.id === past.id)!;
    expect(rowYmd(pastRow)).toBe(yesterday);
    expect(rowTime(pastRow)).toBe("10:00");
    const neu = rows.find((row) => row.id !== past.id)!;
    expect(rowTitle(neu)).toBe("משימה לדוגמה");
    expect(rowYmd(neu)).toBe(tomorrow);
    expect(rowTime(neu)).toBe("13:30");
    expect(hasSoftOffer(saved.reply)).toBe(true);
    expect(
      parseLlmReply(saved.reply).responseBubbles.some((bubble) =>
        (bubble.text ?? "").includes(POST_SAVE_REMINDER_OFFER_TEXT),
      ),
    ).toBe(true);
  }, 30000);

  it("2) upcoming one-off + different day without move verbs → ASK; no mutate", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const list = await prisma.employeeList.create({
      data: {
        employeeId: account.employeeId,
        listType: "tasks",
        name: "",
      },
    });
    const existing = await prisma.employeeListItem.create({
      data: {
        listId: list.id,
        itemKey: "משימה לדוגמה",
        data: {
          "שם משימה": "משימה לדוגמה",
          "תאריך לביצוע": tomorrow,
          "שעה לביצוע": "09:00",
        },
        scope: "personal",
        addedById: account.employeeId,
        visibleTo: [account.employeeId],
      },
    });

    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [
            {
              text: "להוסיף מופע חדש או לעדכן את הקיים?",
              buttons: [
                { label: "חדש", command: "חדש" },
                { label: "לעדכן", command: "לעדכן" },
              ],
            },
          ],
          metadata: { lists: [] },
        },
      ]),
    );

    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: `${nextWeek} שעה 09:00 משימה לדוגמה`,
    });

    const rows = await ownedTasks(account.employeeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(existing.id);
    expect(rowYmd(rows[0]!)).toBe(tomorrow);
  }, 30000);

  it("3) explicit move → update existing", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const list = await prisma.employeeList.create({
      data: {
        employeeId: account.employeeId,
        listType: "tasks",
        name: "",
      },
    });
    const existing = await prisma.employeeListItem.create({
      data: {
        listId: list.id,
        itemKey: "משימה לדוגמה",
        data: {
          "שם משימה": "משימה לדוגמה",
          "תאריך לביצוע": tomorrow,
          "שעה לביצוע": "09:00",
        },
        scope: "personal",
        addedById: account.employeeId,
        visibleTo: [account.employeeId],
      },
    });

    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "הזזתי את המועד." }],
          metadata: {
            lists: [
              {
                action: "update",
                list_type: "tasks",
                list_name: "",
                items: [
                  {
                    item_id: existing.id,
                    "תאריך לביצוע": nextWeek,
                    "שעה לביצוע": "11:00",
                  },
                ],
              },
            ],
          },
        },
      ]),
    );

    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: `תזיזי את המשימה לדוגמה ל־${nextWeek} ב־11:00`,
    });

    const rows = await ownedTasks(account.employeeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(existing.id);
    expect(rowYmd(rows[0]!)).toBe(nextWeek);
    expect(rowTime(rows[0]!)).toBe("11:00");
  }, 30000);

  it("4) timed add without reminder → soft offer injected", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();

    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "הוספתי למשימות." }],
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                items: [
                  {
                    "שם משימה": "משימה לדוגמה",
                    "תאריך לביצוע": tomorrow,
                    "שעה לביצוע": "10:00",
                  },
                ],
              },
            ],
          },
        },
      ]),
    );

    const saved = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: `משימה לדוגמה מחר ב־10:00`,
    });

    const rows = await ownedTasks(account.employeeId);
    expect(rows.map(rowTitle)).toEqual(["משימה לדוגמה"]);
    expect(hasSoftOffer(saved.reply)).toBe(true);
    const snap = await getEmployeeRecordSnapshot(account.employeeId);
    expect(snap.reminders?.length ?? 0).toBe(0);
  }, 30000);

  it("5b) explicit move of a PAST one-off → update same row (not add)", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const list = await prisma.employeeList.create({
      data: {
        employeeId: account.employeeId,
        listType: "tasks",
        name: "",
      },
    });
    const past = await prisma.employeeListItem.create({
      data: {
        listId: list.id,
        itemKey: "משימה לדוגמה",
        data: {
          "שם משימה": "משימה לדוגמה",
          "תאריך לביצוע": yesterday,
          "שעה לביצוע": "10:00",
        },
        scope: "personal",
        addedById: account.employeeId,
        visibleTo: [account.employeeId],
      },
    });

    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "הזזתי את המועד." }],
          metadata: {
            lists: [
              {
                action: "update",
                list_type: "tasks",
                list_name: "",
                items: [
                  {
                    item_id: past.id,
                    "תאריך לביצוע": tomorrow,
                    "שעה לביצוע": "13:30",
                  },
                ],
              },
            ],
          },
        },
      ]),
    );

    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: `תזיזי את המשימה לדוגמה ל־${tomorrow} ב־13:30`,
    });

    const rows = await ownedTasks(account.employeeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(past.id);
    expect(rowYmd(rows[0]!)).toBe(tomorrow);
    expect(rowTime(rows[0]!)).toBe("13:30");
  }, 30000);

  it("5) explicit reminder same turn → no soft offer bubble", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();

    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "שמרתי עם תזכורת." }],
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                items: [
                  {
                    "שם משימה": "משימה לדוגמה",
                    "תאריך לביצוע": tomorrow,
                    "שעה לביצוע": "10:00",
                    remind: {
                      date: tomorrow,
                      time: "09:00",
                      ping: ["טל"],
                      text: "משימה לדוגמה",
                    },
                  },
                ],
              },
            ],
          },
        },
      ]),
    );

    const saved = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: `משימה לדוגמה מחר ב־10:00 תזכירי לי ב־09:00`,
    });

    expect(hasSoftOffer(saved.reply)).toBe(false);
    const rows = await ownedTasks(account.employeeId);
    expect(rows).toHaveLength(1);
  }, 30000);
});
