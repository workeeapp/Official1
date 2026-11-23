/**
 * W2 Active Thread Facts — production-path eval-db via sendChatMessage.
 *
 * Run:
 *   npm run test:eval-db -- tests/active-thread-facts.eval-db.test.ts
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
import { sendChatMessage } from "../src/services/chat.service.js";
import { JOB_META_KEY, type JobMeta } from "../src/services/job-meta.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { resetPieArbitrationStateForTests } from "../src/services/pie-arbitration.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";

const harnesses: HarnessAccount[] = [];

function stubLlm(
  payload: unknown,
  sink?: { facts: string; calls: number },
) {
  setLlmClientForTests({
    async createConversation() {
      return `conv-${randomUUID()}`;
    },
    async createResponse(input) {
      if (sink) {
        sink.facts = input.liveFacts ?? "";
        sink.calls += 1;
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
      itemKey: label,
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
    if (account) {
      await destroyHarnessAccount(account);
    }
  }
});

describe("W2 Active Thread Facts (eval-db)", () => {
  it(
    "short follow-up after open job still injects ACTIVE_THREAD",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
      });

      const sink1 = { facts: "", calls: 0 };
      stubLlm(
        {
          responses: [{ text: "היי, קנית חלב?", buttons: [] }],
          metadata: {},
        },
        sink1,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "היי",
      });
      expect(sink1.facts).toMatch(/ACTIVE_THREAD/);
      expect(sink1.facts).toMatch(/OPEN_JOBS/);

      // Short follow-up — same open process must remain in facts.
      const sink2 = { facts: "", calls: 0 };
      stubLlm(
        {
          responses: [{ text: "מעולה.", buttons: [] }],
          metadata: {},
        },
        sink2,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "כן",
      });
      expect(sink2.facts).toMatch(/ACTIVE_THREAD/);
      expect(sink2.facts).toMatch(/קנית חלב/);
    },
    45_000,
  );

  it(
    "several consecutive short follow-ups keep ACTIVE_THREAD",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
        metaExtra: { ask: "הכנת שיעורי בית?" },
      });

      for (const msg of ["היי", "רגע", "עוד שנייה"]) {
        const sink = { facts: "", calls: 0 };
        stubLlm(
          {
            responses: [{ text: "אוקיי.", buttons: [] }],
            metadata: {},
          },
          sink,
        );
        await sendChatMessage({
          userId: account.userId,
          employeeId: account.employeeId,
          digitalEmployeeId,
          message: msg,
        });
        expect(sink.facts).toMatch(/ACTIVE_THREAD/);
        expect(sink.facts).toMatch(/שיעורי בית/);
      }
    },
    60_000,
  );

  it(
    "topic digression then return: ACTIVE_THREAD still present while job open",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
      });

      const digress = { facts: "", calls: 0 };
      stubLlm(
        {
          responses: [{ text: "מזג האוויר נחמד.", buttons: [] }],
          metadata: {},
        },
        digress,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "מה מזג האוויר?",
      });
      expect(digress.facts).toMatch(/ACTIVE_THREAD/);

      const back = { facts: "", calls: 0 };
      stubLlm(
        {
          responses: [{ text: "לגבי החלב — קנית?", buttons: [] }],
          metadata: {},
        },
        back,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "חזרה לחלב",
      });
      expect(back.facts).toMatch(/ACTIVE_THREAD/);
      expect(back.facts).toMatch(/חלב/);
    },
    45_000,
  );

  it(
    "closed job removes ACTIVE_THREAD",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      const jobId = await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
      });

      const openSink = { facts: "", calls: 0 };
      stubLlm(
        {
          responses: [{ text: "היי.", buttons: [] }],
          metadata: {},
        },
        openSink,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "היי",
      });
      expect(openSink.facts).toMatch(/ACTIVE_THREAD/);

      await prisma.employeeListItem.update({
        where: { id: jobId },
        data: { deletedAt: new Date() },
      });

      const closedSink = { facts: "", calls: 0 };
      stubLlm(
        {
          responses: [{ text: "היי שוב.", buttons: [] }],
          metadata: {},
        },
        closedSink,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "היי שוב",
      });
      expect(closedSink.facts).not.toMatch(/ACTIVE_THREAD/);
      expect(closedSink.facts).not.toMatch(/OPEN_JOBS/);
    },
    45_000,
  );

  it(
    "partial progress note appears under done without inventing ask",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
        metaExtra: {
          ask: "סידרת ביטוח רכב?",
          progress: "חיפש הצעות מחיר",
          state: "progress",
        },
      });
      const sink = { facts: "", calls: 0 };
      stubLlm(
        {
          responses: [{ text: "נמשיך מההצעות.", buttons: [] }],
          metadata: {},
        },
        sink,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "ומה עכשיו?",
      });
      expect(sink.facts).toMatch(/ACTIVE_THREAD/);
      expect(sink.facts).toMatch(/חיפש הצעות מחיר/);
      expect(sink.facts).toMatch(/סידרת ביטוח רכב/);
    },
    30_000,
  );
});
