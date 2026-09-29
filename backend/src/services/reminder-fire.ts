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
import { composeScheduledOutbound } from "./reminder-compose.js";
import {
  formatGitChangelogForCompose,
  readGitChangelog,
} from "./git-changelog.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import { sendWhatsAppText } from "./whatsapp-send.js";
import { recordAuditEvent } from "./audit.service.js";

function pingIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** Compose-at-fire body: use LLM text when present; else fall back to the brief/label. */
export function resolveComposeFireOutbound(input: {
  brief: string;
  itemLabel: string;
  composed: string | null | undefined;
}): { body: string; lastComposedToSave: string | null } {
  const composed = input.composed?.trim() || "";
  if (composed) {
    return {
      body: composed.slice(0, 4096),
      lastComposedToSave: composed.slice(0, 4096),
    };
  }
  const brief = input.brief.trim();
  return {
    body: brief || input.itemLabel,
    lastComposedToSave: null,
  };
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

export async function settleFiredReminder(
  reminder: {
    id: string;
    fireAt: Date;
    repeat: string;
    userId?: string;
    actorId?: string;
    itemLabel?: string;
  },
  now: Date,
  sendStatus: "sent" | "failed",
): Promise<void> {
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
    return;
  }

  // One-shot: keep the row as history (status=done + sent_at). Detach the
  // worker task first so deleting that item cannot CASCADE-delete this clock.
  let workerItemId: string | null = null;
  if (typeof prisma.reminder.findUnique === "function") {
    const row = await prisma.reminder.findUnique({
      where: { id: reminder.id },
      select: { workerItemId: true },
    });
    workerItemId = row?.workerItemId ?? null;
  }

  await prisma.reminder.update({
    where: { id: reminder.id },
    data: {
      status: "done",
      sendStatus,
      sentAt,
      workerItemId: null,
    },
  });

  if (prisma.employeeListItem?.updateMany) {
    await prisma.employeeListItem.updateMany({
      where: { reminderId: reminder.id },
      data: { reminderId: null },
    });
  }
  if (workerItemId && prisma.employeeListItem?.update) {
    try {
      await prisma.employeeListItem.update({
        where: { id: workerItemId },
        data: { deletedAt: new Date(), reminderId: null },
      });
    } catch {
      // Already removed.
    }
  }

  if (reminder.userId) {
    await recordAuditEvent({
      userId: reminder.userId,
      actorEmployeeId: reminder.actorId,
      action: "reminder_fire",
      entityType: "Reminder",
      entityId: reminder.id,
      summary: `fire reminder: ${reminder.itemLabel ?? reminder.id}`,
      detail: { sendStatus, sentAt: sentAt?.toISOString() ?? null },
    });
  }
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

    let outboundBody = reminder.messageText;
    let skipSend = false;
    if (reminder.composeAtFire) {
      const firstDest = dests[0] ?? "";
      const firstTarget =
        employees.find((employee) => employee.id === firstDest) ??
        employees.find(
          (employee) => employee.phone && phonesMatch(employee.phone, firstDest),
        );
      const recipientName =
        firstTarget?.nickname?.trim() ||
        firstTarget?.name ||
        (looksLikePhone(firstDest) ? firstDest : "הנמען");

      let gitChangelog: string | undefined;
      let headSha = "";
      const isGitDigest = reminder.composeSource === "git_log";
      if (isGitDigest) {
        try {
          const log = await readGitChangelog({
            sinceSha: reminder.lastReportSha || undefined,
            sinceDate: reminder.lastReportSha
              ? undefined
              : new Date(now.getTime() - 24 * 60 * 60 * 1000),
          });
          headSha = log.headSha;
          gitChangelog = formatGitChangelogForCompose(log.commits);
          if (!gitChangelog) {
            outboundBody =
              "No new product changes since the last report.";
            skipSend = false;
            await prisma.reminder.update({
              where: { id: reminder.id },
              data: {
                lastComposedText: outboundBody,
                ...(headSha ? { lastReportSha: headSha } : {}),
              },
            });
          }
        } catch (error) {
          recordWhatsAppEvent(
            "reminder_git_log_fail",
            error instanceof Error ? error.message : "unknown",
          );
          skipSend = true;
          await settleFiredReminder(reminder, now, "failed");
          continue;
        }
      }

      if (!isGitDigest || gitChangelog) {
        const composed = await composeScheduledOutbound({
          brief: reminder.messageText,
          itemLabel: reminder.itemLabel,
          actorName,
          recipientName,
          previousText: reminder.lastComposedText,
          gitChangelog,
        });
        const resolved = resolveComposeFireOutbound({
          brief: reminder.messageText,
          itemLabel: reminder.itemLabel,
          composed,
        });
        outboundBody = resolved.body;
        if (resolved.lastComposedToSave || headSha) {
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: {
              ...(resolved.lastComposedToSave
                ? { lastComposedText: resolved.lastComposedToSave }
                : {}),
              ...(headSha ? { lastReportSha: headSha } : {}),
            },
          });
        }
      }
    }

    if (skipSend) {
      continue;
    }

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
        item: reminder.composeAtFire ? undefined : reminder.itemLabel,
        text: outboundBody,
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

    await settleFiredReminder(reminder, now, sendStatus);
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
