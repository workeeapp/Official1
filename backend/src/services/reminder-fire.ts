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
  comparePrice,
  conditionFromReminderJson,
  evaluateComposeCondition,
} from "./compose-condition.js";
import {
  formatMarketPriceWatchFallback,
  validateMarketPriceComposeText,
} from "./market-compose-guard.js";
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
import {
  fetchSportsSchedule,
  minutesUntilKickoff,
  nextUpcomingMatch,
  sportsMatchFingerprint,
} from "./sports-schedule.service.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import { sendWhatsAppButtons } from "./whatsapp-send.js";
import {
  claimDeliverySend,
  completeDeliveryAttempt,
} from "./delivery-attempt.service.js";
import { shouldSuppressLegacyForeignClock } from "./reminder-high-risk-auth.js";
import { jobMetaFrom, type JobMeta } from "./job-meta.js";
import {
  executeWatchTriggerActions,
  listIncompleteWatchFingerprints,
  markWatchTriggerActionsGateBlocked,
  markWatchTriggerNotified,
  parseWatchTriggerExecLedger,
  parseWatchTriggerPackage,
  watchTriggerNeedsActionRecovery,
  watchTriggerNeedsNotifyRecovery,
} from "./watch-trigger-actions.service.js";
import type { ComposeEvalFacts } from "./compose-condition.js";
import {
  parseMonitorState,
  pollWebMonitor,
  type PollWebMonitorInput,
  type PollWebMonitorResult,
} from "./semantic-web-monitor.service.js";
import {
  dualFireAt,
  isPreciseArmDue,
} from "./uwm-schedule.js";
import { uwmApplyGate } from "./uwm-apply-gate.js";
import { recordUwmMetric } from "./uwm-retrieval-metrics.js";

/** Test seam for UWM poll (Phase 3). */
let webMonitorPollImpl: (
  input: PollWebMonitorInput,
) => Promise<PollWebMonitorResult> = pollWebMonitor;

export function setWebMonitorPollImplForTests(
  impl: typeof webMonitorPollImpl | null,
): void {
  webMonitorPollImpl = impl ?? pollWebMonitor;
}

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

/** Plain one-shot WhatsApp failure: try again after this delay. Not a completion. */
export const ONE_SHOT_DELIVERY_RETRY_MS = 120_000;
const ONE_SHOT_DELIVERY_RETRY_CAP = 6;
const ONE_SHOT_DELIVERY_BACKOFF_MS = 6 * 60 * 60 * 1000;
/**
 * WhatsApp accepted the send, and settlement has not finished.
 * A later tick completes the clock without sending again.
 * Recurring clocks store "sent" after settlement, so this value is only the crash window.
 */
const DELIVERY_ACCEPTED = "accepted";

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

const FAIL_NOTICE_PURPOSE = "reminder_fail_notice";

/** Deterministic Reminder.itemKey so a crash after create still dedupes. */
function failNoticeItemKey(sourceReminderId: string): string {
  return `כשל_מסירה:${sourceReminderId}`.slice(0, 255);
}

async function loadJobMetaForReminder(reminder: {
  id: string;
  workerItemId?: string | null;
}): Promise<JobMeta | null> {
  const workerId =
    (typeof reminder.workerItemId === "string" && reminder.workerItemId.trim()) ||
    (await workerItemIdForReminder(reminder.id));
  if (!workerId || typeof prisma.employeeListItem?.findUnique !== "function") {
    return null;
  }
  try {
    const row = await prisma.employeeListItem.findUnique({
      where: { id: workerId },
      select: { data: true },
    });
    return jobMetaFrom(row?.data ?? null);
  } catch {
    return null;
  }
}

/**
 * Who should hear about a reliable Reminder delivery failure.
 * Job/nudge → askerId from meta. Human actor → that actor.
 * Digital actor without job meta → null (ownerId may be the subject — never guess).
 */
function resolveFailNoticeAskerId(input: {
  actor: { id: string; kind: string } | undefined;
  jobMeta: JobMeta | null;
}): string | null {
  const fromJob = input.jobMeta?.askerId?.trim();
  if (fromJob) {
    return fromJob;
  }
  if (input.actor?.kind === "human" && input.actor.id.trim()) {
    return input.actor.id.trim();
  }
  return null;
}

/**
 * One asker notice after reliable suppress/fail. Idempotent via Reminder.itemKey
 * + DeliveryAttempt (purpose reminder_fail_notice). Ledger skip on
 * accepted|sending|unknown — no in_flight→failed recover (avoids duplicate race).
 */
async function notifyAskerOfReliableDeliveryFailure(input: {
  reminder: {
    id: string;
    userId: string;
    actorId: string;
    ownerId: string;
    pingIds: unknown;
    itemLabel: string | null;
    messageText: string;
    workerItemId?: string | null;
  };
  employees: Array<{ id: string; kind: string; phone?: string | null; name: string; nickname?: string | null }>;
  actor: { id: string; kind: string } | undefined;
  jobMeta: JobMeta | null;
  now: Date;
  reason: "suppress" | "delivery_failed";
}): Promise<void> {
  if (!input.reminder.userId || typeof prisma.reminder?.create !== "function") {
    return;
  }
  const askerId = resolveFailNoticeAskerId({
    actor: input.actor,
    jobMeta: input.jobMeta,
  });
  if (!askerId) {
    return;
  }
  const pings = pingIds(input.reminder.pingIds);
  // Self-ping / fail-notice clocks: asker is the recipient — no loop.
  if (pings.length > 0 && pings.every((id) => id === askerId)) {
    return;
  }

  const itemKey = failNoticeItemKey(input.reminder.id);
  try {
    const existing = await prisma.reminder.findFirst({
      where: { userId: input.reminder.userId, itemKey },
      select: { id: true },
    });
    if (existing) {
      return;
    }
  } catch {
    return;
  }

  const asker = input.employees.find((row) => row.id === askerId);
  const destination = asker?.phone?.trim() || `in_app:${askerId}`;
  const claimArgs = {
    userId: input.reminder.userId,
    sourceKey: `reminder:${input.reminder.id}`,
    destination,
    purpose: FAIL_NOTICE_PURPOSE,
  };

  const claim = await claimDeliverySend(claimArgs);
  // Normal ledger contract: accepted | sending | unknown → skip (no recover).
  // A stuck sending/unknown without a Reminder row may lose the notice once;
  // do not force failed→re-claim (that raced into duplicate notices).
  if (!claim.maySend) {
    return;
  }

  const destLabel =
    asker && pings[0]
      ? input.employees.find((row) => row.id === pings[0])?.nickname?.trim() ||
        input.employees.find((row) => row.id === pings[0])?.name ||
        "הנמען"
      : "הנמען";
  const chore =
    (input.reminder.itemLabel || input.reminder.messageText || "").trim().slice(0, 80) ||
    "תזכורת";
  const text =
    input.reason === "suppress"
      ? `לא הצלחתי לשלוח ל${destLabel} את התזכורת «${chore}» (נחסמה לפני שליחה).`
      : `לא הצלחתי לשלוח ל${destLabel} את התזכורת «${chore}».`;
  const label = `לא נשלחה תזכורת: ${chore}`.slice(0, 255);

  try {
    await prisma.reminder.create({
      data: {
        userId: input.reminder.userId,
        ownerId: askerId,
        actorId: askerId,
        itemKey,
        itemLabel: label,
        listType: "tasks",
        fireAt: input.now,
        repeat: "once",
        pingIds: [askerId],
        messageText: text.slice(0, 4096),
      },
    });
    scheduleSoon(input.now);
    if (claim.attemptId) {
      await completeDeliveryAttempt({
        attemptId: claim.attemptId,
        status: "accepted",
      });
    }
  } catch (error) {
    if (claim.attemptId) {
      await completeDeliveryAttempt({
        attemptId: claim.attemptId,
        status: "failed",
        lastError:
          error instanceof Error ? error.message : "fail_notice_create",
      });
    }
  }
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
  options?: {
    forceDone?: boolean;
    retryWhenFailed?: boolean;
    /** UWM Phase 4 dual schedule: override recurrence next when set. */
    nextFireAtOverride?: Date | null;
  },
): Promise<void> {
  const sentAt = sendStatus === "sent" ? now : null;
  const firedCount = (reminder.occurrencesFired ?? 0) + 1;
  const nextAt = options?.forceDone
    ? null
    : options?.nextFireAtOverride !== undefined
      ? options.nextFireAtOverride
      : await resolveNextFireAt(reminder, now, firedCount);
  const rule = parseRecurrence(reminder.recurrence);
  const hasRule = Boolean(rule);
  if (
    !nextAt &&
    sendStatus === "failed" &&
    options?.retryWhenFailed === true &&
    !options?.forceDone &&
    !hasRule
  ) {
    const attempts = (reminder.occurrencesFired ?? 0) + 1;
    const delay =
      attempts <= ONE_SHOT_DELIVERY_RETRY_CAP
        ? ONE_SHOT_DELIVERY_RETRY_MS
        : ONE_SHOT_DELIVERY_BACKOFF_MS;
    const retryAt = new Date(now.getTime() + delay);
    await prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        status: "active",
        sendStatus: "failed",
        sentAt: null,
        fireAt: retryAt,
        occurrencesFired: attempts,
      },
    });
    scheduleSoon(retryAt);
    if (reminder.userId) {
      await recordAuditEvent({
        userId: reminder.userId,
        actorEmployeeId: reminder.actorId,
        action: "reminder_fire",
        entityType: "Reminder",
        entityId: reminder.id,
        summary: `reminder delivery failed, will retry: ${reminder.itemLabel ?? reminder.id}`,
        detail: {
          sendStatus: "failed",
          retryAt: retryAt.toISOString(),
          attempt: attempts,
        },
      });
    }
    return;
  }
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

  // One-shot success: keep the row as history (status=done + sent_at).
  // A failed plain one-shot never reaches here; it stays active for retry.
  // Detach the worker task first so deleting that item cannot CASCADE-delete this clock.
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
    const firedMeta = jobMetaFrom(firedTaskData);
    await recordAuditEvent({
      userId: reminder.userId,
      actorEmployeeId: firedMeta?.askerId || reminder.actorId,
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
    if (reminder.sendStatus === DELIVERY_ACCEPTED) {
      await settleFiredReminder(reminder, now, "sent");
      continue;
    }

    const employees = await listEmployeesForUser(reminder.userId);
    const lucy = employees.find((employee) => isProtectedEmployee(employee));
    const digitals = digitalEmployees(employees);
    const speaker = lucy ?? digitals[0];
    const actor = employees.find((employee) => employee.id === reminder.actorId);
    const actorName = actor?.nickname?.trim() || actor?.name || "";
    const jobMeta = await loadJobMetaForReminder(reminder);
    // Lucy-operated Job/nudge clocks: attribute to the human asker, not «מאת לוסי».
    // When messageText already names the asker, formatAttributedOutbound skips a prefix.
    const attributionName =
      actor?.kind === "digital"
        ? jobMeta?.askerName?.trim() || ""
        : actorName;
    // Stage 6: suppress legacy human-actor foreign clocks without Class V auth marker.
    if (
      shouldSuppressLegacyForeignClock({
        actorId: reminder.actorId,
        pingIds: reminder.pingIds,
        highRiskAuthorizedAt:
          "highRiskAuthorizedAt" in reminder
            ? (reminder.highRiskAuthorizedAt as Date | null)
            : null,
        employees,
      })
    ) {
      recordWhatsAppEvent(
        "reminder_legacy_foreign_suppress",
        `id=${reminder.id} item=${reminder.itemLabel}`,
      );
      await notifyAskerOfReliableDeliveryFailure({
        reminder,
        employees,
        actor,
        jobMeta,
        now,
        reason: "suppress",
      });
      await settleFiredReminder(reminder, now, "failed", {
        retryWhenFailed: false,
      });
      continue;
    }
    const dests = pingIds(reminder.pingIds);
    const sendResults: boolean[] = [];

    let outboundBody = reminder.messageText;
    let busEtaDefaultBody: string | null = null;
    let flightDefaultBody: string | null = null;
    let sportsDefaultBody: string | null = null;
    let webMonitorDefaultBody: string | null = null;
    /** UWM Phase 4: dual schedule override for settleFiredReminder. */
    let uwmNextFireAtOverride: Date | null | undefined = undefined;
    const settleReminder = async (
      status: "sent" | "failed",
      extra?: { forceDone?: boolean; retryWhenFailed?: boolean },
    ) => {
      await settleFiredReminder(reminder, now, status, {
        ...extra,
        ...(uwmNextFireAtOverride !== undefined
          ? { nextFireAtOverride: uwmNextFireAtOverride }
          : {}),
      });
    };
    let skipSend = false;
    let conditionShaAfterSend: string | undefined;
    /** Persistent bus_eta poll failure: send honesty once; skip condition gate. */
    let forceBusEtaPollFailNotify = false;
    const watchPackage = parseWatchTriggerPackage(
      "onTriggerActions" in reminder ? reminder.onTriggerActions : null,
    );
    let watchLedger = parseWatchTriggerExecLedger(
      "onTriggerExec" in reminder ? reminder.onTriggerExec : null,
    );
    let watchEventFingerprint = "";
    let watchEvalFacts: ComposeEvalFacts = {};
    let watchNotifyRecovery = false;
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
        if (condition.type === "sports_match") {
          const schedule = await fetchSportsSchedule({
            team: condition.team,
            competition: condition.competition,
            userId: reminder.userId,
            now,
          });
          const match = nextUpcomingMatch(schedule, now);
          const mins = match
            ? minutesUntilKickoff(match.kickoffIso, now)
            : null;
          const fp = match
            ? sportsMatchFingerprint(match).slice(0, 64)
            : "";
          evalFacts = {
            ...evalFacts,
            sportsMatchEtaMinutes: mins,
            sportsMatchFingerprint: fp,
          };
          if (
            match &&
            mins != null &&
            mins <= condition.minutesBefore &&
            fp
          ) {
            sportsDefaultBody = `משחק של ${condition.team} נגד ${match.opponent} בעוד כ־${mins} דקות.`;
          }
        }
        if (condition.type === "web_monitor") {
          const priorState = parseMonitorState(
            "monitorState" in reminder ? reminder.monitorState : null,
          );
          const preciseDue = isPreciseArmDue({
            state: priorState,
            now,
          });
          const poll = await webMonitorPollImpl({
            reminderId: reminder.id,
            userId: reminder.userId,
            composeCondition: reminder.composeCondition,
            monitorState:
              "monitorState" in reminder ? reminder.monitorState : null,
            watchOnce: Boolean(
              "watchOnce" in reminder && reminder.watchOnce,
            ),
            lastReportSha: reminder.lastReportSha,
            now,
            preciseOnly: preciseDue,
          });
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: {
              monitorState: poll.monitorState as Prisma.InputJsonValue,
            },
          });
          const discoveryNext = await resolveNextFireAt(
            reminder,
            now,
            (reminder.occurrencesFired ?? 0) + 1,
          );
          uwmNextFireAtOverride = dualFireAt(
            discoveryNext,
            poll.nextPrecise ?? poll.monitorState.nextPrecise ?? null,
            now,
          );
          const notifyItem = poll.notify.item;
          evalFacts = {
            ...evalFacts,
            webMonitor: {
              shouldNotify: poll.notify.shouldNotify,
              fingerprint: poll.notify.fingerprint,
              bodyHe: poll.notify.bodyHe,
              reason: poll.notify.reason,
              evidenceGrade: notifyItem?.evidenceGrade,
              evidenceMin: condition.evidenceMin,
              retrievedAt: notifyItem?.retrievedAt,
              itemId: notifyItem?.itemId,
              phase: poll.notify.phase,
              stale: poll.notify.reason === "stale",
              fresh:
                poll.notify.shouldNotify &&
                poll.notify.reason !== "stale" &&
                Boolean(notifyItem?.retrievalOk !== false),
            },
          };
          if (poll.notify.shouldNotify && poll.notify.bodyHe) {
            webMonitorDefaultBody = poll.notify.bodyHe;
          }
          recordWhatsAppEvent(
            "uwm_poll",
            `discovery=${poll.discoveryUsed} bound=${poll.boundPageUsed} found=${poll.itemsFound} matched=${poll.itemsMatched} notify=${poll.notify.shouldNotify} precise=${preciseDue} nextPrecise=${poll.nextPrecise?.fireAtIso ?? ""} dual=${uwmNextFireAtOverride?.toISOString() ?? ""}`,
          );
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
          watchEvalFacts = evalFacts;
          watchEventFingerprint = String(
            gate.shaAfterSend ?? gate.immediateSha ?? "",
          ).slice(0, 64);
          if (gate.immediateSha) {
            await prisma.reminder.update({
              where: { id: reminder.id },
              data: { lastReportSha: gate.immediateSha },
            });
          }
          if (gate.skipSend) {
            // Quiet skip — unless a prior matched event still needs Action or
            // notification recovery (independent ledgers).
            if (watchPackage) {
              const recoveryFp = String(
                reminder.lastReportSha ||
                  gate.immediateSha ||
                  watchEventFingerprint ||
                  "",
              ).slice(0, 64);
              if (recoveryFp) {
                if (
                  watchTriggerNeedsActionRecovery(
                    watchLedger,
                    watchPackage,
                    recoveryFp,
                  )
                ) {
                  const ran = await executeWatchTriggerActions({
                    reminderId: reminder.id,
                    userId: reminder.userId,
                    package: watchPackage,
                    ledger: watchLedger,
                    fingerprint: recoveryFp,
                    facts: evalFacts,
                    now,
                  });
                  watchLedger = ran.ledger;
                }
                if (
                  watchTriggerNeedsNotifyRecovery(watchLedger, recoveryFp)
                ) {
                  // Prior match recorded; WhatsApp still outstanding.
                  skipSend = false;
                  watchNotifyRecovery = true;
                  watchEventFingerprint = recoveryFp;
                  conditionShaAfterSend = gate.shaAfterSend ?? recoveryFp;
                } else {
                  await settleReminder("sent");
                  continue;
                }
              } else {
                await settleReminder("sent");
                continue;
              }
            } else {
              // Quiet skip — clock advances; never send «עדיין לא».
              await settleReminder("sent");
              continue;
            }
          } else {
            conditionShaAfterSend = gate.shaAfterSend;
          }
        }
      }

      // P0: run deferred owner-only Actions after a successful condition match
      // (or Action recovery). Independent of WhatsApp success.
      // UWM Phase 5: web_monitor uses the same Apply path after evidence gate.
      if (
        watchPackage &&
        watchEventFingerprint &&
        (!skipSend || watchNotifyRecovery)
      ) {
        const isUwm = condition?.type === "web_monitor";
        const applyGate = isUwm
          ? uwmApplyGate(watchEvalFacts, now)
          : ({ ok: true } as const);
        if (isUwm) {
          recordUwmMetric("action", {
            op: "checked",
            fingerprint: watchEventFingerprint.slice(0, 40),
            ok: applyGate.ok,
            reason: applyGate.ok ? "pass" : applyGate.reason,
          });
        }
        if (!applyGate.ok) {
          recordUwmMetric("action", {
            op: "skipped",
            reason: applyGate.reason,
            fingerprint: watchEventFingerprint.slice(0, 40),
          });
          // Terminal gate block — do not leave pending Actions that Recovery
          // could execute later without a fresh Gate pass on this fingerprint.
          try {
            watchLedger = await markWatchTriggerActionsGateBlocked({
              reminderId: reminder.id,
              ledger: watchLedger,
              package: watchPackage,
              fingerprint: watchEventFingerprint,
              reason: applyGate.reason,
              now,
            });
          } catch (gateLedgerError) {
            recordWhatsAppEvent(
              "watch_trigger_gate_ledger_error",
              `id=${reminder.id} ${
                gateLedgerError instanceof Error
                  ? gateLedgerError.message.slice(0, 80)
                  : "unknown"
              }`,
            );
          }
        } else {
          try {
            // Also retry any older incomplete fingerprints without touching notify.
            // Gate-blocked fingerprints are excluded by watchTriggerNeedsActionRecovery.
            for (const fp of listIncompleteWatchFingerprints(
              watchLedger,
              watchPackage,
            )) {
              if (fp === watchEventFingerprint) {
                continue;
              }
              if (
                !watchTriggerNeedsActionRecovery(watchLedger, watchPackage, fp)
              ) {
                continue;
              }
              const older = await executeWatchTriggerActions({
                reminderId: reminder.id,
                userId: reminder.userId,
                package: watchPackage,
                ledger: watchLedger,
                fingerprint: fp,
                facts: watchEvalFacts,
                now,
              });
              watchLedger = older.ledger;
              if (isUwm) {
                recordUwmMetric("action", {
                  op: "recovered",
                  fingerprint: fp.slice(0, 40),
                });
              }
            }
            const ran = await executeWatchTriggerActions({
              reminderId: reminder.id,
              userId: reminder.userId,
              package: watchPackage,
              ledger: watchLedger,
              fingerprint: watchEventFingerprint,
              facts: watchEvalFacts,
              now,
            });
            watchLedger = ran.ledger;
            if (isUwm) {
              const failed = ran.actionResults.filter(
                (r) => r.status === "failed",
              );
              const done = ran.actionResults.filter((r) => r.status === "done");
              recordUwmMetric("action", {
                op: failed.length && !done.length ? "failed" : "executed",
                fingerprint: watchEventFingerprint.slice(0, 40),
                done: done.length,
                failed: failed.length,
                reason: failed[0]?.error ?? null,
              });
            }
          } catch (triggerError) {
            if (isUwm) {
              recordUwmMetric("action", {
                op: "failed",
                reason: "exception",
                fingerprint: watchEventFingerprint.slice(0, 40),
              });
            }
            recordWhatsAppEvent(
              "watch_trigger_error",
              `id=${reminder.id} ${
                triggerError instanceof Error
                  ? triggerError.message.slice(0, 80)
                  : "unknown"
              }`,
            );
          }
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
        actorName: attributionName || actorName,
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
      const conditionDefaultBody =
        busEtaDefaultBody ||
        flightDefaultBody ||
        sportsDefaultBody ||
        webMonitorDefaultBody;
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
      // market_price: never send compose that contradicts FACT price/threshold.
      if (
        condition?.type === "market_price" &&
        outboundBody.trim() &&
        factsBundle?.eval?.marketPrice != null &&
        Number.isFinite(factsBundle.eval.marketPrice)
      ) {
        const factPrice = factsBundle.eval.marketPrice;
        const holding = comparePrice(
          factPrice,
          condition.op,
          condition.value,
        );
        const check = validateMarketPriceComposeText({
          text: outboundBody,
          price: factPrice,
          threshold: condition.value,
          op: condition.op,
          holding,
          symbol:
            typeof reminder.composePlace === "string"
              ? reminder.composePlace.split(",")[0]?.trim()
              : "",
        });
        if (!check.ok) {
          recordWhatsAppEvent(
            "reminder_compose_market_guard",
            `reason=${check.reason ?? "contradiction"} item=${reminder.itemLabel.slice(0, 40)}`,
          );
          outboundBody = formatMarketPriceWatchFallback({
            price: factPrice,
            threshold: condition.value,
            op: condition.op,
            holding,
            symbol:
              typeof reminder.composePlace === "string"
                ? reminder.composePlace.split(",")[0]?.trim()
                : "",
          });
        }
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
        Boolean(actor?.phone && phonesMatch(actor.phone, dest)) ||
        Boolean(jobMeta?.askerId && dest === jobMeta.askerId);
      const text = formatAttributedOutbound({
        actorName: attributionName,
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
        // F1: claim DeliveryAttempt before Graph; never auto-resend accepted|unknown|sending.
        let attemptId: string | null = null;
        try {
          const claim = await claimDeliverySend({
            userId: reminder.userId,
            sourceKey: `reminder:${reminder.id}`,
            destination: phone,
            purpose: "reminder_fire",
          });
          attemptId = claim.attemptId;
          if (!claim.maySend) {
            // Already accepted or in-flight/unknown — do not Graph again.
            destDelivered = true;
          } else {
            try {
              const result = await sendWhatsAppButtons(phone, text, buttons, {
                ignoreSession: true,
              });
              if (result === "sent") {
                destDelivered = true;
                if (attemptId) {
                  await completeDeliveryAttempt({
                    attemptId,
                    status: "accepted",
                  });
                }
                if (files.length > 0) {
                  const delivered = await deliverAttachmentsToPhone(phone, files, {
                    ignoreSession: true,
                  });
                  recordWhatsAppEvent(
                    "reminder_files",
                    `sent=${delivered.sent} failed=${delivered.failed}`,
                  );
                }
              } else if (attemptId) {
                await completeDeliveryAttempt({
                  attemptId,
                  status: "failed",
                  lastError: String(result),
                });
              }
            } catch (error) {
              // Crash/timeout after a possible Graph accept → unknown (no auto-resend).
              if (attemptId) {
                await completeDeliveryAttempt({
                  attemptId,
                  status: "unknown",
                  lastError:
                    error instanceof Error ? error.message : "unknown",
                });
              }
              console.error(
                "Reminder WhatsApp failed",
                error instanceof Error ? error.message : "unknown",
              );
            }
          }
        } catch (error) {
          // Ledger unavailable — fall back to direct send (eval/offline mocks).
          recordWhatsAppEvent(
            "reminder_delivery_ledger_fail",
            error instanceof Error ? error.message : "unknown",
          );
          try {
            const result = await sendWhatsAppButtons(phone, text, buttons, {
              ignoreSession: true,
            });
            if (result === "sent") {
              destDelivered = true;
              if (files.length > 0) {
                await deliverAttachmentsToPhone(phone, files, {
                  ignoreSession: true,
                });
              }
            }
          } catch (sendError) {
            console.error(
              "Reminder WhatsApp failed",
              sendError instanceof Error ? sendError.message : "unknown",
            );
          }
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
    if (sendStatus === "sent") {
      // Durable DeliveryAttempt.accepted is claimed before Graph; this reminder
      // flag closes the settle path. Retry after crash skips via ledger.
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: { sendStatus: DELIVERY_ACCEPTED, sentAt: now },
      });
    }

    // Independent notification ledger for Watch→Action packages.
    if (watchPackage && watchEventFingerprint) {
      try {
        watchLedger = await markWatchTriggerNotified({
          reminderId: reminder.id,
          ledger: watchLedger,
          package: watchPackage,
          fingerprint: watchEventFingerprint,
          notified: sendStatus === "sent",
          now,
        });
      } catch (notifyLedgerError) {
        recordWhatsAppEvent(
          "watch_trigger_notify_ledger_error",
          `id=${reminder.id} ${
            notifyLedgerError instanceof Error
              ? notifyLedgerError.message.slice(0, 80)
              : "unknown"
          }`,
        );
      }
    }

    const watchOnce =
      "watchOnce" in reminder && reminder.watchOnce === true;
    const hadCondition = Boolean(
      conditionFromReminderJson(
        "composeCondition" in reminder ? reminder.composeCondition : null,
      ),
    );
    if (sendStatus === "failed" && !skipSend) {
      await notifyAskerOfReliableDeliveryFailure({
        reminder,
        employees,
        actor,
        jobMeta,
        now,
        reason: "delivery_failed",
      });
    }
    await settleReminder(sendStatus, {
      forceDone:
        watchOnce &&
        hadCondition &&
        sendStatus === "sent" &&
        !skipSend,
      retryWhenFailed:
        sendStatus === "failed" && reminder.composeAtFire !== true,
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
  const tick = () => {
    void fireDueReminders().catch((error) => {
      console.error(
        "Reminder tick failed",
        error instanceof Error ? error.message : "unknown",
      );
    });
  };
  tick();
  setInterval(tick, 10_000);
}
