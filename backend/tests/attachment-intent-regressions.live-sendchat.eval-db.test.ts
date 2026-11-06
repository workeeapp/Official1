/**
 * Attachment intent regressions (real model, full sendChatMessage, eval-db).
 * Production incident 2026-11-06 (Tal ↔ Lucy):
 *  1. a bare file sent after a completed filing was auto-attached to that filing;
 *  2. a filing correction attached a Lucy-generated celebration image (it was
 *     stored as a speaker upload and surfaced in PENDING_ATTACHMENTS).
 * Contract (FILE INTENT): a file never authorizes an action by itself; act only
 * when the request refers to it or answers an explicit open question; a
 * correction moves the exact file the user means; Lucy-generated files are
 * never user uploads.
 *
 * Speaker is a NON-owner (like Tal) — owners may attach any account file.
 * Every scenario asserts persisted state and that unrelated rows/files are unchanged.
 *
 * Run (cwd backend):
 *   npm run test:eval-db -- tests/attachment-intent-regressions.live-sendchat.eval-db.test.ts
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
import {
  deliverAttachmentsToPhone,
  listPendingAttachments,
  loadTurnAttachmentsByIds,
  openAttachmentContent,
  resolveUsableAttachments,
} from "../src/services/attachment.service.js";
import { applyEmployeeRecords } from "../src/services/employee-records.service.js";
import * as whatsappMedia from "../src/services/whatsapp-media.js";
import { emptyLlmMetadata } from "@workee/shared";
import {
  setAttachmentStorageForTests,
  type AttachmentStorage,
} from "../src/services/attachment-storage.js";
import { setCelebrationImageGenForTests } from "../src/services/delete-celebration.js";
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

/** In-memory storage so seeded images / the celebration render never touch disk. */
function memoryStorage(): AttachmentStorage & { bytes: Map<string, Buffer> } {
  const bytes = new Map<string, Buffer>();
  return {
    bytes,
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

describe("attachment intent regressions (real model, eval-db)", () => {
  let account: HarnessAccount | null = null;
  let otherAccount: HarnessAccount | null = null;
  let storage: ReturnType<typeof memoryStorage>;
  let png: Buffer;

  beforeAll(async () => {
    const key = injectProductEnvKey("OPENAI_API_KEY");
    expect(key.present, "OPENAI_API_KEY required").toBe(true);
    resetEnvCache();
    await assertEvalDbAndGtfsUntouched();
    png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 120, b: 40 } },
    })
      .png()
      .toBuffer();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    setAttachmentStorageForTests(null);
    setCelebrationImageGenForTests(null);
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
    if (otherAccount) {
      await cleanupHarnessAccount(otherAccount);
      otherAccount = null;
    }
  });

  async function setup() {
    account = await createHarnessAccount("טל");
    // Non-owner speaker, like the production incident.
    await prisma.employee.update({
      where: { id: account.employeeId },
      data: { isOwner: false, addressGender: "male" },
    });
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
    setLlmClientForTests(null);
    setLlmClientForTests(getLlmClient());
    const userId = account.userId;
    const employeeId = account.employeeId;
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
    return { account, lucyId, say };
  }

  async function seedFile(input: {
    uploaderId: string;
    kind: "document" | "image";
    fileName: string;
    createdAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    const storageKey = `eval/${id}`;
    await storage.put(storageKey, input.kind === "image" ? png : Buffer.from("%PDF-1.4 eval"));
    await prisma.attachment.create({
      data: {
        id,
        userId: account!.userId,
        uploaderId: input.uploaderId,
        kind: input.kind,
        mimeType: input.kind === "image" ? "image/png" : "application/pdf",
        fileName: input.fileName,
        storageKey,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
    });
    return id;
  }

  async function seedFiling(name: string, attachmentIds: string[]): Promise<string> {
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

  const filingFiles = async (filingId: string) =>
    (
      await prisma.attachmentLink.findMany({ where: { filingId }, select: { attachmentId: true } })
    )
      .map((row) => row.attachmentId)
      .sort();
  const linksOf = (attachmentId: string) =>
    prisma.attachmentLink.count({ where: { attachmentId } });
  const liveFilings = () =>
    prisma.employeeFiling.findMany({
      where: { employeeId: account!.employeeId, deletedAt: null },
      select: { id: true, itemName: true },
    });
  const listItemCount = () =>
    prisma.employeeListItem.count({
      where: { deletedAt: null, list: { employeeId: account!.employeeId } },
    });
  const looksLikeAsk = (text: string) => /\?|？/.test(text);

  it(
    "1. bare file after a completed filing → ask; not attached to the previous filing",
    async () => {
      const { say } = await setup();
      const receiptA = await seedFile({
        uploaderId: account!.employeeId,
        kind: "document",
        fileName: "CamScanner 06.11.2026 13.37.pdf",
      });

      // Completed filing in the same conversation (explicit instruction + file).
      const first = await say("תתייקי את זה כקבלה של יואב", [receiptA]);
      const yoav = (await liveFilings()).find((row) => row.itemName.includes("יואב"));
      expect(yoav, `filing created: ${parseLlmReply(first.reply).response}`).toBeTruthy();
      expect(await filingFiles(yoav!.id)).toEqual([receiptA]);
      const itemsBefore = await listItemCount();

      // A new file arrives alone — no instruction, previous save is complete.
      const receiptB = await seedFile({
        uploaderId: account!.employeeId,
        kind: "document",
        fileName: "CamScanner 06.11.2026 13.41.pdf",
      });
      const bare = await say("", [receiptB]);
      const spoken = parseLlmReply(bare.reply).response;

      expect(looksLikeAsk(spoken), `asks what to do: ${spoken}`).toBe(true);
      // Persisted state: B linked nowhere; A's filing unchanged; nothing else created.
      expect(await linksOf(receiptB), "new file not attached anywhere").toBe(0);
      expect(await filingFiles(yoav!.id), "previous filing unchanged").toEqual([receiptA]);
      expect((await liveFilings()).length, "no new filing").toBe(1);
      expect(await listItemCount(), "no list rows created").toBe(itemsBefore);
    },
    TIMEOUT,
  );

  it(
    "2. correction moves the exact existing attachment; no pending / Lucy file substituted",
    async () => {
      const { lucyId, say } = await setup();
      const fileA = await seedFile({
        uploaderId: account!.employeeId,
        kind: "document",
        fileName: "CamScanner 06.11.2026 13.37.pdf",
      });
      const fileB = await seedFile({
        uploaderId: account!.employeeId,
        kind: "document",
        fileName: "CamScanner 06.11.2026 13.41.pdf",
      });
      const yoav = await seedFiling("קבלה של יואב", [fileA, fileB]);
      const maya = await seedFiling("קבלה של מאיה", []);
      // Decoys: an unrelated unlinked speaker file + an unlinked Lucy-generated image.
      const decoyUser = await seedFile({
        uploaderId: account!.employeeId,
        kind: "document",
        fileName: "trip-notes.pdf",
      });
      const decoyLucy = await seedFile({
        uploaderId: lucyId,
        kind: "image",
        fileName: "celebration.jpg",
      });
      const itemsBefore = await listItemCount();

      const turn = await say(
        "המסמך CamScanner 13.41 שנמצא בקבלה של יואב בכלל שייך למאיה — תעבירי אותו לקבלה של מאיה",
      );
      const spoken = parseLlmReply(turn.reply).response;

      // Persisted state: exactly B moved Yoav → Maya.
      expect(await filingFiles(maya), `moved to Maya: ${spoken}`).toEqual([fileB]);
      expect(await filingFiles(yoav), "removed from Yoav, A kept").toEqual([fileA]);
      // No substitution; unrelated files untouched.
      expect(await linksOf(decoyUser), "unrelated pending file untouched").toBe(0);
      expect(await linksOf(decoyLucy), "Lucy-generated file untouched").toBe(0);
      expect((await liveFilings()).map((row) => row.id).sort()).toEqual([maya, yoav].sort());
      expect(await listItemCount(), "no list rows changed").toBe(itemsBefore);
    },
    TIMEOUT,
  );

  it(
    "3. Lucy-generated celebration image is never a pending user upload nor attachable",
    async () => {
      const { lucyId, say } = await setup();
      // Profile photo (needed for the celebration) — old enough to be outside the 48h window.
      const profile = await seedFile({
        uploaderId: account!.employeeId,
        kind: "image",
        fileName: "me.png",
        createdAt: new Date(Date.now() - 72 * 3600_000),
      });
      await prisma.employee.update({
        where: { id: account!.employeeId },
        data: { profileAttachmentId: profile },
      });
      setCelebrationImageGenForTests(async () => ({ bytes: png }));
      const tasks = await prisma.employeeList.create({
        data: {
          employeeId: account!.employeeId,
          listType: "tasks",
          name: "",
          scope: "personal",
          visibleTo: [account!.employeeId],
        },
        select: { id: true },
      });
      await prisma.employeeListItem.create({
        data: {
          listId: tasks.id,
          itemKey: "להוריד את הזבל",
          data: { "שם משימה": "להוריד את הזבל" },
          scope: "personal",
          addedById: account!.employeeId,
          visibleTo: [account!.employeeId],
        },
      });
      const maya = await seedFiling("קבלה של מאיה", []);

      // Turn 1: completing the chore triggers the real delete-celebration path.
      const done = await say("סיימתי להוריד את הזבל");
      const celebration = await prisma.attachment.findFirst({
        where: { userId: account!.userId, fileName: { startsWith: "celebration" } },
        orderBy: { createdAt: "desc" },
      });
      expect(
        celebration,
        `celebration rendered (task removed?): ${parseLlmReply(done.reply).response}`,
      ).toBeTruthy();
      // Provenance: generated by Lucy, not uploaded by the speaker.
      expect(celebration!.uploaderId).toBe(lucyId);
      expect(done.outboundAttachmentIds, "still delivered to the speaker").toContain(
        celebration!.id,
      );
      // Permissions: deliverable (send) but never attachable as the speaker's upload.
      expect(
        (await resolveUsableAttachments(account!.employeeId, [celebration!.id], "send")).map(
          (row) => row.id,
        ),
      ).toEqual([celebration!.id]);
      expect(
        await resolveUsableAttachments(account!.employeeId, [celebration!.id], "attach"),
      ).toEqual([]);
      // Not exposed as pending.
      expect(
        (await listPendingAttachments(account!.employeeId)).map((row) => row.attachment_id),
      ).not.toContain(celebration!.id);

      // Web: the assistant bubble carries the image and its content is readable.
      const bubbles = await prisma.chatMessage.findMany({
        where: { author: "assistant", conversation: { employeeId: account!.employeeId } },
        select: { attachments: true },
      });
      expect(JSON.stringify(bubbles.map((row) => row.attachments)), "web bubble has the image").toContain(
        celebration!.id,
      );
      const content = await openAttachmentContent(account!.userId, celebration!.id);
      expect(content, "web content readable").toBeTruthy();
      content!.stream.destroy();

      // WhatsApp: the exact production delivery path (whatsapp.service runWhatsAppTurn):
      // resolveUsableAttachments(speaker, outboundAttachmentIds, "send") → deliverAttachmentsToPhone.
      const upload = vi.spyOn(whatsappMedia, "uploadWhatsAppMedia").mockResolvedValue("eval-media-id");
      const sendMedia = vi.spyOn(whatsappSend, "sendWhatsAppMedia").mockResolvedValue("sent");
      const deliverable = await resolveUsableAttachments(
        account!.employeeId,
        done.outboundAttachmentIds,
        "send",
      );
      expect(deliverable.map((row) => row.id)).toContain(celebration!.id);
      const delivered = await deliverAttachmentsToPhone("972500000001", deliverable, {
        ignoreSession: true,
      });
      expect(delivered.failed, "no media send failures").toBe(0);
      expect(upload).toHaveBeenCalled();
      expect(
        sendMedia.mock.calls.some(
          ([, media]) => (media as { fileName?: string }).fileName?.startsWith("celebration"),
        ),
        "celebration image sent to the non-owner's phone",
      ).toBe(true);

      // "send" stays narrow: another human's unlinked file is not deliverable,
      // and a digital file from ANOTHER account is never visible.
      const otherHuman = await prisma.employee.create({
        data: { userId: account!.userId, kind: "human", name: "מאיה", surname: "" },
        select: { id: true },
      });
      const strangerFile = await seedFile({
        uploaderId: otherHuman.id,
        kind: "document",
        fileName: "maya-private.pdf",
      });
      expect(
        await resolveUsableAttachments(account!.employeeId, [strangerFile], "send"),
        "other human's unlinked file not sendable",
      ).toEqual([]);
      otherAccount = await createHarnessAccount("עמית");
      const otherLucy = await ensureLucy(otherAccount, loadLucyConfig().instructions);
      const foreignId = randomUUID();
      await prisma.attachment.create({
        data: {
          id: foreignId,
          userId: otherAccount.userId,
          uploaderId: otherLucy,
          kind: "image",
          mimeType: "image/png",
          fileName: "celebration.jpg",
          storageKey: `eval/${foreignId}`,
        },
      });
      expect(
        await resolveUsableAttachments(account!.employeeId, [foreignId], "send"),
        "another account's digital file never usable",
      ).toEqual([]);

      // Engine-level attach attempt (as if the model emitted the id) is refused.
      const attachTry = await applyEmployeeRecords(
        account!.employeeId,
        {
          ...emptyLlmMetadata(),
          filing: [
            {
              action: "update_filing",
              itemName: "קבלה של מאיה",
              itemInfo: "",
              itemDescription: "",
              filingId: maya,
              targets: [],
              attachmentIds: [celebration!.id],
            },
          ],
        },
        undefined,
        account!.employeeId,
      );
      expect(attachTry.attachmentOutcome.linked, "celebration not attachable").toBe(0);
      expect(await linksOf(celebration!.id)).toBe(0);

      // Turn 2: the incident request — no user file exists to attach.
      const ask = await say("תצרפי את הקובץ ששלחתי לקבלה של מאיה");
      expect(JSON.stringify(ask.request ?? ""), "celebration id never sent to the model").not.toContain(
        celebration!.id,
      );
      expect(await linksOf(celebration!.id), "celebration never attached").toBe(0);
      expect(await filingFiles(maya), "Maya filing unchanged").toEqual([]);
      expect(await linksOf(profile), "profile photo untouched").toBe(0);
    },
    TIMEOUT,
  );
});
