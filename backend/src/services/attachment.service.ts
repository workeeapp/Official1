import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  ATTACHMENT_MAX_BYTES,
  parseAttachmentKind,
  SEND_ATTACHMENTS_MAX,
  type AttachmentKind,
  type ChatAttachmentRef,
} from "@workee/shared";
import type { Attachment } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { recordAuditEvent } from "./audit.service.js";
import type { Readable } from "node:stream";
import {
  attachmentStorageKey,
  extensionForMime,
  getAttachmentStorage,
} from "./attachment-storage.js";
import {
  imageDataUrl,
  isVisionMime,
  transcribeAudio,
  type TranscriptStatus,
} from "./attachment-understanding.js";
import { downloadWhatsAppMedia, uploadWhatsAppMedia } from "./whatsapp-media.js";
import { sendWhatsAppMedia, type WhatsAppTextResult } from "./whatsapp-send.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";

export interface InboundMedia {
  kind: AttachmentKind;
  mediaId: string;
  mimeType: string;
  caption: string;
  fileName: string;
  /** WhatsApp voice note (push-to-talk) rather than an audio file. */
  voice: boolean;
}

/** One attachment as the model sees it. */
export interface AttachmentFact {
  attachment_id: string;
  kind: AttachmentKind;
  file_name?: string;
  caption?: string;
  transcript?: string;
  /**
   * Audio/voice only. ok | empty | unavailable | error.
   * Omitted for non-audio and for legacy rows with null transcriptStatus.
   */
  transcript_status?: TranscriptStatus;
  voice_note?: boolean;
}

/** Short ref injected on saved rows (list / item / filing / reminder). */
export interface AttachmentSavedRef {
  attachment_id: string;
  kind: AttachmentKind;
  file_name?: string;
}

export interface TurnAttachments {
  facts: AttachmentFact[];
  /** Data URLs for images the model should look at this turn. */
  imageUrls: string[];
  refs: ChatAttachmentRef[];
}

export const NEW_ATTACHMENTS_MARKER = "[קבצים שהתקבלו בהודעה זו]";
export const PENDING_ATTACHMENT_HOURS = 48;
const VISION_MAX_BYTES = ATTACHMENT_MAX_BYTES.image;

export type AttachmentTarget =
  | { listId: string }
  | { listItemId: string }
  | { filingId: string }
  | { reminderId: string };

/** Outcome of one applyAttachmentLinks call. Attach and detach are independent. */
export type AttachmentApplyOutcome = {
  /** New AttachmentLinks created this call. */
  linked: number;
  /** Requested attach ids already linked to this target (not duplicated). */
  alreadyLinked: number;
  /** Links removed this call. */
  detached: number;
  /** True when the ACTION requested at least one attach id. */
  attachRequested: boolean;
};

export function emptyAttachmentOutcome(
  attachRequested = false,
): AttachmentApplyOutcome {
  return { linked: 0, alreadyLinked: 0, detached: 0, attachRequested };
}

export function mergeAttachmentOutcomes(
  ...rows: AttachmentApplyOutcome[]
): AttachmentApplyOutcome {
  return rows.reduce(
    (acc, row) => ({
      linked: acc.linked + row.linked,
      alreadyLinked: acc.alreadyLinked + row.alreadyLinked,
      detached: acc.detached + row.detached,
      attachRequested: acc.attachRequested || row.attachRequested,
    }),
    emptyAttachmentOutcome(),
  );
}

/** Attach succeeded when a new link was made or the file was already on the target. */
export function attachmentAttachSucceeded(outcome: AttachmentApplyOutcome): boolean {
  return (
    outcome.attachRequested &&
    outcome.linked + outcome.alreadyLinked > 0
  );
}

function kindFromMime(mimeType: string, fileName: string): AttachmentKind {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) {
    return mime.includes("webp") && fileName.toLowerCase().endsWith(".webp")
      ? "sticker"
      : "image";
  }
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Store a web/chat upload (bytes already in memory). Same Attachment row shape
 * as WhatsApp ingest so PENDING_ATTACHMENTS / model vision work unchanged.
 */
export async function ingestUploadedBytes(input: {
  userId: string;
  uploaderId: string;
  bytes: Buffer;
  mimeType: string;
  fileName: string;
  caption?: string;
}): Promise<Attachment | null> {
  const mimeType = (input.mimeType || "application/octet-stream").slice(0, 127);
  const kind = kindFromMime(mimeType, input.fileName);
  const max = ATTACHMENT_MAX_BYTES[kind];
  if (!input.bytes.length || input.bytes.length > max) {
    return null;
  }
  try {
    const id = randomUUID();
    const storageKey = attachmentStorageKey(input.userId, id, mimeType);
    await getAttachmentStorage().put(storageKey, input.bytes);
    const stt =
      kind === "audio"
        ? await transcribeAudio({ bytes: input.bytes, mimeType })
        : null;
    const row = await prisma.attachment.create({
      data: {
        id,
        userId: input.userId,
        uploaderId: input.uploaderId,
        kind,
        mimeType,
        fileName: (input.fileName || `upload${extensionForMime(mimeType)}`).slice(
          0,
          255,
        ),
        sizeBytes: input.bytes.length,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
        storageKey,
        caption: (input.caption ?? "").slice(0, 1024),
        transcript: stt?.text ?? "",
        transcriptStatus: stt?.status ?? null,
        waInboundMediaId: "",
      },
    });
    await recordAuditEvent({
      userId: input.userId,
      actorEmployeeId: input.uploaderId,
      action: "attachment_add",
      entityType: "Attachment",
      entityId: row.id,
      summary: `add web attachment: ${kind}${row.fileName ? ` ${row.fileName}` : ""}`,
    });
    return row;
  } catch {
    return null;
  }
}

/** Load speaker-owned attachments by id for a chat turn (web upload → send). */
export async function loadTurnAttachmentsByIds(
  userId: string,
  uploaderId: string,
  ids: string[],
): Promise<TurnAttachments | undefined> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(
    0,
    SEND_ATTACHMENTS_MAX,
  );
  if (unique.length === 0) return undefined;
  const rows = await prisma.attachment.findMany({
    where: {
      userId,
      id: { in: unique },
      OR: [{ uploaderId }, { userId }],
    },
  });
  if (rows.length === 0) return undefined;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = unique
    .map((id) => byId.get(id))
    .filter((r): r is Attachment => Boolean(r));
  if (ordered.length === 0) return undefined;
  return buildTurnAttachments(
    ordered.map((row) => ({
      row,
      voice: row.kind === "audio",
    })),
  );
}

/** Download WhatsApp media, keep our own copy, transcribe voice. Null when it cannot be stored. */
export async function ingestInboundMedia(input: {
  userId: string;
  uploaderId: string;
  media: InboundMedia;
}): Promise<Attachment | null> {
  const { media } = input;
  try {
    const downloaded = await downloadWhatsAppMedia(
      media.mediaId,
      ATTACHMENT_MAX_BYTES[media.kind],
    );
    const mimeType = media.mimeType || downloaded.mimeType || "application/octet-stream";
    const id = randomUUID();
    const storageKey = attachmentStorageKey(input.userId, id, mimeType);
    await getAttachmentStorage().put(storageKey, downloaded.bytes);
    const stt =
      media.kind === "audio"
        ? await transcribeAudio({ bytes: downloaded.bytes, mimeType })
        : null;
    const row = await prisma.attachment.create({
      data: {
        id,
        userId: input.userId,
        uploaderId: input.uploaderId,
        kind: media.kind,
        mimeType: mimeType.slice(0, 127),
        fileName: media.fileName.slice(0, 255),
        sizeBytes: downloaded.bytes.length,
        sha256: createHash("sha256").update(downloaded.bytes).digest("hex"),
        storageKey,
        caption: media.caption,
        transcript: stt?.text ?? "",
        transcriptStatus: stt?.status ?? null,
        waInboundMediaId: media.mediaId.slice(0, 128),
      },
    });
    await recordAuditEvent({
      userId: input.userId,
      actorEmployeeId: input.uploaderId,
      action: "attachment_add",
      entityType: "Attachment",
      entityId: row.id,
      summary: `add attachment: ${media.kind}${media.fileName ? ` ${media.fileName}` : ""}`,
    });
    return row;
  } catch (error) {
    recordWhatsAppEvent(
      "media_ingest_fail",
      `kind=${media.kind} ${error instanceof Error ? error.message : "unknown"}`,
    );
    return null;
  }
}

const TRANSCRIPT_STATUSES = new Set<TranscriptStatus>([
  "ok",
  "empty",
  "unavailable",
  "error",
]);

function parseTranscriptStatus(
  raw: string | null | undefined,
): TranscriptStatus | undefined {
  const value = String(raw ?? "").trim();
  return TRANSCRIPT_STATUSES.has(value as TranscriptStatus)
    ? (value as TranscriptStatus)
    : undefined;
}

export function toAttachmentFact(row: Attachment, voice = false): AttachmentFact {
  const kind = parseAttachmentKind(row.kind) ?? "document";
  const status = parseTranscriptStatus(
    "transcriptStatus" in row
      ? (row as { transcriptStatus?: string | null }).transcriptStatus
      : null,
  );
  return {
    attachment_id: row.id,
    kind,
    ...(row.fileName ? { file_name: row.fileName } : {}),
    ...(row.caption ? { caption: row.caption } : {}),
    ...(row.transcript ? { transcript: row.transcript } : {}),
    // Status only for audio/voice; omit for images and for legacy null rows.
    ...(kind === "audio" && status ? { transcript_status: status } : {}),
    ...(voice ? { voice_note: true } : {}),
  };
}

export function toChatAttachmentRef(row: {
  id: string;
  kind: string;
  fileName: string;
}): ChatAttachmentRef {
  return {
    id: row.id,
    kind: parseAttachmentKind(row.kind) ?? "document",
    file_name: row.fileName,
  };
}

/** Facts + vision inputs for the files that arrived with this turn. */
export async function buildTurnAttachments(
  rows: Array<{ row: Attachment; voice: boolean }>,
): Promise<TurnAttachments> {
  const imageUrls: string[] = [];
  for (const { row } of rows) {
    if (
      (row.kind === "image" || row.kind === "sticker") &&
      isVisionMime(row.mimeType) &&
      row.sizeBytes <= VISION_MAX_BYTES
    ) {
      try {
        const bytes = await getAttachmentStorage().read(row.storageKey);
        imageUrls.push(imageDataUrl(bytes, row.mimeType));
      } catch {
        // the file is still saved; the model just does not see its pixels
      }
    }
  }
  return {
    facts: rows.map(({ row, voice }) => toAttachmentFact(row, voice)),
    imageUrls,
    refs: rows.map(({ row }) => toChatAttachmentRef(row)),
  };
}

export function formatNewAttachmentsBlock(facts: AttachmentFact[]): string {
  if (facts.length === 0) {
    return "";
  }
  return `${NEW_ATTACHMENTS_MARKER}\n${JSON.stringify({ new_attachments: facts })}`;
}

/** The speaker's recent uploads that are not attached to anything yet. */
export async function listPendingAttachments(
  uploaderId: string,
  now = new Date(),
): Promise<AttachmentFact[]> {
  const since = new Date(now.getTime() - PENDING_ATTACHMENT_HOURS * 3600_000);
  const rows = await prisma.attachment.findMany({
    where: {
      uploaderId,
      deletedAt: null,
      createdAt: { gte: since },
      links: { none: {} },
    },
    orderBy: { createdAt: "asc" },
    take: 30,
  });
  return rows.map((row) => toAttachmentFact(row));
}

export function formatPendingAttachmentsContext(facts: AttachmentFact[]): string {
  if (facts.length === 0) {
    return "";
  }
  return [
    "PENDING_ATTACHMENTS:",
    `Files this speaker sent in the last ${PENDING_ATTACHMENT_HOURS} hours that are not attached to anything yet (oldest first). Attach them with attachment_ids on the action they belong to; never speak ids.`,
    JSON.stringify(facts),
  ].join("\n");
}

export interface AttachmentRefsByTarget {
  lists: Map<string, AttachmentSavedRef[]>;
  listItems: Map<string, AttachmentSavedRef[]>;
  filings: Map<string, AttachmentSavedRef[]>;
  reminders: Map<string, AttachmentSavedRef[]>;
}

export async function loadAttachmentRefs(input: {
  listIds?: string[];
  listItemIds?: string[];
  filingIds?: string[];
  reminderIds?: string[];
}): Promise<AttachmentRefsByTarget> {
  const result: AttachmentRefsByTarget = {
    lists: new Map(),
    listItems: new Map(),
    filings: new Map(),
    reminders: new Map(),
  };
  const or = [
    input.listIds?.length ? { listId: { in: input.listIds } } : null,
    input.listItemIds?.length ? { listItemId: { in: input.listItemIds } } : null,
    input.filingIds?.length ? { filingId: { in: input.filingIds } } : null,
    input.reminderIds?.length ? { reminderId: { in: input.reminderIds } } : null,
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (or.length === 0) {
    return result;
  }
  const links = await prisma.attachmentLink.findMany({
    where: { OR: or, attachment: { deletedAt: null } },
    include: { attachment: true },
    orderBy: { createdAt: "asc" },
  });
  const push = (
    map: Map<string, AttachmentSavedRef[]>,
    key: string | null,
    row: Attachment,
  ) => {
    if (!key) {
      return;
    }
    const refs = map.get(key) ?? [];
    refs.push({
      attachment_id: row.id,
      kind: parseAttachmentKind(row.kind) ?? "document",
      ...(row.fileName ? { file_name: row.fileName } : {}),
    });
    map.set(key, refs);
  };
  for (const link of links) {
    push(result.lists, link.listId, link.attachment);
    push(result.listItems, link.listItemId, link.attachment);
    push(result.filings, link.filingId, link.attachment);
    push(result.reminders, link.reminderId, link.attachment);
  }
  return result;
}

type SnapshotShape = {
  lists: Array<{ list_id?: string; items: Record<string, unknown>[] }>;
  filing: Array<{ filing_id: string }>;
  reminders?: Array<{ reminder_id: string }>;
};

/**
 * Adds `attachments` to saved rows that have files.
 * `has_attachments` is true only when the list itself has files (not item roll-up).
 */
export async function withAttachmentRefs<T extends SnapshotShape>(snapshot: T): Promise<T> {
  const itemIdOf = (item: Record<string, unknown>) =>
    typeof item.item_id === "string" ? item.item_id : "";
  const listIds = snapshot.lists.flatMap((list) => (list.list_id ? [list.list_id] : []));
  const listItemIds = snapshot.lists.flatMap((list) =>
    list.items.map(itemIdOf).filter(Boolean),
  );
  const filingIds = snapshot.filing.map((row) => row.filing_id);
  const reminderIds = (snapshot.reminders ?? []).map((row) => row.reminder_id);
  const refs = await loadAttachmentRefs({ listIds, listItemIds, filingIds, reminderIds });
  if (
    refs.lists.size === 0 &&
    refs.listItems.size === 0 &&
    refs.filings.size === 0 &&
    refs.reminders.size === 0
  ) {
    return snapshot;
  }
  const decorated: SnapshotShape = {
    ...snapshot,
    lists: snapshot.lists.map((list) => {
      const items = list.items.map((item) => {
        const own = refs.listItems.get(itemIdOf(item));
        return own ? { ...item, attachments: own } : item;
      });
      const listRefs = list.list_id ? refs.lists.get(list.list_id) : undefined;
      return {
        ...list,
        items,
        ...(listRefs ? { attachments: listRefs, has_attachments: true } : {}),
      };
    }),
    filing: snapshot.filing.map((row) => {
      const own = refs.filings.get(row.filing_id);
      return own ? { ...row, attachments: own } : row;
    }),
    ...(snapshot.reminders
      ? {
          reminders: snapshot.reminders.map((row) => {
            const own = refs.reminders.get(row.reminder_id);
            return own ? { ...row, attachments: own } : row;
          }),
        }
      : {}),
  };
  return decorated as T;
}

/** Read attachment ids from a saved-row `attachments` array (`attachment_id` or `id`). */
export function attachmentIdsFromSavedRefs(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const id =
      (typeof row.attachment_id === "string" && row.attachment_id.trim()) ||
      (typeof row.id === "string" && row.id.trim()) ||
      "";
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Collect file ids from ITEM DUMP target rows (items / filings / reminders).
 * Used so showing a row with files also sends those files (max SEND_ATTACHMENTS_MAX).
 */
export function collectAttachmentIdsForDumpRows(
  snapshot: SnapshotShape,
  rowIds: ReadonlySet<string> | Iterable<string>,
  max = SEND_ATTACHMENTS_MAX,
): string[] {
  const want =
    rowIds instanceof Set
      ? rowIds
      : new Set([...rowIds].map((id) => String(id).trim()).filter(Boolean));
  if (want.size === 0 || max <= 0) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (raw: unknown) => {
    for (const id of attachmentIdsFromSavedRefs(raw)) {
      if (seen.has(id) || out.length >= max) {
        continue;
      }
      seen.add(id);
      out.push(id);
    }
  };
  for (const list of snapshot.lists) {
    for (const item of list.items) {
      const id =
        (typeof item.item_id === "string" && item.item_id.trim()) ||
        (typeof item.contact_id === "string" && item.contact_id.trim()) ||
        "";
      if (id && want.has(id)) {
        take(item.attachments);
      }
    }
  }
  for (const row of snapshot.filing) {
    if (want.has(row.filing_id)) {
      take((row as { attachments?: unknown }).attachments);
    }
  }
  for (const row of snapshot.reminders ?? []) {
    if (want.has(row.reminder_id)) {
      take((row as { attachments?: unknown }).attachments);
    }
  }
  return out;
}

/**
 * Attachments the actor may attach or receive: same account, not deleted, and
 * either their own upload, an account owner, or already attached to saved data
 * (ids the model copied from this turn's visible rows).
 */
export async function resolveUsableAttachments(
  actorId: string,
  attachmentIds: string[],
): Promise<Attachment[]> {
  const ids = [...new Set(attachmentIds.map((id) => id.trim()).filter(Boolean))].filter(
    (id) => UUID_RE.test(id),
  );
  if (ids.length === 0) {
    return [];
  }
  const actor = await prisma.employee.findUnique({
    where: { id: actorId },
    select: { userId: true, isOwner: true },
  });
  if (!actor) {
    return [];
  }
  const rows = await prisma.attachment.findMany({
    where: { id: { in: ids }, userId: actor.userId, deletedAt: null },
    include: { _count: { select: { links: true } } },
  });
  const usable = rows.filter(
    (row) => row.uploaderId === actorId || actor.isOwner || row._count.links > 0,
  );
  const order = new Map(ids.map((id, index) => [id, index]));
  return usable
    .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
    .map(({ _count: _ignored, ...row }) => row);
}

/** Apply the model's attachment_ids / detach ids on one saved target. */
export async function applyAttachmentLinks(input: {
  actorId: string;
  target: AttachmentTarget;
  attachmentIds?: string[];
  detachIds?: string[];
}): Promise<AttachmentApplyOutcome> {
  const attach = input.attachmentIds ?? [];
  const detach = input.detachIds ?? [];
  const attachRequested = attach.some((id) => id.trim().length > 0);
  if (attach.length === 0 && detach.length === 0) {
    return emptyAttachmentOutcome(false);
  }
  const actor = await prisma.employee.findUnique({
    where: { id: input.actorId },
    select: { userId: true },
  });
  if (!actor) {
    return emptyAttachmentOutcome(attachRequested);
  }
  let linked = 0;
  let alreadyLinked = 0;
  for (const row of await resolveUsableAttachments(input.actorId, attach)) {
    const existing = await prisma.attachmentLink.findFirst({
      where: { attachmentId: row.id, ...input.target },
      select: { id: true },
    });
    if (existing) {
      alreadyLinked += 1;
      continue;
    }
    await prisma.attachmentLink.create({
      data: { attachmentId: row.id, addedById: input.actorId, ...input.target },
    });
    linked += 1;
  }
  let detached = 0;
  const detachIds = detach.filter((id) => UUID_RE.test(id));
  if (detachIds.length > 0) {
    const removed = await prisma.attachmentLink.deleteMany({
      where: {
        attachmentId: { in: detachIds },
        attachment: { userId: actor.userId },
        ...input.target,
      },
    });
    detached = removed.count;
  }
  if (linked > 0 || detached > 0) {
    const [entityType, entityId] = targetEntity(input.target);
    await recordAuditEvent({
      userId: actor.userId,
      actorEmployeeId: input.actorId,
      action: linked > 0 ? "attachment_link" : "attachment_unlink",
      entityType,
      entityId,
      summary: `attachments +${linked} already=${alreadyLinked} -${detached}`,
    });
  }
  return { linked, alreadyLinked, detached, attachRequested };
}

function targetEntity(target: AttachmentTarget): [string, string] {
  if ("listId" in target) {
    return ["EmployeeList", target.listId];
  }
  if ("listItemId" in target) {
    return ["EmployeeListItem", target.listItemId];
  }
  if ("filingId" in target) {
    return ["EmployeeFiling", target.filingId];
  }
  return ["Reminder", target.reminderId];
}

/** Live files attached to one reminder clock. */
export async function listReminderAttachments(reminderId: string): Promise<Attachment[]> {
  const links = await prisma.attachmentLink.findMany({
    where: { reminderId, attachment: { deletedAt: null } },
    include: { attachment: true },
    orderBy: { createdAt: "asc" },
  });
  return links.map((link) => link.attachment).slice(0, SEND_ATTACHMENTS_MAX);
}

const OUTBOUND_MEDIA_TTL_MS = 25 * 24 * 3600_000;

async function outboundMediaId(row: Attachment): Promise<string> {
  const fresh =
    row.waOutboundMediaId &&
    row.waOutboundUploadedAt &&
    Date.now() - row.waOutboundUploadedAt.getTime() < OUTBOUND_MEDIA_TTL_MS;
  if (fresh) {
    return row.waOutboundMediaId;
  }
  const bytes = await getAttachmentStorage().read(row.storageKey);
  const mediaId = await uploadWhatsAppMedia({
    bytes,
    mimeType: row.mimeType,
    fileName: row.fileName || `${row.kind}`,
  });
  await prisma.attachment.update({
    where: { id: row.id },
    data: { waOutboundMediaId: mediaId, waOutboundUploadedAt: new Date() },
  });
  return mediaId;
}

/** Send files to a WhatsApp number, one media message each. */
export async function deliverAttachmentsToPhone(
  phone: string,
  rows: Attachment[],
  options?: { ignoreSession?: boolean },
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const row of rows.slice(0, SEND_ATTACHMENTS_MAX)) {
    let result: WhatsAppTextResult = "failed";
    try {
      const mediaId = await outboundMediaId(row);
      result = await sendWhatsAppMedia(
        phone,
        {
          kind: parseAttachmentKind(row.kind) ?? "document",
          mediaId,
          caption: row.caption,
          fileName: row.fileName,
        },
        options,
      );
    } catch (error) {
      recordWhatsAppEvent(
        "media_send_fail",
        error instanceof Error ? error.message : "unknown",
      );
    }
    if (result === "sent") {
      sent += 1;
    } else {
      failed += 1;
    }
  }
  return { sent, failed };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AttachmentContent {
  stream: Readable;
  mimeType: string;
  sizeBytes: number;
  fileName: string;
  inline: boolean;
}

/** Only media the browser renders without running scripts may be shown inline. */
export function isInlineSafeMime(mimeType: string): boolean {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "image/svg+xml") {
    return false;
  }
  return /^(image|video|audio)\//.test(base) || base === "application/pdf";
}

/** One live file of this account, or null (unknown id / other account / deleted). */
export async function openAttachmentContent(
  userId: string,
  attachmentId: string,
): Promise<AttachmentContent | null> {
  if (!UUID_RE.test(attachmentId)) {
    return null;
  }
  const row = await prisma.attachment.findFirst({
    where: { id: attachmentId, userId, deletedAt: null },
  });
  if (!row) {
    return null;
  }
  return {
    stream: getAttachmentStorage().getStream(row.storageKey),
    mimeType: row.mimeType || "application/octet-stream",
    sizeBytes: row.sizeBytes,
    fileName: row.fileName || `${row.kind}.${extensionForMime(row.mimeType)}`,
    inline: isInlineSafeMime(row.mimeType),
  };
}
