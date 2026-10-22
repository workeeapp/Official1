import {
  addReminderInterval,
  digitalEmployees,
  formatJerusalemDateTime,
  isProtectedEmployee,
  nextRecurrenceFire,
  parseRecurrence,
  parseStoredRepeat,
  pruneRecurrenceExceptions,
  serializeRecurrence,
  withinUntil,
  type LlmReplyButton,
} from "@workee/shared";
import { Prisma } from "@prisma/client";
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { isMissingTableError } from "../utils/errors.js";
import { publishChatEvent } from "./chat-events.service.js";
import { rememberInModelConversation } from "./llm-client.js";
import { listEmployeesForUser } from "./employee.service.js";
import { looksLikePhone, phonesMatch } from "../utils/phone.js";
import { formatAttributedOutbound, reminderSnoozeCommand } from "./outbound-text.js";
import { composeScheduledOutbound } from "./reminder-compose.js";
import { loadComposeFacts } from "./compose-facts.js";
import {
  conditionFromReminderJson,
  evaluateComposeCondition,
} from "./compose-condition.js";
import { enrichEvalFactsForExpr } from "./watch-expr.js";
import { fetchBusEtaWatch } from "./routes.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import { sendWhatsAppButtons } from "./whatsapp-send.js";
import { recordAuditEvent } from "./audit.service.js";
import {
  deliverAttachmentsToPhone,
  listReminderAttachments,
  toChatAttachmentRef,
} from "./attachment.service.js";
import { jobMetaFrom } from "./job-meta.js";
import { nextCandleLighting } from "./jewish.js";

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

/** Next fire after this one, or null when the clock is finished (one-shot, count, until). */
export function nextFireAt(
  reminder: { fireAt: Date; repeat: string; recurrence?: unknown },
  now: Date,
  firedCount: number,
): Date | null {
  const rule = parseRecurrence(reminder.recurrence);
  if (rule) {
    return nextRecurrenceFire({ rec: rule, fired: reminder.fireAt, now, firedCount });
  }
  const interval = parseStoredRepeat(reminder.repeat);
  if (!interval) {
    return null;
  }
  let next = addReminderInterval(reminder.fireAt, interval);
  while (next.getTime() <= now.getTime()) {
    next = addReminderInterval(next, interval);
  }
  return next;
}

/**
 * Like nextFireAt, but jewish_candles anchors re-resolve Hebcal (times move weekly).
 * Returns null when the series is done or the city/Hebcal lookup fails.
 */
export async function resolveNextFireAt(
  reminder: {
    fireAt: Date;
    repeat: string;
    recurrence?: unknown;
    scheduleAnchor?: string | null;
    scheduleOffsetMinutes?: number | null;
    composePlace?: string | null;
  },
  now: Date,
  firedCount: number,
): Promise<Date | null> {
  const rule = parseRecurrence(reminder.recurrence);
  if (String(reminder.scheduleAnchor ?? "") === "jewish_candles") {
    // One-shot candle clocks have no recurrence — do not invent the next week.
    if (!rule || rule.freq !== "weekly") {
      return null;
    }
    if (rule.count != null && firedCount >= rule.count) {
      return null;
    }
    const place = String(reminder.composePlace ?? "").trim();
    if (!place) {
      return null;
    }
    const next = await nextCandleLighting({
      place,
      offsetMinutes: Number(reminder.scheduleOffsetMinutes ?? 0),
      from: new Date(Math.max(now.getTime(), reminder.fireAt.getTime()) + 60_000),
    });
    if (!next) {
      return null;
    }
    if (!withinUntil(rule, next)) {
      return null;
    }
    return next;
  }
  return nextFireAt(reminder, now, firedCount);
}

async function workerItemIdForReminder(reminderId: string): Promise<string | null> {
  if (typeof prisma.reminder.findUnique !== "function") {
    return null;
  }
  const row = await prisma.reminder.findUnique({
    where: { id: reminderId },
    select: { workerItemId: true },
  });
  return row?.workerItemId ?? null;
}

async function maybeActivateScheduledJob(input: {
  userId?: string;
  workerItemId: string | null;
  now: Date;
}): Promise<boolean> {
  if (!input.userId || !input.workerItemId) {
    return false;
  }
  try {
    const { activateScheduledJob } = await import("./jobs.service.js");
    return await activateScheduledJob({
      userId: input.userId,
      workerItemId: input.workerItemId,
      now: input.now,
    });
  } catch (error) {
    console.error(
      "Scheduled job activate failed",
      error instanceof Error ? error.message : "unknown",
    );
    return false;
  }
}

export async function settleFiredReminder(
  reminder: {
    id: string;
    fireAt: Date;
    repeat: string;
    recurrence?: unknown;
    occurrencesFired?: number;
    userId?: string;
    actorId?: string;
    itemLabel?: string;
    scheduleAnchor?: string | null;
    scheduleOffsetMinutes?: number | null;
    composePlace?: string | null;
  },
  now: Date,
  sendStatus: "sent" | "failed",
  options?: { forceDone?: boolean },
): Promise<void> {
  const sentAt = sendStatus === "sent" ? now : null;
  const firedCount = (reminder.occurrencesFired ?? 0) + 1;
  const nextAt = options?.forceDone
    ? null
    : await resolveNextFireAt(reminder, now, firedCount);
  const rule = parseRecurrence(reminder.recurrence);
  const hasRule = Boolean(rule);
  const workerItemId = await workerItemIdForReminder(reminder.id);

  if (nextAt) {
    const pruned = rule?.exceptions?.length
      ? pruneRecurrenceExceptions(rule, formatJerusalemDateTime(nextAt).slice(0, 10))
      : null;
    await prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        fireAt: nextAt,
        sendStatus,
        sentAt,
        ...(hasRule ? { occurrencesFired: firedCount } : {}),
        ...(pruned && pruned !== rule
          ? { recurrence: serializeRecurrence(pruned) as Prisma.InputJsonValue }
          : {}),
      },
    });
    scheduleSoon(nextAt);
    // Recurring deferred check-with: activate (clear dates + urgency) and keep
    // the job row; next תאריך/שעה is written back only when the job closes.
    await maybeActivateScheduledJob({
      userId: reminder.userId,
      workerItemId,
      now,
    });
    return;
  }

  // One-shot: keep the row as history (status=done + sent_at). Detach the
  // worker task first so deleting that item cannot CASCADE-delete this clock.
  const keptAsScheduledJob = await maybeActivateScheduledJob({
    userId: reminder.userId,
    workerItemId,
    now,
  });

  await prisma.reminder.update({
    where: { id: reminder.id },
    data: {
      status: "done",
      sendStatus,
      sentAt,
      workerItemId: null,
      ...(hasRule ? { occurrencesFired: firedCount } : {}),
    },
  });

  if (prisma.employeeListItem?.updateMany) {
    await prisma.employeeListItem.updateMany({
      where: { reminderId: reminder.id },
      data: { reminderId: null },
    });
    // Soft-links must not keep pointing at a done one-shot (same as cancel).
    await prisma.employeeListItem.updateMany({
      where: { linkedReminderId: reminder.id, deletedAt: null },
      data: { linkedReminderId: null },
    });
  }

  let firedTaskData: unknown = null;
  if (workerItemId && !keptAsScheduledJob && prisma.employeeListItem?.update) {
    try {
      const task = await prisma.employeeListItem.update({
        where: { id: workerItemId },
        data: { deletedAt: new Date(), reminderId: null },
      });
      firedTaskData = task?.data ?? null;
    } catch {
      // Already removed.
    }
  } else if (workerItemId && keptAsScheduledJob && prisma.employeeListItem?.findUnique) {
    try {
      const task = await prisma.employeeListItem.findUnique({
        where: { id: workerItemId },
      });
      firedTaskData = task?.data ?? null;
    } catch {
      firedTaskData = null;
    }
  }

  const nudge = jobMetaFrom(firedTaskData);
  if (
    workerItemId &&
    reminder.userId &&
    nudge?.kind === "nudge" &&
    !keptAsScheduledJob
  ) {
    try {
      const { continueJobAfterNudge } = await import("./jobs.service.js");
      await continueJobAfterNudge({
        userId: reminder.userId,
        nudgeItemId: workerItemId,
        nudge,
        now,
      });
    } catch (error) {
      console.error(
        "Job follow-up failed",
        error instanceof Error ? error.message : "unknown",
      );
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

export async function claimDueReminder(
  reminderId: string,
  now: Date,
): Promise<boolean> {
  const claimed = await prisma.reminder.updateMany({
    where: {
      id: reminderId,
      status: "active",
      fireAt: { lte: now },
    },
    data: {
      // Park past due so a concurrent poll cannot select this row again.
      // settleFiredReminder overwrites with the real next fireAt / done.
      fireAt: new Date(now.getTime() + 120_000),
    },
  });
  return claimed.count > 0;
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
    // Claim before compose/send so concurrent tickers (or two API processes)
    // cannot fire the same due row twice.
    if (!(await claimDueReminder(reminder.id, now))) {
      continue;
    }

    const employees = await listEmployeesForUser(reminder.userId);
    const lucy = employees.find((employee) => isProtectedEmployee(employee));
    const digitals = digitalEmployees(employees);
    const speaker = lucy ?? digitals[0];
    const actor = employees.find((employee) => employee.id === reminder.actorId);
    const actorName = actor?.nickname?.trim() || actor?.name || "";
    const dests = pingIds(reminder.pingIds);
    const sendResults: boolean[] = [];

    let outboundBody = reminder.messageText;
    let busEtaDefaultBody: string | null = null;
    let skipSend = false;
    let conditionShaAfterSend: string | undefined;
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

      let advanceLastReportSha = false;
      let headSha = "";
      let factsBundle: Awaited<ReturnType<typeof loadComposeFacts>> | undefined;
      try {
        const subjectId =
          firstTarget?.id ?? reminder.actorId ?? reminder.ownerId;
        const conditionEarly = conditionFromReminderJson(
          "composeCondition" in reminder ? reminder.composeCondition : null,
        );
        factsBundle = await loadComposeFacts({
          composeSource: reminder.composeSource ?? "",
          subjectEmployeeId: subjectId,
          repeat: reminder.repeat,
          lastReportSha: reminder.lastReportSha,
          lookbackHours:
            typeof reminder.composeLookbackHours === "number"
              ? reminder.composeLookbackHours
              : 0,
          composePlace:
            typeof reminder.composePlace === "string"
              ? reminder.composePlace
              : "",
          composeAspects:
            "composeAspects" in reminder ? reminder.composeAspects : undefined,
          composeCondition: conditionEarly,
          now,
        });
        advanceLastReportSha = Boolean(factsBundle.advanceLastReportSha);
        headSha = factsBundle.headSha ?? "";
      } catch (error) {
        recordWhatsAppEvent(
          "reminder_compose_facts_fail",
          error instanceof Error ? error.message : "unknown",
        );
        skipSend = true;
        await settleFiredReminder(reminder, now, "failed");
        continue;
      }

      // Conditional watch: skip WhatsApp when the structured condition is false.
      const condition = conditionFromReminderJson(
        "composeCondition" in reminder ? reminder.composeCondition : null,
      );
      const isWatch = Boolean(condition);
      if (condition) {
        let evalFacts = { ...(factsBundle.eval ?? {}) };
        if (condition.type === "bus_eta") {
          const eta = await fetchBusEtaWatch({
            origin: condition.origin,
            destination: condition.destination,
            line: condition.line,
            headsign: condition.headsign,
            now,
          });
          evalFacts = {
            ...evalFacts,
            busEtaMinutes: eta.minutes,
            busEtaFingerprint: eta.fingerprint,
          };
          if (
            eta.minutes != null &&
            eta.minutes <= condition.minutesBefore &&
            eta.fingerprint
          ) {
            busEtaDefaultBody = `קו ${condition.line} מגיע בעוד כ־${eta.minutes} דקות מ«${condition.origin}» לכיוון «${condition.destination}» — זמן לצאת.`;
          }
        }
        if (
          condition.type === "expr" ||
          condition.type === "field_changed"
        ) {
          const enriched = await enrichEvalFactsForExpr({
            condition,
            evalFacts,
            factsBundle,
            composeSource: reminder.composeSource ?? "",
            composePlace:
              typeof reminder.composePlace === "string"
                ? reminder.composePlace
                : "",
            now,
          });
          evalFacts = enriched.evalFacts;
          factsBundle = enriched.factsBundle;
        }
        const gate = evaluateComposeCondition({
          condition,
          facts: evalFacts,
          lastReportSha: reminder.lastReportSha,
        });
        if (gate.immediateSha) {
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: { lastReportSha: gate.immediateSha },
          });
        }
        if (gate.skipSend) {
          // Quiet skip — clock advances; never send «עדיין לא».
          await settleFiredReminder(reminder, now, "sent");
          continue;
        }
        conditionShaAfterSend = gate.shaAfterSend;
      }

      const recipientGender =
        firstTarget &&
        "addressGender" in firstTarget &&
        (firstTarget.addressGender === "male" ||
          firstTarget.addressGender === "female")
          ? firstTarget.addressGender
          : null;

      const composed = await composeScheduledOutbound({
        brief: reminder.messageText,
        itemLabel: reminder.itemLabel,
        actorName,
        recipientName,
        previousText: reminder.lastComposedText,
        facts: factsBundle,
        watch: isWatch,
        addressGender: recipientGender,
      });
      const resolved = resolveComposeFireOutbound({
        brief: reminder.messageText,
        itemLabel: reminder.itemLabel,
        composed,
      });
      outboundBody =
        busEtaDefaultBody &&
        (!resolved.body.trim() ||
          resolved.body.trim() === String(reminder.messageText ?? "").trim())
          ? busEtaDefaultBody
          : resolved.body;
      if (resolved.lastComposedToSave || (advanceLastReportSha && headSha)) {
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: {
            ...(resolved.lastComposedToSave
              ? { lastComposedText: resolved.lastComposedToSave }
              : {}),
            ...(advanceLastReportSha && headSha
              ? { lastReportSha: headSha }
              : {}),
          },
        });
      }
    }

    if (skipSend) {
      continue;
    }

    const files = await listReminderAttachments(reminder.id).catch(() => []);
    const fileRefs = files.map(toChatAttachmentRef);

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
      const snooze = reminderSnoozeCommand({
        item: reminder.itemLabel,
        text: outboundBody,
        composeAtFire: reminder.composeAtFire,
      });
      const buttons: LlmReplyButton[] = snooze
        ? [{ label: "נדנד", command: snooze }]
        : [];

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
              ...(buttons.length > 0
                ? {
                    buttons: buttons.map(({ label, command }) => ({ label, command })),
                  }
                : {}),
              ...(fileRefs.length > 0
                ? { attachments: fileRefs as unknown as Prisma.InputJsonValue }
                : {}),
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
              ...(buttons.length > 0 ? { buttons } : {}),
              ...(fileRefs.length > 0 ? { attachments: fileRefs } : {}),
            },
            raw: { reminder: true },
          });
          await rememberInModelConversation(conversation.openaiConversationId, text);
        }
      }

      const phone = target?.phone?.trim() || (looksLikePhone(dest) ? dest : "");
      recordWhatsAppEvent(
        "reminder_fire",
        `item=${reminder.itemLabel} dest=${dest.slice(-4)} phone=${phone ? `…${phone.replace(/\D/g, "").slice(-4)}` : "none"}`,
      );
      if (phone && getEnv().WHATSAPP_ACCESS_TOKEN?.trim()) {
        try {
          const result = await sendWhatsAppButtons(phone, text, buttons, {
            ignoreSession: true,
          });
          sendResults.push(result === "sent");
          if (result === "sent" && files.length > 0) {
            const delivered = await deliverAttachmentsToPhone(phone, files, {
              ignoreSession: true,
            });
            recordWhatsAppEvent(
              "reminder_files",
              `sent=${delivered.sent} failed=${delivered.failed}`,
            );
          }
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

    if (conditionShaAfterSend && sendStatus === "sent") {
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: { lastReportSha: conditionShaAfterSend },
      });
    }

    const watchOnce =
      "watchOnce" in reminder && reminder.watchOnce === true;
    const hadCondition = Boolean(
      conditionFromReminderJson(
        "composeCondition" in reminder ? reminder.composeCondition : null,
      ),
    );
    await settleFiredReminder(reminder, now, sendStatus, {
      forceDone:
        watchOnce &&
        hadCondition &&
        sendStatus === "sent" &&
        !skipSend,
    });
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
