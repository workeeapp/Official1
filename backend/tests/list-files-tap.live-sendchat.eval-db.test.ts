/**
 * List-level files (real model, eval-db). Regression 2026-11-05: showing a
 * list with images on the list itself stopped offering them (show_dump turns
 * strip model buttons since 176e745). Contract:
 *  1. model shows the list (show_dump) → engine renders «📎 קבצי הרשימה (N)»
 *     on the dump; no files are pushed unasked;
 *  2. the tap is a normal message → the MODEL emits send_attachments with the
 *     list's own files (model understands, engine executes).
 *
 * Run (cwd backend):
 *   npm run test:eval-db -- tests/list-files-tap.live-sendchat.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLlmReply, parseReplyMetadata, readSpokenBubbles } from "@workee/shared";
import { resetEnvCache } from "../src/config/env.js";
import { prisma } from "../src/database/prisma.js";
import { getLlmClient, setLlmClientForTests } from "../src/services/llm-client.js";
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
const LIST_NAME = "שיפוץ המטבח";

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

describe("list-level files tap (real model, eval-db)", () => {
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
    "show list → engine files tap; tap → model send_attachments with the list files",
    async () => {
      account = await createHarnessAccount("טל");
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

      const list = await prisma.employeeList.create({
        data: {
          employeeId: account.employeeId,
          listType: "custom",
          name: LIST_NAME,
          scope: "personal",
          visibleTo: [account.employeeId],
          columns: ["שם"],
        },
        select: { id: true },
      });
      for (const title of ["צבע לקירות", "ידיות לארונות"]) {
        await prisma.employeeListItem.create({
          data: {
            id: randomUUID(),
            listId: list.id,
            itemKey: title,
            data: { שם: title },
            scope: "personal",
            addedById: account.employeeId,
            visibleTo: [account.employeeId],
          },
        });
      }
      const attachmentId = randomUUID();
      await prisma.attachment.create({
        data: {
          id: attachmentId,
          userId: account.userId,
          uploaderId: account.employeeId,
          kind: "image",
          mimeType: "image/jpeg",
          fileName: "kitchen-plan.jpg",
          storageKey: `eval/${attachmentId}.jpg`,
          caption: "תוכנית המטבח",
        },
      });
      await prisma.attachmentLink.create({
        data: { attachmentId, listId: list.id, addedById: account.employeeId },
      });

      const userId = account.userId;
      const employeeId = account.employeeId;
      const say = (message: string) =>
        sendChatMessage({ userId, employeeId, digitalEmployeeId: lucyId, message });

      // 1. Show → dump + engine files tap; nothing pushed unasked.
      const show = await say(`הצג רשימת ${LIST_NAME}`);
      const showMeta = parseReplyMetadata(show.reply);
      const bubbles = readSpokenBubbles(JSON.parse(show.reply)) ?? [];
      const taps = bubbles.flatMap((bubble) => bubble.buttons ?? []);
      const filesTap = taps.find((button) => button.label.startsWith("📎 קבצי הרשימה"));
      expect(parseLlmReply(show.reply).response, "dump shown").toContain("צבע לקירות");
      expect(filesTap, JSON.stringify(taps)).toEqual({
        label: "📎 קבצי הרשימה (1)",
        command: `שלחי את הקבצים של רשימת ${LIST_NAME}`,
      });
      expect(showMeta.sendAttachments ?? [], "no unasked file push").toEqual([]);
      expect(show.outboundAttachmentIds ?? []).toEqual([]);

      // 2. Tap → the model decides send_attachments with the list's own file.
      const tap = await say(filesTap!.command);
      const tapMeta = parseReplyMetadata(tap.reply);
      expect(
        tapMeta.sendAttachments ?? [],
        `spoken: ${parseLlmReply(tap.reply).response}`,
      ).toContain(attachmentId);
    },
    TIMEOUT,
  );
});
