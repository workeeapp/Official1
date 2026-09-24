import type { LlmReminderAction, PublicEmployee } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { looksLikePhone, normalizePhoneDigits, phonesMatch } from "../utils/phone.js";

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
  sent: boolean;
  sent_at: string | null;
}

export function resolveReminderFireAt(
  dateText: string,
  timeText: string,
  now = new Date(),
  inSeconds?: number | null,
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
  if (relative === "tomorrow" || relative === "מחר") {
    const next = new Date(Date.UTC(y, m, d + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth();
    day = next.getUTCDate();
  } else if (relative === "today" || relative === "היום" || relative === "") {
    if (!timeText.trim() && !dateText.trim()) {
      return null;
    }
  } else {
    const iso = relative.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!iso) {
      return null;
    }
    year = Number(iso[1]);
    month = Number(iso[2]) - 1;
    day = Number(iso[3]);
  }

  const time = parseClock(timeText);
  if (!time) {
    return null;
  }

  return new Date(Date.UTC(year, month, day, time.hour - 3, time.minute));
}

function parseClock(value: string): { hour: number; minute: number } | null {
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
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
  reminder: Pick<LlmReminderAction, "ping">,
  employees: PublicEmployee[],
  fallbackId: string,
): string[] {
  const dest: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    if (!seen.has(value)) {
      seen.add(value);
      dest.push(value);
    }
  };

  for (const raw of reminder.ping) {
    const employee = matchEmployee(raw, employees);
    if (employee) {
      add(employee.id);
      continue;
    }
    if (looksLikePhone(raw)) {
      add(normalizePhoneDigits(raw));
    }
  }

  return dest.length > 0 ? dest : [fallbackId];
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
  return /^(all|\*|כל|הכל|כולן|כולם|כל התזכורות)$/iu.test(item.trim());
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
  const adds = incoming.filter((row) => row.action === "add");
  const mutations = incoming.filter(
    (row) => row.action === "remove" || row.action === "update",
  );
  const ready = mutations.filter((row) => row.confirmed);
  let waiting = mutations.filter((row) => !row.confirmed);
  const pending = pendingReminderMutations.get(conversationId) ?? [];

  const wantsAll = waiting.some(
    (row) => row.action === "remove" && isAllReminderItem(row.item),
  );

  if (wantsAll) {
    waiting = removesForItems(existingItems);
    if (waiting.length === 0) {
      pendingReminderMutations.delete(conversationId);
      return {
        apply: [...adds, ...ready],
        ask: [],
        cancelled: false,
        noneToDelete: true,
      };
    }
  }

  if (ready.length > 0 && waiting.length === 0) {
    pendingReminderMutations.delete(conversationId);
    return { apply: [...adds, ...ready], ask: [], cancelled: false, noneToDelete: false };
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
  const removes = ask.filter((row) => row.action === "remove");
  if (removes.length > 1 && removes.length === ask.length) {
    const names = removes.map((row) => row.item).join(", ");
    return `עוד לא בוצע. לאשר מחיקה של כל התזכורות הפעילות (${names})? כן / לא.`;
  }
  return ask
    .map((row) => {
      const verb = row.action === "remove" ? "למחוק" : "לעדכן";
      return `עוד לא בוצע. לאשר ${verb} את התזכורת «${row.item}»? כן / לא.`;
    })
    .join("\n");
}

export async function applyReminders(input: {
  userId: string;
  actor: PublicEmployee;
  employees: PublicEmployee[];
  reminders: LlmReminderAction[];
}): Promise<{ removed: string[]; missed: string[] }> {
  const removed: string[] = [];
  const missed: string[] = [];
  if (!prisma.reminder) {
    return { removed, missed };
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

    const fireAt = resolveReminderFireAt(
      reminder.date,
      reminder.time,
      new Date(),
      reminder.inSeconds,
    );
    if (!fireAt) {
      continue;
    }

    const pingIds = resolveReminderPingDestinations(
      reminder,
      input.employees,
      input.actor.id,
    );
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
          repeat: reminder.repeat,
          pingIds,
          messageText: reminder.text.trim().slice(0, 4096),
        },
      });
      continue;
    }

    await prisma.reminder.create({
      data: {
        userId: input.userId,
        ownerId,
        actorId: input.actor.id,
        itemKey: key,
        itemLabel: reminder.item.trim().slice(0, 255),
        listType: reminder.listType,
        fireAt,
        repeat: reminder.repeat,
        pingIds,
        messageText: reminder.text.trim().slice(0, 4096),
      },
    });
  }
  return { removed, missed };
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
      const daily = row.repeat === "daily" ? ", כל יום" : "";
      return `- ${row.item} (${row.fire_at}${daily})`;
    }),
  ].join("\n");
}

export function formatReminderApplyNotice(result: {
  removed: string[];
  missed: string[];
}): string {
  const parts: string[] = [];
  if (result.removed.length > 0) {
    parts.push(`נמחק: ${result.removed.join(", ")}.`);
  }
  if (result.missed.length > 0) {
    parts.push(`לא נמצאה תזכורת פעילה בשם: ${result.missed.join(", ")}.`);
  }
  return parts.join(" ");
}

export async function listVisibleReminders(
  userId: string,
  employeeId: string,
  employees: PublicEmployee[],
): Promise<ReminderSnapshotRow[]> {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const rows = await prisma.reminder.findMany({
    where: {
      userId,
      OR: [{ status: "active" }, { status: "done", fireAt: { gte: since } }],
    },
    orderBy: { fireAt: "asc" },
  });
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
  },
  names: Map<string, string>,
): ReminderSnapshotRow {
  const pings = Array.isArray(row.pingIds) ? row.pingIds.map(String) : [];
  const sent = row.status === "done";
  return {
    item: row.itemLabel,
    list_type: row.listType,
    fire_at: formatJerusalemDateTime(row.fireAt),
    repeat: row.repeat,
    ping: pings.map((id) => names.get(id) ?? id),
    owner: names.get(row.ownerId) ?? row.ownerId,
    text: row.messageText,
    status: row.status,
    sent,
    sent_at: sent ? formatJerusalemDateTime(row.fireAt) : null,
  };
}
