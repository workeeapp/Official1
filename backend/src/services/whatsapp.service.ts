import {
  digitalEmployees,
  humanEmployees,
  parseAttachmentKind,
  parseLlmReply,
  parseReplyMetadata,
  typingPauseMs,
} from "@workee/shared";
import type { AttachmentKind, PublicEmployee } from "@workee/shared";
import type { Attachment } from "@prisma/client";
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { ServiceUnavailableError } from "../utils/errors.js";
import { sendChatMessage } from "./chat.service.js";
import { createEmployeeForUser, listEmployeesForUser } from "./employee.service.js";
import { phonesMatch } from "../utils/phone.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import {
  sendWhatsAppButtons,
  sendWhatsAppNavigate,
  sendWhatsAppText,
  sendWhatsAppTyping,
  startWhatsAppTyping,
} from "./whatsapp-send.js";
import {
  buildTurnAttachments,
  deliverAttachmentsToPhone,
  ingestInboundMedia,
  resolveUsableAttachments,
  type InboundMedia,
} from "./attachment.service.js";
import { createInboundBatcher } from "./whatsapp-inbound-batch.js";
import {
  formatWhatsAppReplyContext,
  lookupWhatsAppOutbound,
} from "./whatsapp-outbound-memory.js";
import { isKnownShowButtonCommand } from "./show-button-dump.js";
import { markWhatsAppInbound } from "./whatsapp-window.js";

export { phonesMatch };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WhatsAppVerifyQuery {
  mode?: string;
  token?: string;
  challenge?: string;
}

export interface InboundWhatsAppText {
  from: string;
  /** Message body; for media this is the caption (may be empty). */
  text: string;
  messageId: string;
  /** Quoted outbound body when the user swipe-replied (in-memory lookup; no DB). */
  replyToText?: string;
  /** Image / video / audio / document / sticker sent with this message. */
  media?: InboundMedia;
}

const MEDIA_KINDS: AttachmentKind[] = ["image", "video", "audio", "document", "sticker"];

/** WhatsApp media object (`image` / `video` / …) → inbound media. Formatting only. */
export function readInboundMedia(record: Record<string, unknown>): InboundMedia | undefined {
  const kind = parseAttachmentKind(record.type);
  if (!kind || !MEDIA_KINDS.includes(kind)) {
    return undefined;
  }
  const payload = record[kind];
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const media = payload as {
    id?: unknown;
    mime_type?: unknown;
    caption?: unknown;
    filename?: unknown;
    voice?: unknown;
  };
  const mediaId = asTrimmed(media.id);
  if (!mediaId) {
    return undefined;
  }
  return {
    kind,
    mediaId,
    mimeType: asTrimmed(media.mime_type),
    caption: asTrimmed(media.caption),
    fileName: asTrimmed(media.filename),
    voice: media.voice === true,
  };
}

export function verifyWhatsAppWebhook(query: WhatsAppVerifyQuery): string {
  const expected = getEnv().WHATSAPP_VERIFY_TOKEN?.trim();
  if (!expected) {
    throw new ServiceUnavailableError();
  }

  if (query.mode !== "subscribe" || query.token !== expected || !query.challenge) {
    throw new WhatsAppForbiddenError();
  }

  return query.challenge;
}

export class WhatsAppForbiddenError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("Forbidden");
    this.name = "WhatsAppForbiddenError";
  }
}

export function extractInboundTexts(body: unknown): InboundWhatsAppText[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return [];
  }

  const entry = (body as { entry?: unknown }).entry;
  if (!Array.isArray(entry)) {
    return [];
  }

  const messages: InboundWhatsAppText[] = [];

  for (const item of entry) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const changes = (item as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) {
      continue;
    }

    for (const change of changes) {
      if (!change || typeof change !== "object") {
        continue;
      }
      const value = (change as { value?: { messages?: unknown } }).value;
      const incoming = value?.messages;
      if (!Array.isArray(incoming)) {
        continue;
      }

      for (const message of incoming) {
        if (!message || typeof message !== "object") {
          continue;
        }
        const record = message as {
          id?: unknown;
          from?: unknown;
          text?: { body?: unknown };
          interactive?: { button_reply?: { id?: unknown } };
          contacts?: unknown;
          context?: { id?: unknown; from?: unknown };
        };
        const buttonCommand = record.interactive?.button_reply?.id;
        const media = readInboundMedia(message as Record<string, unknown>);
        const body = media
          ? media.caption
          : typeof record.text?.body === "string"
            ? record.text.body
            : typeof buttonCommand === "string"
              ? buttonCommand
              : formatSharedContactsMessage(record.contacts);
        const text = body.trim();
        const from = typeof record.from === "string" ? record.from : "";
        const messageId = typeof record.id === "string" ? record.id : "";
        const replyToId =
          typeof record.context?.id === "string" ? record.context.id.trim() : "";
        const replyToText = replyToId
          ? lookupWhatsAppOutbound(replyToId)
          : undefined;
        if ((text || media) && from && messageId) {
          messages.push({
            from,
            text,
            messageId,
            ...(replyToText ? { replyToText } : {}),
            ...(media ? { media } : {}),
          });
        }
      }
    }
  }

  return messages;
}

export const SHARED_CONTACTS_MARKER = "[כרטיס איש קשר שותף בוואטסאפ]";

/** WhatsApp `contacts` payload → structured block for the model. Formatting only. */
export function formatSharedContactsMessage(contacts: unknown): string {
  if (!Array.isArray(contacts)) {
    return "";
  }
  const cards: Array<{ name: string; phones: string[] }> = [];
  for (const card of contacts) {
    if (!card || typeof card !== "object") {
      continue;
    }
    const record = card as {
      name?: { formatted_name?: unknown; first_name?: unknown; last_name?: unknown };
      phones?: unknown;
    };
    const formatted = asTrimmed(record.name?.formatted_name);
    const name =
      formatted ||
      [asTrimmed(record.name?.first_name), asTrimmed(record.name?.last_name)]
        .filter(Boolean)
        .join(" ");
    const phones: string[] = [];
    if (Array.isArray(record.phones)) {
      const waIds: string[] = [];
      const raw: string[] = [];
      for (const entry of record.phones) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const phone = entry as { phone?: unknown; wa_id?: unknown };
        const waId = asTrimmed(phone.wa_id);
        const number = asTrimmed(phone.phone);
        if (waId) {
          waIds.push(waId);
        }
        if (number) {
          raw.push(number);
        }
      }
      const seenDigits = new Set<string>();
      for (const value of [...waIds, ...raw]) {
        const digits = value.replace(/\D/g, "");
        if (!digits || seenDigits.has(digits)) {
          continue;
        }
        seenDigits.add(digits);
        phones.push(value);
      }
    }
    if (name || phones.length > 0) {
      cards.push({ name, phones });
    }
  }
  if (cards.length === 0) {
    return "";
  }
  return `${SHARED_CONTACTS_MARKER}\n${JSON.stringify({ shared_contacts: cards })}`;
}

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const recentInboundIds = new Set<string>();
const whatsappWorkerByPhone = new Map<string, string>();

export async function handleInboundWhatsAppTexts(
  messages: InboundWhatsAppText[],
): Promise<void> {
  const env = getEnv();
  if (env.NODE_ENV === "test" || !env.WHATSAPP_ACCESS_TOKEN?.trim()) {
    return;
  }

  for (const message of messages) {
    if (recentInboundIds.has(message.messageId)) {
      continue;
    }
    recentInboundIds.add(message.messageId);
    if (recentInboundIds.size > 200) {
      const first = recentInboundIds.values().next().value;
      if (first) {
        recentInboundIds.delete(first);
      }
    }

    if (inboundBatcher.offer(message.from, message, Boolean(message.media))) {
      recordWhatsAppEvent(
        "media_batch",
        `kind=${message.media?.kind ?? "text"} pending=${inboundBatcher.pending(message.from)}`,
      );
      continue;
    }
    await runSerialized(message.from, () => runWhatsAppTurn([message]));
  }
}

const MEDIA_BATCH_IDLE_MS = 3_000;
const MEDIA_BATCH_MAX_MS = 15_000;

const inboundBatcher = createInboundBatcher<InboundWhatsAppText>({
  idleMs: MEDIA_BATCH_IDLE_MS,
  maxMs: MEDIA_BATCH_MAX_MS,
  flush: (phone, batch) => {
    void runSerialized(phone, () => runWhatsAppTurn(batch));
  },
});

const phoneQueues = new Map<string, Promise<void>>();

/** One turn at a time per phone, in arrival order. */
function runSerialized(phone: string, task: () => Promise<void>): Promise<void> {
  const previous = phoneQueues.get(phone) ?? Promise.resolve();
  const next = previous.then(task, task);
  phoneQueues.set(phone, next);
  void next.finally(() => {
    if (phoneQueues.get(phone) === next) {
      phoneQueues.delete(phone);
    }
  });
  return next;
}

const MEDIA_FAILED_NOTICE = "לא הצלחתי לקבל את הקובץ. אפשר לנסות לשלוח אותו שוב?";

/** Caption / text of the batch, in order; a voice note with no text speaks for itself. */
export function batchSpokenText(
  batch: Array<Pick<InboundWhatsAppText, "text">>,
  transcripts: string[],
): string {
  const text = batch
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join("\n");
  return text || transcripts.map((value) => value.trim()).filter(Boolean).join("\n");
}

async function runWhatsAppTurn(batch: InboundWhatsAppText[]): Promise<void> {
  const last = batch[batch.length - 1];
  if (!last) {
    return;
  }
  const from = last.from;
  const stopTyping = startWhatsAppTyping(last.messageId);
  try {
    await markWhatsAppInbound(from);
    const speaker = await resolveWhatsAppSpeaker(from);
    const employees = await listEmployeesForUser(speaker.userId);
    const digitals = digitalEmployees(employees);
    const digital =
      sessionDigital(from, digitals) ??
      digitals.find((employee) => employee.protected) ??
      digitals[0];
    if (!digital) {
      throw new ServiceUnavailableError();
    }

    const stored: Array<{ row: Attachment; voice: boolean }> = [];
    let mediaFailed = 0;
    for (const message of batch) {
      if (!message.media) {
        continue;
      }
      const row = await ingestInboundMedia({
        userId: speaker.userId,
        uploaderId: speaker.employeeId,
        media: message.media,
      });
      if (row) {
        stored.push({ row, voice: message.media.voice });
      } else {
        mediaFailed += 1;
      }
    }
    const spoken = batchSpokenText(
      batch,
      stored.map(({ row }) => row.transcript),
    );
    if (stored.length === 0 && !spoken) {
      if (mediaFailed > 0) {
        await sendWhatsAppText(from, MEDIA_FAILED_NOTICE, { ignoreSession: true });
      }
      return;
    }
    const replyToText = batch.find((message) => message.replyToText)?.replyToText;
    const attachments =
      stored.length > 0 ? await buildTurnAttachments(stored) : undefined;

    recordWhatsAppEvent(
      "chat_start",
      `worker=${digital.name} speaker=${speaker.employeeId.slice(0, 8)} files=${stored.length}`,
    );
    const turn = await sendChatMessage({
      userId: speaker.userId,
      employeeId: speaker.employeeId,
      digitalEmployeeId: digital.id,
      message:
        replyToText && !isKnownShowButtonCommand(spoken)
          ? formatWhatsAppReplyContext(replyToText, spoken)
          : spoken,
      ...(attachments ? { attachments } : {}),
    });
    const handoff =
      parseReplyMetadata(turn.reply).handoff?.worker ?? turn.answeredBy;
    applyWhatsAppHandoff(from, handoff, digitals);
    if (handoff && handoff !== digital.name) {
      recordWhatsAppEvent("handoff", `worker=${handoff}`);
    }
    const parsed = parseLlmReply(turn.reply);
    const replies = parsed.responses.map((text) => text.trim()).filter(Boolean);
    const buttons = parsed.buttons ?? [];
    recordWhatsAppEvent(
      "llm_ok",
      `replies=${replies.length} replyChars=${parsed.response.length} buttons=${buttons.length} files_out=${turn.outboundAttachmentIds.length}`,
    );
    let delivered = true;
    for (const [index, reply] of replies.entries()) {
      if (index > 0) {
        await sendWhatsAppTyping(last.messageId);
        await sleep(typingPauseMs(reply));
      }
      const sendResult = await sendWhatsAppButtons(
        from,
        reply,
        index === 0 ? buttons : [],
        { ignoreSession: true },
      );
      recordWhatsAppEvent("reply_send", `part=${index + 1} result=${sendResult}`);
      if (sendResult !== "sent") {
        delivered = false;
        break;
      }
      if (index === 0 && parsed.navigateAddress) {
        const navigateResult = await sendWhatsAppNavigate(
          from,
          parsed.navigateAddress,
          { ignoreSession: true },
        );
        recordWhatsAppEvent("navigate_send", `result=${navigateResult}`);
      }
    }
    if (delivered && turn.outboundAttachmentIds.length > 0) {
      const rows = await resolveUsableAttachments(
        speaker.employeeId,
        turn.outboundAttachmentIds,
      );
      const result = await deliverAttachmentsToPhone(from, rows, {
        ignoreSession: true,
      });
      recordWhatsAppEvent(
        "media_send",
        `sent=${result.sent} failed=${result.failed}`,
      );
    }
  } catch (error) {
    recordWhatsAppEvent(
      "reply_failed",
      error instanceof Error ? error.message : "unknown",
    );
  } finally {
    stopTyping();
  }
}

export function applyWhatsAppHandoff(
  from: string,
  workerName: string | undefined,
  digitals: PublicEmployee[],
): PublicEmployee | undefined {
  if (!workerName?.trim()) {
    return undefined;
  }
  const matched = matchDigitalName(workerName, digitals);
  if (!matched) {
    return undefined;
  }
  whatsappWorkerByPhone.set(from, matched.id);
  return matched;
}

function sessionDigital(
  from: string,
  digitals: PublicEmployee[],
): PublicEmployee | undefined {
  const id = whatsappWorkerByPhone.get(from);
  return id ? digitals.find((employee) => employee.id === id) : undefined;
}

function matchDigitalName(
  raw: string,
  digitals: PublicEmployee[],
): PublicEmployee | undefined {
  const needle = raw.trim().toLowerCase();
  const ranked = [...digitals].sort((left, right) => {
    const leftName = (left.nickname?.trim() || left.name).length;
    const rightName = (right.nickname?.trim() || right.name).length;
    return rightName - leftName;
  });
  return ranked.find((employee) => {
    const aliases = [
      employee.nickname,
      employee.name,
      employee.surname,
      `${employee.name} ${employee.surname}`.trim(),
    ]
      .filter((value): value is string => Boolean(value && value.trim()))
      .map((value) => value.trim().toLowerCase());
    return aliases.some(
      (alias) =>
        needle === alias ||
        needle.startsWith(`${alias} `) ||
        alias === needle ||
        alias.startsWith(`${needle} `),
    );
  });
}

async function resolveWhatsAppSpeaker(from: string): Promise<{
  userId: string;
  employeeId: string;
}> {
  const users = await prisma.user.findMany({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  for (const user of users) {
    const humans = humanEmployees(await listEmployeesForUser(user.id));
    const match = humans.find(
      (employee) => employee.phone && phonesMatch(employee.phone, from),
    );
    if (match) {
      return { userId: user.id, employeeId: match.id };
    }
  }

  const fallbackUser = users[0];
  if (!fallbackUser) {
    throw new ServiceUnavailableError();
  }

  const created = await createEmployeeForUser(fallbackUser.id, {
    kind: "human",
    name: "אורח",
    surname: "",
    nickname: maskPhoneName(from),
    email: null,
    phone: from,
  });
  return { userId: fallbackUser.id, employeeId: created.id };
}

function maskPhoneName(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length < 4 ? "אורח" : `אורח …${digits.slice(-4)}`;
}
