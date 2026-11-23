/**
 * W1 Progress Arbitration — production-path eval-db.
 * Raisable OPEN_JOBS / overdue must block competing tips via sendChatMessage.
 *
 * Run:
 *   npm run test:eval-db -- tests/progress-arbitration.eval-db.test.ts
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
import * as pieArbitration from "../src/services/pie-arbitration.js";
import * as tipsService from "../src/services/tips.service.js";
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

/** Wrap decidePieArbitration to capture W1 gate inputs/outputs. */
function spyPieGate(): {
  restore: () => void;
  lastProgressActive: boolean | undefined;
  lastReason: string | undefined;
} {
  const state: {
    lastProgressActive: boolean | undefined;
    lastReason: string | undefined;
  } = {
    lastProgressActive: undefined,
    lastReason: undefined,
  };
  const original = pieArbitration.decidePieArbitration;
  const spy = vi
    .spyOn(pieArbitration, "decidePieArbitration")
    .mockImplementation((input) => {
      state.lastProgressActive = input.progressEngagementActive;
      const decision = original(input);
      state.lastReason = decision.reason;
      return decision;
    });
  return {
    get lastProgressActive() {
      return state.lastProgressActive;
    },
    get lastReason() {
      return state.lastReason;
    },
    restore: () => spy.mockRestore(),
  };
}

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
});

beforeEach(() => {
  pieArbitration.resetPieArbitrationStateForTests();
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

describe("W1 Progress Arbitration (eval-db)", () => {
  it(
    "raisable OPEN_JOB sets progress gate and blocks tip resolve",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
      });
      const gate = spyPieGate();
      const tipSpy = vi
        .spyOn(tipsService, "resolveAndRecordTipsForTurn")
        .mockResolvedValue({ texts: [], tipIds: [], tipKeys: [] });
      const sink = { facts: "", calls: 0 };
      stubLlm(
        {
          responses: [{ text: "היי טל.", buttons: [] }],
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
      expect(sink.facts).toMatch(/OPEN_JOBS/);
      expect(sink.facts).toMatch(/"raisable":true/);
      expect(gate.lastProgressActive).toBe(true);
      expect(gate.lastReason).toBe("progress_engagement_active");
      expect(tipSpy).not.toHaveBeenCalled();
      tipSpy.mockRestore();
      gate.restore();
    },
    30_000,
  );

  it(
    "overdue raisable blocks tip; overdueOffered lifts progress gate",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      const jobId = await seedJob({
        digitalEmployeeId,
        speakerId: account.employeeId,
        speakerName: "טל",
        metaExtra: {
          overdueItemIds: [randomUUID()],
          overdueTitles: ["לחם"],
          overdueOffered: false,
        },
      });

      const gate = spyPieGate();
      const tipSpy = vi
        .spyOn(tipsService, "resolveAndRecordTipsForTurn")
        .mockResolvedValue({ texts: [], tipIds: [], tipKeys: [] });

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
      expect(gate.lastProgressActive).toBe(true);
      expect(gate.lastReason).toBe("progress_engagement_active");
      expect(tipSpy).not.toHaveBeenCalled();

      const row = await prisma.employeeListItem.findUniqueOrThrow({
        where: { id: jobId },
      });
      const data = (row.data ?? {}) as Record<string, unknown>;
      const meta = data[JOB_META_KEY] as JobMeta;
      await prisma.employeeListItem.update({
        where: { id: jobId },
        data: {
          data: {
            ...data,
            [JOB_META_KEY]: { ...meta, overdueOffered: true },
          },
        },
      });

      tipSpy.mockClear();
      pieArbitration.resetPieArbitrationStateForTests();
      const sink = { facts: "", calls: 0 };
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
        message: "היי שוב",
      });
      expect(sink.facts).toMatch(/"raisable":false/);
      expect(gate.lastProgressActive).toBe(false);
      expect(gate.lastReason).not.toBe("progress_engagement_active");
      tipSpy.mockRestore();
      gate.restore();
    },
    45_000,
  );

  it(
    "closed job does not activate progress gate",
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

      const gate = spyPieGate();
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
      expect(gate.lastProgressActive).toBe(false);
      expect(gate.lastReason).not.toBe("progress_engagement_active");
      gate.restore();
    },
    30_000,
  );

  it(
    "no open job: progress gate off (PIE otherwise unchanged)",
    async () => {
      const { account, digitalEmployeeId } = await openMember();
      const gate = spyPieGate();
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
      expect(gate.lastProgressActive).toBe(false);
      expect(gate.lastReason).not.toBe("progress_engagement_active");
      gate.restore();
    },
    30_000,
  );
});
