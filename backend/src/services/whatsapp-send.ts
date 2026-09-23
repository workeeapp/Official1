import { isDigitalEmployee, type PublicEmployee } from "@workee/shared";
import { getEnv } from "../config/env.js";
import { ServiceUnavailableError } from "../utils/errors.js";

export async function sendWhatsAppText(to: string, text: string): Promise<void> {
  const env = getEnv();
  const token = env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId) {
    throw new ServiceUnavailableError();
  }

  const destination = to.replace(/\D/g, "");
  if (!destination) {
    throw new ServiceUnavailableError();
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
    console.error(`WhatsApp send failed status=${response.status} ${detail}`);
    throw new ServiceUnavailableError();
  }
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
): Promise<void> {
  if (getEnv().NODE_ENV === "test" || !getEnv().WHATSAPP_ACCESS_TOKEN?.trim()) {
    return;
  }

  const sent = new Set<string>();
  for (const relay of relays) {
    if (relay.target.id === actorId || isDigitalEmployee(relay.target)) {
      continue;
    }
    const phone = relay.target.phone?.trim();
    if (!phone || sent.has(relay.target.id)) {
      continue;
    }
    sent.add(relay.target.id);
    try {
      await sendWhatsAppText(phone, relay.text);
    } catch (error) {
      console.error(
        "WhatsApp relay failed",
        error instanceof Error ? error.message : "unknown",
      );
    }
  }
}
