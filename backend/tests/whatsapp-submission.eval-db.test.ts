/**
 * Held WhatsApp requests (missing file) — persistence, boundaries, resend
 * and cancel (M5), on approved workee_test with the real store and the real
 * production turn path (sendChatMessage, scripted model). Downloads and
 * WhatsApp sends are injected fakes; no OpenAI, WhatsApp or reminder ticker.
 *
 * Run: npm run test:eval-db -- tests/whatsapp-submission.eval-db.test.ts
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
import {
  CANCEL_SUBMISSION_COMMAND,
  CANCELLED_MESSAGE,
  CONFIRM_RESEND_COMMAND,
  NOTHING_PENDING_MESSAGE,
  expireHeldSubmissions,
  loadHeldSubmission,
  routeWhatsAppSubmission,
} from "../src/services/whatsapp-submission.service.js";
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

const MINUTE = 60_000;

/** The held request's content (what must never change when other messages arrive). */
async function heldContent(phone: string) {
  const held = await loadHeldSubmission(phone);
  return JSON.stringify(held && { batch: held.batch, received: held.received, missing: held.missing });
}

describe("held WhatsApp requests (missing file)", () => {
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

  /** One phone + account; `failing` media ids are "not received" by the fake download. */
  async function setup() {
    const account = await createHarnessAccount("טל");
    accounts.push(account);
    const phone = `9725${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
    phones.push(phone);
    const failing = new Set<string>();
    const ingested: string[] = [];
    const notices: Array<{ text: string; buttons: string[] }> = [];
    let clock = new Date("2030-01-01T10:00:00.000Z");
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
      notify: async (text: string, buttons: LlmReplyButton[]) => {
        notices.push({ text, buttons: buttons.map((b) => b.command) });
      },
      now: () => clock,
    };
    const route = (batch: InboundWhatsAppText[]) =>
      routeWhatsAppSubmission(
        { phone, userId: account.userId, employeeId: account.employeeId, batch },
        deps,
      );
    const advance = (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    };
    return { account, phone, failing, ingested, notices, route, advance, now: () => clock };
  }

  const doc = (phone: string, mediaId: string, fileName: string, sha256: string, caption = ""): InboundWhatsAppText => ({
    from: phone,
    text: caption,
    messageId: `wamid.${randomUUID()}`,
    media: { kind: "document", mediaId, mimeType: "application/pdf", caption, fileName, voice: false, sha256 },
  });
  const text = (phone: string, body: string): InboundWhatsAppText => ({
    from: phone,
    text: body,
    messageId: `wamid.${randomUUID()}`,
  });

  it("all files received → runs the request as is (nothing held)", async () => {
    const t = await setup();
    const result = await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2"), text(t.phone, "תתייקי")]);
    expect(result.kind).toBe("run");
    if (result.kind !== "run") return;
    expect(result.stored).toHaveLength(2);
    expect(t.notices).toEqual([]);
    expect(await loadHeldSubmission(t.phone)).toBeNull();
  });

  it("1 of 2 downloads fails → no run; held with the received file; message names the missing file + cancel", async () => {
    const t = await setup();
    t.failing.add("m2");
    const request = [doc(t.phone, "m1", "ticket-1.pdf", "h1"), doc(t.phone, "m2", "ticket-2.pdf", "h2"), text(t.phone, "תתייקי את שני הכרטיסים")];
    const result = await t.route(request);
    expect(result.kind).toBe("handled");
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]!.buttons).toEqual([CANCEL_SUBMISSION_COMMAND]);
    expect(t.notices[0]!.text).toContain("ticket-2.pdf");
    expect(t.notices[0]!.text).toContain("1 מתוך 2");
    const held = await loadHeldSubmission(t.phone);
    expect(held?.missing.map((f) => f.fileName)).toEqual(["ticket-2.pdf"]);
    expect(held?.received).toHaveLength(1);
    expect(held?.batch.map((m) => m.text)).toEqual(["", "", "תתייקי את שני הכרטיסים"]);
    expect(held!.expiresAt.getTime() - t.now().getTime()).toBe(20 * MINUTE);
    // The received file is stored but linked to nothing.
    const received = held!.received[0]!.attachmentId;
    expect(await prisma.attachmentLink.count({ where: { attachmentId: received } })).toBe(0);
  });

  it("the only file fails and there is text → still held, never run as text alone", async () => {
    const t = await setup();
    t.failing.add("m1");
    const result = await t.route([doc(t.phone, "m1", "ticket.pdf", "h1"), text(t.phone, "תתייקי")]);
    expect(result.kind).toBe("handled");
    expect(t.notices[0]!.text).toContain("ticket.pdf");
    expect(t.notices[0]!.text).not.toContain("מתוך");
    expect(await loadHeldSubmission(t.phone)).not.toBeNull();
  });

  it("text while held → not run, not merged; same explanation + cancel; held request unchanged", async () => {
    const t = await setup();
    t.failing.add("m2");
    await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2"), text(t.phone, "בקשה מקורית")]);
    const before = await heldContent(t.phone);
    const result = await t.route([text(t.phone, "תוסיפי חלב לקניות")]);
    expect(result.kind).toBe("handled");
    expect(t.notices.at(-1)!.buttons).toEqual([CANCEL_SUBMISSION_COMMAND]);
    expect(t.notices.at(-1)!.text).toContain("b.pdf");
    expect(await heldContent(t.phone)).toBe(before);
  });

  it("a different file, an unrelated button command, or a resend WITH a caption while held → blocked the same way", async () => {
    const t = await setup();
    t.failing.add("m2");
    await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2")]);
    const before = await heldContent(t.phone);
    for (const batch of [
      [doc(t.phone, "m9", "other.pdf", "h9")],
      [text(t.phone, "סמן כבוצע: לשתות מים")],
      [doc(t.phone, "m3", "b.pdf", "h2", "הנה")],
    ]) {
      const ingestedBefore = t.ingested.length;
      expect((await t.route(batch)).kind).toBe("handled");
      expect(t.ingested.length).toBe(ingestedBefore); // nothing downloaded
      expect(t.notices.at(-1)!.buttons).toEqual([CANCEL_SUBMISSION_COMMAND]);
    }
    expect(await heldContent(t.phone)).toBe(before);
  });

  it("a different file while held → the reply says it was NOT downloaded or saved and to cancel first", async () => {
    const t = await setup();
    t.failing.add("m2");
    await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2")]);
    const attachmentsBefore = await prisma.attachment.count({ where: { userId: t.account.userId } });
    await t.route([doc(t.phone, "m9", "invoice.pdf", "h9")]);
    const reply = t.notices.at(-1)!;
    expect(reply.text).toContain("לא שמרתי את «invoice.pdf»");
    expect(reply.text).toContain("לא הורד");
    expect(reply.text).toContain("«b.pdf»");
    expect(reply.text).toContain("«ביטול»");
    expect(reply.buttons).toEqual([CANCEL_SUBMISSION_COMMAND]);
    expect(await prisma.attachment.count({ where: { userId: t.account.userId } })).toBe(attachmentsBefore);
  });

  it("resend of the same file (sha256) → ONE run with the original request text and both files in order", async () => {
    const t = await setup();
    t.failing.add("m2");
    const original = [doc(t.phone, "m1", "ticket-1.pdf", "h1"), doc(t.phone, "m2", "ticket-2.pdf", "h2"), text(t.phone, "תתייקי את שני הכרטיסים")];
    await t.route(original);
    await t.route([text(t.phone, "טקסט שלא אמור להיכנס")]);
    const result = await t.route([doc(t.phone, "m2-resent", "ticket-2.pdf", "h2")]);
    expect(result.kind).toBe("run");
    if (result.kind !== "run") return;
    expect(result.batch.map((m) => m.messageId)).toEqual(original.map((m) => m.messageId));
    expect(batchSpokenText(result.batch, [])).toBe("תתייקי את שני הכרטיסים");
    expect(result.stored.map((s) => s.row.fileName)).toEqual(["ticket-1.pdf", "ticket-2.pdf"]);
    expect(await loadHeldSubmission(t.phone)).toBeNull();

    // Real production turn: one sendChatMessage with both files → one filing linked to both.
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

  it("resend that fails again → still held, told again; later successful resend completes", async () => {
    const t = await setup();
    t.failing.add("m2");
    t.failing.add("m2b");
    await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2")]);
    expect((await t.route([doc(t.phone, "m2b", "b.pdf", "h2")])).kind).toBe("handled");
    expect(t.notices.at(-1)!.text).toContain("b.pdf");
    expect(await loadHeldSubmission(t.phone)).not.toBeNull();
    expect((await t.route([doc(t.phone, "m2c", "b.pdf", "h2")])).kind).toBe("run");
  });

  it("no sha256: a same-kind same-name file is NOT accepted automatically — explicit confirmation first", async () => {
    const t = await setup();
    t.failing.add("m2");
    await t.route([doc(t.phone, "m1", "a.pdf", ""), doc(t.phone, "m2", "b.pdf", ""), text(t.phone, "בקשה")]);
    const ingestedBefore = t.ingested.length;
    expect((await t.route([doc(t.phone, "m2x", "b.pdf", "")])).kind).toBe("handled");
    expect(t.ingested.length).toBe(ingestedBefore); // not downloaded yet
    expect(t.notices.at(-1)!.text).toContain("«b.pdf»");
    expect(t.notices.at(-1)!.buttons).toEqual([CONFIRM_RESEND_COMMAND, CANCEL_SUBMISSION_COMMAND]);
    expect((await loadHeldSubmission(t.phone))?.missing).toHaveLength(1);
    // Confirmed → downloaded and the request runs once, with the original text.
    const result = await t.route([text(t.phone, CONFIRM_RESEND_COMMAND)]);
    expect(result.kind).toBe("run");
    if (result.kind !== "run") return;
    expect(batchSpokenText(result.batch, [])).toBe("בקשה");
    expect(result.stored.map((s) => s.row.fileName)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("no sha256: anything other than the confirmation drops the candidate; it is never used later", async () => {
    const t = await setup();
    t.failing.add("m2");
    await t.route([doc(t.phone, "m1", "a.pdf", ""), doc(t.phone, "m2", "b.pdf", "")]);
    await t.route([doc(t.phone, "m2x", "b.pdf", "")]);
    await t.route([text(t.phone, "רגע")]); // not a confirmation
    expect((await loadHeldSubmission(t.phone))?.candidate).toBeNull();
    const ingestedBefore = t.ingested.length;
    expect((await t.route([text(t.phone, CONFIRM_RESEND_COMMAND)])).kind).toBe("handled");
    expect(t.ingested.length).toBe(ingestedBefore);
    expect((await loadHeldSubmission(t.phone))?.missing).toHaveLength(1);
  });

  it("sha256 present but different, same name → a different file, never treated as the missing one", async () => {
    const t = await setup();
    t.failing.add("m2");
    await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2")]);
    const ingestedBefore = t.ingested.length;
    expect((await t.route([doc(t.phone, "m2x", "b.pdf", "OTHER")])).kind).toBe("handled");
    expect(t.ingested.length).toBe(ingestedBefore);
    expect(t.notices.at(-1)!.text).toContain("לא שמרתי");
  });

  it("cancel button → released; no run; received file stays unlinked; next text runs normally", async () => {
    const t = await setup();
    t.failing.add("m2");
    await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2"), text(t.phone, "תתייקי")]);
    const held = await loadHeldSubmission(t.phone);
    expect((await t.route([text(t.phone, CANCEL_SUBMISSION_COMMAND)])).kind).toBe("handled");
    expect(t.notices.at(-1)).toEqual({ text: CANCELLED_MESSAGE, buttons: [] });
    expect(await loadHeldSubmission(t.phone)).toBeNull();
    expect(await prisma.attachmentLink.count({ where: { attachmentId: held!.received[0]!.attachmentId } })).toBe(0);
    const next = await t.route([text(t.phone, "תוסיפי חלב לקניות")]);
    expect(next.kind).toBe("run");
  });

  it("cancel with nothing held → fixed reply, no run", async () => {
    const t = await setup();
    expect((await t.route([text(t.phone, CANCEL_SUBMISSION_COMMAND)])).kind).toBe("handled");
    expect(t.notices).toEqual([{ text: NOTHING_PENDING_MESSAGE, buttons: [] }]);
  });

  it("another phone is never affected by a held request", async () => {
    const a = await setup();
    const b = await setup();
    a.failing.add("m2");
    await a.route([doc(a.phone, "m1", "a.pdf", "h1"), doc(a.phone, "m2", "b.pdf", "h2")]);
    expect((await b.route([text(b.phone, "היי")])).kind).toBe("run");
    expect((await b.route([text(b.phone, CANCEL_SUBMISSION_COMMAND)])).kind).toBe("handled");
    expect(await loadHeldSubmission(a.phone)).not.toBeNull();
  });

  it("restart: the held state lives only in the DB — a fresh load still blocks, resends and cancels", async () => {
    const t = await setup();
    t.failing.add("m2");
    await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2")]);
    // No in-memory state exists in the module; a fresh lookup is what a restarted process sees.
    const reloaded = await loadHeldSubmission(t.phone);
    expect(reloaded?.missing).toHaveLength(1);
    expect((await t.route([text(t.phone, "משהו")])).kind).toBe("handled");
    expect((await t.route([doc(t.phone, "m2r", "b.pdf", "h2")])).kind).toBe("run");
  });

  it("a resend after completion is a new request, never merged into the finished one", async () => {
    const t = await setup();
    t.failing.add("m2");
    await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2"), text(t.phone, "בקשה")]);
    expect((await t.route([doc(t.phone, "m2r", "b.pdf", "h2")])).kind).toBe("run");
    const again = await t.route([doc(t.phone, "m2rr", "b.pdf", "h2")]);
    expect(again.kind).toBe("run");
    if (again.kind !== "run") return;
    expect(again.batch).toHaveLength(1);
    expect(batchSpokenText(again.batch, [])).toBe("");
  });


  describe("exactly once: duplicate deliveries and concurrent processing", () => {
    it("a duplicate delivery of the original (failing) batch → silently ignored; one message, one held request", async () => {
      const t = await setup();
      t.failing.add("m2");
      const request = [doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2")];
      await t.route(request);
      const ingestedBefore = t.ingested.length;
      expect((await t.route(request)).kind).toBe("handled");
      expect(t.notices).toHaveLength(1);
      expect(t.ingested.length).toBe(ingestedBefore);
    });

    it("a duplicate delivery of the resend after completion → ignored: no second run, no extra link or filing", async () => {
      const t = await setup();
      t.failing.add("m2");
      await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2"), text(t.phone, "תתייקי")]);
      const resend = [doc(t.phone, "m2r", "b.pdf", "h2")];
      expect((await t.route(resend)).kind).toBe("run");
      const ingestedBefore = t.ingested.length;
      expect((await t.route(resend)).kind).toBe("handled");
      expect(t.ingested.length).toBe(ingestedBefore);
      expect(await prisma.attachment.count({ where: { userId: t.account.userId } })).toBe(2);
    });

    it("a duplicate delivery of a blocked text → ignored (no second explanation)", async () => {
      const t = await setup();
      t.failing.add("m2");
      await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2")]);
      const msg = [text(t.phone, "חלב")];
      await t.route(msg);
      const count = t.notices.length;
      expect((await t.route(msg)).kind).toBe("handled");
      expect(t.notices).toHaveLength(count);
    });

    it("the same resend delivered twice concurrently → exactly one run, one download", async () => {
      const t = await setup();
      t.failing.add("m2");
      await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2")]);
      const resend = [doc(t.phone, "m2r", "b.pdf", "h2")];
      const ingestedBefore = t.ingested.length;
      const results = await Promise.all([t.route(resend), t.route(resend), t.route(resend)]);
      expect(results.filter((r) => r.kind === "run")).toHaveLength(1);
      expect(t.ingested.length - ingestedBefore).toBe(1);
    });

    it("two different deliveries of the missing file concurrently → exactly one run, one download", async () => {
      const t = await setup();
      t.failing.add("m2");
      await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2")]);
      const ingestedBefore = t.ingested.length;
      const results = await Promise.all([
        t.route([doc(t.phone, "m2r1", "b.pdf", "h2")]),
        t.route([doc(t.phone, "m2r2", "b.pdf", "h2")]),
      ]);
      expect(results.filter((r) => r.kind === "run")).toHaveLength(1);
      expect(t.ingested.length - ingestedBefore).toBe(1);
    });

    it("expiry sweep and a resend at the same moment → completion XOR expiry, never both (20 rounds)", async () => {
      for (let round = 0; round < 20; round += 1) {
        const t = await setup();
        t.failing.add("m2");
        await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2")]);
        const held = await loadHeldSubmission(t.phone);
        // The resend arrives just before the deadline; the sweep runs at the deadline.
        t.advance(held!.expiresAt.getTime() - t.now().getTime() - 1);
        const expiredFor: string[] = [];
        // Stagger the start of each side differently per round so both orders are exercised.
        const wait = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const [route] = await Promise.all([
          (async () => {
            await wait(round % 4);
            return t.route([doc(t.phone, `m2r-${round}`, "b.pdf", "h2")]);
          })(),
          (async () => {
            await wait(Math.floor(round / 4) % 4);
            return expireHeldSubmissions(async (phone) => {
              expiredFor.push(phone);
            }, held!.expiresAt);
          })(),
        ]);
        // "completed" = the held request ran (its original 2-file batch). If the sweep won,
        // the late file may only run as a NEW request of its own (1 message), never the held one.
        const completed = route.kind === "run" && route.batch.length === 2;
        const expired = expiredFor.includes(t.phone);
        expect(completed !== expired, `round ${round}: completed=${completed} expired=${expired}`).toBe(true);
        if (expired && route.kind === "run") expect(route.batch).toHaveLength(1);
      }
    }, 120_000);
  });
});
