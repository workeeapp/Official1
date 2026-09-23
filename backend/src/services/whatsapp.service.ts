import { digitalEmployees, humanEmployees, parseLlmReply } from "@workee/shared";
import type { PublicEmployee } from "@workee/shared";
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { ServiceUnavailableError } from "../utils/errors.js";
import { sendChatMessage } from "./chat.service.js";
import { listEmployeesForUser, resolveActingEmployee } from "./employee.service.js";
import { sendWhatsAppText } from "./whatsapp-send.js";

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

const SWITCH_WORKER =
  /^(?:talk to|chat with|switch to|דבר עם|דברי עם|עבור אל|עבור ל|עברי ל)\s+(.+)$/iu;
const LIST_WORKERS =
  /^(?:who can i (?:talk|chat) to|list workers|איזה עובדים|מי העובדים|עם מי אפשר לדבר)\??$/iu;

export function parseWhatsAppWorkerCommand(text: string): {
  list?: boolean;
  workerName?: string;
  rest?: string;
} {
  const trimmed = text.trim();
  if (LIST_WORKERS.test(trimmed)) {
    return { list: true };
  }
  const switched = trimmed.match(SWITCH_WORKER);
  if (!switched?.[1]) {
    return {};
  }
  return { workerName: switched[1].trim() };
}

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
      const employees = await listEmployeesForUser(speaker.userId);
      const digitals = digitalEmployees(employees);
      const routed = await routeWhatsAppDigital(
        message.from,
        message.text,
        digitals,
      );
      if (routed.notice && !routed.message) {
        await sendWhatsAppText(message.from, routed.notice);
        continue;
      }
      const turn = await sendChatMessage({
        userId: speaker.userId,
        employeeId: speaker.employeeId,
        digitalEmployeeId: routed.digital.id,
        message: routed.message ?? message.text,
      });
      const reply = parseLlmReply(turn.reply).response.trim();
      const text = [routed.notice, reply].filter(Boolean).join("\n\n");
      if (text) {
        await sendWhatsAppText(message.from, text);
      }
    } catch (error) {
      console.error(
        "WhatsApp reply failed",
        error instanceof Error ? error.message : "unknown",
      );
    }
  }
}

async function routeWhatsAppDigital(
  from: string,
  text: string,
  digitals: PublicEmployee[],
): Promise<{ digital: PublicEmployee; notice?: string; message?: string }> {
  const command = parseWhatsAppWorkerCommand(text);
  const fallback =
    digitals.find((employee) => employee.protected) ?? digitals[0];
  if (!fallback) {
    throw new ServiceUnavailableError();
  }

  if (command.list) {
    const names = digitals
      .map((employee) => employee.nickname?.trim() || employee.name)
      .join(", ");
    return {
      digital: fallback,
      notice: names
        ? `אפשר לדבר עם: ${names}. כתוב "דבר עם <שם>" כדי לעבור.`
        : "אין עובדים דיגיטליים.",
    };
  }

  if (command.workerName) {
    const matched = matchDigitalName(command.workerName, digitals);
    if (!matched) {
      return {
        digital: sessionDigital(from, digitals) ?? fallback,
        notice: `לא מצאתי עובד דיגיטלי בשם ${command.workerName}. כתוב "מי העובדים" לרשימה.`,
      };
    }
    whatsappWorkerByPhone.set(from, matched.id);
    return {
      digital: matched,
      notice: `עכשיו אתה מדבר עם ${matched.nickname?.trim() || matched.name}.`,
      message: restAfterDigitalName(command.workerName, matched),
    };
  }

  return {
    digital: sessionDigital(from, digitals) ?? fallback,
  };
}

function sessionDigital(
  from: string,
  digitals: PublicEmployee[],
): PublicEmployee | undefined {
  const id = whatsappWorkerByPhone.get(from);
  return id ? digitals.find((employee) => employee.id === id) : undefined;
}

function restAfterDigitalName(
  raw: string,
  employee: PublicEmployee,
): string | undefined {
  const aliases = [
    employee.nickname,
    employee.name,
    `${employee.name} ${employee.surname}`.trim(),
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => value.trim())
    .sort((left, right) => right.length - left.length);
  const lower = raw.trim().toLowerCase();
  for (const alias of aliases) {
    if (lower === alias.toLowerCase()) {
      return undefined;
    }
    if (lower.startsWith(`${alias.toLowerCase()} `)) {
      const rest = raw.trim().slice(alias.length).replace(/^[\s,:\-]+/, "");
      return rest || undefined;
    }
  }
  return undefined;
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
      `${employee.name} ${employee.surname}`.trim(),
    ]
      .filter((value): value is string => Boolean(value && value.trim()))
      .map((value) => value.trim().toLowerCase());
    return aliases.some(
      (alias) => needle === alias || needle.startsWith(`${alias} `),
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
