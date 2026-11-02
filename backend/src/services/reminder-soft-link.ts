/**
 * Soft-link / nested-remind helpers (Phase 1).
 * Fingerprint, exact-key flag, create-or-reuse, no-steal — shared by apply paths.
 */
import {
  JERUSALEM_TIME_ZONE,
  formatJerusalemDateTime,
  jerusalemWallTimeToDate,
  type LlmReminderAction,
  type Recurrence,
} from "@workee/shared";

export const FINGERPRINT_VERSION = "v1";
export const FINGERPRINT_TZ = "Asia/Jerusalem";
export const EXACT_KEY_SOFT_LINK_ENV = "WORKEE_SOFT_LINK_EXACT_KEY";

export type FingerprintRecurrence = {
  freq: string;
  interval: number;
  unit?: string;
  weekdays?: number[];
  monthDay?: number;
  month?: number;
  time?: string;
  endTime?: string;
  until?: string;
  count?: number;
};

export type ClockFingerprintInput = {
  itemId: string;
  resolvedFireAt: Date | null;
  hasExplicitTime: boolean;
  inSeconds: number | null;
  recurrence: FingerprintRecurrence | null;
  ping: string[];
  messageText: string;
  compose: boolean;
  composeSource: string;
  composeMeta: string;
};

export type ExistingLinkedClock = {
  reminderId: string;
  itemId: string;
  status: "active" | "cancelled" | "done";
  fingerprint: string;
};

export type CreateOrReuseDecision =
  | { action: "reuse"; reminderId: string; ensureJoin: true }
  | { action: "create" }
  | { action: "miss"; reason: "unresolved_fire" };

/** absent / 1 / true → ON (default until Phase 3 cutover). 0 / false → OFF. */
export function isExactKeySoftLinkEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[EXACT_KEY_SOFT_LINK_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return true;
  }
  const v = String(raw).trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") {
    return false;
  }
  if (v === "1" || v === "true" || v === "on" || v === "yes") {
    return true;
  }
  return true;
}

export function jerusalemFireToken(
  fireAt: Date,
  hasExplicitTime: boolean,
): string {
  const wall = formatJerusalemDateTime(fireAt);
  const [day, time] = wall.split(" ");
  if (!hasExplicitTime) {
    return `${day}Ttime=none`;
  }
  return `${day}T${time}`;
}

export function stableRecurrenceToken(
  recurrence: FingerprintRecurrence | null,
): string {
  if (!recurrence) {
    return "once";
  }
  const weekdays = [...(recurrence.weekdays ?? [])].sort((a, b) => a - b);
  return JSON.stringify({
    freq: recurrence.freq,
    interval: recurrence.interval,
    unit: recurrence.unit ?? "",
    weekdays,
    monthDay: recurrence.monthDay ?? "",
    month: recurrence.month ?? "",
    time: recurrence.time ?? "",
    endTime: recurrence.endTime ?? "",
    until: recurrence.until ?? "",
    count: recurrence.count ?? "",
  });
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function buildReminderClockFingerprint(
  input: ClockFingerprintInput,
): string | null {
  if (!input.itemId.trim() || !input.resolvedFireAt) {
    return null;
  }
  if (FINGERPRINT_TZ !== JERUSALEM_TIME_ZONE) {
    throw new Error("fingerprint tz drift vs JERUSALEM_TIME_ZONE");
  }
  const fire = jerusalemFireToken(
    input.resolvedFireAt,
    input.hasExplicitTime,
  );
  const inPart =
    input.inSeconds !== null && Number.isFinite(input.inSeconds)
      ? String(Math.trunc(input.inSeconds))
      : "";
  const ping = [...input.ping]
    .map((p) => p.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "he"));
  return [
    FINGERPRINT_VERSION,
    `tz=${FINGERPRINT_TZ}`,
    `item=${input.itemId.trim()}`,
    `fire=${fire}`,
    `in=${inPart}`,
    `rec=${stableRecurrenceToken(input.recurrence)}`,
    `ping=${ping.join(",")}`,
    `text=${normalizeText(input.messageText)}`,
    `compose=${input.compose ? "1" : "0"}`,
    `csrc=${input.composeSource.trim()}`,
    `cmeta=${input.composeMeta.trim()}`,
  ].join("|");
}

export function recurrenceToFingerprint(
  recurrence: Recurrence | null | undefined,
): FingerprintRecurrence | null {
  if (!recurrence) {
    return null;
  }
  return {
    freq: recurrence.freq,
    interval: recurrence.interval,
    ...(recurrence.unit ? { unit: recurrence.unit } : {}),
    ...(recurrence.weekdays ? { weekdays: recurrence.weekdays } : {}),
    ...(recurrence.monthDay != null ? { monthDay: recurrence.monthDay } : {}),
    ...(recurrence.month != null ? { month: recurrence.month } : {}),
    ...(recurrence.time ? { time: recurrence.time } : {}),
    ...(recurrence.endTime ? { endTime: recurrence.endTime } : {}),
    ...(recurrence.until ? { until: recurrence.until } : {}),
    ...(recurrence.count != null ? { count: recurrence.count } : {}),
  };
}

export function composeMetaFromReminder(reminder: LlmReminderAction): string {
  const meta: Record<string, unknown> = {};
  if (reminder.composePlace?.trim()) {
    meta.place = reminder.composePlace.trim();
  }
  if (reminder.composeCondition) {
    meta.condition = reminder.composeCondition;
  }
  if (reminder.composeAspects && reminder.composeAspects.length > 0) {
    meta.aspects = [...reminder.composeAspects].map(String).sort();
  }
  if (reminder.scheduleAnchor) {
    meta.anchor = reminder.scheduleAnchor;
  }
  if (
    typeof reminder.scheduleOffsetMinutes === "number" &&
    Number.isFinite(reminder.scheduleOffsetMinutes) &&
    reminder.scheduleOffsetMinutes !== 0
  ) {
    meta.offset = reminder.scheduleOffsetMinutes;
  }
  return Object.keys(meta).length > 0 ? JSON.stringify(meta) : "";
}

export function fingerprintFromReminderAction(input: {
  itemId: string;
  reminder: LlmReminderAction;
  fireAt: Date;
  /** Explicit HH:mm on ACTION (not inferred). */
  hasExplicitTime: boolean;
  /** Resolved ping labels or ids — same strings used in F.ping. */
  pingKeys: string[];
}): string | null {
  return buildReminderClockFingerprint({
    itemId: input.itemId,
    resolvedFireAt: input.fireAt,
    hasExplicitTime: input.hasExplicitTime,
    inSeconds: input.reminder.inSeconds,
    recurrence: recurrenceToFingerprint(input.reminder.recurrence ?? null),
    ping: input.pingKeys,
    messageText: input.reminder.text || "",
    compose: Boolean(input.reminder.compose),
    composeSource: input.reminder.composeSource || "",
    composeMeta: composeMetaFromReminder(input.reminder),
  });
}

export function resolveJerusalemFireFromParts(input: {
  date: string;
  time?: string | null;
}): { fireAt: Date; hasExplicitTime: boolean } | null {
  const m = input.date.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    return null;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const timeRaw = (input.time ?? "").trim();
  const tm = timeRaw.match(/^(\d{1,2}):(\d{2})$/);
  if (tm) {
    const hour = Number(tm[1]);
    const minute = Number(tm[2]);
    if (hour > 23 || minute > 59) {
      return null;
    }
    return {
      fireAt: jerusalemWallTimeToDate(year, month, day, hour, minute),
      hasExplicitTime: true,
    };
  }
  if (timeRaw !== "") {
    return null;
  }
  return {
    fireAt: jerusalemWallTimeToDate(year, month, day, 12, 0),
    hasExplicitTime: false,
  };
}

export function decideCreateOrReuseClock(input: {
  itemId: string;
  fingerprint: string | null;
  existing: ExistingLinkedClock[];
}): CreateOrReuseDecision {
  if (!input.fingerprint) {
    return { action: "miss", reason: "unresolved_fire" };
  }
  const hit = input.existing.find(
    (row) =>
      row.status === "active" &&
      row.itemId === input.itemId &&
      row.fingerprint === input.fingerprint,
  );
  if (hit) {
    return {
      action: "reuse",
      reminderId: hit.reminderId,
      ensureJoin: true,
    };
  }
  return { action: "create" };
}

export function decideReuseWithoutSteal(input: {
  targetItemId: string;
  reminderId: string;
  joinOwnerItemId: string | null;
}): "reuse_same_item" | "already_joined_same" | "refuse_steal" | "link_orphan" {
  if (input.joinOwnerItemId && input.joinOwnerItemId !== input.targetItemId) {
    return "refuse_steal";
  }
  if (input.joinOwnerItemId === input.targetItemId) {
    return "already_joined_same";
  }
  return "link_orphan";
}

/** Peel nested remind / remind[] from a list item (never persist into data). */
export function splitItemRemind(record: Record<string, unknown>): {
  item: Record<string, unknown>;
  reminds: Record<string, unknown>[];
} {
  const reminds: Record<string, unknown>[] = [];
  const item: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "remind" || key === "reminds") {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            reminds.push(entry as Record<string, unknown>);
          }
        }
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        reminds.push(value as Record<string, unknown>);
      }
      continue;
    }
    item[key] = value;
  }
  return { item, reminds };
}

export function ymdHm(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return jerusalemWallTimeToDate(year, month, day, hour, minute);
}
