/**
 * Regression: bare «הפסיקי» after a milk ping must cancel the milk series,
 * even when the model mistakenly removes a SOLT market watch.
 *
 * Run: npm run test:eval-db -- tests/stop-series-after-ping.eval-db.test.ts
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

describe("stop-series-after-ping (eval-db)", () => {
  let account: HarnessAccount | undefined;

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

  it("הפסיקי after milk ping cancels milk, not SOLT watch", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();

    const milk = await prisma.reminder.create({
      data: {
        userId: account.userId,
        ownerId: account.employeeId,
        actorId: lucyId,
        itemKey: "לשתות חלב",
        itemLabel: "לשתות חלב",
        listType: "tasks",
        fireAt: new Date(Date.now() + 30 * 60_000),
        repeat: "30:minutes",
        recurrence: { freq: "interval", interval: 30, unit: "minutes" },
        pingIds: [account.employeeId],
        messageText: "לשתות חלב",
        status: "active",
        sendStatus: "sent",
        sentAt: new Date(),
        lastComposedText: "תזכורת: לשתות חלב",
      },
    });
    const solt = await prisma.reminder.create({
      data: {
        userId: account.userId,
        ownerId: lucyId,
        actorId: lucyId,
        itemKey: "עדכון אם SOLT מגיע ל־20",
        itemLabel: "עדכון אם SOLT מגיע ל־20",
        listType: "tasks",
        fireAt: new Date(Date.now() + 5 * 60_000),
        repeat: "5:minutes",
        recurrence: { freq: "interval", interval: 5, unit: "minutes" },
        pingIds: [account.employeeId],
        messageText: "SOLT",
        status: "active",
        composeAtFire: true,
        composeSource: "market",
        composePlace: "SOLT",
        composeCondition: {
          type: "market_price",
          op: "eq",
          value: 20,
        },
        watchOnce: true,
      },
    });

    // Model wrongly cancels the SOLT watch and claims that in prose.
    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [
            {
              text: "הפסקתי את ההתראה על עדכון אם SOLT מגיע ל־20.",
            },
          ],
          metadata: {
            reminders: [
              {
                action: "remove",
                reminder_id: solt.id,
                item: "עדכון אם SOLT מגיע ל־20",
              },
            ],
          },
        },
      ]),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "הפסיקי",
    });

    const milkAfter = await prisma.reminder.findUnique({
      where: { id: milk.id },
      select: { status: true },
    });
    const soltAfter = await prisma.reminder.findUnique({
      where: { id: solt.id },
      select: { status: true },
    });
    expect(milkAfter?.status).toBe("cancelled");
    expect(soltAfter?.status).toBe("active");

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/לשתות חלב/);
    expect(spoken).not.toMatch(/SOLT/i);
  }, 30000);
});
