/**
 * M7 — files grouped by WhatsApp send time, through the real production path:
 * production batcher + `mediaBatchHoldUntil` (fake clock) → the real
 * `routeWhatsAppSubmission` on workee_test → real `sendChatMessage` (scripted
 * model). Downloads and WhatsApp sends are injected fakes; no OpenAI/WhatsApp.
 *
 * Run: npm run test:eval-db -- tests/whatsapp-media-grouping.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Attachment } from "@prisma/client";
import type { LlmReplyButton } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { buildTurnAttachments, type InboundMedia } from "../src/services/attachment.service.js";
import { batchSpokenText, type InboundWhatsAppText } from "../src/services/whatsapp.service.js";
import { createInboundBatcher, mediaBatchHoldUntil } from "../src/services/whatsapp-inbound-batch.js";
import { loadHeldSubmission, routeWhatsAppSubmission } from "../src/services/whatsapp-submission.service.js";
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

const T0 = Date.parse("2030-01-01T10:00:00.000Z");

describe("M7: files sent together, delivered >3 s apart → one request (real path)", () => {
  const accounts: HarnessAccount[] = [];
  const phones: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    await prisma.whatsAppSubmission.deleteMany({ where: { phone: { in: phones.splice(0) } } });
    while (accounts.length > 0) {
      const account = accounts.pop()!;
      await prisma.attachmentLink
        .deleteMany({ where: { attachment: { userId: account.userId } } })
        .catch(() => undefined);
      await prisma.attachment.deleteMany({ where: { userId: account.userId } }).catch(() => undefined);
      await prisma.employeeFiling.deleteMany({ where: { employeeId: account.employeeId } }).catch(() => undefined);
      await cleanupHarnessAccount(account);
    }
  });

  async function setup() {
    const account = await createHarnessAccount("טל");
    accounts.push(account);
    const phone = `9726${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
    phones.push(phone);
    const failing = new Set<string>();
    const ingested: string[] = [];
    const notices: string[] = [];
    let clock = T0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let nextId = 1;
    const flushed: InboundWhatsAppText[][] = [];
    const batcher = createInboundBatcher<InboundWhatsAppText>({
      idleMs: 3_000,
      maxMs: 15_000,
      flush: (_phone, batch) => flushed.push(batch),
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { at: clock + ms, fn });
        return id;
      },
      clearTimer: (handle) => timers.delete(handle as number),
      now: () => clock,
      holdUntil: (batch) => mediaBatchHoldUntil(batch, { enabled: true, windowMs: 10_000 }),
    });
    const at = (ms: number) => {
      const target = T0 + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        clock = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      clock = target;
    };
    const offer = (message: InboundWhatsAppText) => batcher.offer(phone, message, Boolean(message.media));
    const deps = {
      ingest: async (media: InboundMedia): Promise<Attachment | null> => {
        ingested.push(media.mediaId);
        if (failing.has(media.mediaId)) return null;
        const id = randomUUID();
        return prisma.attachment.create({
          data: {
            id,
            userId: account.userId,
            uploaderId: account.employeeId,
            kind: media.kind,
            mimeType: media.mimeType,
            fileName: media.fileName,
            storageKey: `eval/${id}`,
            sizeBytes: 1024,
          },
        });
      },
      notify: async (text: string, _buttons: LlmReplyButton[]) => {
        notices.push(text);
      },
      now: () => new Date(clock),
    };
    const route = (batch: InboundWhatsAppText[]) =>
      routeWhatsAppSubmission({ phone, userId: account.userId, employeeId: account.employeeId, batch }, deps);
    return { account, phone, failing, ingested, notices, flushed, at, offer, route };
  }

  const doc = (phone: string, mediaId: string, fileName: string, sha256: string, sentAtMs: number): InboundWhatsAppText => ({
    from: phone,
    text: "",
    messageId: `wamid.${randomUUID()}`,
    sentAt: new Date(sentAtMs).toISOString(),
    media: { kind: "document", mediaId, mimeType: "application/pdf", caption: "", fileName, voice: false, sha256 },
  });
  const text = (phone: string, body: string, sentAtMs: number): InboundWhatsAppText => ({
    from: phone,
    text: body,
    messageId: `wamid.${randomUUID()}`,
    sentAt: new Date(sentAtMs).toISOString(),
  });

  it("two tickets sent together, delivered 6 s apart, + request text → ONE turn: one filing linked to both", async () => {
    const t = await setup();
    t.at(1_000);
    t.offer(doc(t.phone, "m1", "ticket-1.pdf", "h1", T0));
    t.at(7_000);
    t.offer(doc(t.phone, "m2", "ticket-2.pdf", "h2", T0));
    t.at(8_000);
    t.offer(text(t.phone, "תתייקי את שני הכרטיסים תחת ההופעה", T0 + 8_000));
    t.at(60_000);
    expect(t.flushed).toHaveLength(1);

    const result = await t.route(t.flushed[0]!);
    expect(result.kind).toBe("run");
    if (result.kind !== "run") return;
    expect(result.stored.map((s) => s.row.fileName)).toEqual(["ticket-1.pdf", "ticket-2.pdf"]);

    const lucyId = await ensureLucy(t.account);
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);
    const ids = result.stored.map((s) => s.row.id);
    const client = stubLlmReply({
      responses: [{ text: "תייקתי את שני הכרטיסים.", buttons: [] }],
      metadata: {
        lists: [{ action: "add", list_type: "filing", list_name: "", items: [{ item_name: "כרטיסים להופעה", item_info: "", item_description: "", attachment_ids: ids }] }],
      },
    });
    const createResponse = vi.spyOn(client, "createResponse");
    setLlmClientForTests(client);
    await sendChatMessage({
      userId: t.account.userId,
      employeeId: t.account.employeeId,
      digitalEmployeeId: lucyId,
      message: batchSpokenText(result.batch, []),
      attachments: await buildTurnAttachments(result.stored),
    });
    expect(createResponse).toHaveBeenCalledTimes(1);
    const filings = await prisma.employeeFiling.findMany({ where: { employeeId: t.account.employeeId, deletedAt: null } });
    expect(filings).toHaveLength(1);
    const links = await prisma.attachmentLink.findMany({ where: { attachment: { userId: t.account.userId } } });
    expect(links.map((l) => l.attachmentId).sort()).toEqual([...ids].sort());
    expect(links.every((l) => l.filingId === filings[0]!.id)).toBe(true);
  }, 120_000);

  it("partial failure in a grouped batch → the whole request is held (no turn); the same-file resend completes it once", async () => {
    const t = await setup();
    t.failing.add("m2");
    t.at(1_000);
    t.offer(doc(t.phone, "m1", "ticket-1.pdf", "h1", T0));
    t.at(6_000);
    t.offer(doc(t.phone, "m2", "ticket-2.pdf", "h2", T0));
    t.at(7_000);
    t.offer(text(t.phone, "תתייקי את שני הכרטיסים", T0 + 7_000));
    t.at(60_000);
    expect(t.flushed).toHaveLength(1);
    const grouped = t.flushed[0]!;

    expect((await t.route(grouped)).kind).toBe("handled");
    const held = await loadHeldSubmission(t.phone);
    expect(held?.batch.map((m) => m.messageId)).toEqual(grouped.map((m) => m.messageId));
    expect(held?.missing).toHaveLength(1);
    expect(t.notices.at(-1)).toContain("ticket-2.pdf");

    // A duplicate delivery of the grouped batch is ignored (no second message, nothing re-downloaded).
    const before = { notices: t.notices.length, ingested: t.ingested.length };
    expect((await t.route(grouped)).kind).toBe("handled");
    expect(t.notices.length).toBe(before.notices);
    expect(t.ingested.length).toBe(before.ingested);

    const resent = await t.route([doc(t.phone, "m2-resent", "ticket-2.pdf", "h2", T0 + 120_000)]);
    expect(resent.kind).toBe("run");
    if (resent.kind !== "run") return;
    expect(resent.batch.map((m) => m.messageId)).toEqual(grouped.map((m) => m.messageId));
    expect(resent.stored.map((s) => s.row.fileName)).toEqual(["ticket-1.pdf", "ticket-2.pdf"]);
    expect(await loadHeldSubmission(t.phone)).toBeNull();
  }, 120_000);

  it("a file sent after the group closed is its own request — never merged into the earlier one", async () => {
    const t = await setup();
    t.at(1_000);
    t.offer(doc(t.phone, "m1", "ticket-1.pdf", "h1", T0));
    t.at(30_000);
    t.offer(doc(t.phone, "m2", "ticket-2.pdf", "h2", T0 + 29_000));
    t.at(90_000);
    expect(t.flushed.map((b) => b.map((m) => m.media?.fileName))).toEqual([["ticket-1.pdf"], ["ticket-2.pdf"]]);
  }, 60_000);
});
