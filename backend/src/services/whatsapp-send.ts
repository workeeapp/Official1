import { isDigitalEmployee, type PublicEmployee } from "@workee/shared";
import { getEnv } from "../config/env.js";
import { ServiceUnavailableError } from "../utils/errors.js";
import { toWhatsAppAddress } from "../utils/phone.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import { hasWhatsAppSession } from "./whatsapp-window.js";

export type WhatsAppTextResult = "sent" | "no_session" | "failed";

/** Spoken when the real reply could not be delivered after retries. */
export const WHATSAPP_SEND_FALLBACK_HE =
  "לא הצלחתי לשלוח את התשובה בגלל תקלה זמנית בוואטסאפ. שלחי שוב בבקשה ואנסה שוב.";

export interface WhatsAppDeliverySkip {
  label: string;
  reason: "no_session" | "failed" | "no_phone";
}

const TYPING_REFRESH_MS = 20_000;

/** Initial try + retries for transient Graph blips (e.g. OAuth #2 unavailable). */
const SEND_MAX_ATTEMPTS = 4;
/** Pause before attempt 2 / 3 / 4. */
const SEND_RETRY_DELAYS_MS = [800, 2000, 4000] as const;

export function isTransientWhatsAppSendFailure(
  status: number,
  detail: string,
): boolean {
  if (status === 429 || status === 408 || status >= 500) {
    return true;
  }
  if (/\b131047\b/.test(detail)) {
    return false;
  }
  if (status === 401 || status === 403) {
    return false;
  }
  // Meta OAuthException (#2) Service temporarily unavailable — seen on reply sends.
  if (/\bcode=2\b/.test(detail) || /\(#2\)/.test(detail)) {
    return true;
  }
  if (/temporarily unavailable|try again later|service unavailable/i.test(detail)) {
    return true;
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

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

export async function sendWhatsAppText(
  to: string,
  text: string,
  options?: {
    ignoreSession?: boolean;
    sleepFn?: (ms: number) => Promise<void>;
    /** Cap attempts (default SEND_MAX_ATTEMPTS). Useful for short fallbacks. */
    maxAttempts?: number;
    /** Ops alert path — log under ops_* so send_fail cannot re-alert. */
    muteOps?: boolean;
  },
): Promise<WhatsAppTextResult> {
  const env = getEnv();
  const token = env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId) {
    throw new ServiceUnavailableError(undefined, {
      detail: "whatsapp_not_configured",
    });
  }

  const destination = toWhatsAppAddress(to);
  if (!destination) {
    throw new ServiceUnavailableError(undefined, {
      detail: "invalid_destination_phone",
    });
  }

  if (!options?.ignoreSession && !(await hasWhatsAppSession(destination))) {
    recordWhatsAppEvent("send_skip", `reason=no_session to=…${destination.slice(-4)}`);
    return "no_session";
  }

  const wait = options?.sleepFn ?? sleep;
  const maxAttempts = Math.max(
    1,
    Math.min(options?.maxAttempts ?? SEND_MAX_ATTEMPTS, SEND_MAX_ATTEMPTS),
  );
  const body = JSON.stringify({
    messaging_product: "whatsapp",
    to: destination,
    type: "text",
    text: { body: text.slice(0, 4096), preview_url: false },
  });
  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const stepOk = options?.muteOps ? "ops_send_ok" : "send_ok";
  const stepRetry = options?.muteOps ? "ops_send_retry" : "send_retry";
  const stepFail = options?.muteOps ? "ops_send_fail" : "send_fail";

  let lastResult: WhatsAppTextResult = "failed";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { method: "POST", headers, body });
      if (response.ok) {
        const suffix =
          attempt > 1 ? ` after_retry=${attempt - 1}` : "";
        recordWhatsAppEvent(
          stepOk,
          `to=…${destination.slice(-4)}${suffix}`,
        );
        return "sent";
      }

      const detail = await graphErrorDetail(response);
      const result = /\b131047\b/.test(detail) ? "no_session" : "failed";
      lastResult = result;
      const transient =
        result === "failed" &&
        isTransientWhatsAppSendFailure(response.status, detail);
      recordWhatsAppEvent(
        transient && attempt < maxAttempts ? stepRetry : stepFail,
        `status=${response.status} result=${result} attempt=${attempt}/${maxAttempts} ${detail}`.trim(),
      );
      if (!transient || attempt >= maxAttempts) {
        return result;
      }
    } catch (error) {
      lastResult = "failed";
      const message = error instanceof Error ? error.message : "unknown";
      const canRetry = attempt < maxAttempts;
      recordWhatsAppEvent(
        canRetry ? stepRetry : stepFail,
        `network attempt=${attempt}/${maxAttempts} ${message}`.trim(),
      );
      if (!canRetry) {
        return "failed";
      }
    }

    const delay = SEND_RETRY_DELAYS_MS[attempt - 1] ?? SEND_RETRY_DELAYS_MS.at(-1)!;
    await wait(delay);
  }

  return lastResult;
}

/**
 * Send the assistant reply to WhatsApp. If it still fails after retries, try once
 * more with a short Hebrew notice so the speaker is not left with silence.
 */
export async function sendWhatsAppReplyOrFallback(
  to: string,
  reply: string,
  options?: { ignoreSession?: boolean; sleepFn?: (ms: number) => Promise<void> },
): Promise<{ result: WhatsAppTextResult; usedFallback: boolean }> {
  const text = reply.trim();
  if (!text) {
    return { result: "failed", usedFallback: false };
  }

  const result = await sendWhatsAppText(to, text, options);
  if (result === "sent") {
    return { result, usedFallback: false };
  }

  const fallbackResult = await sendWhatsAppText(to, WHATSAPP_SEND_FALLBACK_HE, {
    ...options,
    // Short notice: fewer waits if Graph is still flaky.
    maxAttempts: 2,
  });
  recordWhatsAppEvent(
    "reply_fallback",
    `after=${result} result=${fallbackResult}`,
  );
  return {
    result: fallbackResult,
    usedFallback: true,
  };
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
