import { humanEmployees, parseLlmReply } from "@workee/shared";
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { ServiceUnavailableError } from "../utils/errors.js";
import { sendChatMessage } from "./chat.service.js";
import { listEmployeesForUser, resolveActingEmployee } from "./employee.service.js";

export interface WhatsAppVerifyQuery {
  mode?: string;
  token?: string;
  challenge?: string;
}

export interface InboundWhatsAppText {
  from: string;
  text: string;
  messageId: string;
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
        };
        const text =
          typeof record.text?.body === "string" ? record.text.body.trim() : "";
        const from = typeof record.from === "string" ? record.from : "";
        const messageId = typeof record.id === "string" ? record.id : "";
        if (text && from && messageId) {
          messages.push({ from, text, messageId });
        }
      }
    }
  }

  return messages;
}

const recentInboundIds = new Set<string>();

export function phonesMatch(left: string, right: string): boolean {
  const a = left.replace(/\D/g, "");
  const b = right.replace(/\D/g, "");
  if (!a || !b) {
    return false;
  }
  const size = Math.min(9, a.length, b.length);
  return size >= 8 && a.slice(-size) === b.slice(-size);
}

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

    try {
      const speaker = await resolveWhatsAppSpeaker(message.from);
      const turn = await sendChatMessage({
        userId: speaker.userId,
        employeeId: speaker.employeeId,
        message: message.text,
      });
      const reply = parseLlmReply(turn.reply).response.trim();
      if (reply) {
        await sendWhatsAppText(message.from, reply);
      }
    } catch (error) {
      console.error(
        "WhatsApp reply failed",
        error instanceof Error ? error.message : "unknown",
      );
    }
  }
}

export async function sendWhatsAppText(to: string, text: string): Promise<void> {
  const env = getEnv();
  const token = env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId) {
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
        to,
        type: "text",
        text: { body: text.slice(0, 4096), preview_url: false },
      }),
    },
  );

  if (!response.ok) {
    throw new ServiceUnavailableError();
  }
}

async function resolveWhatsAppSpeaker(from: string): Promise<{
  userId: string;
  employeeId: string;
}> {
  const users = await prisma.user.findMany({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  for (const user of users) {
    const humans = humanEmployees(await listEmployeesForUser(user.id));
    const match = humans.find(
      (employee) => employee.phone && phonesMatch(employee.phone, from),
    );
    if (match) {
      return { userId: user.id, employeeId: match.id };
    }
  }

  const fallbackUser = users[0];
  if (!fallbackUser) {
    throw new ServiceUnavailableError();
  }

  const humans = humanEmployees(await listEmployeesForUser(fallbackUser.id));
  const preferred = getEnv().WHATSAPP_DEFAULT_EMPLOYEE?.trim();
  const named = preferred
    ? humans.find(
        (employee) =>
          employee.nickname?.trim() === preferred ||
          employee.name === preferred,
      )
    : undefined;
  const acting = named ?? (await resolveActingEmployee(fallbackUser.id));
  if (named && (!named.phone || !phonesMatch(named.phone, from))) {
    await prisma.employee.update({
      where: { id: named.id },
      data: { phone: from },
    });
  }
  return { userId: fallbackUser.id, employeeId: acting.id };
}
