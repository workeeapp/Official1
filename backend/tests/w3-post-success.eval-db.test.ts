/**
 * W3 Post-Success — production-path eval-db (Stateless Intelligence).
 * Facts-only change: ACTIVE_THREAD guides natural promotion when a live
 * business thread exists; no LAST_APPLY / Goal State.
 *
 * E1–E8 via sendChatMessage. Stub LLM asserts wire + contract in facts;
 * natural promotion wording is checked in liveFacts the model receives.
 *
 * Run:
 *   npm run test:eval-db -- tests/w3-post-success.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/database/prisma.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  CONVERSATION_IDLE_MS,
  sendChatMessage,
} from "../src/services/chat.service.js";
import { JOB_META_KEY, type JobMeta } from "../src/services/job-meta.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { resetPieArbitrationStateForTests } from "../src/services/pie-arbitration.js";
import * as tipsService from "../src/services/tips.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";

const harnesses: HarnessAccount[] = [];

function stubLlm(
  payload: unknown,
  sink?: { facts: string; calls: number; messages: string[] },
) {
  setLlmClientForTests({
    async createConversation() {
      return `conv-${randomUUID()}`;
    },
    async createResponse(input) {
      if (sink) {
        sink.facts = input.liveFacts ?? "";
        sink.calls += 1;
        sink.messages.push(input.message);
      }
      return { reply: JSON.stringify(payload), raw: {} };
    },
  });
}

async function openMember(): Promise<{
  account: HarnessAccount;
  digitalEmployeeId: string;
}> {
  const account = await createHarnessAccount("טל", { digitalWorker: true });
  harnesses.push(account);
  await prisma.user.update({
    where: { id: account.userId },
    data: { consentPending: false },
  });
  return { account, digitalEmployeeId: account.digitalEmployeeId! };
}

async function seedJob(input: {
  digitalEmployeeId: string;
  speakerId: string;
  speakerName: string;
  metaExtra?: Partial<JobMeta>;
  id?: string;
}): Promise<string> {
  let list = await prisma.employeeList.findFirst({
    where: {
      employeeId: input.digitalEmployeeId,
      listType: "tasks",
      name: "",
      deletedAt: null,
    },
  });
  if (!list) {
    list = await prisma.employeeList.create({
      data: {
        employeeId: input.digitalEmployeeId,
        listType: "tasks",
        name: "",
      },
    });
  }
  const ask = input.metaExtra?.ask ?? "קנית חלב?";
  const label = `לבדוק עם ${input.speakerName}: ${ask}`;
  const meta: JobMeta = {
    kind: "job",
    askerId: input.speakerId,
    askerName: input.speakerName,
    subjectId: input.speakerId,
    subjectName: input.speakerName,
    ask,
    state: "open",
    createdAt: new Date().toISOString(),
    ...input.metaExtra,
  };
  const row = await prisma.employeeListItem.create({
    data: {
      listId: list.id,
      itemKey: `${label}-${randomUUID().slice(0, 8)}`,
      data: {
        "שם משימה": label,
        [JOB_META_KEY]: meta,
      },
      scope: "shared",
      addedById: input.speakerId,
      visibleTo: [input.speakerId],
    },
  });
  return row.id;
}

/** Simulate 40m idle rotation without exporting rotateConversation. */
async function simulateIdleRotate(input: {
  userId: string;
  employeeId: string;
  digitalEmployeeId: string;
}): Promise<void> {
  const conv = await prisma.chatConversation.findUnique({
    where: {
      userId_employeeId_digitalEmployeeId: {
        userId: input.userId,
        employeeId: input.employeeId,
        digitalEmployeeId: input.digitalEmployeeId,
      },
    },
  });
  if (!conv) return;
  const stale = new Date(Date.now() - CONVERSATION_IDLE_MS - 60_000);
  await prisma.chatMessage.updateMany({
    where: { conversationId: conv.id },
    data: { createdAt: stale },
  });
  await prisma.chatConversation.update({
    where: { id: conv.id },
    data: { updatedAt: stale },
  });
}

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
});

beforeEach(() => {
  resetPieArbitrationStateForTests();
  vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
  vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
  vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
  vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);
});

afterAll(async () => {
  setLlmClientForTests(null);
  vi.restoreAllMocks();
  while (harnesses.length > 0) {
    const account = harnesses.pop();
    if (account) await destroyHarnessAccount(account);
  }
});

function expectW3PromotionContract(facts: string) {
  expect(facts).toMatch(/ACTIVE_THREAD/);
  expect(facts).toMatch(/W3 AFTER A SUCCESSFUL UNRELATED MUTATE/);
  expect(facts).toMatch(/prefer that step over a generic tip/);
  expect(facts).toMatch(/Not a mechanical duty/);
  expect(facts).toMatch(/FORBIDDEN forcing this thread/);
}

describe("W3 Post-Success (eval-db)", () => {
  it(
    "E1: success + open raisable job → W3 AT contract + tip hold",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
      });
      const tipSpy = vi
        .spyOn(tipsService, "resolveAndRecordTipsForTurn")
        .mockResolvedValue({ texts: [], tipIds: [], tipKeys: [] });
      const sink = { facts: "", calls: 0, messages: [] as string[] };
      stubLlm(
        {
          responses: [
            { text: "שמרתי חלב.", buttons: [] },
            { text: "רגע — קנית חלב כמו שביקשת לבדוק?", buttons: [] },
          ],
          metadata: {
            lists: [
              {
                action: "add",
                listType: "shopping",
                listName: "",
                targets: ["טל"],
                items: [{ "שם פריט": "חלב" }],
              },
            ],
          },
        },
        sink,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "תוסיפי חלב לקניות",
      });
      expectW3PromotionContract(sink.facts);
      expect(sink.facts).toMatch(/"raisable":true/);
      expect(tipSpy).not.toHaveBeenCalled();
      tipSpy.mockRestore();
    },
    45_000,
  );

  it(
    "E2: standalone success — no AT, no W3 promotion contract",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      const sink = { facts: "", calls: 0, messages: [] as string[] };
      stubLlm(
        {
          responses: [{ text: "שמרתי חלב.", buttons: [] }],
          metadata: {
            lists: [
              {
                action: "add",
                listType: "shopping",
                listName: "",
                targets: ["טל"],
                items: [{ "שם פריט": "חלב" }],
              },
            ],
          },
        },
        sink,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "תוסיפי חלב",
      });
      expect(sink.facts).not.toMatch(/ACTIVE_THREAD/);
      expect(sink.facts).not.toMatch(/W3 AFTER A SUCCESSFUL/);
    },
    30_000,
  );

  it(
    "E3: partial failure keeps open job AT",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
        metaExtra: { ask: "סידרת ביטוח?" },
      });
      const sink = { facts: "", calls: 0, messages: [] as string[] };
      stubLlm(
        {
          responses: [{ text: "ניסיתי.", buttons: [] }],
          metadata: {
            lists: [
              {
                action: "remove",
                listType: "tasks",
                listName: "",
                targets: ["טל"],
                items: [{ item_id: randomUUID() }],
              },
            ],
          },
        },
        sink,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "תמחקי משימה שלא קיימת",
      });
      expectW3PromotionContract(sink.facts);
      expect(sink.facts).toMatch(/ביטוח/);
    },
    30_000,
  );

  it(
    "E4: two open jobs → primary AT + other_open_jobs",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
        metaExtra: { ask: "קנית ביצים?" },
      });
      await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
        metaExtra: {
          ask: "לסגור משימות באיחור",
          overdueItemIds: [randomUUID()],
          overdueTitles: ["לחם"],
        },
      });
      const sink = { facts: "", calls: 0, messages: [] as string[] };
      stubLlm(
        {
          responses: [{ text: "היי.", buttons: [] }],
          metadata: {},
        },
        sink,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "היי",
      });
      expectW3PromotionContract(sink.facts);
      expect(sink.facts).toMatch(/other_open_jobs/);
      expect(sink.facts).toMatch(/overdue/);
    },
    30_000,
  );

  it(
    "E5: topic switch — AT still in facts; W3 forbids forcing",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
      });
      const sink = { facts: "", calls: 0, messages: [] as string[] };
      stubLlm(
        {
          responses: [{ text: "אין לי מזג אוויר חי כאן, ספרי מה תרצי.", buttons: [] }],
          metadata: {},
        },
        sink,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "מה מזג האוויר?",
      });
      expectW3PromotionContract(sink.facts);
      expect(sink.facts).toMatch(/FORBIDDEN forcing this thread/);
    },
    30_000,
  );

  it(
    "E6: return to process — AT still present",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
      });
      stubLlm({
        responses: [{ text: "בסדר.", buttons: [] }],
        metadata: {},
      });
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "רגע על משהו אחר",
      });
      const sink = { facts: "", calls: 0, messages: [] as string[] };
      stubLlm(
        {
          responses: [{ text: "קנית חלב?", buttons: [] }],
          metadata: {},
        },
        sink,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "חזרה לחלב",
      });
      expectW3PromotionContract(sink.facts);
      expect(sink.facts).toMatch(/חלב/);
    },
    45_000,
  );

  it(
    "E7: after idle RESET — OPEN_JOBS + AT reconstructed from DB",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
        metaExtra: { ask: "הכנת שיעורים?" },
      });
      stubLlm({
        responses: [{ text: "היי.", buttons: [] }],
        metadata: {},
      });
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "היי",
      });
      await simulateIdleRotate({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
      });
      resetPieArbitrationStateForTests();
      const sink = { facts: "", calls: 0, messages: [] as string[] };
      stubLlm(
        {
          responses: [{ text: "היי שוב.", buttons: [] }],
          metadata: {},
        },
        sink,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "היי אחרי הפסקה",
      });
      expect(sink.facts).toMatch(/OPEN_JOBS/);
      expectW3PromotionContract(sink.facts);
      expect(sink.facts).toMatch(/שיעורים/);
    },
    45_000,
  );

  it(
    "E8: closed job — no AT / no W3 promotion contract",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      const jobId = await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
      });
      await prisma.employeeListItem.update({
        where: { id: jobId },
        data: { deletedAt: new Date() },
      });
      const sink = { facts: "", calls: 0, messages: [] as string[] };
      stubLlm(
        {
          responses: [{ text: "היי.", buttons: [] }],
          metadata: {},
        },
        sink,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "היי",
      });
      expect(sink.facts).not.toMatch(/ACTIVE_THREAD/);
      expect(sink.facts).not.toMatch(/W3 AFTER A SUCCESSFUL/);
    },
    30_000,
  );
});
