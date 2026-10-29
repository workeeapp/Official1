import {
  digitalEmployees,
  GUEST_LUCY_NAME,
  humanEmployees,
  isGuestEmployee,
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
  beginWhatsAppTyping,
  sendWhatsAppComposeUrl,
  sendWhatsAppMarkRead,
  sendWhatsAppNavigate,
  sendWhatsAppReaction,
  sendWhatsAppText,
  sendWhatsAppTyping,
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
import {
  bindInboundToInvite,
  findPendingInviteByPhone,
  findPendingInviteForGuest,
  WHATSAPP_COMPOSE_LABEL,
} from "./whatsapp-invite.service.js";
import {
  applyWhatsAppWorkerSticky,
  clearWhatsAppWorkerSticky,
  sessionDigitalFromSticky,
} from "./whatsapp-worker-sticky.js";
import { setPendingLocation } from "./pending-location.js";
import { enrichEmptyLocationLabels } from "./reverse-geocode.js";
import { parseCoordinatePair } from "./resolved-location.js";

export { phonesMatch, clearWhatsAppWorkerSticky };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WhatsAppVerifyQuery {
  mode?: string;
  token?: string;
  challenge?: string;
}

export type InboundLocation = {
  lat: number;
  lng: number;
  name: string;
  address: string;
};

export interface InboundWhatsAppText {
  from: string;
  /** Message body; for media this is the caption (may be empty). */
  text: string;
  messageId: string;
  /** Quoted outbound body when the user swipe-replied (in-memory lookup; no DB). */
  replyToText?: string;
  /** Image / video / audio / document / sticker sent with this message. */
  media?: InboundMedia;
  /** WhatsApp location pin. */
  location?: InboundLocation;
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
        const location = readInboundLocation(
          message as Record<string, unknown>,
        );
        const sharedContacts = readInboundContacts(
          message as Record<string, unknown>,
        );
        const body = media
          ? media.caption
          : location
            ? formatSharedLocationMessage(location)
            : typeof record.text?.body === "string"
              ? record.text.body
              : typeof buttonCommand === "string"
                ? buttonCommand
                : formatSharedContactsMessage(sharedContacts);
        const text = body.trim();
        const from = typeof record.from === "string" ? record.from : "";
        const messageId = typeof record.id === "string" ? record.id : "";
        const replyToId =
          typeof record.context?.id === "string" ? record.context.id.trim() : "";
        const replyToText = replyToId
          ? lookupWhatsAppOutbound(replyToId)
          : undefined;
        if ((text || media || location) && from && messageId) {
          messages.push({
            from,
            text,
            messageId,
            ...(replyToText ? { replyToText } : {}),
            ...(media ? { media } : {}),
            ...(location ? { location } : {}),
          });
        }
      }
    }
  }

  return messages;
}

export const SHARED_LOCATION_MARKER = "[מיקום שותף בוואטסאפ]";

/**
 * WhatsApp static `location` pin → inbound coords.
 * `live_location` is not supported (Meta sends a different type; we ignore it).
 * Out-of-range lat/lng (±90 / ±180) are rejected at ingest.
 */
export function readInboundLocation(
  record: Record<string, unknown>,
): InboundLocation | undefined {
  if (String(record.type ?? "") !== "location") {
    return undefined;
  }
  const payload = record.location;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const loc = payload as {
    latitude?: unknown;
    longitude?: unknown;
    name?: unknown;
    address?: unknown;
  };
  const pair = parseCoordinatePair(loc.latitude, loc.longitude);
  if (!pair) {
    return undefined;
  }
  return {
    lat: pair.lat,
    lng: pair.lng,
    name: asTrimmed(loc.name),
    address: asTrimmed(loc.address),
  };
}

export function formatSharedLocationMessage(loc: InboundLocation): string {
  return `${SHARED_LOCATION_MARKER}\n${JSON.stringify({
    location: {
      lat: loc.lat,
      lng: loc.lng,
      name: loc.name,
      address: loc.address,
    },
  })}`;
}

export const SHARED_CONTACTS_MARKER = "[כרטיס איש קשר שותף בוואטסאפ]";

/** One shared contact card after inbound normalize (model-facing). */
export type InboundSharedContact = {
  name: string;
  /** Deduped phone values; wa_id preferred over raw phone when both share digits. */
  phones: string[];
  emails?: Array<{ email: string; type?: string }>;
  urls?: Array<{ url: string; type?: string }>;
  addresses?: Array<{
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
    country_code?: string;
    type?: string;
  }>;
  org?: { company?: string; department?: string; title?: string };
  birthday?: string;
  name_parts?: {
    formatted_name?: string;
    first_name?: string;
    last_name?: string;
    middle_name?: string;
    prefix?: string;
    suffix?: string;
  };
  phone_entries?: Array<{ phone?: string; wa_id?: string; type?: string }>;
};

/**
 * Normalize Meta Cloud API `contacts` array (or a single contact object) into
 * InboundSharedContact[]. Skips malformed cards; keeps valid siblings.
 */
export function normalizeInboundContactsPayload(
  contacts: unknown,
): InboundSharedContact[] {
  const list = Array.isArray(contacts)
    ? contacts
    : contacts && typeof contacts === "object"
      ? [contacts]
      : [];
  const cards: InboundSharedContact[] = [];
  for (const entry of list) {
    const card = parseOneInboundContactCard(entry);
    if (card) {
      cards.push(card);
    }
  }
  return cards;
}

/**
 * WhatsApp `type: "contacts"` message → normalized shared contact cards.
 * Empty when type is not contacts or no usable cards remain.
 */
export function readInboundContacts(
  record: Record<string, unknown>,
): InboundSharedContact[] {
  if (String(record.type ?? "") !== "contacts") {
    return [];
  }
  return normalizeInboundContactsPayload(record.contacts);
}

/**
 * Shared contacts → structured block for the model. Formatting only.
 * Accepts already-normalized cards or raw Meta `contacts` array / single object.
 */
export function formatSharedContactsMessage(
  contacts: InboundSharedContact[] | unknown,
): string {
  const cards = Array.isArray(contacts)
    ? contacts.every(isNormalizedSharedContact)
      ? (contacts as InboundSharedContact[])
      : normalizeInboundContactsPayload(contacts)
    : normalizeInboundContactsPayload(contacts);
  if (cards.length === 0) {
    return "";
  }
  return `${SHARED_CONTACTS_MARKER}\n${JSON.stringify({
    shared_contacts: cards.map(serializeSharedContactForModel),
  })}`;
}

function isNormalizedSharedContact(value: unknown): value is InboundSharedContact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.name === "string" &&
    Array.isArray(row.phones) &&
    row.phones.every((p) => typeof p === "string")
  );
}

function serializeSharedContactForModel(
  card: InboundSharedContact,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: card.name,
    phones: card.phones,
  };
  if (card.emails?.length) {
    out.emails = card.emails;
  }
  if (card.urls?.length) {
    out.urls = card.urls;
  }
  if (card.addresses?.length) {
    out.addresses = card.addresses;
  }
  if (card.org && Object.values(card.org).some((v) => Boolean(v))) {
    out.org = card.org;
  }
  if (card.birthday) {
    out.birthday = card.birthday;
  }
  if (card.name_parts && Object.values(card.name_parts).some((v) => Boolean(v))) {
    out.name_parts = card.name_parts;
  }
  if (card.phone_entries?.length) {
    out.phone_entries = card.phone_entries;
  }
  return out;
}

function parseOneInboundContactCard(card: unknown): InboundSharedContact | null {
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    return null;
  }
  if (isNormalizedSharedContact(card)) {
    return card;
  }
  const record = card as Record<string, unknown>;
  const nameObj =
    record.name && typeof record.name === "object" && !Array.isArray(record.name)
      ? (record.name as Record<string, unknown>)
      : null;
  const formatted = asTrimmed(nameObj?.formatted_name);
  const first = asTrimmed(nameObj?.first_name);
  const last = asTrimmed(nameObj?.last_name);
  const middle = asTrimmed(nameObj?.middle_name);
  const prefix = asTrimmed(nameObj?.prefix);
  const suffix = asTrimmed(nameObj?.suffix);
  const name =
    formatted || [first, last].filter(Boolean).join(" ") || asTrimmed(record.name);

  const phoneEntries: Array<{ phone?: string; wa_id?: string; type?: string }> =
    [];
  const phones: string[] = [];
  if (Array.isArray(record.phones)) {
    const waIds: string[] = [];
    const raw: string[] = [];
    for (const entry of record.phones) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const phone = entry as Record<string, unknown>;
      const waId = asTrimmed(phone.wa_id);
      const number = asTrimmed(phone.phone);
      const type = asTrimmed(phone.type);
      if (!waId && !number) {
        continue;
      }
      const detail: { phone?: string; wa_id?: string; type?: string } = {};
      if (number) {
        detail.phone = number;
      }
      if (waId) {
        detail.wa_id = waId;
      }
      if (type) {
        detail.type = type;
      }
      phoneEntries.push(detail);
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

  if (!name && phones.length === 0) {
    return null;
  }

  const emails = parseTypedStringList(record.emails, "email");
  const urls = parseTypedStringList(record.urls, "url");
  const addresses = parseContactAddresses(record.addresses);
  const org = parseContactOrg(record.org);
  const birthday = asTrimmed(record.birthday);
  const name_parts: InboundSharedContact["name_parts"] = {};
  if (formatted) {
    name_parts.formatted_name = formatted;
  }
  if (first) {
    name_parts.first_name = first;
  }
  if (last) {
    name_parts.last_name = last;
  }
  if (middle) {
    name_parts.middle_name = middle;
  }
  if (prefix) {
    name_parts.prefix = prefix;
  }
  if (suffix) {
    name_parts.suffix = suffix;
  }

  const out: InboundSharedContact = { name, phones };
  if (emails.length) {
    out.emails = emails;
  }
  if (urls.length) {
    out.urls = urls;
  }
  if (addresses.length) {
    out.addresses = addresses;
  }
  if (org) {
    out.org = org;
  }
  if (birthday) {
    out.birthday = birthday;
  }
  if (Object.keys(name_parts).length > 0) {
    out.name_parts = name_parts;
  }
  if (phoneEntries.length > 0) {
    out.phone_entries = phoneEntries;
  }
  return out;
}

function parseTypedStringList(
  raw: unknown,
  valueKey: "email" | "url",
): Array<{ email: string; type?: string } | { url: string; type?: string }> {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Array<
    { email: string; type?: string } | { url: string; type?: string }
  > = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const value = asTrimmed(row[valueKey]);
    if (!value) {
      continue;
    }
    const type = asTrimmed(row.type);
    if (valueKey === "email") {
      out.push(type ? { email: value, type } : { email: value });
    } else {
      out.push(type ? { url: value, type } : { url: value });
    }
  }
  return out;
}

function parseContactAddresses(
  raw: unknown,
): NonNullable<InboundSharedContact["addresses"]> {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: NonNullable<InboundSharedContact["addresses"]> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const address: NonNullable<InboundSharedContact["addresses"]>[number] = {};
    for (const key of [
      "street",
      "city",
      "state",
      "zip",
      "country",
      "country_code",
      "type",
    ] as const) {
      const value = asTrimmed(row[key]);
      if (value) {
        address[key] = value;
      }
    }
    if (Object.keys(address).length > 0) {
      out.push(address);
    }
  }
  return out;
}

function parseContactOrg(
  raw: unknown,
): InboundSharedContact["org"] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  const org: NonNullable<InboundSharedContact["org"]> = {};
  for (const key of ["company", "department", "title"] as const) {
    const value = asTrimmed(row[key]);
    if (value) {
      org[key] = value;
    }
  }
  return Object.keys(org).length > 0 ? org : undefined;
}

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const recentInboundIds = new Set<string>();
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
  // Read receipt only — typing waits until after show_icon reaction (or LLM if none).
  await sendWhatsAppMarkRead(last.messageId);
  let stopTyping: () => void = () => {};
  try {
    await markWhatsAppInbound(from);
    let speaker = await resolveWhatsAppSpeaker(from);
    const inboundSpoken = batch
      .map((message) => message.text.trim())
      .filter(Boolean)
      .join("\n");
    const inviteBind = await bindInboundToInvite({
      fromPhone: from,
      inboundText: inboundSpoken,
      currentUserId: speaker.userId,
      currentEmployeeId: speaker.employeeId,
    }).catch(() => null);
    let pendingInvite = inviteBind?.context;
    if (inviteBind) {
      speaker = {
        userId: inviteBind.userId,
        employeeId: inviteBind.employeeId,
      };
    } else {
      const sticky =
        (await findPendingInviteForGuest(speaker.employeeId).catch(() => null)) ??
        (await findPendingInviteByPhone(from).catch(() => null));
      if (sticky) {
        const rebound = await bindInboundToInvite({
          fromPhone: from,
          inboundText: `${sticky.token}\n`,
          currentUserId: speaker.userId,
          currentEmployeeId: speaker.employeeId,
        }).catch(() => null);
        if (rebound) {
          speaker = {
            userId: rebound.userId,
            employeeId: rebound.employeeId,
          };
          pendingInvite = rebound.context;
        }
      }
    }
    const employees = await listEmployeesForUser(speaker.userId);
    const speakerEmployee = employees.find((row) => row.id === speaker.employeeId);
    const digitals = digitalEmployees(employees);
    const guestLucy = digitals.find(
      (employee) =>
        employee.name === GUEST_LUCY_NAME || employee.nickname === GUEST_LUCY_NAME,
    );
    const digital = speakerEmployee && isGuestEmployee(speakerEmployee)
      ? guestLucy ??
        digitals.find((employee) => employee.protected) ??
        digitals[0]
      : sessionDigitalFromSticky(from, digitals) ??
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
    const locMessage = batch.find((message) => message.location);
    const location = locMessage?.location
      ? await enrichEmptyLocationLabels(locMessage.location)
      : undefined;
    if (location) {
      setPendingLocation(speaker.employeeId, location);
      // Keep the model-facing turn in sync when reverse-geocode filled labels.
      if (locMessage) {
        locMessage.location = location;
        locMessage.text = formatSharedLocationMessage(location);
      }
    }
    const spoken = batchSpokenText(
      batch,
      stored.map(({ row }) => row.transcript),
    );
    if (stored.length === 0 && !spoken && !location) {
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
      ...(pendingInvite ? { pendingInvite } : {}),
    });
    const handoff =
      parseReplyMetadata(turn.reply).handoff?.worker ?? turn.answeredBy;
    applyWhatsAppHandoff(from, handoff, digitals);
    if (handoff && handoff !== digital.name) {
      recordWhatsAppEvent("handoff", `worker=${handoff}`);
    }
    const parsed = parseLlmReply(turn.reply);
    const bubbles = parsed.responseBubbles
      .map((bubble) => ({
        ...bubble,
        text: bubble.text.trim(),
      }))
      .filter((bubble) => bubble.text);
    const buttonCount = bubbles.reduce(
      (sum, bubble) => sum + (bubble.buttons?.length ?? 0),
      0,
    );
    recordWhatsAppEvent(
      "llm_ok",
      `replies=${bubbles.length} replyChars=${parsed.response.length} buttons=${buttonCount} icon=${parsed.showIcon ?? ""} files_out=${turn.outboundAttachmentIds.length}`,
    );
    // Fast path after LLM: acknowledge already sent → reaction (if any) → typing → reply.
    if (parsed.showIcon) {
      const reactionResult = await sendWhatsAppReaction(
        from,
        last.messageId,
        parsed.showIcon,
      );
      recordWhatsAppEvent("reaction_send", `result=${reactionResult}`);
    }
    if (parsed.showIcon || bubbles.length > 0) {
      stopTyping = await beginWhatsAppTyping(last.messageId);
    }
    let delivered = true;
    for (const [index, bubble] of bubbles.entries()) {
      if (index > 0) {
        await sendWhatsAppTyping(last.messageId);
        await sleep(typingPauseMs(bubble.text));
      }
      const sendResult = await sendWhatsAppButtons(
        from,
        bubble.text,
        bubble.buttons ?? [],
        { ignoreSession: true },
      );
      recordWhatsAppEvent("reply_send", `part=${index + 1} result=${sendResult}`);
      if (sendResult !== "sent") {
        delivered = false;
        break;
      }
      if (bubble.navigateAddress) {
        const navigateResult = await sendWhatsAppNavigate(
          from,
          bubble.navigateAddress,
          { ignoreSession: true },
        );
        recordWhatsAppEvent("navigate_send", `result=${navigateResult}`);
      }
      if (bubble.whatsappComposeUrl) {
        const composeResult = await sendWhatsAppComposeUrl(
          from,
          bubble.whatsappComposeUrl,
          WHATSAPP_COMPOSE_LABEL,
          { ignoreSession: true },
        );
        recordWhatsAppEvent("compose_send", `result=${composeResult}`);
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
  applyWhatsAppWorkerSticky(from, matched.id);
  return matched;
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

  const matches: Array<{ userId: string; employee: PublicEmployee }> = [];
  for (const user of users) {
    const humans = humanEmployees(await listEmployeesForUser(user.id));
    for (const employee of humans) {
      if (employee.phone && phonesMatch(employee.phone, from)) {
        matches.push({ userId: user.id, employee });
      }
    }
  }
  // Prefer a registered member over an אורח shell when duplicates exist.
  const preferred =
    matches.find((row) => !isGuestEmployee(row.employee)) ?? matches[0];
  if (preferred) {
    return { userId: preferred.userId, employeeId: preferred.employee.id };
  }

  const fallbackUser = users[0];
  if (!fallbackUser) {
    throw new ServiceUnavailableError();
  }

  const created = await createEmployeeForUser(
    fallbackUser.id,
    {
      kind: "human",
      name: "אורח",
      surname: "",
      nickname: maskPhoneName(from),
      email: null,
      phone: from,
    },
    { isGuest: true },
  );
  return { userId: fallbackUser.id, employeeId: created.id };
}

function maskPhoneName(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length < 4 ? "אורח" : `אורח …${digits.slice(-4)}`;
}
