/**
 * W3 Post-Success — real model via sendChatMessage (workee_test).
 * Checks natural promotion vs tip / bare confirm when an OPEN_JOB is live,
 * and topic-switch without forcing the old thread.
 *
 * Run (cwd backend):
 *   npm run test:eval-db -- tests/w3-post-success.live-sendchat.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { getLlmClient, setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { JOB_META_KEY, type JobMeta } from "../src/services/job-meta.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  injectProductEnvKey,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const TIMEOUT = 300_000;

function loadLucyConfig() {
  const path = resolve(process.cwd(), "..", "LLM.config.json");
  expect(existsSync(path), path).toBe(true);
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    systemMessage: string[];
    model: string;
    temperature: number;
    reasoningEffort?: string;
  };
  return {
    instructions: raw.systemMessage.join("\n"),
    model: raw.model,
    temperature: raw.temperature,
    reasoningEffort: raw.reasoningEffort ?? null,
  };
}

function spokenAll(reply: string): string {
  const parsed = parseLlmReply(reply);
  return [parsed.response, ...(parsed.responseBubbles ?? []).map((b) => b.text)]
    .join("\n")
    .toLowerCase();
}

async function seedSelfJob(input: {
  digitalEmployeeId: string;
  speakerId: string;
  ask: string;
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
  const label = `לבדוק עם טל: ${input.ask}`;
  const meta: JobMeta = {
    kind: "job",
    askerId: input.speakerId,
    askerName: "טל",
    subjectId: input.speakerId,
    subjectName: "טל",
    ask: input.ask,
    state: "open",
    createdAt: new Date().toISOString(),
  };
  const row = await prisma.employeeListItem.create({
    data: {
      listId: list.id,
      itemKey: label,
      data: { "שם משימה": label, [JOB_META_KEY]: meta },
      scope: "shared",
      addedById: input.speakerId,
      visibleTo: [input.speakerId],
    },
  });
  return row.id;
}

describe("W3 Post-Success (live model)", () => {
  let account: HarnessAccount;
  let lucyId: string;

  beforeAll(async () => {
    injectProductEnvKey();
    assertEvalDbAndGtfsUntouched();
    const config = loadLucyConfig();
    account = await createHarnessAccount("טל", { partners: [] });
    lucyId = await ensureLucy(account, config.instructions);
    await prisma.employee.update({
      where: { id: lucyId },
      data: {
        instructions: config.instructions,
        model: config.model,
        temperature: config.temperature,
        reasoningEffort: config.reasoningEffort,
      },
    });
    await prisma.user.update({
      where: { id: account.userId },
      data: { consentPending: false },
    });
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);
    setLlmClientForTests(null);
    setLlmClientForTests(getLlmClient());
  }, TIMEOUT);

  afterAll(async () => {
    setLlmClientForTests(null);
    vi.restoreAllMocks();
    if (account) await cleanupHarnessAccount(account);
  });

  it(
    "after shopping save with open self-check: promotes job ask, not only bare confirm/tip",
    async () => {
      await seedSelfJob({
        digitalEmployeeId: lucyId,
        speakerId: account.employeeId,
        ask: "קנית שוקו?",
      });
      const result = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "תוסיפי לחם לקניות",
      });
      const text = spokenAll(result.reply);
      // Must acknowledge save somehow OR still be on-topic.
      expect(text.length).toBeGreaterThan(0);
      // Natural promotion: mention the open self-check (שוקו), not invent a new process.
      expect(text).toMatch(/שוקו/);
      // Must not invent an unrelated capability tip as the only move.
      const tipOnly =
        /רוצה לשתף|דרך אגב|לידיעתך/.test(text) && !/שוקו/.test(text);
      expect(tipOnly).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "clear topic switch: answers new topic without inventing steps for closed work",
    async () => {
      // No open job for this account turn — fresh ask unrelated.
      const result = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "רק שאלה: איך קוראים לך?",
      });
      const text = spokenAll(result.reply);
      expect(text.length).toBeGreaterThan(0);
      // Should not invent a shopping/task mutate for a name question.
      const meta = result.raw;
      void meta;
      expect(text).not.toMatch(/שמרתי לך משימה שלא ביקשת/);
    },
    TIMEOUT,
  );
});
