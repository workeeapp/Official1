import {
  isDigitalEmployee,
  readSpokenBubbles,
  readSpokenResponses,
  serializeSpokenBubbles,
  REPLY_BUTTON_COMMAND_MAX,
  REPLY_BUTTON_LABEL_MAX,
  REPLY_BUTTON_MAX,
  wazeNavigateUrl,
  type AttachmentKind,
  type LlmReplyButton,
  type LlmSpokenBubble,
  type PublicEmployee,
} from "@workee/shared";
import { getEnv } from "../config/env.js";
import { ServiceUnavailableError } from "../utils/errors.js";
import { toWhatsAppAddress } from "../utils/phone.js";
import { EMPTY_REPLY_RETRY } from "./employee-records.service.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import { rememberWhatsAppOutbound } from "./whatsapp-outbound-memory.js";
import { hasWhatsAppSession } from "./whatsapp-window.js";

export type WhatsAppTextResult = "sent" | "no_session" | "failed";

export interface WhatsAppDeliverySkip {
  label: string;
  reason: "no_session" | "failed" | "no_phone";
}

const TYPING_REFRESH_MS = 20_000;

export function whatsappMarkReadBody(messageId: string): {
  messaging_product: "whatsapp";
  status: "read";
  message_id: string;
} {
  return {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  };
}

export function whatsappTypingBody(messageId: string): {
  messaging_product: "whatsapp";
  status: "read";
  message_id: string;
  typing_indicator: { type: "text" };
} {
  return {
    ...whatsappMarkReadBody(messageId),
    typing_indicator: { type: "text" },
  };
}

async function postWhatsAppStatus(
  messageId: string,
  body: Record<string, unknown>,
  okEvent: "typing_ok" | "mark_read_ok",
  failEvent: "typing_fail" | "mark_read_fail",
): Promise<boolean> {
  const id = messageId.trim();
  if (!id) {
    return false;
  }

  const env = getEnv();
  if (env.NODE_ENV === "test") {
    return false;
  }

  const token = env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId) {
    return false;
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const detail = await graphErrorDetail(response);
      recordWhatsAppEvent(failEvent, `status=${response.status} ${detail}`.trim());
      return false;
    }
    recordWhatsAppEvent(okEvent, `id=${id.slice(0, 20)}`);
    return true;
  } catch (error) {
    recordWhatsAppEvent(
      failEvent,
      error instanceof Error ? error.message : "unknown",
    );
    return false;
  }
}

/** Mark inbound as read without showing the typing indicator. Soft-fails. */
export async function sendWhatsAppMarkRead(messageId: string): Promise<boolean> {
  const id = messageId.trim();
  if (!id) {
    return false;
  }
  return postWhatsAppStatus(
    id,
    whatsappMarkReadBody(id),
    "mark_read_ok",
    "mark_read_fail",
  );
}

export async function sendWhatsAppTyping(messageId: string): Promise<boolean> {
  const id = messageId.trim();
  if (!id) {
    return false;
  }
  return postWhatsAppStatus(
    id,
    whatsappTypingBody(id),
    "typing_ok",
    "typing_fail",
  );
}

export function startWhatsAppTyping(messageId: string): () => void {
  if (getEnv().NODE_ENV === "test") {
    return () => {};
  }
  void sendWhatsAppTyping(messageId);
  const timer = setInterval(() => {
    void sendWhatsAppTyping(messageId);
  }, TYPING_REFRESH_MS);
  return () => {
    clearInterval(timer);
  };
}

/**
 * Await the first typing indicator, then refresh on an interval.
 * Prefer this when order vs reaction/reply matters (Graph ack ≠ device delivery).
 */
export async function beginWhatsAppTyping(
  messageId: string,
): Promise<() => void> {
  if (getEnv().NODE_ENV === "test") {
    return () => {};
  }
  await sendWhatsAppTyping(messageId);
  const timer = setInterval(() => {
    void sendWhatsAppTyping(messageId);
  }, TYPING_REFRESH_MS);
  return () => {
    clearInterval(timer);
  };
}

/**
 * WhatsApp renders *text* as bold; product copy quotes with «…» (kept as-is in
 * the DB and web chat). Bold markers must hug the text and stay on one line,
 * and only bold on word boundaries — letters glued to the quote (ל«X», «X»ים)
 * go inside the markers.
 */
const QUOTE_TO_BOLD =
  /([\p{L}\p{M}\p{N}]*)«[^\S\n]*([^«»\n]*?[^\s«»])[^\S\n]*»([\p{L}\p{M}\p{N}]*)/gu;

export function toWhatsAppFormatting(text: string): string {
  return text.replace(QUOTE_TO_BOLD, "*$1$2$3*");
}

export const WHATSAPP_BUTTON_BODY_MAX = 1024;
const WHATSAPP_BUTTONS_FOLLOWUP_BODY = "לצפייה ברשימה";

/** Hebrew — avoid \\b (JS word chars are ASCII-only even with /u). */
const ITEM_SHOW_TASK_COMMAND = /^הציגי?\s+את\s+המטלה(?:\s|$)/u;
const ITEM_SHOW_FILING_COMMAND = /^הציגי?\s+את\s+התיוק(?:\s|$)/u;

/**
 * WhatsApp reply titles hard-cap at REPLY_BUTTON_LABEL_MAX (20). Prefer the
 * fixed item-show fallbacks over mid-string slice when the model put a long
 * task/filing title on the label (full ask stays in command).
 */
export function fitReplyButtonLabel(button: LlmReplyButton): string {
  const label = button.label.trim();
  if (label.length <= REPLY_BUTTON_LABEL_MAX) {
    return label;
  }
  const command = button.command.trim();
  if (ITEM_SHOW_TASK_COMMAND.test(command)) {
    return "להצגת המטלה";
  }
  if (ITEM_SHOW_FILING_COMMAND.test(command)) {
    return "להצגת התיוק";
  }
  return label.slice(0, REPLY_BUTTON_LABEL_MAX);
}

export function whatsappButtonsBody(
  destination: string,
  body: string,
  buttons: LlmReplyButton[],
): Record<string, unknown> {
  // WhatsApp rejects duplicate reply titles in one interactive (#131009).
  const unique: LlmReplyButton[] = [];
  const seenTitles = new Set<string>();
  for (const button of buttons.slice(0, REPLY_BUTTON_MAX)) {
    const title = fitReplyButtonLabel(button);
    if (!title || seenTitles.has(title)) {
      continue;
    }
    seenTitles.add(title);
    unique.push(button);
  }
  return {
    messaging_product: "whatsapp",
    to: destination,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: toWhatsAppFormatting(body).slice(0, WHATSAPP_BUTTON_BODY_MAX) },
      action: {
        buttons: unique.map((button) => ({
          type: "reply",
          reply: {
            id: button.command.slice(0, REPLY_BUTTON_COMMAND_MAX),
            title: fitReplyButtonLabel(button),
          },
        })),
      },
    },
  };
}

/**
 * Reply text with tap buttons. A tap comes back as an inbound message whose
 * text is the button's command. Falls back to plain text if the interactive
 * send fails.
 */
export async function sendWhatsAppButtons(
  to: string,
  text: string,
  buttons: LlmReplyButton[],
  options?: { ignoreSession?: boolean },
): Promise<WhatsAppTextResult> {
  if (buttons.length === 0) {
    return sendWhatsAppText(to, text, options);
  }

  const fits = text.trim().length > 0 && text.length <= WHATSAPP_BUTTON_BODY_MAX;
  if (!fits) {
    const textResult = await sendWhatsAppText(to, text, options);
    if (textResult !== "sent") {
      return textResult;
    }
    await sendWhatsAppPayload(
      to,
      (destination) => whatsappButtonsBody(destination, WHATSAPP_BUTTONS_FOLLOWUP_BODY, buttons),
      { ignoreSession: true },
    );
    return textResult;
  }

  const result = await sendWhatsAppPayload(
    to,
    (destination) => whatsappButtonsBody(destination, text, buttons),
    options,
  );
  if (result === "failed") {
    return sendWhatsAppText(to, text, options);
  }
  return result;
}

export const WHATSAPP_NAVIGATE_LABEL = "פתח ב-Waze";

export function whatsappCtaUrlBody(
  destination: string,
  body: string,
  displayText: string,
  url: string,
): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    to: destination,
    type: "interactive",
    interactive: {
      type: "cta_url",
      body: { text: toWhatsAppFormatting(body).slice(0, WHATSAPP_BUTTON_BODY_MAX) },
      action: {
        name: "cta_url",
        parameters: { display_text: displayText, url },
      },
    },
  };
}

/** Waze button for the reply's address; plain text with the link if the CTA send fails. */
export async function sendWhatsAppNavigate(
  to: string,
  address: string,
  options?: { ignoreSession?: boolean },
): Promise<WhatsAppTextResult> {
  const url = wazeNavigateUrl(address);
  const result = await sendWhatsAppPayload(
    to,
    (destination) => whatsappCtaUrlBody(destination, address, WHATSAPP_NAVIGATE_LABEL, url),
    options,
  );
  if (result === "failed") {
    return sendWhatsAppText(to, `${WHATSAPP_NAVIGATE_LABEL}: ${url}`, options);
  }
  return result;
}

export interface WhatsAppMediaMessage {
  kind: AttachmentKind;
  /** Media id from our upload to WhatsApp. */
  mediaId: string;
  caption?: string;
  fileName?: string;
}

const WHATSAPP_CAPTION_MAX = 1024;

/** Audio and stickers cannot carry a caption; documents also carry their file name. */
export function whatsappMediaBody(
  destination: string,
  media: WhatsAppMediaMessage,
): Record<string, unknown> {
  const caption = media.caption?.trim()
    ? toWhatsAppFormatting(media.caption.trim()).slice(0, WHATSAPP_CAPTION_MAX)
    : "";
  const object: Record<string, unknown> = { id: media.mediaId };
  if (caption && media.kind !== "audio" && media.kind !== "sticker") {
    object.caption = caption;
  }
  if (media.kind === "document" && media.fileName?.trim()) {
    object.filename = media.fileName.trim().slice(0, 240);
  }
  return {
    messaging_product: "whatsapp",
    to: destination,
    type: media.kind,
    [media.kind]: object,
  };
}

export async function sendWhatsAppMedia(
  to: string,
  media: WhatsAppMediaMessage,
  options?: { ignoreSession?: boolean },
): Promise<WhatsAppTextResult> {
  return sendWhatsAppPayload(
    to,
    (destination) => whatsappMediaBody(destination, media),
    options,
  );
}

export async function sendWhatsAppText(
  to: string,
  text: string,
  options?: { ignoreSession?: boolean },
): Promise<WhatsAppTextResult> {
  return sendWhatsAppPayload(
    to,
    (destination) => ({
      messaging_product: "whatsapp",
      to: destination,
      type: "text",
      text: { body: toWhatsAppFormatting(text).slice(0, 4096), preview_url: false },
    }),
    options,
  );
}

/** Meta reaction on an inbound user message (emoji on their bubble). */
export function whatsappReactionBody(
  destination: string,
  messageId: string,
  emoji: string,
): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: destination,
    type: "reaction",
    reaction: {
      message_id: messageId,
      emoji,
    },
  };
}

/**
 * React to the speaker's inbound WhatsApp message. Soft-fails like typing —
 * a missed reaction must not block the spoken reply.
 */
export async function sendWhatsAppReaction(
  to: string,
  messageId: string,
  emoji: string,
): Promise<WhatsAppTextResult> {
  const id = messageId.trim();
  const icon = emoji.trim();
  if (!id || !icon) {
    return "failed";
  }

  const env = getEnv();
  if (env.NODE_ENV === "test") {
    return "sent";
  }

  try {
    return await sendWhatsAppPayload(
      to,
      (destination) => whatsappReactionBody(destination, id, icon),
      { ignoreSession: true },
    );
  } catch (error) {
    recordWhatsAppEvent(
      "reaction_fail",
      error instanceof Error ? error.message : "unknown",
    );
    return "failed";
  }
}

async function sendWhatsAppPayload(
  to: string,
  payload: (destination: string) => Record<string, unknown>,
  options?: { ignoreSession?: boolean },
): Promise<WhatsAppTextResult> {
  const env = getEnv();
  // Isolation for Studio / approved-test runs: keep real send code paths, but
  // never hit Meta Graph when outbound is explicitly disabled.
  if (process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND === "1") {
    recordWhatsAppEvent("send_skip", "reason=outbound_disabled");
    return "failed";
  }
  if (env.NODE_ENV === "test") {
    recordWhatsAppEvent("send_skip", "reason=node_env_test");
    return "failed";
  }
  const token = env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId) {
    throw new ServiceUnavailableError();
  }

  const destination = toWhatsAppAddress(to);
  if (!destination) {
    throw new ServiceUnavailableError();
  }

  if (!options?.ignoreSession && !(await hasWhatsAppSession(destination))) {
    recordWhatsAppEvent("send_skip", `reason=no_session to=…${destination.slice(-4)}`);
    return "no_session";
  }

  const body = payload(destination);
  const response = await fetch(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const detail = await graphErrorDetail(response);
    const result = /\b131047\b/.test(detail) ? "no_session" : "failed";
    recordWhatsAppEvent(
      "send_fail",
      `status=${response.status} result=${result} ${detail}`.trim(),
    );
    return result;
  }

  const outboundText = outboundTextFromPayload(body);
  if (outboundText) {
    try {
      const json = (await response.json()) as {
        messages?: Array<{ id?: unknown }>;
      };
      const graphId = json.messages?.[0]?.id;
      if (typeof graphId === "string" && graphId.trim()) {
        rememberWhatsAppOutbound(graphId.trim(), outboundText);
      }
    } catch {
      // send succeeded; missing id only skips reply-context memory
    }
  }

  recordWhatsAppEvent("send_ok", `to=…${destination.slice(-4)}`);
  return "sent";
}

function outboundTextFromPayload(body: Record<string, unknown>): string {
  const text = body.text as { body?: unknown } | undefined;
  if (typeof text?.body === "string" && text.body.trim()) {
    return text.body;
  }
  const interactive = body.interactive as
    | { body?: { text?: unknown }; type?: unknown }
    | undefined;
  if (typeof interactive?.body?.text === "string" && interactive.body.text.trim()) {
    return interactive.body.text;
  }
  return "";
}

async function graphErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; type?: unknown; message?: unknown };
    };
    const code = body.error?.code ?? "";
    const type = body.error?.type ?? "";
    const message =
      typeof body.error?.message === "string"
        ? body.error.message.replace(/EAA[A-Za-z0-9]+/g, "[token]")
        : "";
    return `code=${code} type=${type} ${message}`.trim();
  } catch {
    return "body=unreadable";
  }
}

export type WhatsAppDeliveryResult = {
  skips: WhatsAppDeliverySkip[];
  sentLabels: string[];
};

export async function deliverWhatsAppRelays(
  relays: Array<{
    target: PublicEmployee;
    text: string;
    buttons?: LlmReplyButton[];
  }>,
  actorId: string,
): Promise<WhatsAppDeliveryResult> {
  if (getEnv().NODE_ENV === "test" || !getEnv().WHATSAPP_ACCESS_TOKEN?.trim()) {
    return { skips: [], sentLabels: [] };
  }

  const skips: WhatsAppDeliverySkip[] = [];
  const sentLabels: string[] = [];
  const sent = new Set<string>();
  for (const relay of relays) {
    if (relay.target.id === actorId || isDigitalEmployee(relay.target)) {
      continue;
    }
    const label = relay.target.nickname?.trim() || relay.target.name;
    const phone = relay.target.phone?.trim();
    if (!phone) {
      skips.push({ label, reason: "no_phone" });
      continue;
    }
    if (sent.has(relay.target.id)) {
      continue;
    }
    sent.add(relay.target.id);
    const buttons = relay.buttons ?? [];
    const result =
      buttons.length > 0
        ? await sendQuietlyButtons(
            phone,
            relay.text,
            buttons,
            "WhatsApp relay failed",
          )
        : await sendQuietly(phone, relay.text, "WhatsApp relay failed");
    if (result !== "sent") {
      skips.push({
        label,
        reason: result === "no_session" ? "no_session" : "failed",
      });
    } else {
      sentLabels.push(label);
    }
  }
  return { skips, sentLabels };
}

export async function deliverWhatsAppPhones(
  relays: Array<{ phone: string; text: string; label?: string }>,
): Promise<WhatsAppDeliveryResult> {
  if (getEnv().NODE_ENV === "test" || !getEnv().WHATSAPP_ACCESS_TOKEN?.trim()) {
    return { skips: [], sentLabels: [] };
  }

  const skips: WhatsAppDeliverySkip[] = [];
  const sentLabels: string[] = [];
  const sent = new Set<string>();
  for (const relay of relays) {
    const phone = toWhatsAppAddress(relay.phone);
    if (!phone || sent.has(phone)) {
      continue;
    }
    sent.add(phone);
    const label = relay.label?.trim() || phone;
    const result = await sendQuietly(phone, relay.text, "WhatsApp phone send failed");
    if (result !== "sent") {
      skips.push({
        label,
        reason: result === "no_session" ? "no_session" : "failed",
      });
    } else {
      sentLabels.push(label);
    }
  }
  return { skips, sentLabels };
}

async function sendQuietly(
  phone: string,
  text: string,
  logLabel: string,
): Promise<WhatsAppTextResult> {
  try {
    return await sendWhatsAppText(phone, text);
  } catch (error) {
    console.error(logLabel, error instanceof Error ? error.message : "unknown");
    return "failed";
  }
}

async function sendQuietlyButtons(
  phone: string,
  text: string,
  buttons: LlmReplyButton[],
  logLabel: string,
): Promise<WhatsAppTextResult> {
  try {
    return await sendWhatsAppButtons(phone, text, buttons);
  } catch (error) {
    console.error(logLabel, error instanceof Error ? error.message : "unknown");
    return "failed";
  }
}

export function formatWhatsAppSkipNotice(skips: WhatsAppDeliverySkip[]): string {
  if (skips.length === 0) {
    return "";
  }

  return skips
    .map((skip) => {
      if (skip.reason === "no_session") {
        return `הוואטסאפ אל ${skip.label} לא נשלח: הנמען לא כתב לעסק ב־24 השעות האחרונות.`;
      }
      if (skip.reason === "no_phone") {
        return `הוואטסאפ אל ${skip.label} לא נשלח: אין מספר בכרטיס.`;
      }
      return `הוואטסאפ אל ${skip.label} לא נשלח.`;
    })
    .join("\n");
}

export function composeAssistantReply(input: {
  llmReply: string;
  notice: string;
  /** When WhatsApp delivery failed, drop the model's false "sent" claim. */
  replaceResponse?: boolean;
}): string {
  if (input.replaceResponse && input.notice.trim()) {
    return setEngineResponse(input.llmReply, input.notice.trim());
  }
  return appendEngineNotice(input.llmReply, input.notice);
}

function parseReplyRecord(reply: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(reply);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* plain text */
  }
  return null;
}

function withSpokenBubbles(
  record: Record<string, unknown>,
  bubbles: LlmSpokenBubble[],
): string {
  const { response: _legacy, ...rest } = record;
  const flatButtons = bubbles.flatMap((bubble) => bubble.buttons ?? []);
  const metadata =
    rest.metadata &&
    typeof rest.metadata === "object" &&
    !Array.isArray(rest.metadata)
      ? { ...(rest.metadata as Record<string, unknown>) }
      : {};
  if (flatButtons.length === 0) {
    delete metadata.buttons;
  } else {
    const seen = new Set<string>();
    metadata.buttons = flatButtons.filter((button) => {
      if (seen.has(button.command)) {
        return false;
      }
      seen.add(button.command);
      return true;
    });
  }
  const navigate = bubbles.find((bubble) => bubble.navigateAddress)?.navigateAddress;
  if (navigate) {
    metadata.navigate_address = navigate;
  } else {
    delete metadata.navigate_address;
  }
  return JSON.stringify({
    ...rest,
    responses: serializeSpokenBubbles(bubbles),
    metadata,
  });
}

function withResponses(
  record: Record<string, unknown>,
  responses: string[],
): string {
  return withSpokenBubbles(
    record,
    responses.map((text) => ({ text })),
  );
}

/** Replaces every spoken message of the turn with one engine message. */
export function setEngineResponse(reply: string, response: string): string {
  const record = parseReplyRecord(reply);
  return record ? withResponses(record, [response]) : response;
}

/** Writes per-bubble text + buttons + Waze (and mirrors flat metadata for legacy). */
export function setEngineSpokenBubbles(
  reply: string,
  bubbles: LlmSpokenBubble[],
): string {
  const record = parseReplyRecord(reply);
  if (!record) {
    return reply;
  }
  return withSpokenBubbles(record, bubbles);
}

/**
 * Patches buttons on a JSON LLM reply.
 * When responses already use per-bubble chrome, merges onto the first bubble
 * (show taps) while preserving other bubbles' choice buttons via the caller —
 * prefer {@link setEngineSpokenBubbles} after applyShowButtonsToBubbles.
 * Legacy string responses: writes turn-level metadata.buttons.
 */
export function setEngineButtons(
  reply: string,
  buttons: Array<{ label: string; command: string }>,
): string {
  const record = parseReplyRecord(reply);
  if (!record) {
    return reply;
  }
  const bubbles = readSpokenBubbles(record);
  if (bubbles && bubbles.length > 0) {
    const next = bubbles.map((bubble, index) => {
      if (index !== 0) {
        return bubble;
      }
      if (buttons.length === 0) {
        const { buttons: _drop, ...rest } = bubble;
        return rest;
      }
      return { ...bubble, buttons: [...buttons] };
    });
    // If only one bubble, put all buttons there; multi-bubble callers should
    // use setEngineSpokenBubbles with applyShowButtonsToBubbles instead.
    if (bubbles.length === 1) {
      return withSpokenBubbles(record, next);
    }
  }
  const metadata =
    record.metadata &&
    typeof record.metadata === "object" &&
    !Array.isArray(record.metadata)
      ? { ...(record.metadata as Record<string, unknown>) }
      : {};
  if (buttons.length === 0) {
    delete metadata.buttons;
  } else {
    metadata.buttons = buttons.map(({ label, command }) => ({ label, command }));
  }
  return JSON.stringify({ ...record, metadata });
}

/** Patches navigate_address (Waze) onto the first bubble without one, plus metadata. */
export function setEngineNavigateAddress(
  reply: string,
  address: string | null,
): string {
  const record = parseReplyRecord(reply);
  if (!record) {
    return reply;
  }
  const trimmed = address?.trim() ?? "";
  const bubbles = readSpokenBubbles(record);
  if (bubbles && bubbles.length > 0) {
    const next = bubbles.map((bubble, index) => {
      if (!trimmed) {
        const { navigateAddress: _drop, ...rest } = bubble;
        return rest;
      }
      if (bubble.navigateAddress) {
        return bubble;
      }
      const firstEmpty = bubbles.findIndex((row) => !row.navigateAddress);
      if (index === (firstEmpty >= 0 ? firstEmpty : 0)) {
        return { ...bubble, navigateAddress: trimmed };
      }
      return bubble;
    });
    return withSpokenBubbles(record, next);
  }
  const metadata =
    record.metadata &&
    typeof record.metadata === "object" &&
    !Array.isArray(record.metadata)
      ? { ...(record.metadata as Record<string, unknown>) }
      : {};
  if (!trimmed) {
    delete metadata.navigate_address;
  } else {
    metadata.navigate_address = trimmed;
  }
  return JSON.stringify({ ...record, metadata });
}

/** Adds an engine body as its own message after the model's messages (no buttons/Waze). */
export function appendEngineResponse(reply: string, text: string): string {
  if (!text.trim()) {
    return reply;
  }
  const record = parseReplyRecord(reply);
  if (record) {
    const spoken = readSpokenBubbles(record);
    if (spoken) {
      return withSpokenBubbles(record, [...spoken, { text: text.trim() }]);
    }
  }
  return `${reply.trim()}\n\n${text.trim()}`;
}

/** @deprecated Prefer {@link appendEngineResponse}. */
export function appendEngineNotice(reply: string, notice: string): string {
  return appendEngineResponse(reply, notice);
}

/**
 * Preface for the WATCH baseline sample (2nd bubble after the model ack).
 * Pure live asks stay unwrapped — only WATCH+ack uses this.
 */
export function formatWatchSampleLive(
  liveText: string,
  domain: "market" | "other" = "other",
): string {
  const body = liveText.trim();
  if (!body) {
    return "";
  }
  if (/^לידיעתך\s+כרגע/u.test(body)) {
    return body;
  }
  if (domain === "market") {
    const isFx =
      /\([A-Z]{2,5}=X\)/.test(body) ||
      /\b[A-Z]{3}\/[A-Z]{3}\b/.test(body) ||
      /שער/.test(body);
    const label = isFx ? "השער הוא" : "המחיר הוא";
    return `לידיעתך כרגע ${label} ${body}`;
  }
  return `לידיעתך כרגע:\n${body}`;
}

/**
 * Live domain reply: keep the model's ack when present, else replace with facts.
 * Pure live ask (empty spoken) → replace with all parts (e.g. tip + weather body).
 * WATCH/ack + sample → append one sample bubble (last part only when array).
 * Engine EMPTY_REPLY_RETRY alone is not an ack — replace so live facts are not
 * double-bubbled after a premature empty fallback.
 * WATCH sample (`watchSample`) wraps the 2nd bubble with «לידיעתך כרגע…».
 */
export function applyLiveDomainReply(
  reply: string,
  liveText: string | string[],
  options?: { watchSample?: boolean; watchDomain?: "market" | "other" },
): string {
  const parts = (Array.isArray(liveText) ? liveText : [liveText])
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return reply;
  }
  const record = parseReplyRecord(reply);
  const spoken = record ? readSpokenResponses(record) : null;
  const nonEmpty = (spoken ?? []).map((entry) => entry.trim()).filter(Boolean);
  const plain = !record ? reply.trim() : "";
  const onlyEmptyRetry =
    (nonEmpty.length === 1 && nonEmpty[0] === EMPTY_REPLY_RETRY) ||
    plain === EMPTY_REPLY_RETRY;
  const hasAck = Boolean(
    !onlyEmptyRetry && (nonEmpty.length > 0 || plain.length > 0),
  );
  if (!hasAck) {
    const next = parseReplyRecord(reply);
    return next ? withResponses(next, parts) : parts.join("\n\n");
  }
  // WATCH / ack: append facts body only (last part) — never tip as sample.
  const body = parts[parts.length - 1]!;
  const sample =
    options?.watchSample === true
      ? formatWatchSampleLive(body, options.watchDomain ?? "other")
      : body;
  return appendEngineResponse(reply, sample);
}
