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
import {
  isMissingTableError,
  isUniqueConstraintError,
} from "../utils/errors.js";
import { publishChatEvent } from "./chat-events.service.js";
import { getLlmClient, rememberInModelConversation } from "./llm-client.js";
import { listEmployeesForUser } from "./employee.service.js";
import { looksLikePhone, phonesMatch } from "../utils/phone.js";
import {
  formatAttributedOutbound,
  reminderFireButtons,
} from "./outbound-text.js";
import { composeScheduledOutbound } from "./reminder-compose.js";
import { loadComposeFacts } from "./compose-facts.js";
import {
  conditionFromReminderJson,
  evaluateComposeCondition,
} from "./compose-condition.js";
import { enrichEvalFactsForExpr } from "./watch-expr.js";
import {
  BUS_ETA_POLL_FAIL_NOTIFY_AFTER,
  busEtaPollFailNotifiedSha,
  busEtaPollFailSha,
  fetchBusEtaWatch,
  isBusEtaPollFailNotified,
  parseBusEtaPollFailCount,
  ROUTES_BUS_ETA_POLL_UNAVAILABLE_HE,
} from "./routes.js";
import {
  fetchFlightChangedWatch,
  fetchFlightEtaWatch,
  flightEtaThresholdMinutes,
} from "./flights.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import { sendWhatsAppButtons } from "./whatsapp-send.js";

/** ChatConversations row for actor×digital so reminder_compose can FK LlmUsages. */
async function getOrCreateBillingConversation(input: {
  userId: string;
  employeeId: string;
  digitalEmployeeId: string;
}): Promise<string | null> {
  const existing = await prisma.chatConversation.findUnique({
    where: {
      userId_employeeId_digitalEmployeeId: {
        userId: input.userId,
        employeeId: input.employeeId,
        digitalEmployeeId: input.digitalEmployeeId,
      },
    },
    select: { id: true },
  });
  if (existing) {
    return existing.id;
  }
  try {
    const openaiConversationId = await getLlmClient().createConversation();
    const created = await prisma.chatConversation.create({
      data: {
        userId: input.userId,
        employeeId: input.employeeId,
        digitalEmployeeId: input.digitalEmployeeId,
        openaiConversationId,
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      recordWhatsAppEvent(
        "reminder_compose_billing_conv_fail",
        error instanceof Error ? error.message : "unknown",
      );
      return null;
    }
    const raced = await prisma.chatConversation.findUnique({
      where: {
        userId_employeeId_digitalEmployeeId: {
          userId: input.userId,
          employeeId: input.employeeId,
          digitalEmployeeId: input.digitalEmployeeId,
        },
      },
      select: { id: true },
    });
    return raced?.id ?? null;
  }
}
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

/** Compose sources that must never WhatsApp the raw brief when the LLM fails. */
const FACT_COMPOSE_KINDS = new Set([
  "git_log",
  "saved_data",
  "weather",
  "market",
  "mashov",
  "jewish",
  "places",
  "flights",
  "routes",
]);

export type ComposeFireOutbound = {
  /** "send" → WhatsApp/chat; "fail" → settle failed, no body. */
  outcome: "send" | "fail";
  body: string;
  lastComposedToSave: string | null;
};

/**
 * Compose-at-fire body selection.
 * - LLM text when present.
 * - Else truthful fixedBody when the facts loader provided one.
 * - Else fact-dependent clocks fail closed (never send the instruction brief).
 * - Creative / empty-source clocks may still fall back to brief/label.
 */
export function resolveComposeFireOutbound(input: {
  brief: string;
  itemLabel: string;
  composed: string | null | undefined;
  kind?: string | null;
  fixedBody?: string | null;
}): ComposeFireOutbound {
  const composed = input.composed?.trim() || "";
  if (composed) {
    return {
      outcome: "send",
      body: composed.slice(0, 4096),
      lastComposedToSave: composed.slice(0, 4096),
    };
  }
  const fixed = input.fixedBody?.trim() || "";
  if (fixed) {
    return {
      outcome: "send",
      body: fixed.slice(0, 4096),
      lastComposedToSave: null,
    };
  }
  const kind = String(input.kind ?? "").trim();
  if (FACT_COMPOSE_KINDS.has(kind)) {
    return { outcome: "fail", body: "", lastComposedToSave: null };
  }
  const brief = input.brief.trim();
  return {
    outcome: "send",
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

  let firedTaskData: unknown = null;
  if (!keptAsScheduledJob && prisma.employeeListItem) {
    // Soft-delete before clearing FKs — workerItemId and/or items that still
    // point at this clock via reminderId (covers a missing reverse FK).
    const softDeleteIds = new Set<string>();
    if (workerItemId) {
      softDeleteIds.add(workerItemId);
    }
    if (prisma.employeeListItem.findMany) {
      try {
        const linked = await prisma.employeeListItem.findMany({
          where: { reminderId: reminder.id, deletedAt: null },
          select: { id: true },
        });
        for (const row of linked ?? []) {
          if (row?.id) softDeleteIds.add(row.id);
        }
      } catch {
        // Table missing in tests / early migrate.
      }
    }
    for (const itemId of softDeleteIds) {
      try {
        const task = await prisma.employeeListItem.update({
          where: { id: itemId },
          data: { deletedAt: new Date(), reminderId: null },
        });
        if (itemId === workerItemId || firedTaskData == null) {
          firedTaskData = task?.data ?? null;
        }
      } catch {
        // Already removed.
      }
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

  if (prisma.employeeListItem?.updateMany) {
    // Clear any leftover primary FKs and soft-links (same as cancel).
    await prisma.employeeListItem.updateMany({
      where: { reminderId: reminder.id },
      data: { reminderId: null },
    });
    await prisma.employeeListItem.updateMany({
      where: { linkedReminderId: reminder.id, deletedAt: null },
      data: { linkedReminderId: null },
    });
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
    let flightDefaultBody: string | null = null;
    let skipSend = false;
    let conditionShaAfterSend: string | undefined;
    /** Persistent bus_eta poll failure: send honesty once; skip condition gate. */
    let forceBusEtaPollFailNotify = false;
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
          if (!eta.ok) {
            // Provider/network failure — not “ETA still above threshold”.
            // Transient: quiet-skip. Persistent: one honesty notify (no invented ETA).
            const prevFail = parseBusEtaPollFailCount(reminder.lastReportSha);
            const nextFail = prevFail + 1;
            if (
              nextFail < BUS_ETA_POLL_FAIL_NOTIFY_AFTER ||
              isBusEtaPollFailNotified(reminder.lastReportSha)
            ) {
              await prisma.reminder.update({
                where: { id: reminder.id },
                data: {
                  lastReportSha: isBusEtaPollFailNotified(
                    reminder.lastReportSha,
                  )
                    ? reminder.lastReportSha
                    : busEtaPollFailSha(nextFail),
                },
              });
              await settleFiredReminder(reminder, now, "sent");
              continue;
            }
            busEtaDefaultBody = ROUTES_BUS_ETA_POLL_UNAVAILABLE_HE;
            conditionShaAfterSend = busEtaPollFailNotifiedSha(now);
            forceBusEtaPollFailNotify = true;
          } else {
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
              // Google Routes ETA estimate — never claim MOT SIRI live.
              busEtaDefaultBody = `קו ${condition.line} משוער בעוד כ־${eta.minutes} דקות מ«${condition.origin}» לכיוון «${condition.destination}» (הערכת Google, לא תחזית SIRI חיה) — זמן לצאת.`;
            }
          }
        }
        if (condition.type === "flight_eta") {
          const eta = await fetchFlightEtaWatch({
            airport: condition.airport,
            direction: condition.direction,
            flight: condition.flight,
            airline: condition.airline,
            city: condition.city,
            now,
          });
          evalFacts = {
            ...evalFacts,
            flightEtaMinutes: eta.minutesUntil,
            flightEtaFingerprint: eta.fingerprint,
          };
          const threshold = flightEtaThresholdMinutes({
            minutesBefore: condition.minutesBefore,
            hoursBefore: condition.hoursBefore,
          });
          if (
            eta.minutesUntil != null &&
            eta.minutesUntil <= threshold &&
            eta.fingerprint &&
            eta.summary
          ) {
            const verb =
              condition.direction === "departures" ? "המראה" : "נחיתה";
            flightDefaultBody = `${eta.summary} — עוד כ־${eta.minutesUntil} דקות עד ה${verb}.`;
          }
        }
        if (condition.type === "flight_changed") {
          const changed = await fetchFlightChangedWatch({
            airport: condition.airport,
            direction: condition.direction,
            flight: condition.flight,
          });
          evalFacts = {
            ...evalFacts,
            flightChangedFingerprint: changed.fingerprint,
          };
          if (changed.fingerprint && changed.summary) {
            flightDefaultBody = `עדכון בטיסה: ${changed.summary}.`;
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
        if (forceBusEtaPollFailNotify) {
          // Honesty path already set busEtaDefaultBody + conditionShaAfterSend.
        } else {
          const gate = evaluateComposeCondition({
            condition,
            facts: evalFacts,
            lastReportSha: reminder.lastReportSha,
            // Explicit watch_once:false → level (alert every poll while holding).
            // true (default one-shot) → edge (false→true only).
            alertWhileHolding:
              "watchOnce" in reminder && reminder.watchOnce === false,
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
      }

      const recipientGender =
        firstTarget &&
        "addressGender" in firstTarget &&
        (firstTarget.addressGender === "male" ||
          firstTarget.addressGender === "female")
          ? firstTarget.addressGender
          : null;

      let composeBilling:
        | {
            conversationId: string;
            employeeId: string;
            digitalEmployeeId: string;
          }
        | null = null;
      if (actor && speaker) {
        const billingConversationId = await getOrCreateBillingConversation({
          userId: reminder.userId,
          employeeId: actor.id,
          digitalEmployeeId: speaker.id,
        });
        if (billingConversationId) {
          composeBilling = {
            conversationId: billingConversationId,
            employeeId: actor.id,
            digitalEmployeeId: speaker.id,
          };
        }
      }
      const composed = await composeScheduledOutbound({
        brief: reminder.messageText,
        itemLabel: reminder.itemLabel,
        actorName,
        recipientName,
        previousText: reminder.lastComposedText,
        facts: factsBundle,
        watch: isWatch,
        addressGender: recipientGender,
        billing: composeBilling,
      });
      const resolved = resolveComposeFireOutbound({
        brief: reminder.messageText,
        itemLabel: reminder.itemLabel,
        composed,
        kind: factsBundle?.kind,
        fixedBody: factsBundle?.fixedBody,
      });
      const conditionDefaultBody = busEtaDefaultBody || flightDefaultBody;
      const preferConditionDefault =
        Boolean(conditionDefaultBody) &&
        (forceBusEtaPollFailNotify ||
          !resolved.body.trim() ||
          resolved.body.trim() === String(reminder.messageText ?? "").trim() ||
          resolved.outcome === "fail");
      if (preferConditionDefault && conditionDefaultBody) {
        outboundBody = conditionDefaultBody;
      } else if (resolved.outcome === "fail") {
        // Fact clock: LLM empty/null and no fixedBody — do not send the brief.
        recordWhatsAppEvent(
          "reminder_compose_outbound_fail",
          `kind=${factsBundle?.kind ?? ""} item=${reminder.itemLabel.slice(0, 40)}`,
        );
        await settleFiredReminder(reminder, now, "failed");
        continue;
      } else {
        outboundBody = resolved.body;
      }
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
      const buttons: LlmReplyButton[] = reminderFireButtons({
        item: reminder.itemLabel,
        text: outboundBody,
        composeAtFire: reminder.composeAtFire,
      });

      let destDelivered = false;
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
          // In-app chat counts as delivered — watch_once must close even when
          // WhatsApp is missing/fails (otherwise Lucy's worker task stays open).
          destDelivered = true;
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
          if (result === "sent") {
            destDelivered = true;
            if (files.length > 0) {
              const delivered = await deliverAttachmentsToPhone(phone, files, {
                ignoreSession: true,
              });
              recordWhatsAppEvent(
                "reminder_files",
                `sent=${delivered.sent} failed=${delivered.failed}`,
              );
            }
          }
        } catch (error) {
          console.error(
            "Reminder WhatsApp failed",
            error instanceof Error ? error.message : "unknown",
          );
        }
      }
      sendResults.push(destDelivered);
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
  // Studio / isolated eval: keep fireDueReminders implementation, but do not
  // schedule ticks that could message real users from a shared process.
  if (process.env.WORKEE_DISABLE_REMINDER_FIRE === "1") {
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
