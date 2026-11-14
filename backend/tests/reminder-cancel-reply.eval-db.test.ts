/**
 * A successful reminder cancel keeps the model's confirmation.
 * The clock id is the applied remove; the label in `removed` is not a second item.
 *
 * Run: npm run test:eval-db -- tests/reminder-cancel-reply.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const CONFIRM = "הפסקתי את התזכורת היומית לשתות מים.";
const UNKNOWN_CAUTION_RE = /לא הצלחתי לאמת את כל הפעולות —/;

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
  vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
  vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
  vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
  vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);
}

function removePayload(
  rows: Array<{ id: string; item: string }>,
  text: string,
) {
  return {
    responses: [{ text }],
    metadata: {
      lists: [],
      reminders: rows.map((row) => ({
        action: "remove",
        reminder_id: row.id,
        item: row.item,
        list_type: "shopping",
      })),
    },
  };
}

describe("reminder cancel reply follows the applied clock", () => {
  let account: HarnessAccount | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  async function seedClock(label: string) {
    return prisma.reminder.create({
      data: {
        userId: account!.userId,
        ownerId: account!.employeeId,
        actorId: account!.employeeId,
        itemKey: `${label}-${randomUUID().slice(0, 8)}`,
        itemLabel: label,
        listType: "tasks",
        fireAt: new Date(Date.now() + 60 * 60 * 1000),
        repeat: "1:days",
        pingIds: [account!.employeeId],
        messageText: label,
        status: "active",
      },
    });
  }

  it("keeps the confirmation after the clock is cancelled", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const clock = await seedClock("לשתות מים");
    setLlmClientForTests(
      stubLlmQueue([
        removePayload([{ id: clock.id, item: "לשתות מים" }], CONFIRM),
      ]),
    );

    const sent = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תפסיקי להזכיר לי את זה",
    });

    const row = await prisma.reminder.findUnique({
      where: { id: clock.id },
      select: { status: true },
    });
    expect(row?.status).toBe("cancelled");
    expect(parseLlmReply(sent.reply).response).toBe(CONFIRM);
    expect(sent.reply).not.toContain("הסרתי 2");
    expect(sent.reply).not.toMatch(UNKNOWN_CAUTION_RE);
  }, 30000);

  it("a real miss stays a partial failure and cancels only the clock that existed", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const water = await seedClock("לשתות מים");
    const dog = await seedClock("להוריד את הכלב");
    const missingId = "99999999-8888-4777-8666-555555555555";
    setLlmClientForTests(
      stubLlmQueue([
        removePayload(
          [
            { id: water.id, item: "לשתות מים" },
            { id: missingId, item: "להוריד את הכלב" },
          ],
          "הפסקתי את שתי התזכורות.",
        ),
      ]),
    );

    const sent = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תפסיקי את שתי התזכורות",
    });

    const rows = await prisma.reminder.findMany({
      where: { id: { in: [water.id, dog.id] } },
      select: { id: true, status: true },
    });
    expect(rows.find((row) => row.id === water.id)?.status).toBe("cancelled");
    expect(rows.find((row) => row.id === dog.id)?.status).toBe("active");
    expect(sent.reply).toContain("לשתות מים");
    expect(sent.reply).toContain("לא מצאתי את הפריט ברשימה.");
    expect(sent.reply).not.toContain("הסרתי 2");
    expect(sent.reply).not.toMatch(UNKNOWN_CAUTION_RE);
    expect(sent.reply).not.toContain("שתי התזכורות");
  }, 30000);
});
