/**
 * Held WhatsApp requests — expiry (M6), on approved workee_test with the real
 * store. A held request is never run once its time is up
 * (WHATSAPP_SUBMISSION_EXPIRY_MINUTES, default 20): the user is told which file
 * never arrived; files that did arrive stay stored and unlinked. Recovery after
 * a restart needs only the DB row. Downloads and sends are injected fakes.
 *
 * Run: npm run test:eval-db -- tests/whatsapp-submission-expiry.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Attachment } from "@prisma/client";
import type { LlmReplyButton } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { type InboundMedia } from "../src/services/attachment.service.js";
import { type InboundWhatsAppText } from "../src/services/whatsapp.service.js";
import {
  expireHeldSubmissions,
  loadHeldSubmission,
  routeWhatsAppSubmission,
} from "../src/services/whatsapp-submission.service.js";
import {
  cleanupHarnessAccount,
  createHarnessAccount,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
});

const MINUTE = 60_000;

describe("held WhatsApp requests — expiry (WHATSAPP_SUBMISSION_EXPIRY_MINUTES, default 20)", () => {
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

  it("sweep after 20 minutes → released, not run, user told which file never arrived; received file kept unlinked", async () => {
    const t = await setup();
    t.failing.add("m2");
    await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "ticket-2.pdf", "h2"), text(t.phone, "תתייקי")]);
    const held = await loadHeldSubmission(t.phone);
    const sent: Array<{ phone: string; text: string }> = [];
    const notify = async (phone: string, body: string) => {
      sent.push({ phone, text: body });
    };
    expect(await expireHeldSubmissions(notify, new Date(t.now().getTime() + 19 * MINUTE))).toBe(0);
    expect(await loadHeldSubmission(t.phone)).not.toBeNull();
    expect(await expireHeldSubmissions(notify, new Date(t.now().getTime() + 20 * MINUTE))).toBeGreaterThanOrEqual(1);
    const mine = sent.filter((s) => s.phone === t.phone);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("לא בוצעה");
    expect(mine[0]!.text).toContain("ticket-2.pdf");
    expect(await loadHeldSubmission(t.phone)).toBeNull();
    expect(await prisma.attachmentLink.count({ where: { attachmentId: held!.received[0]!.attachmentId } })).toBe(0);
    // Resend after expiry → a new request on its own.
    const after = await t.route([doc(t.phone, "m2r", "ticket-2.pdf", "h2")]);
    expect(after.kind).toBe("run");
    if (after.kind === "run") expect(after.batch).toHaveLength(1);
  });

  it("a message after the expiry time but before the sweep → the held request expires first (told once), then the message is handled normally", async () => {
    const t = await setup();
    t.failing.add("m2");
    await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2")]);
    t.advance(21 * MINUTE);
    const result = await t.route([text(t.phone, "היי")]);
    expect(result.kind).toBe("run");
    const expiredNotices = t.notices.filter((n) => n.text.includes("לא בוצעה"));
    expect(expiredNotices).toHaveLength(1);
    expect(await loadHeldSubmission(t.phone)).toBeNull();
    // The sweep later finds nothing to expire for this phone.
    const sent: string[] = [];
    await expireHeldSubmissions(async (phone) => {
      sent.push(phone);
    }, new Date(t.now().getTime() + MINUTE));
    expect(sent).not.toContain(t.phone);
  });

  it("recovery after restart: a request held before a restart is expired by the start-up sweep", async () => {
    const t = await setup();
    t.failing.add("m2");
    await t.route([doc(t.phone, "m1", "a.pdf", "h1"), doc(t.phone, "m2", "b.pdf", "h2")]);
    // A new process runs the sweep on start; it only needs the DB row.
    const sent: string[] = [];
    await expireHeldSubmissions(async (phone) => {
      sent.push(phone);
    }, new Date(t.now().getTime() + 30 * MINUTE));
    expect(sent).toContain(t.phone);
    expect(await loadHeldSubmission(t.phone)).toBeNull();
  });
});
