/**
 * Reply contract — real model via sendChatMessage on workee_test.
 * The engine no longer polices the model's text, so the model itself must:
 *  1. answer the SPEAKER when relaying (never the body written for the other person);
 *  2. show saved items only via show_dump (engine-numbered LAST_NUMBERED_DUMP);
 *  3. resolve «2» that answers ITS OWN numbered question from that question —
 *     never from a stale LAST_NUMBERED_DUMP.
 *
 * Run (cwd backend):
 *   npm run test:eval-db -- tests/reply-contract.live-sendchat.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLlmReply, parseReplyMetadata } from "@workee/shared";
import { resetEnvCache } from "../src/config/env.js";
import { prisma } from "../src/database/prisma.js";
import {
  getLlmClient,
  setLlmClientForTests,
} from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
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

const TIMEOUT = 240_000;

/** Production prompt AND production model settings — evaluate what users get. */
function loadLucyConfig(): {
  instructions: string;
  model: string;
  temperature: number;
  reasoningEffort: string | null;
} {
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

async function seedAccount(partners: string[] = []) {
  const account = await createHarnessAccount("טל", { partners });
  const config = loadLucyConfig();
  const lucyId = await ensureLucy(account, config.instructions);
  await prisma.employee.update({
    where: { id: lucyId },
    data: {
      instructions: config.instructions,
      model: config.model,
      temperature: config.temperature,
      reasoningEffort: config.reasoningEffort,
    },
  });
  vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent");
  vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent");
  vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0);
  vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => {});
  setLlmClientForTests(null);
  setLlmClientForTests(getLlmClient());
  return { account, lucyId };
}

async function seedItems(
  account: HarnessAccount,
  listType: "shopping" | "tasks",
  titles: string[],
): Promise<string[]> {
  const list = await prisma.employeeList.create({
    data: {
      employeeId: account.employeeId,
      listType,
      name: "",
      scope: "personal",
      visibleTo: [account.employeeId],
    },
    select: { id: true },
  });
  const key = listType === "shopping" ? "שם פריט" : "שם משימה";
  const ids: string[] = [];
  for (const title of titles) {
    const id = randomUUID();
    await prisma.employeeListItem.create({
      data: {
        id,
        listId: list.id,
        itemKey: title,
        data: { [key]: title },
        scope: "personal",
        addedById: account.employeeId,
        visibleTo: [account.employeeId],
      },
    });
    ids.push(id);
  }
  return ids;
}

async function liveIds(ids: string[]): Promise<string[]> {
  const rows = await prisma.employeeListItem.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

function say(
  seeded: { account: HarnessAccount; lucyId: string },
  message: string,
) {
  return sendChatMessage({
    userId: seeded.account.userId,
    employeeId: seeded.account.employeeId,
    digitalEmployeeId: seeded.lucyId,
    message,
  });
}

/** Text of the line numbered n in a spoken reply (test-side reading only). */
function numberedLine(spoken: string, n: number): string {
  const match = spoken.match(new RegExp(`^\\s*${n}[.)]\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

describe("reply contract (real model, eval-db)", () => {
  let account: HarnessAccount | null = null;

  beforeAll(async () => {
    const key = injectProductEnvKey("OPENAI_API_KEY");
    expect(key.present, "OPENAI_API_KEY required").toBe(true);
    resetEnvCache();
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

  it(
    "relay: responses confirm to the speaker; the body goes only to the partner",
    async () => {
      const seeded = await seedAccount(["עמית"]);
      account = seeded.account;
      const turn = await say(seeded, "תשאלי את עמית אם הוא קנה חלב");
      const meta = parseReplyMetadata(turn.reply);
      const spoken = parseLlmReply(turn.reply).response.trim();
      const relays = meta.messages ?? [];

      expect(relays.length, JSON.stringify(meta)).toBeGreaterThanOrEqual(1);
      expect(relays.some((row) => (row.targets ?? []).join(" ").includes("עמית"))).toBe(true);
      expect(spoken).not.toBe("");
      for (const row of relays) {
        expect(spoken, "responses must not be the relay body").not.toBe(
          (row.text ?? "").trim(),
        );
      }
      expect(spoken, "must not address the partner by name").not.toMatch(/^עמית[,،]/);
      expect(spoken, "speaker-facing confirmation names the partner").toMatch(/עמית/);
    },
    TIMEOUT,
  );

  it(
    "show via show_dump, then «תמחקי את 2» removes line 2 of the engine dump",
    async () => {
      const seeded = await seedAccount();
      account = seeded.account;
      const ids = await seedItems(account, "shopping", ["חלב", "לחם", "ביצים"]);

      const show = await say(seeded, "מה יש לי ברשימת הקניות?");
      const showMeta = parseReplyMetadata(show.reply);
      const showSpoken = parseLlmReply(show.reply).response;
      const line2 = numberedLine(showSpoken, 2);
      expect(line2, `engine dump must number the list:\n${showSpoken}`).not.toBe("");
      expect(showMeta.lists ?? []).toEqual([]);

      await say(seeded, "תמחקי את 2");
      const alive = await liveIds(ids);
      const titles = ["חלב", "לחם", "ביצים"];
      const removed = titles.filter((_t, i) => !alive.includes(ids[i]));
      expect(removed, `line 2 was «${line2}»`).toHaveLength(1);
      expect(line2).toContain(removed[0]);
    },
    TIMEOUT,
  );

  it(
    "«2» answering the model's own numbered question never uses a stale dump",
    async () => {
      const seeded = await seedAccount();
      account = seeded.account;
      const shopIds = await seedItems(account, "shopping", ["חלב", "לחם", "ביצים"]);
      const taskTitles = ["להזמין מלון לצפון", "להזמין מלון לאילת"];
      const taskIds = await seedItems(account, "tasks", taskTitles);

      // Stale engine dump: shopping lines 1..3 become LAST_NUMBERED_DUMP.
      await say(seeded, "מה יש לי ברשימת הקניות?");

      const ask = await say(seeded, "תמחקי את המשימה של המלון");
      const askMeta = parseReplyMetadata(ask.reply);
      const askSpoken = parseLlmReply(ask.reply).response;
      expect(
        (askMeta.lists ?? []).filter((row) => row.action === "remove"),
        "ambiguous → ask, no delete yet",
      ).toEqual([]);
      // Prompt: «whenever you ASK which of ≥2 candidates, write them as numbered lines».
      const option2 = numberedLine(askSpoken, 2);
      expect(option2, `expected a numbered candidate question:\n${askSpoken}`).not.toBe("");

      await say(seeded, "2");

      expect(await liveIds(shopIds), "stale shopping dump must not be used").toEqual(
        expect.arrayContaining(shopIds),
      );
      const alive = await liveIds(taskIds);
      const removed = taskTitles.filter((_t, i) => !alive.includes(taskIds[i]));
      expect(removed, `option 2 was «${option2}»`).toHaveLength(1);
      const target = option2.includes("אילת") ? "להזמין מלון לאילת" : "להזמין מלון לצפון";
      expect(removed[0]).toBe(target);
    },
    TIMEOUT,
  );
});
