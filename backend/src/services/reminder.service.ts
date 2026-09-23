import type { LlmReminderAction, PublicEmployee } from "@workee/shared";
import { prisma } from "../database/prisma.js";

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

function displayName(employee: PublicEmployee): string {
  return employee.nickname?.trim() || employee.name;
}

function matchEmployee(
  name: string,
  employees: PublicEmployee[],
): PublicEmployee | undefined {
  const needle = name.trim().toLowerCase();
  return employees.find((employee) => {
    const aliases = [
      employee.nickname,
      employee.name,
      `${employee.name} ${employee.surname}`.trim(),
    ]
      .filter((value): value is string => Boolean(value && value.trim()))
      .map((value) => value.trim().toLowerCase());
    return aliases.includes(needle);
  });
}

function pingIdsFor(
  reminder: LlmReminderAction,
  employees: PublicEmployee[],
  fallbackId: string,
): string[] {
  const ids = reminder.ping
    .map((name) => matchEmployee(name, employees)?.id)
    .filter((id): id is string => Boolean(id));
  return ids.length > 0 ? [...new Set(ids)] : [fallbackId];
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
}): Promise<void> {
  if (!prisma.reminder) {
    return;
  }
  for (const reminder of input.reminders) {
    const ownerId = ownerIdFor(reminder, input.employees, input.actor.id);
    const key = itemKey(reminder.item);
    if (!key) {
      continue;
    }

    if (reminder.action === "remove") {
      await prisma.reminder.updateMany({
        where: {
          userId: input.userId,
          ownerId,
          itemKey: key,
          status: "active",
        },
        data: { status: "cancelled" },
      });
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

    const pingIds = pingIdsFor(reminder, input.employees, input.actor.id);
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
