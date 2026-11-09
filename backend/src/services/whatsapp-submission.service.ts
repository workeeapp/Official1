/**
 * WhatsApp requests whose files did not all arrive.
 *
 * WhatsApp delivers every file as its own message; a request (text + files) is
 * one batch (see whatsapp-inbound-batch). When a file of the batch cannot be
 * downloaded (after retries), the request is NOT run with part of its files:
 * it is held here, the user is told exactly which file is missing, and can
 * resend that same file or cancel. While a request is held, nothing else from
 * that phone is run or merged into it — the user is told why, with the cancel
 * button. After WHATSAPP_SUBMISSION_EXPIRY_MINUTES the held request expires: it
 * is not run, and the user is told so.
 *
 * Deterministic only: a resend is recognised by WhatsApp's file SHA-256; without
 * one, a same-kind same-name file needs the user's explicit confirmation (fixed
 * button). Cancel is a fixed button command. No message text is interpreted.
 *
 * Exactly once: a resend claims the row in the DB before downloading; completion
 * and expiry are conditional writes on that claim, so they are mutually
 * exclusive and a request runs at most once. A completed row is kept briefly so
 * a duplicate webhook delivery of the same messages is recognised and ignored.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type Attachment } from "@prisma/client";
import type { AttachmentKind, LlmReplyButton } from "@workee/shared";
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import type { InboundMedia } from "./attachment.service.js";

/** Fixed commands behind the buttons (WhatsApp button reply ids). */
export const CANCEL_SUBMISSION_COMMAND = "ביטול הבקשה שממתינה לקובץ";
export const CONFIRM_RESEND_COMMAND = "כן, זה הקובץ שחסר לבקשה";
export const CANCEL_SUBMISSION_BUTTON: LlmReplyButton = {
  label: "ביטול",
  command: CANCEL_SUBMISSION_COMMAND,
};
export const CONFIRM_RESEND_BUTTON: LlmReplyButton = {
  label: "כן, זה הקובץ",
  command: CONFIRM_RESEND_COMMAND,
};

/** A claim older than this is treated as abandoned (process died mid-resend). */
const STALE_CLAIM_MS = 5 * 60_000;
/** How long a completed row is kept to recognise duplicate webhook deliveries. */
const COMPLETED_KEEP_MS = 10 * 60_000;

/** The part of an inbound WhatsApp message this module needs. */
export interface SubmissionMessage {
  messageId: string;
  text: string;
  media?: InboundMedia;
}

export interface MissingFile {
  /** Position of the file's message in the original batch. */
  index: number;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sha256: string;
}

export interface ReceivedFile {
  index: number;
  attachmentId: string;
}

/** A same-kind same-name file (no SHA-256) waiting for the user's confirmation. */
export interface ResendCandidate {
  index: number;
  media: InboundMedia;
}

export interface HeldSubmission<T extends SubmissionMessage> {
  phone: string;
  userId: string;
  employeeId: string;
  batch: T[];
  received: ReceivedFile[];
  missing: MissingFile[];
  candidate: ResendCandidate | null;
  handledIds: string[];
  claimedBy: string | null;
  claimedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date;
}

/** What the caller does next: run a turn with these messages + files, or nothing (already answered). */
export type SubmissionRoute<T extends SubmissionMessage> =
  | { kind: "run"; batch: T[]; stored: Array<{ row: Attachment; voice: boolean }> }
  | { kind: "handled" };

export interface SubmissionDeps {
  /** Download + store one file; null when it could not be received (after retries). */
  ingest: (media: InboundMedia) => Promise<Attachment | null>;
  /** Send a fixed server message to this phone, with these buttons (may be none). */
  notify: (text: string, buttons: LlmReplyButton[]) => Promise<unknown>;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Fixed user-facing texts (server-owned: a file fetch failed).

const KIND_HE: Record<AttachmentKind, string> = {
  image: "תמונה",
  video: "סרטון",
  audio: "הקלטה",
  document: "מסמך",
  sticker: "מדבקה",
};

/** «ticket.pdf» or «מסמך (קובץ 2)» when WhatsApp gave no file name. */
export function describeMissingFile(file: Pick<MissingFile, "index" | "kind" | "fileName">): string {
  const name = file.fileName.trim();
  return name ? `«${name}»` : `${KIND_HE[file.kind] ?? "קובץ"} (קובץ ${file.index + 1})`;
}

function missingList(missing: MissingFile[]): string {
  return missing.map(describeMissingFile).join(", ");
}

export function missingFilesMessage(received: number, missing: MissingFile[]): string {
  const total = received + missing.length;
  return [
    received > 0
      ? `קיבלתי ${received} מתוך ${total} קבצים. לא הצלחתי לקבל את: ${missingList(missing)}.`
      : `לא הצלחתי לקבל את: ${missingList(missing)}.`,
    "הבקשה ממתינה. שלחו שוב את אותו קובץ כדי שאמשיך איתה, או לחצו «ביטול».",
  ].join("\n");
}

export function heldRequestMessage(missing: MissingFile[]): string {
  return [
    `יש בקשה שממתינה לקובץ: ${missingList(missing)}.`,
    "שלחו שוב את אותו קובץ כדי שאמשיך איתה, או לחצו «ביטול» ואז שלחו את ההודעה מחדש.",
  ].join("\n");
}

/** A file that is not the missing one arrived while a request is held: it was NOT downloaded. */
export function differentFileMessage(incoming: InboundMedia[], missing: MissingFile[]): string {
  const names = incoming
    .map((media, index) => describeMissingFile({ index, kind: media.kind, fileName: media.fileName }))
    .join(", ");
  return [
    `לא שמרתי את ${names} — ${incoming.length === 1 ? "הקובץ לא הורד" : "הקבצים לא הורדו"}.`,
    `יש בקשה שממתינה לקובץ: ${missingList(missing)}.`,
    "כדי לשלוח בקשה אחרת עם קבצים, לחצו קודם «ביטול» ואז שלחו אותה שוב יחד עם הקבצים.",
  ].join("\n");
}

/** Same kind + same name, but WhatsApp sent no SHA-256: ask before treating it as the missing file. */
export function confirmResendMessage(media: InboundMedia, target: MissingFile): string {
  return [
    `קיבלתי קובץ בשם ${describeMissingFile({ index: target.index, kind: media.kind, fileName: media.fileName })}.`,
    "זה הקובץ שחסר לבקשה? אם כן לחצו «כן, זה הקובץ», אחרת «ביטול».",
  ].join("\n");
}

export const CANCELLED_MESSAGE = "בוטל. אפשר לשלוח את הבקשה מחדש.";
export const NOTHING_PENDING_MESSAGE = "אין כרגע בקשה שממתינה לקובץ.";

export function expiredMessage(missing: MissingFile[]): string {
  return [
    missing.length === 1
      ? `הבקשה לא בוצעה, כי הקובץ ${missingList(missing)} לא הגיע.`
      : `הבקשה לא בוצעה, כי הקבצים ${missingList(missing)} לא הגיעו.`,
    "הקבצים שכן הגיעו שמורים אצלי. כדי להמשיך, שלחו שוב את כל הקבצים יחד עם ההוראה.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Store (one row per phone).

export function submissionExpiryMs(): number {
  return getEnv().WHATSAPP_SUBMISSION_EXPIRY_MINUTES * 60_000;
}

function asArray<T>(value: Prisma.JsonValue | null | undefined): T[] {
  return Array.isArray(value) ? (value as unknown as T[]) : [];
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

/** The request currently waiting for a file, or null (a completed request is not held). */
export async function loadHeldSubmission<T extends SubmissionMessage>(
  phone: string,
): Promise<HeldSubmission<T> | null> {
  const row = await loadSubmissionRow<T>(phone);
  return row && !row.completedAt ? row : null;
}

/** The row for this phone, including a completed tombstone kept for duplicate detection. */
async function loadSubmissionRow<T extends SubmissionMessage>(
  phone: string,
): Promise<HeldSubmission<T> | null> {
  const row = await prisma.whatsAppSubmission.findUnique({ where: { phone } });
  if (!row) return null;
  return {
    phone: row.phone,
    userId: row.userId,
    employeeId: row.employeeId,
    batch: asArray<T>(row.batch),
    received: asArray<ReceivedFile>(row.received),
    missing: asArray<MissingFile>(row.missing),
    candidate: (row.candidate as unknown as ResendCandidate | null) ?? null,
    handledIds: asArray<string>(row.handledIds),
    claimedBy: row.claimedBy,
    claimedAt: row.claimedAt,
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
  };
}

/** Row still waiting, not claimed by a live resend (a stale claim counts as free). */
function openUnclaimed(phone: string, now: Date): Prisma.WhatsAppSubmissionWhereInput {
  return {
    phone,
    completedAt: null,
    OR: [{ claimedBy: null }, { claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } }],
  };
}

/** Expire one row if it is due and free. True when THIS call expired it. */
async function expireOne(phone: string, now: Date): Promise<boolean> {
  const { count } = await prisma.whatsAppSubmission.deleteMany({
    where: { ...openUnclaimed(phone, now), expiresAt: { lte: now } },
  });
  return count > 0;
}

// ---------------------------------------------------------------------------
// Routing one inbound batch.

function isCommand(batch: SubmissionMessage[], command: string): boolean {
  return batch.length > 0 && batch.every((m) => !m.media && m.text.trim() === command);
}

function bySha256(media: InboundMedia, missing: MissingFile[]): MissingFile | undefined {
  const hash = media.sha256?.trim() ?? "";
  return hash ? missing.find((file) => file.sha256 && file.sha256 === hash) : undefined;
}

/** Same kind + same non-empty name, where a SHA-256 comparison is impossible. */
function byNameNeedsConfirm(media: InboundMedia, missing: MissingFile[]): MissingFile | undefined {
  const name = media.fileName.trim();
  if (!name) return undefined;
  const hash = media.sha256?.trim() ?? "";
  return missing.find(
    (file) => (!file.sha256 || !hash) && file.kind === media.kind && file.fileName === name,
  );
}

function missingFrom(media: InboundMedia, index: number): MissingFile {
  return {
    index,
    kind: media.kind,
    fileName: media.fileName,
    mimeType: media.mimeType,
    sha256: media.sha256?.trim() ?? "",
  };
}

async function storedInOrder(
  received: ReceivedFile[],
  batch: SubmissionMessage[],
): Promise<Array<{ row: Attachment; voice: boolean }>> {
  const ordered = [...received].sort((a, b) => a.index - b.index);
  if (ordered.length === 0) return [];
  const rows = await prisma.attachment.findMany({
    where: { id: { in: ordered.map((file) => file.attachmentId) } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ordered
    .map((file) => {
      const row = byId.get(file.attachmentId);
      return row ? { row, voice: batch[file.index]?.media?.voice === true } : null;
    })
    .filter((entry): entry is { row: Attachment; voice: boolean } => entry !== null);
}

/**
 * Claim the held row, download the resent files, then complete (one run) or
 * stay held. Returns null when the row could not be claimed because it no
 * longer exists (expired / cancelled meanwhile) — the caller then treats the
 * batch as a new request.
 */
async function processResend<T extends SubmissionMessage>(
  held: HeldSubmission<T>,
  files: Array<{ media: InboundMedia; target: MissingFile }>,
  incomingIds: string[],
  deps: SubmissionDeps,
  now: Date,
): Promise<SubmissionRoute<T> | null> {
  const token = randomUUID();
  const claimed = await prisma.whatsAppSubmission.updateMany({
    where: { ...openUnclaimed(held.phone, now), expiresAt: { gt: now } },
    data: { claimedBy: token, claimedAt: now },
  });
  if (claimed.count === 0) {
    // Gone → new request; still there → another delivery is completing it (or it is done/expired).
    return (await prisma.whatsAppSubmission.count({ where: { phone: held.phone } })) === 0
      ? null
      : { kind: "handled" };
  }
  let missing = [...held.missing];
  const received = [...held.received];
  for (const { media, target } of files) {
    if (!missing.includes(target)) continue; // a second copy of the same file in this batch
    const row = await deps.ingest(media);
    if (row) {
      received.push({ index: target.index, attachmentId: row.id });
      missing = missing.filter((file) => file !== target);
    }
  }
  const handledIds = [...new Set([...held.handledIds, ...incomingIds])];
  if (missing.length > 0) {
    await prisma.whatsAppSubmission.updateMany({
      where: { phone: held.phone, claimedBy: token },
      data: {
        received: json(received),
        missing: json(missing),
        candidate: Prisma.DbNull,
        handledIds: json(handledIds),
        claimedBy: null,
        claimedAt: null,
      },
    });
    await deps.notify(missingFilesMessage(received.length, missing), [CANCEL_SUBMISSION_BUTTON]);
    return { kind: "handled" };
  }
  const done = await prisma.whatsAppSubmission.updateMany({
    where: { phone: held.phone, claimedBy: token, completedAt: null },
    data: {
      received: json(received),
      missing: json([]),
      candidate: Prisma.DbNull,
      handledIds: json(handledIds),
      claimedBy: null,
      claimedAt: null,
      completedAt: now,
    },
  });
  if (done.count === 0) return { kind: "handled" };
  return { kind: "run", batch: held.batch, stored: await storedInOrder(received, held.batch) };
}

/**
 * Decide what to do with one inbound batch from `phone`. Downloads files via
 * `deps.ingest`; never runs the model itself — returns "run" with the exact
 * messages + files of ONE complete request (at most once per request), or
 * "handled" when the user has been answered with a fixed server message (or
 * the batch is a duplicate delivery and needs no answer).
 */
export async function routeWhatsAppSubmission<T extends SubmissionMessage>(
  input: { phone: string; userId: string; employeeId: string; batch: T[] },
  deps: SubmissionDeps,
): Promise<SubmissionRoute<T>> {
  const now = deps.now?.() ?? new Date();
  const incomingIds = input.batch.map((m) => m.messageId).filter(Boolean);
  let held = await loadSubmissionRow<T>(input.phone);

  if (held) {
    const known = new Set([...held.batch.map((m) => m.messageId), ...held.handledIds]);
    if (incomingIds.length > 0 && incomingIds.every((id) => known.has(id))) {
      return { kind: "handled" }; // duplicate webhook delivery: already handled
    }
    if (held.completedAt) {
      await prisma.whatsAppSubmission.deleteMany({
        where: { phone: input.phone, completedAt: { not: null } },
      });
      held = null;
    } else if (held.expiresAt.getTime() <= now.getTime()) {
      // Past its time (the sweep may not have run yet): expire it first, then treat this as new.
      if (await expireOne(input.phone, now)) {
        await deps.notify(expiredMessage(held.missing), []);
      }
      held = null;
    }
  }

  if (held) {
    if (isCommand(input.batch, CANCEL_SUBMISSION_COMMAND)) {
      const { count } = await prisma.whatsAppSubmission.deleteMany({
        where: openUnclaimed(input.phone, now),
      });
      if (count > 0) await deps.notify(CANCELLED_MESSAGE, []);
      return { kind: "handled" };
    }
    if (isCommand(input.batch, CONFIRM_RESEND_COMMAND) && held.candidate) {
      const target = held.missing.find((file) => file.index === held!.candidate!.index);
      if (target) {
        const result = await processResend(
          held,
          [{ media: held.candidate.media, target }],
          incomingIds,
          deps,
          now,
        );
        if (result) return result;
        held = null;
      }
    }
  }

  if (held) {
    const files = input.batch.filter((m) => m.media).map((m) => m.media!);
    const mediaOnly = files.length > 0 && files.length === input.batch.length && input.batch.every((m) => !m.text.trim());
    if (mediaOnly) {
      const exact = files.map((media) => ({ media, target: bySha256(media, held!.missing) }));
      if (exact.every((pair) => pair.target)) {
        const result = await processResend(
          held,
          exact as Array<{ media: InboundMedia; target: MissingFile }>,
          incomingIds,
          deps,
          now,
        );
        if (result) return result;
        held = null;
      } else if (files.length === 1 && byNameNeedsConfirm(files[0]!, held.missing)) {
        const target = byNameNeedsConfirm(files[0]!, held.missing)!;
        await prisma.whatsAppSubmission.updateMany({
          where: openUnclaimed(input.phone, now),
          data: {
            candidate: json({ index: target.index, media: files[0]! } satisfies ResendCandidate),
            handledIds: json([...new Set([...held.handledIds, ...incomingIds])]),
          },
        });
        await deps.notify(confirmResendMessage(files[0]!, target), [
          CONFIRM_RESEND_BUTTON,
          CANCEL_SUBMISSION_BUTTON,
        ]);
        return { kind: "handled" };
      }
    }
  }

  if (held) {
    // Never merged, never run on its own. A pending confirmation is dropped.
    const files = input.batch.filter((m) => m.media).map((m) => m.media!);
    await prisma.whatsAppSubmission.updateMany({
      where: openUnclaimed(input.phone, now),
      data: {
        candidate: Prisma.DbNull,
        handledIds: json([...new Set([...held.handledIds, ...incomingIds])]),
      },
    });
    await deps.notify(
      files.length > 0 ? differentFileMessage(files, held.missing) : heldRequestMessage(held.missing),
      [CANCEL_SUBMISSION_BUTTON],
    );
    return { kind: "handled" };
  }

  // Nothing held.
  if (
    isCommand(input.batch, CANCEL_SUBMISSION_COMMAND) ||
    isCommand(input.batch, CONFIRM_RESEND_COMMAND)
  ) {
    await deps.notify(NOTHING_PENDING_MESSAGE, []);
    return { kind: "handled" };
  }

  const received: ReceivedFile[] = [];
  const missing: MissingFile[] = [];
  for (const [index, message] of input.batch.entries()) {
    if (!message.media) continue;
    const row = await deps.ingest(message.media);
    if (row) {
      received.push({ index, attachmentId: row.id });
    } else {
      missing.push(missingFrom(message.media, index));
    }
  }
  if (missing.length > 0) {
    try {
      await prisma.whatsAppSubmission.create({
        data: {
          phone: input.phone,
          userId: input.userId,
          employeeId: input.employeeId,
          batch: json(input.batch),
          received: json(received),
          missing: json(missing),
          expiresAt: new Date(now.getTime() + submissionExpiryMs()),
        },
      });
    } catch (error) {
      // Another delivery of the same request is already held (unique phone): answer once.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return { kind: "handled" };
      }
      throw error;
    }
    await deps.notify(missingFilesMessage(received.length, missing), [CANCEL_SUBMISSION_BUTTON]);
    return { kind: "handled" };
  }
  return { kind: "run", batch: input.batch, stored: await storedInOrder(received, input.batch) };
}

/**
 * Expire held requests whose time is up: the request is NOT run; the user is
 * told which file never arrived. Files that did arrive stay stored (unlinked).
 * A row claimed by a resend in progress is skipped (completion and expiry are
 * mutually exclusive). Completed rows past their keep time are removed.
 * Returns how many requests expired.
 */
export async function expireHeldSubmissions(
  notify: (phone: string, text: string) => Promise<unknown>,
  now: Date = new Date(),
): Promise<number> {
  await prisma.whatsAppSubmission.deleteMany({
    where: { completedAt: { lt: new Date(now.getTime() - COMPLETED_KEEP_MS) } },
  });
  const due = await prisma.whatsAppSubmission.findMany({
    where: { completedAt: null, expiresAt: { lte: now } },
    select: { phone: true, missing: true },
  });
  let expired = 0;
  for (const row of due) {
    if (!(await expireOne(row.phone, now))) continue; // resent / claimed / cancelled meanwhile
    expired += 1;
    await notify(row.phone, expiredMessage(asArray<MissingFile>(row.missing)));
  }
  return expired;
}

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Expire held requests once a minute, and once right away on start — so a
 * request held before a restart still expires (and its user is told) after it.
 */
export function startWhatsAppSubmissionSweep(): void {
  if (getEnv().NODE_ENV === "test") {
    return;
  }
  const tick = async () => {
    try {
      const { sendWhatsAppText } = await import("./whatsapp-send.js");
      await expireHeldSubmissions((phone, text) =>
        sendWhatsAppText(phone, text, { ignoreSession: true }),
      );
    } catch (error) {
      console.error(
        "WhatsApp submission sweep failed",
        error instanceof Error ? error.message : "unknown",
      );
    }
  };
  void tick();
  setInterval(() => void tick(), SWEEP_INTERVAL_MS);
}
