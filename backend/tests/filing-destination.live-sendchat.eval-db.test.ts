/**
 * Filing intent + destination (real model, full sendChatMessage, eval-db).
 *
 * Contract (system ATTACHMENTS → CONTENT-FIRST DESTINATION):
 *  - Lucy understands what the file is and what the speaker asked; the
 *    instruction sentence is never saved as a row.
 *  - An existing row the file belongs to (by content + named topic) wins —
 *    no new filing beside it.
 *  - A task is a home only when the file is material for THAT task — never
 *    by default because a task exists.
 *  - A new filing only when nothing fits; a repeated save does not duplicate.
 *
 * Images carry readable text (rendered SVG) so the model can see the content.
 * Every scenario asserts persisted state.
 *
 * Run (cwd backend):
 *   npm run test:eval-db -- tests/filing-destination.live-sendchat.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { resetEnvCache } from "../src/config/env.js";
import { prisma } from "../src/database/prisma.js";
import { getLlmClient, setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { loadTurnAttachmentsByIds } from "../src/services/attachment.service.js";
import {
  setAttachmentStorageForTests,
  type AttachmentStorage,
} from "../src/services/attachment-storage.js";
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

function memoryStorage(): AttachmentStorage {
  const bytes = new Map<string, Buffer>();
  return {
    async put(key, data) {
      bytes.set(key, data);
    },
    async read(key) {
      const hit = bytes.get(key);
      if (!hit) throw new Error(`missing ${key}`);
      return hit;
    },
    getStream(key) {
      return Readable.from(bytes.get(key) ?? Buffer.alloc(0));
    },
    async delete(key) {
      bytes.delete(key);
    },
  };
}

/** A white "document" image with readable lines of text. */
async function documentImage(lines: string[]): Promise<Buffer> {
  const text = lines
    .map(
      (line, index) =>
        `<text x="40" y="${80 + index * 60}" font-family="Arial" font-size="36" fill="#111">${line}</text>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${120 + lines.length * 60}"><rect width="100%" height="100%" fill="#fff"/>${text}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const TICKET = ["EVENT TICKET", "Omer Adam - Live in Concert", "Menora Arena, 12.12.2026, 21:00", "Row 14, Seat 7"];
const POLICY = ["CAR INSURANCE POLICY 2027", "Policy no. 55-123456", "Vehicle 70-312-45", "Valid 01.01.2027 - 31.12.2027"];

describe("filing intent + destination (real model, eval-db)", () => {
  let account: HarnessAccount | null = null;
  let storage: AttachmentStorage;

  beforeAll(async () => {
    const key = injectProductEnvKey("OPENAI_API_KEY");
    expect(key.present, "OPENAI_API_KEY required").toBe(true);
    resetEnvCache();
    await assertEvalDbAndGtfsUntouched();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    setAttachmentStorageForTests(null);
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  async function setup() {
    account = await createHarnessAccount("טל");
    await prisma.employee.update({ where: { id: account.employeeId }, data: { addressGender: "male" } });
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
    storage = memoryStorage();
    setAttachmentStorageForTests(storage);
    setLlmClientForTests(getLlmClient());
    const { userId, employeeId } = account;
    const say = async (message: string, attachmentIds: string[] = []) =>
      sendChatMessage({
        userId,
        employeeId,
        digitalEmployeeId: lucyId,
        message,
        ...(attachmentIds.length
          ? { attachments: await loadTurnAttachmentsByIds(userId, employeeId, attachmentIds) }
          : {}),
      });
    return { say };
  }

  async function seedImage(fileName: string, lines: string[]): Promise<string> {
    const id = randomUUID();
    const storageKey = `eval/${id}`;
    await storage.put(storageKey, await documentImage(lines));
    await prisma.attachment.create({
      data: {
        id,
        userId: account!.userId,
        uploaderId: account!.employeeId,
        kind: "image",
        mimeType: "image/png",
        fileName,
        storageKey,
      },
    });
    return id;
  }

  async function seedFiling(name: string, attachmentIds: string[] = []): Promise<string> {
    const filing = await prisma.employeeFiling.create({
      data: {
        employeeId: account!.employeeId,
        itemName: name,
        itemInfo: "",
        itemDescription: "",
        addedById: account!.employeeId,
        scope: "personal",
        visibleTo: [account!.employeeId],
      },
      select: { id: true },
    });
    for (const attachmentId of attachmentIds) {
      await prisma.attachmentLink.create({
        data: { attachmentId, filingId: filing.id, addedById: account!.employeeId },
      });
    }
    return filing.id;
  }

  async function seedTask(title: string): Promise<string> {
    const list =
      (await prisma.employeeList.findFirst({
        where: { employeeId: account!.employeeId, listType: "tasks", deletedAt: null },
        select: { id: true },
      })) ??
      (await prisma.employeeList.create({
        data: {
          employeeId: account!.employeeId,
          listType: "tasks",
          name: "",
          scope: "personal",
          visibleTo: [account!.employeeId],
        },
        select: { id: true },
      }));
    const id = randomUUID();
    await prisma.employeeListItem.create({
      data: {
        id,
        listId: list.id,
        itemKey: `${title}-${id.slice(0, 8)}`,
        data: { "שם משימה": title },
        scope: "personal",
        addedById: account!.employeeId,
        visibleTo: [account!.employeeId],
      },
    });
    return id;
  }

  const filesOn = async (where: { filingId?: string; listItemId?: string }) =>
    (await prisma.attachmentLink.findMany({ where, select: { attachmentId: true } }))
      .map((row) => row.attachmentId)
      .sort();
  const liveFilings = () =>
    prisma.employeeFiling.findMany({
      where: { employeeId: account!.employeeId, deletedAt: null },
      select: { id: true, itemName: true, itemInfo: true, itemDescription: true },
    });
  const liveItems = () =>
    prisma.employeeListItem.findMany({
      where: { deletedAt: null, list: { employeeId: account!.employeeId } },
      select: { id: true, data: true },
    });
  /** No saved row may carry the instruction sentence itself. */
  async function expectInstructionNotSaved(instructionStem: string) {
    for (const row of await liveFilings()) {
      const text = `${row.itemName} ${row.itemInfo} ${row.itemDescription}`;
      expect(text, `instruction saved as a filing: ${text}`).not.toContain(instructionStem);
    }
    for (const row of await liveItems()) {
      const text = JSON.stringify(row.data);
      expect(text, `instruction saved as a list row: ${text}`).not.toContain(instructionStem);
    }
  }

  it(
    "1. a ticket + «file it with the show tickets» → the EXISTING filing gets it; no new filing; the unrelated task untouched",
    async () => {
      const { say } = await setup();
      const firstTicket = await seedImage("ticket-1.png", TICKET);
      const showFiling = await seedFiling("כרטיסים להופעה של עומר אדם", [firstTicket]);
      const task = await seedTask("לחדש ביטוח רכב");
      const itemsBefore = (await liveItems()).length;

      const secondTicket = await seedImage("ticket-2.png", [...TICKET.slice(0, 3), "Row 14, Seat 8"]);
      const turn = await say("תתייקי את זה עם הכרטיסים להופעה", [secondTicket]);
      const spoken = parseLlmReply(turn.reply).response;

      expect(await filesOn({ filingId: showFiling }), `attached to the existing filing: ${spoken}`).toEqual(
        [firstTicket, secondTicket].sort(),
      );
      expect((await liveFilings()).map((row) => row.id), "no new filing").toEqual([showFiling]);
      expect(await filesOn({ listItemId: task }), "unrelated task untouched").toEqual([]);
      expect((await liveItems()).length, "no list rows created").toBe(itemsBefore);
      await expectInstructionNotSaved("תתייק");
    },
    TIMEOUT,
  );

  it(
    "2. a policy + «file it» with no fitting home → ONE new filing named for the document; an unrelated task is not a default home; repeating the save does not duplicate",
    async () => {
      const { say } = await setup();
      const giftTask = await seedTask("לקנות מתנה לדנה");
      await seedFiling("קוד לשער אצל לבנת");
      const itemsBefore = (await liveItems()).length;

      const policy = await seedImage("scan-0001.png", POLICY);
      const turn = await say("תתייקי את זה", [policy]);
      const spoken = parseLlmReply(turn.reply).response;

      const created = (await liveFilings()).filter((row) => row.itemName !== "קוד לשער אצל לבנת");
      expect(created, `exactly one new filing: ${spoken}`).toHaveLength(1);
      expect(await filesOn({ filingId: created[0]!.id })).toEqual([policy]);
      expect(created[0]!.itemName, "named for what the document is").toMatch(/ביטוח|פוליס|policy|insurance/i);
      expect(await filesOn({ listItemId: giftTask }), "unrelated task untouched").toEqual([]);
      expect((await liveItems()).length, "no list rows created").toBe(itemsBefore);
      await expectInstructionNotSaved("תתייק");

      // The same save again (no new file) → still one filing for the policy.
      const again = await say("תשמרי את פוליסת הביטוח בתיוקים");
      const policyFilings = (await liveFilings()).filter((row) => row.itemName !== "קוד לשער אצל לבנת");
      expect(policyFilings.map((row) => row.id), `no duplicate filing: ${parseLlmReply(again.reply).response}`).toEqual([
        created[0]!.id,
      ]);
      expect(await filesOn({ filingId: created[0]!.id })).toEqual([policy]);
    },
    TIMEOUT,
  );

  it(
    "3. a policy + «it is for the insurance task» → attached to THAT task; no filing created",
    async () => {
      const { say } = await setup();
      const insuranceTask = await seedTask("לחדש ביטוח רכב");
      const giftTask = await seedTask("לקנות מתנה לדנה");

      const policy = await seedImage("scan-0002.png", POLICY);
      const turn = await say("זה בשביל המשימה של חידוש הביטוח, תצרפי לשם", [policy]);
      const spoken = parseLlmReply(turn.reply).response;

      expect(await filesOn({ listItemId: insuranceTask }), `attached to the matching task: ${spoken}`).toEqual([
        policy,
      ]);
      expect(await filesOn({ listItemId: giftTask }), "other task untouched").toEqual([]);
      expect(await liveFilings(), "no filing created").toEqual([]);
      await expectInstructionNotSaved("תצרפי");
    },
    TIMEOUT,
  );
});
