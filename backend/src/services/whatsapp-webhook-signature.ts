/**
 * F0 — Meta WhatsApp Cloud API webhook authenticity.
 * X-Hub-Signature-256 = HMAC-SHA256(app_secret, raw_body) as sha256=<hex>.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Env } from "../config/env.js";

export const WHATSAPP_SIGNATURE_HEADER = "x-hub-signature-256";

/** Express request field set by webhook raw-body middleware. */
export type WhatsAppRawBody = { rawBody?: Buffer };

export type WhatsAppSignatureResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 };

/** Build the header value Meta sends (for tests / fixtures). */
export function signWhatsAppWebhookBody(
  rawBody: Buffer,
  appSecret: string,
): string {
  const hex = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return `sha256=${hex}`;
}

function parseSignatureHex(header: string | undefined): Buffer | null {
  if (!header || typeof header !== "string") {
    return null;
  }
  const trimmed = header.trim();
  const match = /^sha256=([0-9a-fA-F]+)$/.exec(trimmed);
  if (!match?.[1] || match[1].length % 2 !== 0) {
    return null;
  }
  try {
    const buf = Buffer.from(match[1], "hex");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Verify Meta webhook signature over the original request bytes.
 * Missing/malformed/wrong signature → 401/403. Never throws.
 *
 * There is no production bypass. Callers in NODE_ENV=test must supply a real
 * HMAC (fixture) via WHATSAPP_APP_SECRET + signWhatsAppWebhookBody.
 */
export function verifyWhatsAppWebhookSignature(input: {
  rawBody: Buffer | undefined;
  signatureHeader: string | undefined;
  appSecret: string | undefined;
}): WhatsAppSignatureResult {
  const secret = input.appSecret?.trim() ?? "";
  if (!secret) {
    return { ok: false, status: 403 };
  }
  const raw = input.rawBody;
  if (!raw || !Buffer.isBuffer(raw)) {
    return { ok: false, status: 401 };
  }
  const provided = parseSignatureHex(input.signatureHeader);
  if (!provided) {
    return { ok: false, status: 401 };
  }
  const expected = createHmac("sha256", secret).update(raw).digest();
  if (!safeEqual(provided, expected)) {
    return { ok: false, status: 403 };
  }
  return { ok: true };
}

/**
 * Production fail-closed: WhatsApp enabled (access token set) requires App Secret.
 * Call from process startup only — not from request handlers.
 */
export function assertWhatsAppWebhookConfig(env: Pick<
  Env,
  "NODE_ENV" | "WHATSAPP_ACCESS_TOKEN" | "WHATSAPP_APP_SECRET"
>): void {
  if (env.NODE_ENV !== "production") {
    return;
  }
  const waActive = Boolean(env.WHATSAPP_ACCESS_TOKEN?.trim());
  if (waActive && !env.WHATSAPP_APP_SECRET?.trim()) {
    throw new Error(
      "WHATSAPP_APP_SECRET is required in production when WHATSAPP_ACCESS_TOKEN is set",
    );
  }
}
