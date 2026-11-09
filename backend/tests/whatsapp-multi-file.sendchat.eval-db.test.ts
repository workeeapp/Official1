/**
 * WhatsApp multi-file submission — production path (sendChatMessage, scripted
 * model, approved workee_test). Two files that reach Lucy in ONE turn must end
 * up linked to ONE filing, with no duplicate filing and no extra links.
 * No OpenAI, WhatsApp delivery or reminder ticker. Proves the engine path from
 * ingested files onward — NOT live model behavior and NOT batching (see
 * whatsapp-multi-file-batch.offline.test.ts).
 *
 * Run: npm run test:eval-db -- tests/whatsapp-multi-file.sendchat.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/database/prisma.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { loadTurnAttachmentsByIds } from "../src/services/attachment.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  stubLlmReply,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
});

describe("WhatsApp multi-file submission via sendChatMessage", () => {
  const accounts: HarnessAccount[] = [];
  const marker = `mf-${Date.now().toString(36)}`;

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    while (accounts.length > 0) {
      const account = accounts.pop()!;
      await prisma.attachmentLink
        .deleteMany({ where: { attachment: { userId: account.userId } } })
        .catch(() => undefined);
      await prisma.attachment.deleteMany({ where: { userId: account.userId } }).catch(() => undefined);
      await prisma.employeeFiling
        .deleteMany({ where: { employeeId: account.employeeId } })
        .catch(() => undefined);
      await cleanupHarnessAccount(account);
    }
  });

  async function setup(): Promise<{ account: HarnessAccount; lucyId: string }> {
    const account = await createHarnessAccount("טל");
    accounts.push(account);
    const lucyId = await ensureLucy(account);
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);
    return { account, lucyId };
  }

  /** The state ingestInboundMedia leaves behind for one received WhatsApp document. */
  async function seedDocument(account: HarnessAccount, fileName: string) {
    const id = randomUUID();
    return prisma.attachment.create({
      data: {
        id,
        userId: account.userId,
        uploaderId: account.employeeId,
        kind: "document",
        mimeType: "application/pdf",
        fileName,
        storageKey: `eval/${id}.pdf`,
        sizeBytes: 1024,
      },
    });
  }

  it("two files in one turn → one filing linked to both; no duplicate filing or link", async () => {
    const { account, lucyId } = await setup();
    const ticketA = await seedDocument(account, `ticket-a-${marker}.pdf`);
    const ticketB = await seedDocument(account, `ticket-b-${marker}.pdf`);
    const attachments = await loadTurnAttachmentsByIds(account.userId, account.employeeId, [
      ticketA.id,
      ticketB.id,
    ]);
    // Both files reach the turn input.
    expect(attachments?.facts.map((fact) => fact.attachment_id)).toEqual([ticketA.id, ticketB.id]);

    const filingName = `כרטיסים להופעה ${marker}`;
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "תייקתי את שני הכרטיסים.", buttons: [] }],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "filing",
              list_name: "",
              items: [
                {
                  item_name: filingName,
                  item_info: "",
                  item_description: "",
                  attachment_ids: [ticketA.id, ticketB.id],
                },
              ],
            },
          ],
        },
      }),
    );
    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תתייקי את שני הכרטיסים תחת ההופעה",
      attachments,
    });

    const filings = await prisma.employeeFiling.findMany({
      where: { employeeId: account.employeeId, deletedAt: null },
      select: { id: true, itemName: true },
    });
    expect(filings, JSON.stringify(filings)).toHaveLength(1);
    expect(filings[0]!.itemName).toBe(filingName);

    const links = await prisma.attachmentLink.findMany({
      where: { attachment: { userId: account.userId } },
      select: { attachmentId: true, filingId: true, listItemId: true, listId: true, reminderId: true, contactId: true },
    });
    // Exactly one link per file, both on the same filing, nothing else linked.
    expect(links).toHaveLength(2);
    expect(new Set(links.map((link) => link.attachmentId))).toEqual(new Set([ticketA.id, ticketB.id]));
    expect(links.every((link) => link.filingId === filings[0]!.id)).toBe(true);
    expect(links.every((link) => !link.listItemId && !link.listId && !link.reminderId && !link.contactId)).toBe(true);

    // The user turn carries both files (web chat / history). User rows are stored as author "you".
    const userRows = await prisma.chatMessage.findMany({
      where: { author: "you", conversation: { userId: account.userId } },
      select: { attachments: true },
    });
    expect(userRows).toHaveLength(1);
    const carried = JSON.stringify(userRows.map((row) => row.attachments));
    expect(carried).toContain(ticketA.id);
    expect(carried).toContain(ticketB.id);
  }, 120_000);

  it("a repeated id in attachment_ids does not create a duplicate link", async () => {
    const { account, lucyId } = await setup();
    const ticketA = await seedDocument(account, `ticket-a-${marker}.pdf`);
    const ticketB = await seedDocument(account, `ticket-b-${marker}.pdf`);
    const attachments = await loadTurnAttachmentsByIds(account.userId, account.employeeId, [
      ticketA.id,
      ticketB.id,
    ]);
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "תייקתי.", buttons: [] }],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "filing",
              list_name: "",
              items: [
                {
                  item_name: `כרטיסים ${marker}`,
                  item_info: "",
                  item_description: "",
                  attachment_ids: [ticketA.id, ticketB.id, ticketA.id],
                },
              ],
            },
          ],
        },
      }),
    );
    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תתייקי את הכרטיסים",
      attachments,
    });
    const filings = await prisma.employeeFiling.count({
      where: { employeeId: account.employeeId, deletedAt: null },
    });
    expect(filings).toBe(1);
    const links = await prisma.attachmentLink.findMany({
      where: { attachment: { userId: account.userId } },
      select: { attachmentId: true },
    });
    expect(links.map((link) => link.attachmentId).sort()).toEqual([ticketA.id, ticketB.id].sort());
  }, 120_000);
});
