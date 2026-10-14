export const ATTACHMENT_KINDS = [
  "image",
  "video",
  "audio",
  "document",
  "sticker",
] as const;

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** WhatsApp Cloud API media size limits (bytes). */
export const ATTACHMENT_MAX_BYTES: Record<AttachmentKind, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
  sticker: 500 * 1024,
};

/** Max files the model may ask the engine to send back in one turn. */
export const SEND_ATTACHMENTS_MAX = 10;

/** Attachment reference shown on a chat bubble. */
export interface ChatAttachmentRef {
  id: string;
  kind: AttachmentKind;
  file_name: string;
}

export function parseAttachmentKind(value: unknown): AttachmentKind | null {
  return typeof value === "string" &&
    (ATTACHMENT_KINDS as readonly string[]).includes(value)
    ? (value as AttachmentKind)
    : null;
}

export function attachmentContentUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(id)}/content`;
}

/** Trimmed unique string ids from a model field; anything else is dropped. */
export function parseAttachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const id = entry.trim();
    if (id) {
      seen.add(id);
    }
  }
  return [...seen];
}

export function parseChatAttachmentRefs(value: unknown): ChatAttachmentRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const refs: ChatAttachmentRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const row = entry as { id?: unknown; kind?: unknown; file_name?: unknown };
    const kind = parseAttachmentKind(row.kind);
    if (typeof row.id !== "string" || !row.id || !kind) {
      continue;
    }
    refs.push({
      id: row.id,
      kind,
      file_name: typeof row.file_name === "string" ? row.file_name : "",
    });
  }
  return refs;
}
