/**
 * Tasks dump isolation via production sendChatMessage (eval-db).
 *
 * Stubbed LLM only — proves engine routing / snapshot / REPLACE rendering.
 * Does NOT prove live-model prompt compliance for free-text «הצג מטלות».
 *
 * Run: npm run test:eval-db -- tests/tasks-dump-sendchat-e2e.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyLlmMetadata, parseLlmReply } from "@workee/shared";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import {
  applyEmployeeRecords,
} from "../src/services/employee-records.service.js";
import {
  isKnownShowButtonCommand,
  mapShowButtonCommandToDump,
} from "../src/services/show-button-dump.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const SPEAKER_TASK = "לסדר את המחסן-eval-dump";
const SPEAKER_TASK_2 = "להתקשר לרופא-eval-dump";
const LUCY_FOLLOWUP = "לבדוק עם טל אם קנית חלב-eval-dump";

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

async function seedSpeakerAndLucyTasks(
  account: HarnessAccount,
  lucyId: string,
): Promise<void> {
  await applyEmployeeRecords(
    account.employeeId,
    {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          targets: [],
          items: [
            { "שם מטלה": SPEAKER_TASK },
            { "שם מטלה": SPEAKER_TASK_2 },
          ],
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

  await applyEmployeeRecords(
    lucyId,
    {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          targets: [],
          items: [{ "שם מטלה": LUCY_FOLLOWUP }],
        },
      ],
    },
    {
      scope: "personal",
      addedById: account.employeeId,
      visibleTo: [account.employeeId, lucyId],
    },
    account.employeeId,
  );
}

describe("tasks dump sendChat E2E (eval-db, stubbed LLM)", () => {
  let account: HarnessAccount | null = null;
  let whatsappTextSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fireDueSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scheduleSoonSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  beforeEach(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  afterEach(async () => {
    setLlmClientForTests(null);
    whatsappTextSpy?.mockRestore();
    fireDueSpy?.mockRestore();
    scheduleSoonSpy?.mockRestore();
    whatsappTextSpy = null;
    fireDueSpy = null;
    scheduleSoonSpy = null;
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  it("free-text הצג מטלות + stubbed show_dump=tasks → speaker book, not Lucy follow-ups", async () => {
    // Free-text is NOT the opaque button command — model must emit show_dump.
    expect(mapShowButtonCommandToDump("הצג מטלות")).toBeNull();
    expect(isKnownShowButtonCommand("הצג מטלות")).toBe(false);

    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    await seedSpeakerAndLucyTasks(account, lucyId);

    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");

    // Stubbed model ACTION for free-text (does not prove live-model behavior).
    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "רגע, מציגה." }],
          metadata: {
            lists: [],
            show_dump: "tasks",
          },
        },
      ]),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "הצג מטלות",
    });

    expect(whatsappTextSpy).not.toHaveBeenCalled();
    expect(fireDueSpy).not.toHaveBeenCalled();
    expect(scheduleSoonSpy).not.toHaveBeenCalled();

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toContain(SPEAKER_TASK);
    expect(spoken).toContain(SPEAKER_TASK_2);
    expect(spoken).not.toContain(LUCY_FOLLOWUP);
    expect(spoken).not.toContain("רגע, מציגה");
  });

  it("הצג מטלות של לוסי after intervening Lucy message → worker follow-ups only", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    await seedSpeakerAndLucyTasks(account, lucyId);

    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");

    setLlmClientForTests(
      stubLlmQueue([
        // Turn 1: intervening automated Lucy bubble (no dump).
        {
          responses: [{ text: "קיבלתי, אעדכן אותך כשיהיה משהו." }],
          metadata: { lists: [] },
        },
        // Turn 2: model omits show_dump — engine synthesizes from opaque worker button.
        {
          responses: [{ text: "רגע" }],
          metadata: { lists: [] },
        },
      ]),
    );

    const intervening = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תודה",
    });
    expect(parseLlmReply(intervening.reply).response).toContain("קיבלתי");

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "הצג מטלות של לוסי",
    });

    expect(whatsappTextSpy).not.toHaveBeenCalled();
    expect(fireDueSpy).not.toHaveBeenCalled();
    expect(scheduleSoonSpy).not.toHaveBeenCalled();

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toContain(LUCY_FOLLOWUP);
    expect(spoken).not.toContain(SPEAKER_TASK);
    expect(spoken).not.toContain(SPEAKER_TASK_2);
    expect(spoken).not.toContain("רגע");
  });
});
