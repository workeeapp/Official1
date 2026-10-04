import {
  digitalEmployees,
  humanEmployees,
  parseLlmReply,
  parseReplyMetadata,
} from "@workee/shared";
import type { PublicEmployee } from "@workee/shared";
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { ServiceUnavailableError, opsErrorDetail } from "../utils/errors.js";
import { sendChatMessage } from "./chat.service.js";
import { createEmployeeForUser, listEmployeesForUser } from "./employee.service.js";
import { phonesMatch } from "../utils/phone.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import {
  sendWhatsAppReplyOrFallback,
  sendWhatsAppText,
  startWhatsAppTyping,
  WHATSAPP_SEND_FALLBACK_HE,
} from "./whatsapp-send.js";
import {
  claimWhatsAppMessageId,
  getWhatsAppActiveDigitalId,
  setWhatsAppActiveDigital,
} from "./whatsapp-session.js";
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
    throw new ServiceUnavailableError(undefined, {
      detail: "whatsapp_verify_token_missing",
    });
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

export async function handleInboundWhatsAppTexts(
  messages: InboundWhatsAppText[],
): Promise<void> {
  const env = getEnv();
  if (env.NODE_ENV === "test" || !env.WHATSAPP_ACCESS_TOKEN?.trim()) {
    return;
  }

  for (const message of messages) {
    if (!(await claimWhatsAppMessageId(message.messageId))) {
      continue;
    }

    const stopTyping = startWhatsAppTyping(message.messageId);
    try {
      await markWhatsAppInbound(message.from);
      const speaker = await resolveWhatsAppSpeaker(message.from);
      const employees = await listEmployeesForUser(speaker.userId);
      const digitals = digitalEmployees(employees);
      const digital =
        (await sessionDigital(message.from, digitals)) ??
        digitals.find((employee) => employee.protected) ??
        digitals[0];
      if (!digital) {
        throw new ServiceUnavailableError(undefined, {
          detail: "no_digital_employee",
        });
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
      await applyWhatsAppHandoff(message.from, handoff, digitals);
      if (handoff && handoff !== digital.name) {
        recordWhatsAppEvent("handoff", `worker=${handoff}`);
      }
      const reply = parseLlmReply(turn.reply).response.trim();
      recordWhatsAppEvent("llm_ok", `replyChars=${reply.length}`);
      if (reply) {
        const delivery = await sendWhatsAppReplyOrFallback(message.from, reply, {
          ignoreSession: true,
        });
        recordWhatsAppEvent(
          "reply_send",
          `result=${delivery.result}${delivery.usedFallback ? " fallback=1" : ""}`,
        );
      }
    } catch (error) {
      recordWhatsAppEvent("reply_failed", opsErrorDetail(error));
      try {
        const fallbackResult = await sendWhatsAppText(
          message.from,
          WHATSAPP_SEND_FALLBACK_HE,
          { ignoreSession: true, maxAttempts: 2 },
        );
        recordWhatsAppEvent(
          "reply_fallback",
          `after=exception result=${fallbackResult}`,
        );
      } catch {
        /* Meta still down — nothing more on this channel */
      }
    } finally {
      stopTyping();
    }
  }
}

export async function applyWhatsAppHandoff(
  from: string,
  workerName: string | undefined,
  digitals: PublicEmployee[],
): Promise<PublicEmployee | undefined> {
  if (!workerName?.trim()) {
    return undefined;
  }
  const matched = matchDigitalName(workerName, digitals);
  if (!matched) {
    return undefined;
  }
  await setWhatsAppActiveDigital(from, matched.id);
  return matched;
}

async function sessionDigital(
  from: string,
  digitals: PublicEmployee[],
): Promise<PublicEmployee | undefined> {
  const id = await getWhatsAppActiveDigitalId(from);
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
    throw new ServiceUnavailableError(undefined, {
      detail: "no_account_user_for_whatsapp_guest",
    });
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
