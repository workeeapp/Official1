import {
  digitalEmployees,
  humanEmployees,
  parseLlmReply,
  parseReplyMetadata,
} from "@workee/shared";
import type { PublicEmployee } from "@workee/shared";
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { ServiceUnavailableError } from "../utils/errors.js";
import { sendChatMessage } from "./chat.service.js";
import { createEmployeeForUser, listEmployeesForUser } from "./employee.service.js";
import { phonesMatch } from "../utils/phone.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import { sendWhatsAppText } from "./whatsapp-send.js";
import { markWhatsAppInbound } from "./whatsapp-window.js";

export { phonesMatch };

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
const whatsappWorkerByPhone = new Map<string, string>();

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
      await markWhatsAppInbound(message.from);
      const speaker = await resolveWhatsAppSpeaker(message.from);
      const employees = await listEmployeesForUser(speaker.userId);
      const digitals = digitalEmployees(employees);
      const digital =
        sessionDigital(message.from, digitals) ??
        digitals.find((employee) => employee.protected) ??
        digitals[0];
      if (!digital) {
        throw new ServiceUnavailableError();
      }
      recordWhatsAppEvent(
        "chat_start",
        `worker=${digital.name} speaker=${speaker.employeeId.slice(0, 8)}`,
      );
      const turn = await sendChatMessage({
        userId: speaker.userId,
        employeeId: speaker.employeeId,
        digitalEmployeeId: digital.id,
        message: message.text,
      });
      const handoff =
        parseReplyMetadata(turn.reply).handoff?.worker ?? turn.answeredBy;
      applyWhatsAppHandoff(message.from, handoff, digitals);
      if (handoff && handoff !== digital.name) {
        recordWhatsAppEvent("handoff", `worker=${handoff}`);
      }
      const reply = parseLlmReply(turn.reply).response.trim();
      recordWhatsAppEvent("llm_ok", `replyChars=${reply.length}`);
      if (reply) {
        const sendResult = await sendWhatsAppText(message.from, reply, {
          ignoreSession: true,
        });
        recordWhatsAppEvent("reply_send", `result=${sendResult}`);
      }
    } catch (error) {
      recordWhatsAppEvent(
        "reply_failed",
        error instanceof Error ? error.message : "unknown",
      );
    }
  }
}

export function applyWhatsAppHandoff(
  from: string,
  workerName: string | undefined,
  digitals: PublicEmployee[],
): PublicEmployee | undefined {
  if (!workerName?.trim()) {
    return undefined;
  }
  const matched = matchDigitalName(workerName, digitals);
  if (!matched) {
    return undefined;
  }
  whatsappWorkerByPhone.set(from, matched.id);
  return matched;
}

function sessionDigital(
  from: string,
  digitals: PublicEmployee[],
): PublicEmployee | undefined {
  const id = whatsappWorkerByPhone.get(from);
  return id ? digitals.find((employee) => employee.id === id) : undefined;
}

function matchDigitalName(
  raw: string,
  digitals: PublicEmployee[],
): PublicEmployee | undefined {
  const needle = raw.trim().toLowerCase();
  const ranked = [...digitals].sort((left, right) => {
    const leftName = (left.nickname?.trim() || left.name).length;
    const rightName = (right.nickname?.trim() || right.name).length;
    return rightName - leftName;
  });
  return ranked.find((employee) => {
    const aliases = [
      employee.nickname,
      employee.name,
      employee.surname,
      `${employee.name} ${employee.surname}`.trim(),
    ]
      .filter((value): value is string => Boolean(value && value.trim()))
      .map((value) => value.trim().toLowerCase());
    return aliases.some(
      (alias) =>
        needle === alias ||
        needle.startsWith(`${alias} `) ||
        alias === needle ||
        alias.startsWith(`${needle} `),
    );
  });
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

  const created = await createEmployeeForUser(fallbackUser.id, {
    kind: "human",
    name: "אורח",
    surname: "",
    nickname: maskPhoneName(from),
    email: null,
    phone: from,
  });
  return { userId: fallbackUser.id, employeeId: created.id };
}

function maskPhoneName(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length < 4 ? "אורח" : `אורח …${digits.slice(-4)}`;
}
