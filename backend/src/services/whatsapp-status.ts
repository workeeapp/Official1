import type { WhatsAppStatusResponse } from "@workee/shared";
import { getEnv } from "../config/env.js";
import {
  lastWhatsAppInboundAt,
  listWhatsAppEvents,
} from "./whatsapp-log.js";

export const EXPECTED_WHATSAPP_WEBHOOK =
  "https://wa.workee.site/api/whatsapp/webhook";

function redact(value: string): string {
  return value.replace(/EAA[A-Za-z0-9]+/g, "[token]");
}

export async function getWhatsAppStatus(): Promise<WhatsAppStatusResponse> {
  const env = getEnv();
  const meta = await readMetaWebhookUrls();
  const expected = EXPECTED_WHATSAPP_WEBHOOK;
  const urls = [meta.waba, meta.app].filter(Boolean) as string[];
  const webhookMismatch =
    urls.length > 0 &&
    urls.some((url) => !url.startsWith("https://wa.workee.site/"));

  return {
    expectedWebhook: expected,
    metaWabaWebhook: meta.waba,
    metaAppWebhook: meta.app,
    webhookMismatch,
    hasAccessToken: Boolean(env.WHATSAPP_ACCESS_TOKEN?.trim()),
    lastInboundAt: lastWhatsAppInboundAt(),
    events: listWhatsAppEvents(),
  };
}

async function readMetaWebhookUrls(): Promise<{
  waba: string | null;
  app: string | null;
}> {
  const env = getEnv();
  const token = env.WHATSAPP_ACCESS_TOKEN?.trim();
  const wabaId = env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim();
  const phoneId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token) {
    return { waba: null, app: null };
  }

  try {
    const [wabaRes, phoneRes] = await Promise.all([
      wabaId
        ? fetch(`https://graph.facebook.com/v22.0/${wabaId}/subscribed_apps`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        : Promise.resolve(null),
      phoneId
        ? fetch(`https://graph.facebook.com/v22.0/${phoneId}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        : Promise.resolve(null),
    ]);

    let waba: string | null = null;
    if (wabaRes?.ok) {
      const body = (await wabaRes.json()) as {
        data?: Array<{ override_callback_uri?: string }>;
      };
      waba = body.data?.[0]?.override_callback_uri?.trim() || null;
    }

    let app: string | null = null;
    if (phoneRes?.ok) {
      const body = (await phoneRes.json()) as {
        webhook_configuration?: {
          whatsapp_business_account?: string;
          application?: string;
        };
      };
      app =
        body.webhook_configuration?.whatsapp_business_account?.trim() ||
        body.webhook_configuration?.application?.trim() ||
        null;
    }

    return {
      waba: waba ? redact(waba) : null,
      app: app ? redact(app) : null,
    };
  } catch {
    return { waba: null, app: null };
  }
}
