import {
  addReminderInterval,
  digitalEmployees,
  isProtectedEmployee,
  parseStoredRepeat,
} from "@workee/shared";
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { isMissingTableError } from "../utils/errors.js";
import { publishChatEvent } from "./chat-events.service.js";
import { listEmployeesForUser } from "./employee.service.js";
import { looksLikePhone, phonesMatch } from "../utils/phone.js";
import { formatAttributedOutbound } from "./outbound-text.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import { sendWhatsAppText } from "./whatsapp-send.js";

function pingIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function nextFireAt(from: Date, repeat: string, now: Date): Date | null {
  const interval = parseStoredRepeat(repeat);
  if (!interval) {
    return null;
  }
  let next = addReminderInterval(from, interval);
  while (next.getTime() <= now.getTime()) {
    next = addReminderInterval(next, interval);
  }
  return next;
}

export async function fireDueReminders(now = new Date()): Promise<number> {
  if (getEnv().NODE_ENV === "test" || !prisma.reminder) {
    return 0;
  }

  let due;
  try {
    due = await prisma.reminder.findMany({
      where: { status: "active", fireAt: { lte: now } },
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      return 0;
    }
    throw error;
  }

  for (const reminder of due) {
    const employees = await listEmployeesForUser(reminder.userId);
    const lucy = employees.find((employee) => isProtectedEmployee(employee));
    const digitals = digitalEmployees(employees);
    const speaker = lucy ?? digitals[0];
    const actor = employees.find((employee) => employee.id === reminder.actorId);
    const actorName = actor?.nickname?.trim() || actor?.name || "";
    const dests = pingIds(reminder.pingIds);
    const sendResults: boolean[] = [];

    for (const dest of dests) {
      const target =
        employees.find((employee) => employee.id === dest) ??
        employees.find(
          (employee) => employee.phone && phonesMatch(employee.phone, dest),
        );
      const destIsActor =
        dest === reminder.actorId ||
        Boolean(actor?.phone && phonesMatch(actor.phone, dest));
      const text = formatAttributedOutbound({
        actorName,
        destIsActor,
        item: reminder.itemLabel,
        text: reminder.messageText,
      });

      if (target && speaker) {
        const conversation = await prisma.chatConversation.findUnique({
          where: {
            userId_employeeId_digitalEmployeeId: {
              userId: reminder.userId,
              employeeId: target.id,
              digitalEmployeeId: speaker.id,
            },
          },
        });
        if (conversation) {
          const created = await prisma.chatMessage.create({
            data: {
              conversationId: conversation.id,
              author: "assistant",
              speaker: speaker.nickname?.trim() || speaker.name,
              text,
              raw: { reminder: true },
            },
          });
          publishChatEvent(reminder.userId, target.id, speaker.id, {
            employeeId: target.id,
            digitalEmployeeId: speaker.id,
            message: {
              id: created.id,
              author: "assistant",
              speaker: created.speaker,
              text: created.text,
              createdAt: created.createdAt.toISOString(),
            },
            raw: { reminder: true },
          });
        }
      }

      const phone = target?.phone?.trim() || (looksLikePhone(dest) ? dest : "");
      recordWhatsAppEvent(
        "reminder_fire",
        `item=${reminder.itemLabel} dest=${dest.slice(-4)} phone=${phone ? `…${phone.replace(/\D/g, "").slice(-4)}` : "none"}`,
      );
      if (phone && getEnv().WHATSAPP_ACCESS_TOKEN?.trim()) {
        try {
          const result = await sendWhatsAppText(phone, text, {
            ignoreSession: true,
          });
          sendResults.push(result === "sent");
        } catch (error) {
          console.error(
            "Reminder WhatsApp failed",
            error instanceof Error ? error.message : "unknown",
          );
          sendResults.push(false);
        }
      } else {
        sendResults.push(false);
      }
    }

    const sendStatus =
      dests.length > 0 &&
      sendResults.length > 0 &&
      sendResults.every(Boolean)
        ? "sent"
        : "failed";
    const sentAt = sendStatus === "sent" ? now : null;

    const nextAt = nextFireAt(reminder.fireAt, reminder.repeat, now);
    if (nextAt) {
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          fireAt: nextAt,
          sendStatus,
          sentAt,
        },
      });
      scheduleSoon(nextAt);
    } else {
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: { status: "done", sendStatus, sentAt },
      });
    }
  }

  return due.length;
}

export function scheduleSoon(fireAt: Date): void {
  if (getEnv().NODE_ENV === "test") {
    return;
  }
  const delay = Math.max(0, fireAt.getTime() - Date.now());
  if (delay > 120_000) {
    return;
  }
  setTimeout(() => {
    void fireDueReminders().catch((error) => {
      console.error(
        "Reminder tick failed",
        error instanceof Error ? error.message : "unknown",
      );
    });
  }, delay + 250);
}

export function startReminderTicker(): void {
  if (getEnv().NODE_ENV === "test") {
    return;
  }
  setInterval(() => {
    void fireDueReminders().catch((error) => {
      console.error(
        "Reminder tick failed",
        error instanceof Error ? error.message : "unknown",
      );
    });
  }, 10_000);
}
