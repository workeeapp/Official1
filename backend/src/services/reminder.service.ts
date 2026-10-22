import type { LlmReminderAction, PublicEmployee } from "@workee/shared";
import {
  addJerusalemDays,
  isGuestEmployee,
  addReminderInterval,
  anchorRecurrence,
  applyRecurrenceException,
  baseRecurrenceOccurrence,
  firstOccurrence,
  formatJerusalemDateTime as formatJerusalemWallTime,
  formatRecurrenceExceptionsHe,
  formatRecurrenceHe,
  formatReminderIntervalHe,
  isSubHourlyRecurrence,
  MIN_REPEAT_INTERVAL_MINUTES,
  jerusalemParts,
  jerusalemWallTimeToDate,
  legacyRepeatFor,
  listOccurrences,
  nextOccurrence,
  nextWeekdayFireAt,
  parseRecurrence,
  parseStoredRepeat,
  pruneRecurrenceExceptions,
  recurrenceFromInterval,
  serializeRecurrence,
  serializeReminderRepeat,
  withRecurrenceException,
  withinUntil,
  type Recurrence,
  type RecurrenceException,
  type ReminderInterval,
} from "@workee/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { isMissingTableError } from "../utils/errors.js";
import { looksLikePhone, normalizePhoneDigits, phonesMatch } from "../utils/phone.js";
import { matchContact, type SpeakerContact } from "./contact.service.js";
import { recordAuditEvent } from "./audit.service.js";
import { applyAttachmentLinks } from "./attachment.service.js";
import { applyClockRuleToTask } from "./list-recurrence.js";
import { nextCandleLighting } from "./jewish.js";
import { scheduleSoon } from "./reminder-fire.js";
import { seedWatchBaseline } from "./watch-baseline.js";

export function formatJerusalemDateTime(value: Date): string {
  return formatJerusalemWallTime(value);
}

export interface ReminderSnapshotRow {
  reminder_id: string;
  item: string;
  list_type: string;
  fire_at: string;
  repeat: string;
  ping: string[];
  ping_ids: string[];
  /** Who the clock is about (display names) — e.g. birthday of עמית. */
  about?: string[];
  about_ids?: string[];
  owner: string;
  text: string;
  /** Final WhatsApp body from the last compose-at-fire (empty when fixed copy). */
  last_composed_text: string;
  /**
   * Body that was / will be sent: last_composed_text when present, else text.
   * Use this when answering what we sent.
   */
  sent_text: string;
  compose_at_fire: boolean;
  compose_source: string;
  /** Git digest content window in hours (0 = since-last-report for recurring). */
  compose_lookback_hours: number;
  /** Place/symbols/child for compose_source weather|market|mashov. */
  compose_place?: string;
  /** Conditional watch gate (null when unconditional). */
  compose_condition?: unknown;
  /** One-shot watch: done after first successful condition send. */
  watch_once?: boolean;
  /** Plugin aspects at fire (mashov/weather/market). */
  compose_aspects?: string[];
  status: string;
  send_status: "pending" | "sent" | "failed";
  sent: boolean;
  sent_at: string | null;
  /** When status changed to done/cancelled (Jerusalem). */
  changed_at?: string | null;
  /** Repeating clocks: the rule in product Hebrew. */
  recurrence_text?: string;
  /** Repeating clocks: upcoming fires, "YYYY-MM-DD HH:mm" (Jerusalem). */
  next_occurrences?: string[];
  /** Repeating clocks with a count: fires left. */
  remaining_times?: number;
  /** Repeating clocks: one-off changes still ahead («23.10 בוטל» / «23.10 ב־11:00»). */
  exceptions?: string[];
}

export type ReminderSkipReason =
  | "no_time"
  | "db"
  | "no_phone"
  | "too_frequent"
  | "no_place"
  | "anchor_failed";

export const SUB_HOURLY_REFUSAL =
  "אי אפשר לקבוע חזרה כל פחות מ־5 דקות או בשניות. הכי תכוף שאפשר הוא כל 5 דקות.";

/** A new / changed clock that repeats too often (refused). */
export function reminderRepeatsSubHourly(
  reminder: Pick<
    LlmReminderAction,
    "action" | "recurrence" | "everyUnit" | "everyCount" | "composeCondition"
  >,
): boolean {
  if (reminder.action === "remove") {
    return false;
  }
  // Google Routes bus_eta watches may poll every ≥1 minute.
  const busEta = reminder.composeCondition?.type === "bus_eta";
  if (busEta) {
    if (reminder.recurrence) {
      if (
        reminder.recurrence.freq === "interval" &&
        reminder.recurrence.unit === "seconds"
      ) {
        return true;
      }
      if (
        reminder.recurrence.freq === "interval" &&
        reminder.recurrence.unit === "minutes"
      ) {
        return (reminder.recurrence.interval ?? 0) < 1;
      }
      return isSubHourlyRecurrence(reminder.recurrence);
    }
    if (reminder.everyUnit === "seconds") {
      return true;
    }
    if (reminder.everyUnit === "minutes") {
      return (reminder.everyCount ?? 0) < 1;
    }
    return false;
  }
  if (reminder.recurrence) {
    return isSubHourlyRecurrence(reminder.recurrence);
  }
  if (reminder.everyUnit === "seconds") {
    return true;
  }
  if (reminder.everyUnit === "minutes") {
    return (reminder.everyCount ?? 0) < MIN_REPEAT_INTERVAL_MINUTES;
  }
  return false;
}

function intervalOf(reminder: LlmReminderAction): ReminderInterval | null {
  if (reminder.weekdays && reminder.weekdays.length > 0) {
    return { count: 1, unit: "weekdays", weekdays: reminder.weekdays };
  }
  if (reminder.everyCount && reminder.everyUnit && reminder.everyUnit !== "weekdays") {
    return {
      count: reminder.everyCount,
      unit: reminder.everyUnit,
    };
  }
  return null;
}

/** Exact itemKey match only (tests / display). Never used to mutate on add. */
export function findMatchingActiveReminder<
  T extends { itemKey: string; itemLabel: string },
>(rows: T[], item: string): T | undefined {
  const key = itemKey(item);
  if (!key) {
    return undefined;
  }
  return rows.find((row) => row.itemKey === key);
}

/** Text-only / clock update with no new time → keep the saved fireAt, ping, and repeat. */
export function canReuseExistingReminderClock(
  reminder: Pick<
    LlmReminderAction,
    | "action"
    | "text"
    | "time"
    | "inSeconds"
    | "everyCount"
    | "everyUnit"
    | "weekdays"
    | "recurrence"
  >,
  hasExisting: boolean,
): boolean {
  if (!hasExisting) {
    return false;
  }
  if (reminder.action === "update") {
    return true;
  }
  const hasNewClock =
    Boolean(reminder.time.trim()) ||
    Boolean(reminder.inSeconds && reminder.inSeconds > 0) ||
    Boolean(reminder.everyCount && reminder.everyUnit) ||
    Boolean(reminder.weekdays && reminder.weekdays.length > 0) ||
    Boolean(reminder.recurrence);
  return Boolean(reminder.text.trim()) && !hasNewClock;
}

export function resolveReminderFireAt(
  dateText: string,
  timeText: string,
  now = new Date(),
  inSeconds?: number | null,
  interval?: ReminderInterval | null,
): Date | null {
  if (inSeconds && inSeconds > 0) {
    return new Date(now.getTime() + inSeconds * 1000);
  }

  const localNow = jerusalemParts(now);
  const relative = dateText.trim().toLowerCase();

  let year = localNow.year;
  let month = localNow.month;
  let day = localNow.day;
  if (relative === "") {
    if (!timeText.trim()) {
      return interval ? addReminderInterval(now, interval) : null;
    }
  } else {
    const iso = relative.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
      year = Number(iso[1]);
      month = Number(iso[2]);
      day = Number(iso[3]);
    }
  }

  const time = parseClock(timeText);
  if (!time) {
    return interval ? addReminderInterval(now, interval) : null;
  }

  let fireAt = jerusalemWallTimeToDate(year, month, day, time.hour, time.minute);
  while (fireAt.getTime() <= now.getTime()) {
    fireAt = addJerusalemDays(fireAt, 1);
  }
  if (interval?.weekdays?.length) {
    fireAt = nextWeekdayFireAt(fireAt, interval.weekdays, false);
    while (fireAt.getTime() <= now.getTime()) {
      fireAt = nextWeekdayFireAt(fireAt, interval.weekdays, true);
    }
  }
  return fireAt;
}

/**
 * First fire of a structured rule. Fields the rule leaves out (weekday, day of month,
 * month, time) come from the ACTION's date/time, then from the first fire itself.
 * Daily/weekly/monthly/yearly need a time; interval rules behave like every_count.
 */
export function resolveRecurringFireAt(
  rec: Recurrence,
  dateText: string,
  timeText: string,
  now = new Date(),
  inSeconds?: number | null,
): { fireAt: Date; recurrence: Recurrence } | null {
  if (rec.freq === "interval") {
    const fireAt = resolveReminderFireAt(dateText, timeText || rec.time || "", now, inSeconds, {
      count: rec.interval,
      unit: rec.unit ?? "hours",
    });
    return fireAt && withinUntil(rec, fireAt) ? { fireAt, recurrence: rec } : null;
  }
  const clock = rec.time ? parseClock(rec.time) : parseClock(timeText);
  if (!clock) {
    return null;
  }
  let shaped: Recurrence = {
    ...rec,
    time: `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`,
  };
  let from = now;
  let inclusive = false;
  const iso = dateText.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const dayStart = jerusalemWallTimeToDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), 0, 0);
    shaped = anchorRecurrence(shaped, dayStart);
    if (dayStart.getTime() > now.getTime()) {
      from = dayStart;
      inclusive = true;
    }
  }
  const fireAt = firstOccurrence(shaped, from, inclusive);
  if (!withinUntil(shaped, fireAt)) {
    return null;
  }
  return { fireAt, recurrence: anchorRecurrence(shaped, fireAt) };
}

const SNAPSHOT_OCCURRENCES = 6;
const SNAPSHOT_HORIZON_DAYS = 62;
/** Cap when expanding a repeating clock for an explicit dump date window. */
const RANGE_OCCURRENCE_LIMIT = 400;

/** The rule a stored clock follows: `recurrence` JSON, else the legacy `repeat` token. */
export function storedReminderRule(row: {
  fireAt: Date;
  repeat: string;
  recurrence?: unknown;
}): Recurrence | null {
  const rule = parseRecurrence(row.recurrence);
  if (rule) {
    return rule;
  }
  const interval = typeof row.repeat === "string" ? parseStoredRepeat(row.repeat) : null;
  return interval && row.fireAt instanceof Date
    ? anchorRecurrence(recurrenceFromInterval(interval), row.fireAt)
    : null;
}

export type ReminderOccurrenceRange = {
  from?: string | null;
  to?: string | null;
};

function reminderDay(value: Date): string {
  return formatJerusalemDateTime(value).slice(0, 10);
}

/**
 * Repeating-clock fires whose calendar day lands in [from, to]. Walks forward from
 * the clock's next fireAt so every-N parity stays correct beyond the short snapshot horizon.
 */
export function reminderOccurrencesInRange(
  row: {
    fireAt: Date;
    repeat: string;
    recurrence?: unknown;
    occurrencesFired?: number;
  },
  fromYmd: string,
  toYmd: string,
): string[] {
  const rule = storedReminderRule(row);
  if (!rule) {
    return [];
  }
  const from = fromYmd.trim().slice(0, 10);
  const to = toYmd.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    return [];
  }
  const fired = typeof row.occurrencesFired === "number" ? row.occurrencesFired : 0;
  const horizon = jerusalemWallTimeToDate(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)),
    Number(to.slice(8, 10)),
    23,
    59,
  );
  let first = row.fireAt;
  for (
    let guard = 0;
    reminderDay(first) < from && first.getTime() < horizon.getTime() && guard < 10000;
    guard += 1
  ) {
    first = nextOccurrence(rule, first);
  }
  if (reminderDay(first) > to || !withinUntil(rule, first)) {
    return [];
  }
  return listOccurrences(rule, {
    first,
    limit: RANGE_OCCURRENCE_LIMIT,
    horizon,
    firedCount: fired,
  })
    .filter((value) => {
      const day = reminderDay(value);
      return day >= from && day <= to;
    })
    .map((value) => formatJerusalemDateTime(value));
}

/**
 * Facts for a repeating clock: product-Hebrew rule text and the next concrete fires
 * (bounded by until/count), so the model answers per date without weekday math.
 * When `occurrenceRange` is set (day-agenda dump), expand through that window instead
 * of the short every-turn horizon.
 */
export function reminderRuleSnapshot(
  row: {
    fireAt: Date;
    repeat: string;
    recurrence?: unknown;
    occurrencesFired?: number;
  },
  occurrenceRange?: ReminderOccurrenceRange | null,
): {
  recurrence_text?: string;
  next_occurrences?: string[];
  remaining_times?: number;
} {
  const rule = storedReminderRule(row);
  if (!rule) {
    return {};
  }
  const fired = typeof row.occurrencesFired === "number" ? row.occurrencesFired : 0;
  const from = occurrenceRange?.from?.trim().slice(0, 10) || "";
  const to = occurrenceRange?.to?.trim().slice(0, 10) || "";
  const occurrences =
    from || to
      ? reminderOccurrencesInRange(row, from || to, to || from)
      : listOccurrences(rule, {
          first: row.fireAt,
          limit: SNAPSHOT_OCCURRENCES,
          horizon: addJerusalemDays(row.fireAt, SNAPSHOT_HORIZON_DAYS),
          firedCount: fired,
        }).map((value) => formatJerusalemDateTime(value));
  const exceptions = formatRecurrenceExceptionsHe(
    pruneRecurrenceExceptions(rule, formatJerusalemDateTime(new Date()).slice(0, 10)),
  );
  return {
    recurrence_text: formatRecurrenceHe(rule),
    next_occurrences: occurrences,
    ...(rule.count ? { remaining_times: Math.max(0, rule.count - fired) } : {}),
    ...(exceptions.length ? { exceptions } : {}),
  };
}

function parseClock(value: string): { hour: number; minute: number } | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (hour > 23 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function itemKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 255);
}

export function formatJerusalemClock(value: Date): string {
  return formatJerusalemDateTime(value).slice(-5);
}

export function applyTimeToTaskLabel(label: string, time: string): string {
  const trimmed = label.trim();
  if (!trimmed) {
    return `ב־${time}`;
  }
  if (/\d{1,2}:\d{2}/.test(trimmed)) {
    return trimmed.replace(/\d{1,2}:\d{2}/, time);
  }
  return `${trimmed} ב־${time}`;
}

/** Normalize HH:mm for appointment≠ping compares (pad hour). */
function normalizeTaskClockHm(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) {
    return raw.trim();
  }
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

/**
 * Keep worker להזכיר chore time in sync with the linked clock — except when
 * the item already has a distinct שעה לביצוע (appointment ≠ ping). Then leave
 * תאריך/שעה לביצוע and the title clock alone; only mirror recurrence meta.
 */
export async function syncLinkedWorkerTaskClock(input: {
  reminderId: string;
  workerItemId?: string | null;
  fireAt: Date;
  /** The clock's rule; copied onto the worker task when present. */
  rule?: Recurrence | null;
}): Promise<void> {
  if (!prisma.employeeListItem?.findUnique || !prisma.employeeListItem?.update) {
    return;
  }
  try {
    const item = input.workerItemId
      ? await prisma.employeeListItem.findUnique({
          where: { id: input.workerItemId },
        })
      : await prisma.employeeListItem.findUnique({
          where: { reminderId: input.reminderId },
        });
    if (!item || item.deletedAt) {
      return;
    }
    const pingTime = formatJerusalemClock(input.fireAt);
    const data =
      item.data && typeof item.data === "object" && !Array.isArray(item.data)
        ? { ...(item.data as Record<string, unknown>) }
        : {};
    const existingChore = normalizeTaskClockHm(data["שעה לביצוע"]);
    const preserveChore =
      Boolean(existingChore) && existingChore !== normalizeTaskClockHm(pingTime);
    const currentName =
      typeof data["שם מטלה"] === "string" && data["שם מטלה"].trim()
        ? data["שם מטלה"].trim()
        : item.itemKey;
    const nextName = preserveChore
      ? currentName
      : applyTimeToTaskLabel(currentName, pingTime);
    const ruled =
      input.rule === undefined
        ? data
        : applyClockRuleToTask(data, input.rule, new Date(), input.fireAt);
    await prisma.employeeListItem.update({
      where: { id: item.id },
      data: {
        data: {
          ...ruled,
          "שם מטלה": nextName,
          ...(preserveChore ? {} : { "שעה לביצוע": pingTime }),
        } as Prisma.InputJsonValue,
        ...(itemKey(nextName) !== item.itemKey
          ? { itemKey: itemKey(nextName) }
          : {}),
      },
    });
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records the humans a worker task's clock pings in its visible_to, so each
 * recipient is involved in it (sees it in WORKER_SAVED_DATA and may act on it).
 * The task stays the worker's own — never scope=shared, which would put it into
 * people's EMPLOYEE_SAVED_DATA. Phone/contact destinations and guests are skipped.
 */
export async function shareWorkerTaskWithPingRecipients(input: {
  workerItemId?: string | null;
  ownerId?: string | null;
  pingIds: unknown;
}): Promise<void> {
  const workerItemId = input.workerItemId?.trim();
  if (
    !workerItemId ||
    !prisma.employee?.findMany ||
    !prisma.employeeListItem?.findUnique ||
    !prisma.employeeListItem?.update
  ) {
    return;
  }
  const pingIds = Array.isArray(input.pingIds)
    ? input.pingIds
        .map(String)
        .filter((id) => UUID_PATTERN.test(id) && id !== input.ownerId)
    : [];
  if (pingIds.length === 0) {
    return;
  }
  try {
    const recipients = (
      await prisma.employee.findMany({
        where: { id: { in: pingIds }, kind: "human" },
        select: { id: true, name: true, nickname: true },
      })
    ).filter((employee) => !isGuestEmployee({ ...employee, kind: "human" }));
    if (recipients.length === 0) {
      return;
    }
    const item = await prisma.employeeListItem.findUnique({
      where: { id: workerItemId },
    });
    if (!item || item.deletedAt) {
      return;
    }
    const current = Array.isArray(item.visibleTo)
      ? item.visibleTo.filter((id): id is string => typeof id === "string" && Boolean(id))
      : [];
    const visibleTo = [
      ...new Set(
        [
          item.addedById,
          input.ownerId,
          ...current,
          ...recipients.map((employee) => employee.id),
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    if (
      visibleTo.length === current.length &&
      visibleTo.every((id) => current.includes(id))
    ) {
      return;
    }
    await prisma.employeeListItem.update({
      where: { id: item.id },
      data: { visibleTo },
    });
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
  }
}

export function reminderLabelsMatch(stored: string, wanted: string): boolean {
  const left = itemKey(stored);
  const right = itemKey(wanted);
  if (!left || !right || right.length < 2) {
    return left === right;
  }
  return left === right || left.includes(right) || right.includes(left);
}

export interface WorkerTaskRef {
  id: string;
  itemKey: string;
}

export function pairWorkerItemsToReminders(
  reminders: Array<{ id: string; itemKey: string; itemLabel: string }>,
  workerItems: WorkerTaskRef[],
): Array<{ reminderId: string; workerItemId: string }> {
  if (reminders.length === 0 || workerItems.length === 0) {
    return [];
  }
  if (reminders.length === 1 && workerItems.length === 1) {
    return [
      { reminderId: reminders[0].id, workerItemId: workerItems[0].id },
    ];
  }
  // Multi: exact itemKey equality only — never fuzzy label contains.
  const used = new Set<string>();
  const pairs: Array<{ reminderId: string; workerItemId: string }> = [];
  for (const reminder of reminders) {
    const want = itemKey(reminder.itemKey);
    const match = workerItems.find(
      (item) => !used.has(item.id) && itemKey(item.itemKey) === want,
    );
    if (!match) {
      continue;
    }
    used.add(match.id);
    pairs.push({ reminderId: reminder.id, workerItemId: match.id });
  }
  return pairs;
}

export async function linkRemindersToWorkerTasks(
  reminders: Array<{ id: string; itemKey: string; itemLabel: string }>,
  workerItems: WorkerTaskRef[],
): Promise<void> {
  if (!prisma.employeeListItem?.update || !prisma.reminder?.update) {
    return;
  }
  for (const pair of pairWorkerItemsToReminders(reminders, workerItems)) {
    try {
      const task = await prisma.employeeListItem.update({
        where: { id: pair.workerItemId },
        data: { reminderId: pair.reminderId },
      });
      const clock = await prisma.reminder.update({
        where: { id: pair.reminderId },
        data: { workerItemId: pair.workerItemId },
      });
      const rule = clock && task ? storedReminderRule(clock) : null;
      if (rule && task?.data && typeof task.data === "object") {
        await prisma.employeeListItem.update({
          where: { id: pair.workerItemId },
          data: {
            data: applyClockRuleToTask(
              task.data as Record<string, unknown>,
              rule,
              new Date(),
              clock.fireAt instanceof Date ? clock.fireAt : undefined,
            ) as Prisma.InputJsonValue,
          },
        });
      }
      if (clock) {
        await shareWorkerTaskWithPingRecipients({
          workerItemId: pair.workerItemId,
          ownerId: clock.ownerId,
          pingIds: clock.pingIds,
        });
      }
    } catch (error) {
      if (!isMissingTableError(error)) {
        throw error;
      }
    }
  }
}

export interface LinkedItemRef {
  id: string;
  itemKey: string;
  itemLabel: string;
}

/**
 * Soft-link candidates: same-turn mutations first, then live rows by id.
 * Exact itemKey pairing happens later — never fuzzy label.
 */
export function unionSoftLinkItemCandidates(
  sameTurn: LinkedItemRef[],
  live: LinkedItemRef[],
): LinkedItemRef[] {
  const byId = new Map<string, LinkedItemRef>();
  for (const row of live) {
    byId.set(row.id, row);
  }
  for (const row of sameTurn) {
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

/**
 * Same-turn human list rows eligible for soft-linking new clocks.
 * Includes add and update (exact itemKey later). Never live inventory.
 */
export function itemsFromListMutationsForSoftLink(
  rows: Array<{
    action: string;
    listShell?: boolean;
    itemId?: string | null;
    itemKey?: string;
    itemLabel?: string;
    employeeId: string;
  }>,
  humanIds: ReadonlySet<string> | Iterable<string>,
): LinkedItemRef[] {
  const humans =
    humanIds instanceof Set ? humanIds : new Set(humanIds);
  return rows
    .filter(
      (row) =>
        (row.action === "add" || row.action === "update") &&
        !row.listShell &&
        Boolean(row.itemId) &&
        humans.has(row.employeeId),
    )
    .map((row) => ({
      id: row.itemId as string,
      itemKey: row.itemKey ?? "",
      itemLabel: row.itemLabel ?? "",
    }));
}

/**
 * Same-turn speaker/shared items ↔ clocks from that turn.
 * Exact itemKey equality only (no fuzzy label). No lone-pair shortcut — a turn
 * can add an unrelated item next to a reminder.
 */
export function pairLinkedItemsToReminders(
  reminders: Array<{ id: string; itemKey: string; itemLabel: string }>,
  items: LinkedItemRef[],
): Array<{ reminderId: string; itemId: string }> {
  const pairs: Array<{ reminderId: string; itemId: string }> = [];
  const usedClocks = new Set<string>();
  for (const item of items) {
    const want = itemKey(item.itemKey) || itemKey(item.itemLabel);
    if (!want) {
      continue;
    }
    const match = reminders.find(
      (reminder) =>
        !usedClocks.has(reminder.id) && itemKey(reminder.itemKey) === want,
    );
    if (match) {
      usedClocks.add(match.id);
      pairs.push({ reminderId: match.id, itemId: item.id });
    }
  }
  return pairs;
}

export async function linkRemindersToItems(
  reminders: Array<{ id: string; itemKey: string; itemLabel: string }>,
  items: LinkedItemRef[],
): Promise<void> {
  if (reminders.length === 0 || items.length === 0 || !prisma.employeeListItem?.update) {
    return;
  }
  for (const pair of pairLinkedItemsToReminders(reminders, items)) {
    try {
      await prisma.employeeListItem.update({
        where: { id: pair.itemId },
        data: { linkedReminderId: pair.reminderId },
      });
    } catch (error) {
      if (!isMissingTableError(error) && !isMissingRecord(error)) {
        throw error;
      }
    }
  }
}

/**
 * Live human shopping/tasks for soft-linking clocks after reminders.save
 * (includes rows that already existed — not only same-turn adds).
 */
export async function listLiveHumanItemsForReminderLink(input: {
  userId: string;
  humanIds: string[];
}): Promise<LinkedItemRef[]> {
  if (
    input.humanIds.length === 0 ||
    !prisma.employeeListItem?.findMany
  ) {
    return [];
  }
  try {
    const rows = await prisma.employeeListItem.findMany({
      where: {
        deletedAt: null,
        list: {
          deletedAt: null,
          listType: { in: ["shopping", "tasks"] },
          employeeId: { in: input.humanIds },
          employee: { userId: input.userId, kind: "human" },
        },
      },
      select: { id: true, itemKey: true, data: true },
    });
    return rows.map((row) => {
      const data = (row.data ?? {}) as Record<string, unknown>;
      const itemLabel =
        (typeof data["שם מטלה"] === "string" && data["שם מטלה"].trim()) ||
        (typeof data["שם פריט"] === "string" && data["שם פריט"].trim()) ||
        (typeof data.name === "string" && data.name.trim()) ||
        row.itemKey;
      return { id: row.id, itemKey: row.itemKey, itemLabel };
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      return [];
    }
    throw error;
  }
}

function isMissingRecord(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025"
  );
}

export async function removeReminderAndLinkedWorkerTask(match: {
  id: string;
  workerItemId?: string | null;
  userId?: string;
  actorEmployeeId?: string | null;
  label?: string;
}): Promise<
  Array<{
    id: string;
    itemKey: string;
    itemLabel: string;
    employeeId: string;
  }>
> {
  const workerItemId = match.workerItemId ?? null;
  const removedWorkerTasks: Array<{
    id: string;
    itemKey: string;
    itemLabel: string;
    employeeId: string;
  }> = [];
  if (prisma.employeeListItem?.findMany && prisma.employeeListItem?.updateMany) {
    const doomed = await prisma.employeeListItem.findMany({
      where: {
        deletedAt: null,
        OR: [
          { reminderId: match.id },
          ...(workerItemId ? [{ id: workerItemId }] : []),
        ],
      },
      include: { list: { select: { employeeId: true, listType: true } } },
    });
    for (const row of doomed) {
      const data = (row.data ?? {}) as Record<string, unknown>;
      const label =
        (typeof data["שם מטלה"] === "string" && data["שם מטלה"].trim()) ||
        (typeof data.name === "string" && data.name.trim()) ||
        row.itemKey;
      removedWorkerTasks.push({
        id: row.id,
        itemKey: row.itemKey,
        itemLabel: label,
        employeeId: row.list.employeeId,
      });
    }
    if (doomed.length > 0) {
      await prisma.employeeListItem.updateMany({
        where: { id: { in: doomed.map((row) => row.id) } },
        data: { deletedAt: new Date(), reminderId: null },
      });
    }
  }
  if (prisma.employeeListItem?.updateMany) {
    // Speaker/shared soft links must not keep pointing at a cancelled clock.
    await prisma.employeeListItem.updateMany({
      where: { linkedReminderId: match.id, deletedAt: null },
      data: { linkedReminderId: null },
    });
  }
  if (!prisma.reminder?.update) {
    return removedWorkerTasks;
  }
  try {
    await prisma.reminder.update({
      where: { id: match.id },
      data: {
        status: "cancelled",
        workerItemId: null,
      },
    });
    if (match.userId) {
      await recordAuditEvent({
        userId: match.userId,
        actorEmployeeId: match.actorEmployeeId,
        action: "reminder_cancel",
        entityType: "Reminder",
        entityId: match.id,
        summary: `cancel reminder: ${match.label ?? match.id}`,
      });
    }
  } catch (error) {
    if (isMissingTableError(error) || isMissingRecord(error)) {
      return removedWorkerTasks;
    }
    throw error;
  }
  return removedWorkerTasks;
}

export async function cancelReminderLinkedToWorkerItem(
  workerItemId: string,
): Promise<{ reminderId: string; label: string } | null> {
  if (!prisma.reminder?.findFirst && !prisma.employeeListItem?.findUnique) {
    return null;
  }
  try {
    const item = prisma.employeeListItem?.findUnique
      ? await prisma.employeeListItem.findUnique({
          where: { id: workerItemId },
        })
      : null;
    const reminderId =
      item && "reminderId" in item && typeof item.reminderId === "string"
        ? item.reminderId
        : null;
    const softLinkedId =
      item &&
      "linkedReminderId" in item &&
      typeof item.linkedReminderId === "string"
        ? item.linkedReminderId
        : null;
    const idCandidates = [
      ...new Set(
        [reminderId, softLinkedId].filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        ),
      ),
    ];
    // Prefer an active clock; fall back to any matching row.
    const clock = prisma.reminder?.findFirst
      ? ((await prisma.reminder.findFirst({
          where: {
            status: "active",
            OR: [
              { workerItemId },
              ...(idCandidates.length > 0
                ? [{ id: { in: idCandidates } }]
                : []),
            ],
          },
        })) ??
        (await prisma.reminder.findFirst({
          where: {
            OR: [
              { workerItemId },
              ...(idCandidates.length > 0
                ? [{ id: { in: idCandidates } }]
                : []),
            ],
          },
        })))
      : null;
    const id = clock?.id ?? reminderId ?? softLinkedId;
    if (!id) {
      return null;
    }
    const linkedWorkerId =
      clock && "workerItemId" in clock && typeof clock.workerItemId === "string"
        ? clock.workerItemId
        : workerItemId;
    const label =
      (clock &&
        "itemLabel" in clock &&
        typeof clock.itemLabel === "string" &&
        clock.itemLabel.trim()) ||
      id;
    await removeReminderAndLinkedWorkerTask({
      id,
      workerItemId: linkedWorkerId,
      label,
    });
    return { reminderId: id, label };
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
    return null;
  }
}

/**
 * @deprecated No-op. List remove must cancel clocks only via FK
 * (`cancelReminderLinkedToWorkerItem`). Never match by key/label.
 */
export async function cancelActiveRemindersMatchingWork(_input: {
  userId: string;
  itemKey: string;
  itemLabel?: string;
  actorEmployeeId?: string | null;
}): Promise<{
  cancelledReminders: string[];
  cancelledReminderIds: string[];
  removedWorkerTasks: Array<{
    id: string;
    itemKey: string;
    itemLabel: string;
    employeeId: string;
  }>;
}> {
  return {
    cancelledReminders: [],
    cancelledReminderIds: [],
    removedWorkerTasks: [],
  };
}

/**
 * Everyone a clock involves: its owner, the people it pings, and whoever its
 * linked worker task involves (who asked, visible_to). Read before the change.
 */
async function clockInvolvedIds(clock: {
  ownerId: string;
  pingIds: unknown;
  workerItemId?: string | null;
}): Promise<string[]> {
  const ids = [
    clock.ownerId,
    ...(Array.isArray(clock.pingIds) ? clock.pingIds.map(String) : []),
  ];
  const workerItemId = clock.workerItemId?.trim();
  if (workerItemId && prisma.employeeListItem?.findUnique) {
    const task = await prisma.employeeListItem.findUnique({
      where: { id: workerItemId },
    });
    if (task) {
      ids.push(
        task.addedById ?? "",
        ...(Array.isArray(task.visibleTo) ? task.visibleTo.map(String) : []),
      );
    }
  }
  return [...new Set(ids.filter(Boolean))];
}

export type CascadedWorkerTask = {
  id: string;
  itemKey: string;
  itemLabel: string;
  employeeId: string;
};

async function cancelActiveReminderById(
  userId: string,
  reminderId: string,
): Promise<{
  label: string;
  fireAt: Date;
  involvedIds: string[];
  removedWorkerTasks: CascadedWorkerTask[];
} | null> {
  const match = await prisma.reminder.findFirst({
    where: { id: reminderId, userId, status: "active" },
  });
  if (!match) {
    return null;
  }
  const workerItemId =
    "workerItemId" in match && typeof match.workerItemId === "string"
      ? match.workerItemId
      : null;
  const involvedIds = await clockInvolvedIds({
    ownerId: match.ownerId,
    pingIds: match.pingIds,
    workerItemId,
  });
  const removedWorkerTasks = await removeReminderAndLinkedWorkerTask({
    id: match.id,
    workerItemId,
    userId,
    label: match.itemLabel,
  });
  return {
    label: match.itemLabel,
    fireAt: match.fireAt,
    involvedIds,
    removedWorkerTasks,
  };
}

/** True when `day` is one of the rule's own occurrence days, walking from the clock's next fire. */
function clockLandsOn(rule: Recurrence, nextFire: Date, day: string): boolean {
  let cursor = baseRecurrenceOccurrence(rule, nextFire);
  for (let guard = 0; formatJerusalemDateTime(cursor).slice(0, 10) < day && guard < 5000; guard += 1) {
    cursor = nextOccurrence(rule, cursor);
  }
  return formatJerusalemDateTime(cursor).slice(0, 10) === day;
}

/**
 * Cancel / move ONE occurrence of a repeating clock (the ACTION's occurrence_change).
 * The rule stays; fireAt moves when the changed day is the next fire. Refused (null)
 * without an active calendar rule, for a past day, or a day the rule does not land on.
 * fireAt null = that was the last occurrence, so the clock was cancelled.
 */
export async function applyReminderOccurrenceChange(input: {
  userId: string;
  actorEmployeeId: string;
  reminderId: string;
  change: RecurrenceException;
  now?: Date;
}): Promise<{
  id: string;
  label: string;
  itemKey: string;
  pingIds: string[];
  involvedIds: string[];
  previousFireAt: Date;
  fireAt: Date | null;
} | null> {
  const now = input.now ?? new Date();
  const row = await prisma.reminder.findFirst({
    where: { id: input.reminderId, userId: input.userId, status: "active" },
  });
  if (!row) {
    return null;
  }
  const rule = storedReminderRule(row);
  const today = formatJerusalemDateTime(now).slice(0, 10);
  if (
    !rule ||
    rule.freq === "interval" ||
    input.change.date < today ||
    !clockLandsOn(rule, row.fireAt, input.change.date)
  ) {
    return null;
  }
  const updated = withRecurrenceException(rule, input.change, today);
  // Walk from the rule slot of the pending fire so every-N cycles keep their parity.
  let fireAt: Date | null = null;
  let slot = baseRecurrenceOccurrence(rule, row.fireAt);
  for (let guard = 0; guard < 5000 && withinUntil(updated, slot); guard += 1) {
    const actual = applyRecurrenceException(updated, slot);
    if (actual && actual.getTime() > now.getTime()) {
      fireAt = actual;
      break;
    }
    slot = nextOccurrence(updated, slot);
  }
  const workerItemId =
    "workerItemId" in row && typeof row.workerItemId === "string" ? row.workerItemId : null;
  const involvedIds = await clockInvolvedIds({
    ownerId: row.ownerId,
    pingIds: row.pingIds,
    workerItemId,
  });
  const base = {
    id: row.id,
    label: row.itemLabel,
    itemKey: row.itemKey,
    pingIds: Array.isArray(row.pingIds) ? row.pingIds.map(String) : [],
    involvedIds,
    previousFireAt: row.fireAt,
  };
  if (!fireAt) {
    await removeReminderAndLinkedWorkerTask({
      id: row.id,
      workerItemId,
      userId: input.userId,
      label: row.itemLabel,
    });
    return { ...base, fireAt: null };
  }
  await prisma.reminder.update({
    where: { id: row.id },
    data: {
      fireAt,
      recurrence: serializeRecurrence(updated) as Prisma.InputJsonValue,
    },
  });
  // The worker task shows the rule's own time, not a one-off moved slot.
  await syncLinkedWorkerTaskClock({
    reminderId: row.id,
    workerItemId,
    fireAt: baseRecurrenceOccurrence(updated, fireAt),
    rule: updated,
  });
  await recordAuditEvent({
    userId: input.userId,
    actorEmployeeId: input.actorEmployeeId,
    action: "reminder_save",
    entityType: "Reminder",
    entityId: row.id,
    summary: `occurrence ${input.change.cancel ? "cancel" : `time ${input.change.time}`} ${input.change.date} reminder: ${row.itemLabel}`,
    detail: { fireAt: fireAt.toISOString() },
  });
  scheduleSoon(fireAt);
  return { ...base, fireAt };
}

/** A remove/update of an existing clock, so everyone else it involves can be told. */
export type ReminderChange = {
  action: "remove" | "update";
  label: string;
  fireAt: string;
  involvedIds: string[];
};

function displayName(employee: PublicEmployee): string {
  return employee.nickname?.trim() || employee.name;
}

function matchEmployee(
  name: string,
  employees: PublicEmployee[],
): PublicEmployee | undefined {
  const needle = name.trim().toLowerCase();
  const byName = employees.find((employee) => {
    const aliases = [
      employee.nickname,
      employee.name,
      employee.surname,
      `${employee.name} ${employee.surname}`.trim(),
    ]
      .filter((value): value is string => Boolean(value && value.trim()))
      .map((value) => value.trim().toLowerCase());
    return aliases.includes(needle);
  });
  if (byName) {
    return byName;
  }
  if (!looksLikePhone(name)) {
    return undefined;
  }
  return employees.find(
    (employee) => employee.phone && phonesMatch(employee.phone, name),
  );
}

/**
 * Resolve reminders[].about names → employee ids (Known humans only).
 * No phone fallback, no default to speaker — empty about stays empty.
 */
export function resolveReminderAboutIds(
  reminder: Pick<LlmReminderAction, "about">,
  employees: PublicEmployee[],
): string[] {
  const about = Array.isArray(reminder.about) ? reminder.about : [];
  const ids: string[] = [];
  for (const raw of about) {
    const employee = matchEmployee(String(raw), employees);
    if (employee && !ids.includes(employee.id)) {
      ids.push(employee.id);
    }
  }
  return ids;
}

export function resolveReminderPingDestinations(
  reminder: Pick<LlmReminderAction, "ping"> & {
    targets?: string[];
    item?: string;
    text?: string;
  },
  employees: PublicEmployee[],
  fallbackId: string,
  contacts: SpeakerContact[] = [],
): string[] {
  const named = [
    ...reminder.ping,
    ...("targets" in reminder && Array.isArray(reminder.targets)
      ? reminder.targets
      : []),
  ];

  const phones: string[] = [];
  const people: string[] = [];
  const addPhone = (value: string) => {
    if (!phones.includes(value)) {
      phones.push(value);
    }
  };
  const addPerson = (value: string) => {
    if (!people.includes(value)) {
      people.push(value);
    }
  };

  for (const raw of named) {
    const phone = destPhoneToken(raw);
    if (phone) {
      addPhone(phone);
      continue;
    }
    const employee = matchEmployee(raw, employees);
    if (employee) {
      addPerson(employee.id);
      continue;
    }
    const contact = matchContact(raw, contacts);
    if (contact) {
      addPhone(normalizePhoneDigits(contact.phone));
    }
  }

  if (phones.length > 0) {
    return phones;
  }
  if (people.length > 0) {
    return people;
  }
  return named.length > 0 ? [] : [fallbackId];
}

export function formatPingLabel(
  value: string,
  employees: PublicEmployee[],
): string {
  const employee = employees.find((row) => row.id === value);
  if (employee) {
    return employee.nickname?.trim() || employee.name;
  }
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : value.slice(0, 8);
}

function destPhoneToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (!looksLikePhone(trimmed) || /[A-Za-z\u0590-\u05FF]/.test(trimmed)) {
    return null;
  }
  return normalizePhoneDigits(trimmed);
}

export function unknownDestNames(
  reminder: Pick<LlmReminderAction, "ping"> & { targets?: string[] },
  employees: PublicEmployee[],
  contacts: SpeakerContact[] = [],
): string[] {
  const named = [
    ...reminder.ping,
    ...(reminder.targets ?? []),
  ];
  const unknown: string[] = [];
  for (const raw of named) {
    if (
      destPhoneToken(raw) ||
      matchEmployee(raw, employees) ||
      matchContact(raw, contacts)
    ) {
      continue;
    }
    if (raw.trim()) {
      unknown.push(raw.trim());
    }
  }
  return unknown;
}

function ownerIdFor(
  reminder: LlmReminderAction,
  employees: PublicEmployee[],
  fallbackId: string,
): string {
  const named = reminder.targets
    .map((name) => matchEmployee(name, employees)?.id)
    .find(Boolean);
  return named ?? fallbackId;
}

/** An update that only (de)attaches files — the clock itself stays as it is. */
export function isAttachmentOnlyReminderUpdate(reminder: LlmReminderAction): boolean {
  return (
    Boolean(reminder.attachmentIds?.length || reminder.detachAttachmentIds?.length) &&
    !reminder.time.trim() &&
    !reminder.date.trim() &&
    !(typeof reminder.inSeconds === "number" && reminder.inSeconds > 0) &&
    reminder.recurrence === undefined &&
    !reminder.text.trim() &&
    !reminder.everyCount &&
    !(reminder.weekdays && reminder.weekdays.length > 0) &&
    reminder.ping.every((part) => !String(part).trim())
  );
}

export async function applyReminders(input: {
  userId: string;
  actor: PublicEmployee;
  employees: PublicEmployee[];
  reminders: LlmReminderAction[];
  contacts?: SpeakerContact[];
  /** Reminder ids already cancelled this turn (e.g. list-remove cascade). */
  alreadyCancelledReminderIds?: Iterable<string>;
}): Promise<{
  removed: string[];
  missed: string[];
  /** Worker tasks soft-deleted when a clock cascade ran this turn. */
  removedWorkerTasks: CascadedWorkerTask[];
  saved: Array<{
    id: string;
    item: string;
    itemKey: string;
    itemLabel: string;
    fireAt: string;
    ping?: string;
    sameTimeOthers?: string[];
    composeAtFire?: boolean;
  }>;
  skipped: Array<{
    item: string;
    reason: ReminderSkipReason;
    dest?: string;
  }>;
  changes: ReminderChange[];
}> {
  const contacts = input.contacts ?? [];
  const alreadyCancelled = new Set(
    [...(input.alreadyCancelledReminderIds ?? [])]
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const removed: string[] = [];
  const missed: string[] = [];
  const removedWorkerTasks: CascadedWorkerTask[] = [];
  const seenWorkerTaskIds = new Set<string>();
  const pushCascadedTasks = (tasks: CascadedWorkerTask[]) => {
    for (const task of tasks) {
      if (seenWorkerTaskIds.has(task.id)) {
        continue;
      }
      seenWorkerTaskIds.add(task.id);
      removedWorkerTasks.push(task);
    }
  };
  const changes: ReminderChange[] = [];
  const saved: Array<{
    id: string;
    item: string;
    itemKey: string;
    itemLabel: string;
    fireAt: string;
    ping?: string;
    sameTimeOthers?: string[];
    composeAtFire?: boolean;
  }> = [];
  const skipped: Array<{
    item: string;
    reason: ReminderSkipReason;
    dest?: string;
  }> = [];
  if (!prisma.reminder) {
    for (const reminder of input.reminders.filter((row) => row.action !== "remove")) {
      skipped.push({ item: reminder.item.trim(), reason: "db" });
    }
    return { removed, missed, removedWorkerTasks, saved, skipped, changes };
  }
  for (const reminder of input.reminders) {
    if (reminder.action === "remove") {
      const reminderId = reminder.reminderId.trim();
      if (!reminderId) {
        if (reminder.item.trim()) {
          missed.push(reminder.item.trim());
        }
        continue;
      }
      const cancelled = await cancelActiveReminderById(
        input.userId,
        reminderId,
      );
      if (cancelled) {
        removed.push(cancelled.label);
        alreadyCancelled.add(reminderId);
        pushCascadedTasks(cancelled.removedWorkerTasks);
        changes.push({
          action: "remove",
          label: cancelled.label,
          fireAt: formatJerusalemDateTime(cancelled.fireAt),
          involvedIds: cancelled.involvedIds,
        });
      } else if (alreadyCancelled.has(reminderId)) {
        // Same-turn list cascade already cancelled this clock — not a miss.
        removed.push(reminder.item.trim() || reminderId);
      } else {
        missed.push(reminder.item.trim() || reminderId);
      }
      continue;
    }

    const reminderId = reminder.reminderId.trim();
    const key = itemKey(reminder.item);
    if (reminder.action === "update" && !reminderId) {
      skipped.push({ item: reminder.item.trim() || "(missing reminder_id)", reason: "db" });
      continue;
    }
    if (reminder.action === "update" && reminder.occurrenceChange) {
      try {
        const applied = await applyReminderOccurrenceChange({
          userId: input.userId,
          actorEmployeeId: input.actor.id,
          reminderId,
          change: reminder.occurrenceChange,
        });
        if (!applied) {
          missed.push(reminder.item.trim() || reminderId);
          continue;
        }
        if (applied.fireAt) {
          const fireLabel = formatJerusalemDateTime(applied.fireAt);
          saved.push({
            id: applied.id,
            item: reminder.item.trim(),
            itemKey: applied.itemKey,
            itemLabel: applied.label,
            fireAt: fireLabel,
            ping: applied.pingIds.map((id) => formatPingLabel(id, input.employees)).join(","),
          });
          changes.push({
            action: "update",
            label: applied.label,
            fireAt: fireLabel,
            involvedIds: applied.involvedIds,
          });
        } else {
          removed.push(applied.label);
          changes.push({
            action: "remove",
            label: applied.label,
            fireAt: formatJerusalemDateTime(applied.previousFireAt),
            involvedIds: applied.involvedIds,
          });
        }
      } catch {
        skipped.push({ item: reminder.item.trim() || reminderId, reason: "db" });
      }
      continue;
    }
    if (reminder.action === "update" && isAttachmentOnlyReminderUpdate(reminder)) {
      const clock = await prisma.reminder.findFirst({
        where: { id: reminderId, userId: input.userId, status: "active" },
        select: { id: true },
      });
      if (!clock) {
        missed.push(reminder.item.trim() || reminderId);
        continue;
      }
      await applyAttachmentLinks({
        actorId: input.actor.id,
        target: { reminderId: clock.id },
        attachmentIds: reminder.attachmentIds,
        detachIds: reminder.detachAttachmentIds,
      });
      continue;
    }
    if (reminder.action === "add" && !key) {
      continue;
    }
    if (reminderRepeatsSubHourly(reminder)) {
      skipped.push({ item: reminder.item.trim() || reminderId, reason: "too_frequent" });
      continue;
    }

    const rows = await prisma.reminder.findMany({
      where: { userId: input.userId, status: "active" },
    });
    // Update only by reminder_id. Add always creates — never reuse a clock by label.
    const existing =
      reminder.action === "update" && reminderId
        ? rows.find((row) => row.id === reminderId)
        : undefined;
    // Clocks stay on the speaker who created them; do not re-scope by targets.
    const ownerId = existing?.ownerId ?? input.actor.id;

    const canReuseClock = canReuseExistingReminderClock(reminder, Boolean(existing));

    const existingAnchor =
      existing && "scheduleAnchor" in existing
        ? String((existing as { scheduleAnchor?: string }).scheduleAnchor ?? "")
        : "";
    const existingOffset =
      existing && "scheduleOffsetMinutes" in existing
        ? Number(
            (existing as { scheduleOffsetMinutes?: number }).scheduleOffsetMinutes ??
              0,
          )
        : 0;
    const existingPlaceEarly =
      existing && "composePlace" in existing
        ? String((existing as { composePlace?: string }).composePlace ?? "")
        : "";

    let scheduleAnchor =
      reminder.scheduleAnchor === "jewish_candles"
        ? "jewish_candles"
        : canReuseClock && existingAnchor === "jewish_candles"
          ? "jewish_candles"
          : "";
    const rawOffset = Number(reminder.scheduleOffsetMinutes ?? 0);
    let scheduleOffsetMinutes =
      reminder.scheduleAnchor === "jewish_candles" || rawOffset !== 0
        ? rawOffset
        : canReuseClock
          ? existingOffset
          : 0;
    let schedulePlace = (
      reminder.composePlace.trim() ||
      (canReuseClock && scheduleAnchor ? existingPlaceEarly : "") ||
      ""
    )
      .trim()
      .slice(0, 255);

    // Candle-offset clocks: engine fills fire_at from Hebcal (no wall time/in).
    let recurring =
      reminder.recurrence && scheduleAnchor !== "jewish_candles"
        ? resolveRecurringFireAt(
            reminder.recurrence,
            reminder.date,
            reminder.time,
            new Date(),
            reminder.inSeconds,
          )
        : null;
    const interval =
      reminder.recurrence || scheduleAnchor === "jewish_candles"
        ? null
        : intervalOf(reminder);
    let fireAt: Date | null = null;

    if (scheduleAnchor === "jewish_candles") {
      if (!schedulePlace) {
        skipped.push({ item: reminder.item.trim(), reason: "no_place" });
        continue;
      }
      fireAt = await nextCandleLighting({
        place: schedulePlace,
        offsetMinutes: scheduleOffsetMinutes,
      });
      if (!fireAt) {
        skipped.push({ item: reminder.item.trim(), reason: "anchor_failed" });
        continue;
      }
      // One-shot by default. Weekly only when the model sent weekly (כל שישי).
      recurring =
        reminder.recurrence && reminder.recurrence.freq === "weekly"
          ? { fireAt, recurrence: reminder.recurrence }
          : null;
    } else {
      fireAt = reminder.recurrence
        ? (recurring?.fireAt ?? null)
        : resolveReminderFireAt(
            reminder.date,
            reminder.time,
            new Date(),
            reminder.inSeconds,
            interval,
          );
    }

    if (!fireAt && canReuseClock && existing) {
      fireAt = existing.fireAt;
    }
    if (!fireAt) {
      skipped.push({ item: reminder.item.trim(), reason: "no_time" });
      continue;
    }

    let pingIds = resolveReminderPingDestinations(
      reminder,
      input.employees,
      input.actor.id,
      contacts,
    );
    const pingOmitted =
      reminder.ping.every((part) => !String(part).trim()) &&
      !(reminder.targets ?? []).some((part) => String(part).trim());
    // On update, empty ping must keep the existing destination — otherwise
    // resolve falls back to the speaker and the send goes to the wrong phone.
    if (existing && canReuseClock && pingOmitted) {
      pingIds = Array.isArray(existing.pingIds)
        ? existing.pingIds.map(String)
        : [];
    } else if (pingIds.length === 0 && existing && canReuseClock) {
      pingIds = Array.isArray(existing.pingIds)
        ? existing.pingIds.map(String)
        : [];
    }
    if (pingIds.length === 0) {
      skipped.push({
        item: reminder.item.trim(),
        reason: "no_phone",
        dest: unknownDestNames(reminder, input.employees, contacts).join(", "),
      });
      continue;
    }

    const aboutNamed = (reminder.about ?? []).some((part) => String(part).trim());
    let aboutIds = resolveReminderAboutIds(reminder, input.employees);
    if (existing && canReuseClock && !aboutNamed) {
      aboutIds = Array.isArray(existing.aboutIds)
        ? existing.aboutIds.map(String)
        : [];
    }

    try {
      const owned = rows.filter((row) => row.ownerId === ownerId);
      const label = (existing?.itemLabel ?? reminder.item.trim()).slice(0, 255);
      const stopsRule = reminder.recurrence === null;
      const nextRepeat = recurring
        ? legacyRepeatFor(recurring.recurrence)
        : interval
          ? serializeReminderRepeat(interval)
          : existing && canReuseClock && !stopsRule
            ? existing.repeat
            : serializeReminderRepeat(null);
      const keepsRule =
        !recurring && !interval && !stopsRule && Boolean(existing && canReuseClock);
      const hadRule = Boolean(existing && "recurrence" in existing && existing.recurrence);
      const ruleFields = recurring
        ? {
            recurrence: serializeRecurrence(recurring.recurrence) as Prisma.InputJsonValue,
            occurrencesFired: 0,
          }
        : hadRule && !keepsRule
          ? { recurrence: Prisma.DbNull, occurrencesFired: 0 }
          : {};
      const nextText = reminder.text.trim()
        ? reminder.text.trim().slice(0, 4096)
        : existing && canReuseClock
          ? existing.messageText
          : "";
      const nextCompose =
        canReuseClock && existing
          ? reminder.compose || existing.composeAtFire
          : reminder.compose;
      const existingSource =
        existing && "composeSource" in existing
          ? String(existing.composeSource ?? "")
          : "";
      const nextSource =
        reminder.composeSource === "git_log" || existingSource === "git_log"
          ? "git_log"
          : reminder.composeSource === "saved_data" ||
              existingSource === "saved_data"
            ? "saved_data"
            : reminder.composeSource === "weather" ||
                existingSource === "weather"
              ? "weather"
              : reminder.composeSource === "market" ||
                  existingSource === "market"
                ? "market"
                : reminder.composeSource === "mashov" ||
                    existingSource === "mashov"
                  ? "mashov"
                  : "";
      const existingLookback =
        existing && "composeLookbackHours" in existing
          ? Number(
              (existing as { composeLookbackHours?: number }).composeLookbackHours ??
                0,
            )
          : 0;
      const nextLookback =
        nextSource === "git_log"
          ? reminder.composeLookbackHours > 0
            ? reminder.composeLookbackHours
            : canReuseClock && existingLookback > 0
              ? existingLookback
              : // One-shot digests default to a week window so they never stamp last_report_sha.
                nextRepeat === "once"
                ? 168
                : 0
          : 0;
      const existingPlace =
        existing && "composePlace" in existing
          ? String((existing as { composePlace?: string }).composePlace ?? "")
          : "";
      const nextPlace =
        nextSource === "weather" ||
        nextSource === "market" ||
        nextSource === "mashov" ||
        scheduleAnchor === "jewish_candles"
          ? (schedulePlace ||
              reminder.composePlace.trim() ||
              (canReuseClock ? existingPlace : "") ||
              "")
              .trim()
              .slice(0, 255)
          : "";
      const nextScheduleAnchor =
        scheduleAnchor === "jewish_candles"
          ? "jewish_candles"
          : canReuseClock && existingAnchor && !reminder.scheduleAnchor
            ? existingAnchor
            : "";
      const nextScheduleOffset =
        scheduleAnchor === "jewish_candles" || rawOffset !== 0
          ? scheduleOffsetMinutes
          : canReuseClock
            ? existingOffset
            : 0;
      const existingCondition =
        existing &&
        "composeCondition" in existing &&
        existing.composeCondition != null &&
        typeof existing.composeCondition === "object"
          ? (existing.composeCondition as Prisma.InputJsonValue)
          : null;
      const nextCondition: Prisma.InputJsonValue | typeof Prisma.DbNull =
        reminder.composeCondition != null
          ? (reminder.composeCondition as Prisma.InputJsonValue)
          : canReuseClock && existingCondition != null
            ? existingCondition
            : Prisma.DbNull;
      const existingWatchOnce =
        existing && "watchOnce" in existing
          ? Boolean((existing as { watchOnce?: boolean }).watchOnce)
          : false;
      const nextWatchOnce =
        reminder.watchOnce === true
          ? true
          : canReuseClock
            ? existingWatchOnce
            : false;
      const existingAspects =
        existing &&
        "composeAspects" in existing &&
        Array.isArray((existing as { composeAspects?: unknown }).composeAspects)
          ? ((existing as { composeAspects: unknown[] }).composeAspects
              .map((entry) => String(entry ?? "").trim().toLowerCase())
              .filter(Boolean) as string[])
          : [];
      const nextAspects =
        Array.isArray(reminder.composeAspects) &&
        reminder.composeAspects.length > 0
          ? reminder.composeAspects
              .map((entry) => String(entry ?? "").trim().toLowerCase())
              .filter(Boolean)
              .slice(0, 12)
          : canReuseClock && existingAspects.length > 0
            ? existingAspects
            : [];
      const nextAspectsJson: Prisma.InputJsonValue | typeof Prisma.DbNull =
        nextAspects.length > 0
          ? (nextAspects as Prisma.InputJsonValue)
          : Prisma.DbNull;
      const composeAtFire =
        nextCompose ||
        nextSource === "git_log" ||
        nextSource === "saved_data" ||
        nextSource === "weather" ||
        nextSource === "market" ||
        nextSource === "mashov" ||
        nextCondition !== Prisma.DbNull;
      const row = existing
        ? await prisma.reminder.update({
            where: { id: existing.id },
            data: {
              itemLabel: label,
              listType: reminder.listType || existing.listType,
              fireAt,
              repeat: nextRepeat,
              ...ruleFields,
              pingIds,
              aboutIds,
              messageText: nextText,
              composeAtFire,
              composeSource: nextSource,
              composeLookbackHours: nextLookback,
              composePlace: nextPlace,
              scheduleAnchor: nextScheduleAnchor,
              scheduleOffsetMinutes: nextScheduleOffset,
              composeCondition: nextCondition,
              watchOnce: nextWatchOnce,
              composeAspects: nextAspectsJson,
            },
          })
        : await prisma.reminder.create({
            data: {
              userId: input.userId,
              ownerId,
              actorId: input.actor.id,
              itemKey: key,
              itemLabel: reminder.item.trim().slice(0, 255),
              listType: reminder.listType,
              fireAt,
              repeat: nextRepeat,
              ...ruleFields,
              pingIds,
              aboutIds,
              messageText: nextText,
              composeAtFire,
              composeSource: nextSource,
              composeLookbackHours: nextLookback,
              composePlace: nextPlace,
              scheduleAnchor: nextScheduleAnchor,
              scheduleOffsetMinutes: nextScheduleOffset,
              composeCondition: nextCondition,
              watchOnce: nextWatchOnce,
              composeAspects: nextAspectsJson,
            },
          });
      const linkedWorkerItemId =
        "workerItemId" in row && typeof row.workerItemId === "string"
          ? row.workerItemId
          : existing &&
              "workerItemId" in existing &&
              typeof existing.workerItemId === "string"
            ? existing.workerItemId
            : null;
      if (existing) {
        await shareWorkerTaskWithPingRecipients({
          workerItemId: linkedWorkerItemId,
          ownerId,
          pingIds,
        });
      }
      await applyAttachmentLinks({
        actorId: input.actor.id,
        target: { reminderId: row.id },
        attachmentIds: reminder.attachmentIds,
        detachIds: reminder.detachAttachmentIds,
      });
      await syncLinkedWorkerTaskClock({
        reminderId: row.id,
        workerItemId: linkedWorkerItemId,
        fireAt,
        rule: recurring
          ? recurring.recurrence
          : "recurrence" in ruleFields
            ? null
            : undefined,
      });
      if (nextCondition !== Prisma.DbNull) {
        const subjectId =
          (Array.isArray(pingIds) && typeof pingIds[0] === "string"
            ? pingIds[0]
            : null) || ownerId;
        await seedWatchBaseline({
          reminderId: row.id,
          composeSource: nextSource,
          composePlace: nextPlace,
          composeCondition: nextCondition,
          composeAspects: nextAspects,
          subjectEmployeeId: subjectId,
          repeat: nextRepeat,
        }).catch(() => null);
      }
      await recordAuditEvent({
        userId: input.userId,
        actorEmployeeId: input.actor.id,
        action: "reminder_save",
        entityType: "Reminder",
        entityId: row.id,
        summary: `${existing ? "update" : "add"} reminder: ${label}`,
        detail: { fireAt: fireAt.toISOString(), pingIds },
      });
      const fireLabel = formatJerusalemDateTime(fireAt);
      const sameTimeOthers = uniqueLabels(
        owned
          .filter(
            (peer) =>
              peer.id !== row.id &&
              formatJerusalemDateTime(peer.fireAt) === fireLabel,
          )
          .map((peer) => peer.itemLabel),
      );
      saved.push({
        id: row.id,
        item: reminder.item.trim(),
        itemKey: key,
        itemLabel: label,
        fireAt: fireLabel,
        ping: pingIds
          .map((id) => formatPingLabel(id, input.employees))
          .join(","),
        ...(sameTimeOthers.length > 0 ? { sameTimeOthers } : {}),
        ...(nextCompose ? { composeAtFire: true } : {}),
      });
      if (existing) {
        changes.push({
          action: "update",
          label,
          fireAt: fireLabel,
          involvedIds: [
            ...new Set([
              ...(await clockInvolvedIds({
                ownerId: existing.ownerId,
                pingIds: existing.pingIds,
                workerItemId: linkedWorkerItemId,
              })),
              ...pingIds,
            ]),
          ],
        });
      }
      scheduleSoon(fireAt);
    } catch {
      skipped.push({ item: reminder.item.trim(), reason: "db" });
    }
  }
  return { removed, missed, removedWorkerTasks, saved, skipped, changes };
}

export function formatReminderDeleteFallback(labels: string[]): string {
  const unique = uniqueLabels(labels);
  if (unique.length === 0) {
    return "מחקתי את התזכורת.";
  }
  if (unique.length === 1) {
    return `מחקתי את התזכורת «${unique[0]}».`;
  }
  return `מחקתי ${unique.length} תזכורות.`;
}

export function formatActiveRemindersReply(
  rows: ReminderSnapshotRow[],
): string {
  const active = rows.filter((row) => row.status === "active");
  if (active.length === 0) {
    return "אין לך תזכורות פעילות.";
  }
  return [
    "התזכורות הפעילות שלך:",
    ...active.map((row) => {
      const cadence = formatReminderIntervalHe(row.repeat);
      return `- ${row.item} (${row.fire_at}${cadence ? `, ${cadence}` : ""})`;
    }),
  ].join("\n");
}

export function reminderIsScheduledSend(
  row: Pick<ReminderSnapshotRow, "ping_ids">,
  speakerId: string,
  speakerPhone?: string | null,
): boolean {
  const dests = row.ping_ids ?? [];
  if (dests.length === 0) {
    return false;
  }
  return dests.some((dest) => {
    if (dest === speakerId) {
      return false;
    }
    if (speakerPhone && phonesMatch(speakerPhone, dest)) {
      return false;
    }
    return true;
  });
}

export function formatTodosReply(input: {
  shopping: string[];
  tasks: string[];
  reminders: ReminderSnapshotRow[];
  speakerId: string;
  speakerPhone?: string | null;
  voice?: "speaker" | "self-female" | "self-male" | "named";
  subjectName?: string;
}): string {
  const shopping = uniqueLabels(input.shopping);
  const tasks = uniqueLabels(input.tasks);
  const listed = [...shopping, ...tasks];
  const selfReminders = input.reminders.filter(
    (row) =>
      row.status === "active" &&
      !reminderIsScheduledSend(row, input.speakerId, input.speakerPhone) &&
      !listed.some((label) => reminderLabelsMatch(row.item, label)),
  );
  const items = [
    ...shopping,
    ...tasks,
    ...selfReminders.map((row) => `${row.item} (${row.fire_at})`),
  ];
  const lines = items.map((item) => `- ${item}`);
  if (input.voice === "self-female" || input.voice === "self-male") {
    const verb = input.voice === "self-female" ? "צריכה" : "צריך";
    if (items.length === 0) {
      return "אין לי כרגע משימות ממתינות.";
    }
    if (items.length === 1) {
      return `אני ${verb} ${items[0]}`;
    }
    return [`אני ${verb}:`, ...lines].join("\n");
  }
  if (items.length === 0) {
    return "אין לך כרגע משימות או קניות ממתינות.";
  }
  if (input.voice === "named" && input.subjectName) {
    return [`מה ש${input.subjectName} צריך לעשות:`, ...lines].join("\n");
  }
  return ["מה שאתה צריך לעשות:", ...lines].join("\n");
}

function uniqueLabels(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const label = value.trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(label);
  }
  return result;
}

export function formatReminderApplyNotice(result: {
  removed: string[];
  missed: string[];
  saved?: Array<{
    item: string;
    fireAt: string;
    ping?: string;
    sameTimeOthers?: string[];
    composeAtFire?: boolean;
  }>;
  skipped?: Array<{
    item: string;
    reason: ReminderSkipReason;
    dest?: string;
  }>;
}): string {
  const parts: string[] = [];
  // Success save/remove: no engine ack — the model's response already confirms
  // (אזכיר לך… / ביטלתי…). Keep skip / missed corrections only.
  if (result.skipped && result.skipped.length > 0) {
    parts.push(
      result.skipped
        .map((row) =>
          row.reason === "db"
            ? `לא נשמרה «${row.item}» — השמירה נכשלה.`
            : row.reason === "no_phone"
              ? row.dest
                ? `אין לי מספר ל«${row.dest}». מה המספר?`
                : `אין לי מספר ליעד. מה המספר?`
              : row.reason === "too_frequent"
                ? `לא נשמרה «${row.item}» — ${SUB_HOURLY_REFUSAL}`
                : row.reason === "no_place"
                  ? `לא נשמרה «${row.item}» — באיזה יישוב לחשב את הדלקת הנרות?`
                  : row.reason === "anchor_failed"
                    ? `לא נשמרה «${row.item}» — לא הצלחתי לחשב את שעת הדלקת הנרות. נסה שוב בעוד רגע.`
                    : `לא נשמרה «${row.item}» — מתי לשלוח? עכשיו, בעוד X, או שעה קבועה.`,
        )
        .join(" "),
    );
  }
  if (result.missed.length > 0) {
    const labels = result.missed
      .map((row) => row.trim())
      .filter((row) => row && !looksLikeOpaqueId(row));
    parts.push(
      labels.length > 0
        ? `לא נמצאה תזכורת פעילה בשם: ${labels.join(", ")}.`
        : "לא נמצאה תזכורת פעילה.",
    );
  }
  return parts.join(" ");
}

/** UUID / opaque engine ids must never appear in user-facing miss text. */
function looksLikeOpaqueId(value: string): boolean {
  const trimmed = value.trim();
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  // Compact hex ids (no hyphens) of typical UUID length.
  return /^[0-9a-f]{32}$/i.test(trimmed);
}

export async function listReminderRowsForUser(userId: string) {
  if (!prisma.reminder) {
    return [];
  }
  try {
    // Live clocks only — done/cancelled stay in DB but are never loaded into context.
    return await prisma.reminder.findMany({
      where: { userId, status: "active" },
      orderBy: { fireAt: "asc" },
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      console.error("Reminders table missing");
      return [];
    }
    throw error;
  }
}

export async function listVisibleReminders(
  userId: string,
  employeeId: string,
  employees: PublicEmployee[],
): Promise<ReminderSnapshotRow[]> {
  const rows = await listReminderRowsForUser(userId);
  const names = new Map(employees.map((employee) => [employee.id, displayName(employee)]));

  return rows
    .filter((row) => {
      const pings = Array.isArray(row.pingIds) ? row.pingIds.map(String) : [];
      return row.ownerId === employeeId || pings.includes(employeeId);
    })
    .map((row) => toReminderSnapshotRow(row, names));
}

export function toReminderSnapshotRow(
  row: {
    id: string;
    itemLabel: string;
    listType: string;
    fireAt: Date;
    repeat: string;
    recurrence?: unknown;
    occurrencesFired?: number;
    pingIds: unknown;
    aboutIds?: unknown;
    ownerId: string;
    messageText: string;
    composeAtFire?: boolean;
    composeSource?: string;
    composeLookbackHours?: number;
    composePlace?: string;
    composeCondition?: unknown;
    watchOnce?: boolean;
    composeAspects?: unknown;
    lastComposedText?: string | null;
    status: string;
    sendStatus?: string;
    sentAt?: Date | null;
    updatedAt?: Date | null;
  },
  names: Map<string, string>,
  occurrenceRange?: ReminderOccurrenceRange | null,
): ReminderSnapshotRow {
  const pings = Array.isArray(row.pingIds) ? row.pingIds.map(String) : [];
  const abouts = Array.isArray(row.aboutIds) ? row.aboutIds.map(String) : [];
  const sendStatus =
    row.sendStatus === "sent" || row.sendStatus === "failed"
      ? row.sendStatus
      : "pending";
  const text = row.messageText ?? "";
  const lastComposed = (row.lastComposedText ?? "").trim();
  const changedAt =
    row.status === "done" && row.sentAt
      ? formatJerusalemDateTime(row.sentAt)
      : row.status === "cancelled" && row.updatedAt
        ? formatJerusalemDateTime(row.updatedAt)
        : row.updatedAt && row.status !== "active"
          ? formatJerusalemDateTime(row.updatedAt)
          : null;
  const lookback =
    typeof row.composeLookbackHours === "number" &&
    Number.isFinite(row.composeLookbackHours) &&
    row.composeLookbackHours > 0
      ? row.composeLookbackHours
      : 0;
  return {
    reminder_id: row.id,
    item: row.itemLabel,
    list_type: row.listType,
    fire_at: formatJerusalemDateTime(row.fireAt),
    repeat: row.repeat,
    ping: pings.map((id) => names.get(id) ?? id),
    ping_ids: pings,
    about: abouts.map((id) => names.get(id) ?? id),
    about_ids: abouts,
    owner: names.get(row.ownerId) ?? row.ownerId,
    text,
    last_composed_text: lastComposed,
    sent_text: lastComposed || text,
    compose_at_fire: row.composeAtFire === true,
    compose_source:
      row.composeSource === "git_log"
        ? "git_log"
        : row.composeSource === "saved_data"
          ? "saved_data"
          : row.composeSource === "weather"
            ? "weather"
            : row.composeSource === "market"
              ? "market"
              : row.composeSource === "mashov"
                ? "mashov"
                : "",
    compose_lookback_hours: lookback,
    compose_place:
      row.composeSource === "weather" ||
      row.composeSource === "market" ||
      row.composeSource === "mashov"
        ? String(row.composePlace ?? "").trim()
        : "",
    compose_condition:
      row.composeCondition != null &&
      typeof row.composeCondition === "object" &&
      !Array.isArray(row.composeCondition)
        ? row.composeCondition
        : null,
    watch_once: row.watchOnce === true,
    compose_aspects: Array.isArray(row.composeAspects)
      ? row.composeAspects
          .map((entry) => String(entry ?? "").trim().toLowerCase())
          .filter(Boolean)
      : [],
    status: row.status,
    send_status: sendStatus,
    sent: sendStatus === "sent",
    sent_at: row.sentAt ? formatJerusalemDateTime(row.sentAt) : null,
    changed_at: changedAt,
    ...(row.status === "active" ? reminderRuleSnapshot(row, occurrenceRange) : {}),
  };
}
