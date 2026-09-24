import { isDigitalEmployee, type PublicEmployee } from "@workee/shared";
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

export async function sendWhatsAppText(
  to: string,
  text: string,
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
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: destination,
        type: "text",
        text: { body: text.slice(0, 4096), preview_url: false },
      }),
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

export async function deliverWhatsAppRelays(
  relays: Array<{ target: PublicEmployee; text: string }>,
  actorId: string,
): Promise<WhatsAppDeliverySkip[]> {
  if (getEnv().NODE_ENV === "test" || !getEnv().WHATSAPP_ACCESS_TOKEN?.trim()) {
    return [];
  }

  const skips: WhatsAppDeliverySkip[] = [];
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
    }
  }
  return skips;
}

export async function deliverWhatsAppPhones(
  relays: Array<{ phone: string; text: string }>,
): Promise<WhatsAppDeliverySkip[]> {
  if (getEnv().NODE_ENV === "test" || !getEnv().WHATSAPP_ACCESS_TOKEN?.trim()) {
    return [];
  }

  const skips: WhatsAppDeliverySkip[] = [];
  const sent = new Set<string>();
  for (const relay of relays) {
    const phone = toWhatsAppAddress(relay.phone);
    if (!phone || sent.has(phone)) {
      continue;
    }
    sent.add(phone);
    const result = await sendQuietly(phone, relay.text, "WhatsApp phone send failed");
    if (result !== "sent") {
      skips.push({
        label: phone,
        reason: result === "no_session" ? "no_session" : "failed",
      });
    }
  }
  return skips;
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

export function replaceLlmResponse(reply: string, response: string): string {
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
