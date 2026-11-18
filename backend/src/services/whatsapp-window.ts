import { prisma } from "../database/prisma.js";
import { toWhatsAppAddress } from "../utils/phone.js";

export const WHATSAPP_SESSION_MS = 24 * 60 * 60 * 1000;

export function sessionOpenAt(
  lastInboundAt: Date | null | undefined,
  now = new Date(),
): boolean {
  if (!lastInboundAt) {
    return false;
  }
  return now.getTime() - lastInboundAt.getTime() < WHATSAPP_SESSION_MS;
}

export async function markWhatsAppInbound(
  phone: string,
  at = new Date(),
): Promise<void> {
  const destination = toWhatsAppAddress(phone);
  if (!destination || !prisma.whatsAppInbound) {
    return;
  }
  try {
    await prisma.whatsAppInbound.upsert({
      where: { phone: destination },
      create: { phone: destination, lastInboundAt: at },
      update: { lastInboundAt: at },
    });
  } catch (error) {
    console.error(
      "WhatsApp inbound window save failed",
      error instanceof Error ? error.message : "unknown",
    );
  }
}

export async function hasWhatsAppSession(
  phone: string,
  now = new Date(),
): Promise<boolean> {
  const destination = toWhatsAppAddress(phone);
  if (!destination) {
    return false;
  }
  if (!prisma.whatsAppInbound) {
    return true;
  }
  try {
    const row = await prisma.whatsAppInbound.findUnique({
      where: { phone: destination },
    });
    return sessionOpenAt(row?.lastInboundAt, now);
  } catch (error) {
    console.error(
      "WhatsApp session lookup failed",
      error instanceof Error ? error.message : "unknown",
    );
    return true;
  }
}

/**
 * Dev / test helper: drop the Meta 24h customer-service window row so the
 * phone is treated as cold (no open session). Prefer delete over nulling
 * `lastInboundAt` (column is non-nullable).
 */
export async function clearWhatsAppInboundWindow(phone: string): Promise<boolean> {
  const destination = toWhatsAppAddress(phone);
  if (!destination || !prisma.whatsAppInbound) {
    return false;
  }
  try {
    const result = await prisma.whatsAppInbound.deleteMany({
      where: { phone: destination },
    });
    return result.count > 0;
  } catch (error) {
    console.error(
      "WhatsApp inbound window clear failed",
      error instanceof Error ? error.message : "unknown",
    );
    return false;
  }
}

/**
 * Cold Prospect / cold recipient: no open Meta 24h customer-service window.
 * Callers should skip free-form Graph send and queue a Pending invite + AskerNotice.
 */
export async function isColdWhatsAppRecipient(
  phone: string,
  now = new Date(),
): Promise<boolean> {
  return !(await hasWhatsAppSession(phone, now));
}
