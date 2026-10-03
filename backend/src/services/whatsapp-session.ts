import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { toWhatsAppAddress } from "../utils/phone.js";

export async function claimWhatsAppMessageId(messageId: string): Promise<boolean> {
  const id = messageId.trim();
  if (!id) {
    return false;
  }
  try {
    await prisma.whatsAppProcessedMessage.create({
      data: { messageId: id },
    });
    return true;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }
    console.error(
      "WhatsApp message claim failed",
      error instanceof Error ? error.message : "unknown",
    );
    // Degraded: process once rather than drop the inbound on DB blips.
    return true;
  }
}

export async function setWhatsAppActiveDigital(
  phone: string,
  digitalEmployeeId: string,
): Promise<void> {
  const destination = toWhatsAppAddress(phone);
  if (!destination || !digitalEmployeeId) {
    return;
  }
  try {
    await prisma.whatsAppInbound.upsert({
      where: { phone: destination },
      create: {
        phone: destination,
        lastInboundAt: new Date(),
        activeDigitalEmployeeId: digitalEmployeeId,
      },
      update: { activeDigitalEmployeeId: digitalEmployeeId },
    });
  } catch (error) {
    console.error(
      "WhatsApp active digital save failed",
      error instanceof Error ? error.message : "unknown",
    );
  }
}

export async function getWhatsAppActiveDigitalId(
  phone: string,
): Promise<string | undefined> {
  const destination = toWhatsAppAddress(phone);
  if (!destination) {
    return undefined;
  }
  try {
    const row = await prisma.whatsAppInbound.findUnique({
      where: { phone: destination },
      select: { activeDigitalEmployeeId: true },
    });
    return row?.activeDigitalEmployeeId ?? undefined;
  } catch (error) {
    console.error(
      "WhatsApp active digital lookup failed",
      error instanceof Error ? error.message : "unknown",
    );
    return undefined;
  }
}
