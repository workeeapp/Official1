import {
  isDigitalEmployee,
  REPLY_BUTTON_COMMAND_MAX,
  REPLY_BUTTON_LABEL_MAX,
  REPLY_BUTTON_MAX,
  type LlmReplyButton,
  type PublicEmployee,
} from "@workee/shared";
import { getEnv } from "../config/env.js";
import { ServiceUnavailableError } from "../utils/errors.js";
import { toWhatsAppAddress } from "../utils/phone.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import { hasWhatsAppSession } from "./whatsapp-window.js";

export type WhatsAppTextResult = "sent" | "no_session" | "failed";

export interface WhatsAppDeliverySkip {
  label: string;
  reason: "no_session" | "failed" | "no_phone";
}

const TYPING_REFRESH_MS = 20_000;

export function whatsappTypingBody(messageId: string): {
  messaging_product: "whatsapp";
  status: "read";
  message_id: string;
  typing_indicator: { type: "text" };
} {
  return {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  };
}

export async function sendWhatsAppTyping(messageId: string): Promise<boolean> {
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
        body: JSON.stringify(whatsappTypingBody(id)),
      },
    );
    if (!response.ok) {
      const detail = await graphErrorDetail(response);
      recordWhatsAppEvent("typing_fail", `status=${response.status} ${detail}`.trim());
      return false;
    }
    recordWhatsAppEvent("typing_ok", `id=${id.slice(0, 20)}`);
    return true;
  } catch (error) {
    recordWhatsAppEvent(
      "typing_fail",
      error instanceof Error ? error.message : "unknown",
    );
    return false;
  }
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

export const WHATSAPP_BUTTON_BODY_MAX = 1024;
const WHATSAPP_BUTTONS_FOLLOWUP_BODY = "לצפייה ברשימה";

export function whatsappButtonsBody(
  destination: string,
  body: string,
  buttons: LlmReplyButton[],
): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    to: destination,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body.slice(0, WHATSAPP_BUTTON_BODY_MAX) },
      action: {
        buttons: buttons.slice(0, REPLY_BUTTON_MAX).map((button) => ({
          type: "reply",
          reply: {
            id: button.command.slice(0, REPLY_BUTTON_COMMAND_MAX),
            title: button.label.slice(0, REPLY_BUTTON_LABEL_MAX),
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
      text: { body: text.slice(0, 4096), preview_url: false },
    }),
    options,
  );
}

async function sendWhatsAppPayload(
  to: string,
  payload: (destination: string) => Record<string, unknown>,
  options?: { ignoreSession?: boolean },
): Promise<WhatsAppTextResult> {
  const env = getEnv();
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

  const response = await fetch(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload(destination)),
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

  recordWhatsAppEvent("send_ok", `to=…${destination.slice(-4)}`);
  return "sent";
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
  relays: Array<{ target: PublicEmployee; text: string }>,
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
    const result = await sendQuietly(phone, relay.text, "WhatsApp relay failed");
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

export function setEngineResponse(reply: string, response: string): string {
  try {
    const parsed: unknown = JSON.parse(reply);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({
        ...(parsed as Record<string, unknown>),
        response,
      });
    }
  } catch {
    /* plain text */
  }
  return response;
}

export function appendEngineNotice(reply: string, notice: string): string {
  if (!notice.trim()) {
    return reply;
  }
  try {
    const parsed: unknown = JSON.parse(reply);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as { response?: unknown };
      if (typeof record.response === "string") {
        return JSON.stringify({
          ...record,
          response: `${record.response.trim()}\n\n${notice}`,
        });
      }
    }
  } catch {
    /* plain text */
  }
  return `${reply.trim()}\n\n${notice}`;
}
