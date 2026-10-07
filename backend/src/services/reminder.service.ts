import type { LlmReminderAction, PublicEmployee } from "@workee/shared";
import {
  addJerusalemDays,
  addReminderInterval,
  anchorRecurrence,
  firstOccurrence,
  formatJerusalemDateTime as formatJerusalemWallTime,
  formatRecurrenceHe,
  formatReminderIntervalHe,
  jerusalemParts,
  jerusalemWallTimeToDate,
  legacyRepeatFor,
  listOccurrences,
  nextWeekdayFireAt,
  parseRecurrence,
  parseStoredRepeat,
  recurrenceFromInterval,
  serializeRecurrence,
  serializeReminderRepeat,
  withinUntil,
  type Recurrence,
  type ReminderInterval,
} from "@workee/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { isMissingTableError } from "../utils/errors.js";
import { looksLikePhone, normalizePhoneDigits, phonesMatch } from "../utils/phone.js";
import { matchContact, type SpeakerContact } from "./contact.service.js";
import { recordAuditEvent } from "./audit.service.js";
import { scheduleSoon } from "./reminder-fire.js";

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

/** Match an active clock by key/label across the whole account (any owner). */
export function findMatchingActiveReminder<
  T extends { itemKey: string; itemLabel: string },
>(rows: T[], item: string): T | undefined {
  const key = itemKey(item);
  if (!key) {
    return undefined;
  }
  return rows.find(
    (row) =>
      row.itemKey === key ||
      reminderLabelsMatch(row.itemLabel, item) ||
      reminderLabelsMatch(row.itemKey, key),
  );
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
    const fireAt = resolveReminderFireAt(dateText, timeText, now, inSeconds, {
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
  const interval = parseStoredRepeat(row.repeat);
  return interval ? anchorRecurrence(recurrenceFromInterval(interval), row.fireAt) : null;
}

/**
 * Facts for a repeating clock: product-Hebrew rule text and the next concrete fires
 * (bounded by until/count), so the model answers per date without weekday math.
 */
export function reminderRuleSnapshot(row: {
  fireAt: Date;
  repeat: string;
  recurrence?: unknown;
  occurrencesFired?: number;
}): {
  recurrence_text?: string;
  next_occurrences?: string[];
  remaining_times?: number;
} {
  const rule = storedReminderRule(row);
  if (!rule) {
    return {};
  }
  const fired = typeof row.occurrencesFired === "number" ? row.occurrencesFired : 0;
  const occurrences = listOccurrences(rule, {
    first: row.fireAt,
    limit: SNAPSHOT_OCCURRENCES,
    horizon: addJerusalemDays(row.fireAt, SNAPSHOT_HORIZON_DAYS),
    firedCount: fired,
  });
  return {
    recurrence_text: formatRecurrenceHe(rule),
    next_occurrences: occurrences.map((value) => formatJerusalemDateTime(value)),
    ...(rule.count ? { remaining_times: Math.max(0, rule.count - fired) } : {}),
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

export async function syncLinkedWorkerTaskClock(input: {
  reminderId: string;
  workerItemId?: string | null;
  fireAt: Date;
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
    const time = formatJerusalemClock(input.fireAt);
    const data =
      item.data && typeof item.data === "object" && !Array.isArray(item.data)
        ? { ...(item.data as Record<string, unknown>) }
        : {};
    const currentName =
      typeof data["שם מטלה"] === "string" && data["שם מטלה"].trim()
        ? data["שם מטלה"].trim()
        : item.itemKey;
    const nextName = applyTimeToTaskLabel(currentName, time);
    await prisma.employeeListItem.update({
      where: { id: item.id },
      data: {
        data: {
          ...data,
          "שם מטלה": nextName,
          "שעה לביצוע": time,
        },
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
  const used = new Set<string>();
  const pairs: Array<{ reminderId: string; workerItemId: string }> = [];
  for (const reminder of reminders) {
    const match = workerItems.find(
      (item) =>
        !used.has(item.id) &&
        (item.itemKey === reminder.itemKey ||
          reminderLabelsMatch(reminder.itemLabel, item.itemKey) ||
          reminderLabelsMatch(reminder.itemKey, item.itemKey)),
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
      await prisma.employeeListItem.update({
        where: { id: pair.workerItemId },
        data: { reminderId: pair.reminderId },
      });
      await prisma.reminder.update({
        where: { id: pair.reminderId },
        data: { workerItemId: pair.workerItemId },
      });
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
 * Same-turn speaker/shared items (שוקו, לבדוק שטויות, תפוחים for ערן+עמית) ↔ the clock
 * the model emitted in that turn. Labels must match — no lone-pair shortcut, because a
 * turn can add an unrelated item next to a reminder.
 */
export function pairLinkedItemsToReminders(
  reminders: Array<{ id: string; itemKey: string; itemLabel: string }>,
  items: LinkedItemRef[],
): Array<{ reminderId: string; itemId: string }> {
  const pairs: Array<{ reminderId: string; itemId: string }> = [];
  for (const item of items) {
    const labels = [item.itemKey, item.itemLabel].filter((label) => label.trim());
    const match =
      reminders.find((reminder) =>
        labels.some((label) => itemKey(label) === reminder.itemKey),
      ) ??
      reminders.find((reminder) =>
        labels.some(
          (label) =>
            reminderLabelsMatch(reminder.itemLabel, label) ||
            reminderLabelsMatch(reminder.itemKey, label),
        ),
      );
    if (match) {
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
): Promise<void> {
  if (!prisma.reminder?.findFirst && !prisma.employeeListItem?.findUnique) {
    return;
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
    const clock = prisma.reminder?.findFirst
      ? await prisma.reminder.findFirst({
          where: {
            OR: [
              { workerItemId },
              ...(reminderId ? [{ id: reminderId }] : []),
            ],
          },
        })
      : null;
    const id = clock?.id ?? reminderId;
    if (!id) {
      return;
    }
    const linkedWorkerId =
      clock && "workerItemId" in clock && typeof clock.workerItemId === "string"
        ? clock.workerItemId
        : workerItemId;
    await removeReminderAndLinkedWorkerTask({
      id,
      workerItemId: linkedWorkerId,
    });
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
  }
}

/**
 * When a speaker shopping/task wrapper is removed, cancel active clocks that
 * are the same work by key/label (self-nudge clocks are linked to the worker
 * task, not the speaker row).
 */
export async function cancelActiveRemindersMatchingWork(input: {
  userId: string;
  itemKey: string;
  itemLabel?: string;
  actorEmployeeId?: string | null;
}): Promise<{
  cancelledReminders: string[];
  removedWorkerTasks: Array<{
    id: string;
    itemKey: string;
    itemLabel: string;
    employeeId: string;
  }>;
}> {
  if (!prisma.reminder?.findMany) {
    return { cancelledReminders: [], removedWorkerTasks: [] };
  }
  const wantedKey = itemKey(input.itemKey);
  const wantedLabel = (input.itemLabel ?? input.itemKey).trim();
  if (!wantedKey && !wantedLabel) {
    return { cancelledReminders: [], removedWorkerTasks: [] };
  }
  try {
    const rows = await prisma.reminder.findMany({
      where: { userId: input.userId, status: "active" },
    });
    const matches = rows.filter(
      (row) =>
        (wantedKey.length > 0 && row.itemKey === wantedKey) ||
        reminderLabelsMatch(row.itemLabel, wantedLabel) ||
        (wantedKey.length > 0
          ? reminderLabelsMatch(row.itemKey, wantedKey)
          : false),
    );
    const cancelledReminders: string[] = [];
    const removedWorkerTasks: Array<{
      id: string;
      itemKey: string;
      itemLabel: string;
      employeeId: string;
    }> = [];
    const seenWorker = new Set<string>();
    for (const match of matches) {
      const workerItemId =
        "workerItemId" in match && typeof match.workerItemId === "string"
          ? match.workerItemId
          : null;
      const removed = await removeReminderAndLinkedWorkerTask({
        id: match.id,
        workerItemId,
        userId: input.userId,
        actorEmployeeId: input.actorEmployeeId,
        label: match.itemLabel,
      });
      cancelledReminders.push(match.itemLabel);
      for (const task of removed) {
        if (seenWorker.has(task.id)) {
          continue;
        }
        seenWorker.add(task.id);
        removedWorkerTasks.push(task);
      }
    }
    return { cancelledReminders, removedWorkerTasks };
  } catch (error) {
    if (isMissingTableError(error)) {
      return { cancelledReminders: [], removedWorkerTasks: [] };
    }
    throw error;
  }
}

async function cancelActiveReminderById(
  userId: string,
  reminderId: string,
): Promise<string | null> {
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
  await removeReminderAndLinkedWorkerTask({
    id: match.id,
    workerItemId,
    userId,
    label: match.itemLabel,
  });
  return match.itemLabel;
}

async function cancelActiveReminder(
  userId: string,
  ownerId: string,
  wanted: string,
): Promise<string | null> {
  const rows = await prisma.reminder.findMany({
    where: { userId, status: "active" },
  });
  const owned = rows.filter((row) => row.ownerId === ownerId);
  const pool = owned.length > 0 ? owned : rows;
  const match = pool.find(
    (row) =>
      row.itemKey === itemKey(wanted) || reminderLabelsMatch(row.itemLabel, wanted),
  );
  if (!match) {
    return null;
  }
  const workerItemId =
    "workerItemId" in match && typeof match.workerItemId === "string"
      ? match.workerItemId
      : null;
  await removeReminderAndLinkedWorkerTask({
    id: match.id,
    workerItemId,
    userId,
    label: match.itemLabel,
  });
  return match.itemLabel;
}

async function cancelActiveReminderAnyOwner(
  userId: string,
  wanted: string,
): Promise<string | null> {
  const rows = await prisma.reminder.findMany({
    where: { userId, status: "active" },
  });
  const match = rows.find(
    (row) =>
      row.itemKey === itemKey(wanted) || reminderLabelsMatch(row.itemLabel, wanted),
  );
  if (!match) {
    return null;
  }
  const workerItemId =
    "workerItemId" in match && typeof match.workerItemId === "string"
      ? match.workerItemId
      : null;
  await removeReminderAndLinkedWorkerTask({
    id: match.id,
    workerItemId,
    userId,
    label: match.itemLabel,
  });
  return match.itemLabel;
}

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

export async function applyReminders(input: {
  userId: string;
  actor: PublicEmployee;
  employees: PublicEmployee[];
  reminders: LlmReminderAction[];
  contacts?: SpeakerContact[];
}): Promise<{
  removed: string[];
  missed: string[];
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
    reason: "no_time" | "db" | "no_phone";
    dest?: string;
  }>;
}> {
  const contacts = input.contacts ?? [];
  const removed: string[] = [];
  const missed: string[] = [];
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
    reason: "no_time" | "db" | "no_phone";
    dest?: string;
  }> = [];
  if (!prisma.reminder) {
    for (const reminder of input.reminders.filter((row) => row.action !== "remove")) {
      skipped.push({ item: reminder.item.trim(), reason: "db" });
    }
    return { removed, missed, saved, skipped };
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
        removed.push(cancelled);
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
    if (reminder.action === "add" && !key) {
      continue;
    }

    const recurring = reminder.recurrence
      ? resolveRecurringFireAt(
          reminder.recurrence,
          reminder.date,
          reminder.time,
          new Date(),
          reminder.inSeconds,
        )
      : null;
    const interval = reminder.recurrence ? null : intervalOf(reminder);
    let fireAt = reminder.recurrence
      ? (recurring?.fireAt ?? null)
      : resolveReminderFireAt(
          reminder.date,
          reminder.time,
          new Date(),
          reminder.inSeconds,
          interval,
        );

    const rows = await prisma.reminder.findMany({
      where: { userId: input.userId, status: "active" },
    });
    const existing =
      reminder.action === "update" && reminderId
        ? rows.find((row) => row.id === reminderId)
        : findMatchingActiveReminder(rows, reminder.item);
    // Clocks stay on the speaker who created them; do not re-scope by targets.
    const ownerId = existing?.ownerId ?? input.actor.id;

    const canReuseClock = canReuseExistingReminderClock(reminder, Boolean(existing));

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
      const composeAtFire =
        nextCompose || nextSource === "git_log" || nextSource === "saved_data";
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
              messageText: nextText,
              composeAtFire,
              composeSource: nextSource,
              composeLookbackHours: nextLookback,
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
              messageText: nextText,
              composeAtFire,
              composeSource: nextSource,
              composeLookbackHours: nextLookback,
            },
          });
      await syncLinkedWorkerTaskClock({
        reminderId: row.id,
        workerItemId:
          "workerItemId" in row && typeof row.workerItemId === "string"
            ? row.workerItemId
            : existing &&
                "workerItemId" in existing &&
                typeof existing.workerItemId === "string"
              ? existing.workerItemId
              : null,
        fireAt,
      });
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
      scheduleSoon(fireAt);
    } catch {
      skipped.push({ item: reminder.item.trim(), reason: "db" });
    }
  }
  return { removed, missed, saved, skipped };
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
    reason: "no_time" | "db" | "no_phone";
    dest?: string;
  }>;
}): string {
  const parts: string[] = [];
  if (result.saved && result.saved.length > 0) {
    parts.push(
      result.saved
        .map((row) => {
          const kind = row.composeAtFire
            ? `נשמרה הנחיה להודעה מתוזמנת «${row.item}» ל-${row.fireAt}`
            : `נשמרה התזכורת «${row.item}» ל-${row.fireAt}`;
          const saved = row.ping ? `${kind} (אל ${row.ping}).` : `${kind}.`;
          const others = (row.sameTimeOthers ?? []).filter(Boolean);
          if (others.length === 0) {
            return saved;
          }
          const listed =
            others.length === 1
              ? `«${others[0]}»`
              : others.map((name) => `«${name}»`).join(", ");
          return `${saved} שים לב: יש לך כבר תזכורת אחרת באותה שעה (${listed}).`;
        })
        .join(" "),
    );
  }
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
            : `לא נשמרה «${row.item}» — מתי לשלוח? עכשיו, בעוד X, או שעה קבועה.`,
        )
        .join(" "),
    );
  }
  if (result.removed.length > 0) {
    parts.push(
      result.removed
        .map((name) => `ביטלתי את התזכורת «${name}».`)
        .join(" "),
    );
  }
  if (result.missed.length > 0) {
    parts.push(`לא נמצאה תזכורת פעילה בשם: ${result.missed.join(", ")}.`);
  }
  return parts.join(" ");
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
    ownerId: string;
    messageText: string;
    composeAtFire?: boolean;
    composeSource?: string;
    composeLookbackHours?: number;
    lastComposedText?: string | null;
    status: string;
    sendStatus?: string;
    sentAt?: Date | null;
    updatedAt?: Date | null;
  },
  names: Map<string, string>,
): ReminderSnapshotRow {
  const pings = Array.isArray(row.pingIds) ? row.pingIds.map(String) : [];
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
          : "",
    compose_lookback_hours: lookback,
    status: row.status,
    send_status: sendStatus,
    sent: sendStatus === "sent",
    sent_at: row.sentAt ? formatJerusalemDateTime(row.sentAt) : null,
    changed_at: changedAt,
    ...(row.status === "active" ? reminderRuleSnapshot(row) : {}),
  };
}
