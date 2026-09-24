import type { LlmReminderAction, PublicEmployee } from "@workee/shared";
import {
  addReminderInterval,
  formatReminderIntervalHe,
  nextWeekdayFireAt,
  parseStoredRepeat,
  serializeReminderRepeat,
  type ReminderInterval,
} from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { isMissingTableError } from "../utils/errors.js";
import { looksLikePhone, normalizePhoneDigits, phonesMatch } from "../utils/phone.js";
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
  owner: string;
  text: string;
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
  return parseStoredRepeat(reminder.repeat);
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
  if (relative === "tomorrow") {
    const next = new Date(Date.UTC(y, m, d + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth();
    day = next.getUTCDate();
  } else if (relative === "today" || relative === "") {
    if (!timeText.trim() && !dateText.trim()) {
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

export function reminderLabelsMatch(stored: string, wanted: string): boolean {
  const left = itemKey(stored);
  const right = itemKey(wanted);
  if (!left || !right || right.length < 2) {
    return left === right;
  }
  return left === right || left.includes(right) || right.includes(left);
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
  await prisma.reminder.update({
    where: { id: match.id },
    data: { status: "cancelled" },
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
): string[] {
  const named = [
    ...reminder.ping,
    ...(reminder.targets ?? []),
  ];
  const unknown: string[] = [];
  for (const raw of named) {
    if (destPhoneToken(raw) || matchEmployee(raw, employees)) {
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

const pendingReminderMutations = new Map<string, LlmReminderAction[]>();

function isAllReminderItem(item: string): boolean {
  return item.trim().toLowerCase() === "all";
}

function removesForItems(
  items: Array<{ item: string; listType: string }>,
): LlmReminderAction[] {
  return items.map((row) => ({
    action: "remove" as const,
    item: row.item,
    listType: (row.listType === "tasks" ? "tasks" : "shopping") as
      | "shopping"
      | "tasks",
    date: "",
    time: "",
    repeat: "once" as const,
    ping: [],
    targets: [],
    text: "",
    inSeconds: null,
    everyCount: null,
    everyUnit: null,
    weekdays: null,
    confirmed: false,
  }));
}

export function planReminderWrites(
  conversationId: string,
  incoming: LlmReminderAction[],
  existingItems: Array<{ item: string; listType: string }> = [],
  confirm: boolean | null = null,
): {
  apply: LlmReminderAction[];
  ask: LlmReminderAction[];
  cancelled: boolean;
  noneToDelete: boolean;
} {
  const adds = incoming.filter(
    (row) => row.action === "add" || row.action === "update",
  );
  const mutations = incoming.filter((row) => row.action === "remove");
  const ready = mutations.filter(
    (row) => row.confirmed && !isAllReminderItem(row.item),
  );
  let waiting = mutations.filter(
    (row) => !row.confirmed && !isAllReminderItem(row.item),
  );
  const pending = pendingReminderMutations.get(conversationId) ?? [];
  const incomingAll = mutations.filter((row) => isAllReminderItem(row.item));

  if (incomingAll.length > 0) {
    const expanded =
      pending.length > 0 ? pending : removesForItems(existingItems);
    if (expanded.length === 0) {
      pendingReminderMutations.delete(conversationId);
      return {
        apply: adds,
        ask: [],
        cancelled: false,
        noneToDelete: true,
      };
    }
    const go =
      confirm === true || incomingAll.some((row) => row.confirmed);
    if (go) {
      pendingReminderMutations.delete(conversationId);
      return {
        apply: [...adds, ...expanded],
        ask: [],
        cancelled: false,
        noneToDelete: false,
      };
    }
    pendingReminderMutations.set(conversationId, expanded);
    return {
      apply: adds,
      ask: expanded,
      cancelled: false,
      noneToDelete: false,
    };
  }

  if (ready.length > 0 && waiting.length === 0) {
    pendingReminderMutations.delete(conversationId);
    return {
      apply: [...adds, ...ready],
      ask: [],
      cancelled: false,
      noneToDelete: false,
    };
  }

  if (waiting.length > 0) {
    pendingReminderMutations.set(conversationId, waiting);
    return { apply: [...adds, ...ready], ask: waiting, cancelled: false, noneToDelete: false };
  }

  if (pending.length > 0 && confirm === false) {
    pendingReminderMutations.delete(conversationId);
    return { apply: adds, ask: [], cancelled: true, noneToDelete: false };
  }

  if (pending.length > 0 && confirm === true) {
    pendingReminderMutations.delete(conversationId);
    return { apply: [...adds, ...pending], ask: [], cancelled: false, noneToDelete: false };
  }

  return { apply: adds, ask: [], cancelled: false, noneToDelete: false };
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
}): Promise<{
  removed: string[];
  missed: string[];
  saved: Array<{ item: string; fireAt: string; ping?: string }>;
  skipped: Array<{
    item: string;
    reason: "no_time" | "db" | "no_phone";
    dest?: string;
  }>;
}> {
  const removed: string[] = [];
  const missed: string[] = [];
  const saved: Array<{ item: string; fireAt: string; ping?: string }> = [];
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
    const ownerId = ownerIdFor(reminder, input.employees, input.actor.id);
    const key = itemKey(reminder.item);
    if (!key) {
      continue;
    }

    if (reminder.action === "remove") {
      const cancelled = await cancelActiveReminder(
        input.userId,
        ownerId,
        reminder.item,
      );
      if (cancelled) {
        removed.push(cancelled);
      } else {
        missed.push(reminder.item.trim());
      }
      continue;
    }

    const interval = intervalOf(reminder);
    const fireAt = resolveReminderFireAt(
      reminder.date,
      reminder.time,
      new Date(),
      reminder.inSeconds,
      interval,
    );
    if (!fireAt) {
      skipped.push({ item: reminder.item.trim(), reason: "no_time" });
      continue;
    }

    const pingIds = resolveReminderPingDestinations(
      reminder,
      input.employees,
      input.actor.id,
    );
    if (pingIds.length === 0) {
      skipped.push({
        item: reminder.item.trim(),
        reason: "no_phone",
        dest: unknownDestNames(reminder, input.employees).join(", "),
      });
      continue;
    }

    try {
      const existing = await prisma.reminder.findFirst({
        where: {
          userId: input.userId,
          ownerId,
          itemKey: key,
          status: "active",
        },
      });

      if (existing) {
        await prisma.reminder.update({
          where: { id: existing.id },
          data: {
            itemLabel: reminder.item.trim().slice(0, 255),
            listType: reminder.listType,
            fireAt,
            repeat: serializeReminderRepeat(interval),
            pingIds,
            messageText: reminder.text.trim().slice(0, 4096),
          },
        });
      } else {
        await prisma.reminder.create({
          data: {
            userId: input.userId,
            ownerId,
            actorId: input.actor.id,
            itemKey: key,
            itemLabel: reminder.item.trim().slice(0, 255),
            listType: reminder.listType,
            fireAt,
            repeat: serializeReminderRepeat(interval),
            pingIds,
            messageText: reminder.text.trim().slice(0, 4096),
          },
        });
      }
      saved.push({
        item: reminder.item.trim(),
        fireAt: formatJerusalemDateTime(fireAt),
        ping: pingIds
          .map((id) => formatPingLabel(id, input.employees))
          .join(","),
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

export function formatReminderApplyNotice(result: {
  removed: string[];
  missed: string[];
  saved?: Array<{ item: string; fireAt: string; ping?: string }>;
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
        .map((row) =>
          row.ping
            ? `נשמרה התזכורת «${row.item}» ל-${row.fireAt} (אל ${row.ping}).`
            : `נשמרה התזכורת «${row.item}» ל-${row.fireAt}.`,
        )
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
    owner: names.get(row.ownerId) ?? row.ownerId,
    text: row.messageText,
    status: row.status,
    send_status: sendStatus,
    sent: sendStatus === "sent",
    sent_at: row.sentAt ? formatJerusalemDateTime(row.sentAt) : null,
  };
}
