import type { LlmReminderAction, PublicEmployee } from "@workee/shared";
import {
  addReminderInterval,
  formatReminderIntervalHe,
  nextWeekdayFireAt,
  serializeReminderRepeat,
  type ReminderInterval,
} from "@workee/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { isMissingTableError } from "../utils/errors.js";
import { looksLikePhone, normalizePhoneDigits, phonesMatch } from "../utils/phone.js";
import { matchContact, type SpeakerContact } from "./contact.service.js";
import { scheduleSoon } from "./reminder-fire.js";

const JERUSALEM_OFFSET_MS = 3 * 60 * 60 * 1000;

export function formatJerusalemDateTime(value: Date): string {
  const local = new Date(value.getTime() + JERUSALEM_OFFSET_MS);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

export interface ReminderSnapshotRow {
  item: string;
  list_type: string;
  fire_at: string;
  repeat: string;
  ping: string[];
  ping_ids: string[];
  owner: string;
  text: string;
  compose_at_fire: boolean;
  compose_source: string;
  status: string;
  send_status: "pending" | "sent" | "failed";
  sent: boolean;
  sent_at: string | null;
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
    "action" | "text" | "time" | "inSeconds" | "everyCount" | "everyUnit" | "weekdays"
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
    Boolean(reminder.weekdays && reminder.weekdays.length > 0);
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

  const localNow = new Date(now.getTime() + JERUSALEM_OFFSET_MS);
  const y = localNow.getUTCFullYear();
  const m = localNow.getUTCMonth();
  const d = localNow.getUTCDate();
  const relative = dateText.trim().toLowerCase();

  let year = y;
  let month = m;
  let day = d;
  if (relative === "") {
    if (!timeText.trim()) {
      return interval ? addReminderInterval(now, interval) : null;
    }
  } else {
    const iso = relative.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
      year = Number(iso[1]);
      month = Number(iso[2]) - 1;
      day = Number(iso[3]);
    }
  }

  const time = parseClock(timeText);
  if (!time) {
    return interval ? addReminderInterval(now, interval) : null;
  }

  let fireAt = new Date(Date.UTC(year, month, day, time.hour - 3, time.minute));
  while (fireAt.getTime() <= now.getTime()) {
    fireAt = new Date(fireAt.getTime() + 24 * 60 * 60 * 1000);
  }
  if (interval?.weekdays?.length) {
    fireAt = nextWeekdayFireAt(fireAt, interval.weekdays, false);
    while (fireAt.getTime() <= now.getTime()) {
      fireAt = nextWeekdayFireAt(fireAt, interval.weekdays, true);
    }
  }
  return fireAt;
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
    if (!item) {
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

function isMissingRecord(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025"
  );
}

export async function removeReminderAndLinkedWorkerTask(match: {
  id: string;
  workerItemId?: string | null;
}): Promise<void> {
  const workerItemId = match.workerItemId ?? null;
  if (prisma.employeeListItem?.deleteMany) {
    await prisma.employeeListItem.deleteMany({
      where: {
        OR: [
          { reminderId: match.id },
          ...(workerItemId ? [{ id: workerItemId }] : []),
        ],
      },
    });
  }
  if (!prisma.reminder?.delete) {
    return;
  }
  try {
    await prisma.reminder.delete({ where: { id: match.id } });
  } catch (error) {
    if (isMissingTableError(error) || isMissingRecord(error)) {
      return;
    }
    throw error;
  }
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
    const digits = (employee.phone ?? "").replace(/\D/g, "");
    if (digits.length >= 4) {
      return `…${digits.slice(-4)}`;
    }
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

export const PENDING_DELETE_TIMEOUT_MS = 15 * 60 * 1000;

export type PendingDeleteAction = {
  action: "delete_reminder";
  step: "confirm";
  targets: string[];
  at: Date;
};

export type ReminderWritePlan = {
  apply: LlmReminderAction[];
  ask: LlmReminderAction[];
  cancelled: boolean;
  noneToDelete: boolean;
  nextPending: PendingDeleteAction | null;
};

function emptyPlan(
  apply: LlmReminderAction[] = [],
  extras: Partial<ReminderWritePlan> = {},
): ReminderWritePlan {
  return {
    apply,
    ask: [],
    cancelled: false,
    noneToDelete: false,
    nextPending: null,
    ...extras,
  };
}

function removeShell(item: string): LlmReminderAction {
  return {
    action: "remove",
    item,
    listType: "tasks",
    date: "",
    time: "",
    repeat: "once",
    ping: [],
    targets: [],
    text: "",
    inSeconds: null,
    everyCount: null,
    everyUnit: null,
    weekdays: null,
    confirmed: false,
    compose: false,
    composeSource: "",
  };
}

export function pendingFromStored(row: {
  pendingAction: string | null;
  pendingTargets: unknown;
  pendingStep: string | null;
  pendingAt: Date | null;
} | null): PendingDeleteAction | null {
  if (!row || row.pendingAction !== "delete_reminder" || row.pendingStep !== "confirm") {
    return null;
  }
  const targets = Array.isArray(row.pendingTargets)
    ? row.pendingTargets.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  if (targets.length === 0 || !row.pendingAt) {
    return null;
  }
  return {
    action: "delete_reminder",
    step: "confirm",
    targets,
    at: row.pendingAt,
  };
}

export function formatPendingActionContext(
  pending: PendingDeleteAction | null,
): string {
  if (!pending) {
    return "";
  }
  return [
    "PENDING_ACTION_STATE:",
    `current_action: ${pending.action}`,
    `current_target: ${pending.targets.join(", ")}`,
    `current_step: ${pending.step}`,
    "Stay inside this action until the server clears it.",
    "A reminder name from the speaker selects/narrows targets — it is NOT a send or new command.",
    "Yes / confirm → metadata.confirm=true and empty reminders.",
    "No / cancel → metadata.confirm=false and empty reminders.",
    "Do not emit messages, lists, or reminder adds while current_step is confirm.",
  ].join("\n");
}

export function hasUnrelatedWorkWhilePending(input: {
  confirm: boolean | null;
  reminders: LlmReminderAction[];
  messages: Array<{ text: string; targets: string[] }>;
  lists: unknown[];
  filing: unknown[];
}): boolean {
  if (input.confirm !== null) {
    return false;
  }
  if (input.reminders.some((row) => row.action === "add" || row.action === "update")) {
    return true;
  }
  if (
    input.messages.some(
      (row) => row.text.trim().length > 0 && row.targets.length > 0,
    )
  ) {
    return true;
  }
  if (input.lists.length > 0 || input.filing.length > 0) {
    return true;
  }
  return false;
}

/** Pure planner: pending delete lives in nextPending, not an in-memory Map. */
export function planReminderWrites(
  incoming: LlmReminderAction[],
  confirm: boolean | null = null,
  stored: PendingDeleteAction | null = null,
  options: { now?: Date; timeoutMs?: number; abandonPending?: boolean } = {},
): ReminderWritePlan {
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? PENDING_DELETE_TIMEOUT_MS;
  const adds = incoming.filter(
    (row) => row.action === "add" || row.action === "update",
  );
  const mutations = incoming.filter(
    (row) => row.action === "remove" && row.item.trim() !== "",
  );
  const ready = mutations.filter((row) => row.confirmed);
  const waiting = mutations.filter((row) => !row.confirmed);

  let pending = stored;
  if (
    pending &&
    now.getTime() - pending.at.getTime() > timeoutMs
  ) {
    pending = null;
    if (confirm === null && waiting.length === 0 && ready.length === 0) {
      return emptyPlan(adds, { cancelled: true });
    }
  }

  if (options.abandonPending && pending) {
    return emptyPlan(adds, { cancelled: true, nextPending: null });
  }

  if (pending && confirm === false) {
    return emptyPlan(adds, { cancelled: true });
  }

  if (pending && confirm === true) {
    const held = pending.targets.map(removeShell);
    return emptyPlan([...adds, ...held]);
  }

  if (ready.length > 0 && waiting.length === 0) {
    return emptyPlan([...adds, ...ready]);
  }

  if (waiting.length > 0) {
    const targets = waiting.map((row) => row.item.trim()).filter(Boolean);
    return {
      apply: [...adds, ...ready],
      ask: waiting,
      cancelled: false,
      noneToDelete: false,
      nextPending: {
        action: "delete_reminder",
        step: "confirm",
        targets,
        at: pending?.at ?? now,
      },
    };
  }

  if (pending) {
    return emptyPlan(adds, {
      nextPending: pending,
    });
  }

  return emptyPlan(adds);
}

export function formatReminderConfirmNotice(
  ask: LlmReminderAction[],
  cancelled: boolean,
  noneToDelete = false,
): string {
  if (cancelled) {
    return "לא שיניתי ולא מחקתי כלום.";
  }
  if (noneToDelete) {
    return "אין תזכורות פעילות למחוק.";
  }
  if (ask.length === 0) {
    return "";
  }
  const names = ask.map((row) => row.item).filter(Boolean);
  if (names.length === 1) {
    return `למחוק את «${names[0]}»?`;
  }
  return `למחוק את אלה: ${names.join(", ")}?`;
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
    const key = itemKey(reminder.item);
    if (!key) {
      continue;
    }

    if (reminder.action === "remove") {
      const ownerId = ownerIdFor(reminder, input.employees, input.actor.id);
      const cancelled = await cancelActiveReminder(
        input.userId,
        ownerId,
        reminder.item,
      );
      if (cancelled) {
        removed.push(cancelled);
      } else {
        // Also try across the account — clocks may be owned by another human.
        const any = await cancelActiveReminderAnyOwner(
          input.userId,
          reminder.item,
        );
        if (any) {
          removed.push(any);
        } else {
          missed.push(reminder.item.trim());
        }
      }
      continue;
    }

    const interval = intervalOf(reminder);
    let fireAt = resolveReminderFireAt(
      reminder.date,
      reminder.time,
      new Date(),
      reminder.inSeconds,
      interval,
    );

    const rows = await prisma.reminder.findMany({
      where: { userId: input.userId, status: "active" },
    });
    const existing = findMatchingActiveReminder(rows, reminder.item);
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
    if (pingIds.length === 0 && existing && canReuseClock) {
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
      const nextRepeat = interval
        ? serializeReminderRepeat(interval)
        : existing && canReuseClock
          ? existing.repeat
          : serializeReminderRepeat(null);
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
          : "";
      const row = existing
        ? await prisma.reminder.update({
            where: { id: existing.id },
            data: {
              itemLabel: label,
              listType: reminder.listType || existing.listType,
              fireAt,
              repeat: nextRepeat,
              pingIds,
              messageText: nextText,
              composeAtFire: nextCompose || nextSource === "git_log",
              composeSource: nextSource,
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
              pingIds,
              messageText: nextText,
              composeAtFire: nextCompose || nextSource === "git_log",
              composeSource: nextSource,
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
            : `לא נשמרה «${row.item}» — חסר זמן תזכורת (שעה או in).`,
        )
        .join(" "),
    );
  }
  if (result.removed.length > 0) {
    parts.push(`נמחק: ${result.removed.join(", ")}.`);
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
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    return await prisma.reminder.findMany({
      where: {
        userId,
        OR: [{ status: "active" }, { status: "done", fireAt: { gte: since } }],
      },
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
    itemLabel: string;
    listType: string;
    fireAt: Date;
    repeat: string;
    pingIds: unknown;
    ownerId: string;
    messageText: string;
    composeAtFire?: boolean;
    composeSource?: string;
    status: string;
    sendStatus?: string;
    sentAt?: Date | null;
  },
  names: Map<string, string>,
): ReminderSnapshotRow {
  const pings = Array.isArray(row.pingIds) ? row.pingIds.map(String) : [];
  const sendStatus =
    row.sendStatus === "sent" || row.sendStatus === "failed"
      ? row.sendStatus
      : "pending";
  return {
    item: row.itemLabel,
    list_type: row.listType,
    fire_at: formatJerusalemDateTime(row.fireAt),
    repeat: row.repeat,
    ping: pings.map((id) => names.get(id) ?? id),
    ping_ids: pings,
    owner: names.get(row.ownerId) ?? row.ownerId,
    text: row.messageText,
    compose_at_fire: row.composeAtFire === true,
    compose_source: row.composeSource === "git_log" ? "git_log" : "",
    status: row.status,
    send_status: sendStatus,
    sent: sendStatus === "sent",
    sent_at: row.sentAt ? formatJerusalemDateTime(row.sentAt) : null,
  };
}
