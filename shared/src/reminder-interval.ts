const JERUSALEM_OFFSET_MS = 3 * 60 * 60 * 1000;

const WEEKDAY_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

export const REMINDER_INTERVAL_UNITS = [
  "seconds",
  "minutes",
  "hours",
  "days",
  "weeks",
  "months",
  "weekdays",
] as const;

export type ReminderIntervalUnit = (typeof REMINDER_INTERVAL_UNITS)[number];

export interface ReminderInterval {
  count: number;
  unit: ReminderIntervalUnit;
  weekdays?: number[];
}

const UNIT_SET = new Set<string>(REMINDER_INTERVAL_UNITS);
const COUNT_UNITS = new Set<ReminderIntervalUnit>([
  "seconds",
  "minutes",
  "hours",
  "days",
  "weeks",
  "months",
]);

export function parseStoredRepeat(value: string): ReminderInterval | null {
  return parseStructuredRepeatToken(value);
}

export function serializeReminderRepeat(interval: ReminderInterval | null): string {
  if (!interval || interval.count < 1) {
    return "once";
  }
  if (interval.unit === "weekdays") {
    const days = normalizeWeekdays(interval.weekdays);
    return days.length > 0 ? `weekdays:${days.join(",")}` : "once";
  }
  return `${interval.count}:${interval.unit}`;
}

export function israelWeekday(value: Date): number {
  return new Date(value.getTime() + JERUSALEM_OFFSET_MS).getUTCDay();
}

export function nextWeekdayFireAt(
  from: Date,
  weekdays: number[],
  skipStart: boolean,
): Date {
  const wanted = new Set(weekdays.filter((day) => day >= 0 && day <= 6));
  if (wanted.size === 0) {
    return new Date(from.getTime() + 24 * 60 * 60 * 1000);
  }
  let cursor = skipStart
    ? new Date(from.getTime() + 24 * 60 * 60 * 1000)
    : new Date(from.getTime());
  for (let step = 0; step < 14; step += 1) {
    if (wanted.has(israelWeekday(cursor))) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return cursor;
}

export function addReminderInterval(from: Date, interval: ReminderInterval): Date {
  if (interval.unit === "weekdays") {
    return nextWeekdayFireAt(from, interval.weekdays ?? [], true);
  }
  const count = Math.max(1, interval.count);
  if (interval.unit === "months") {
    const next = new Date(from.getTime());
    next.setUTCMonth(next.getUTCMonth() + count);
    return next;
  }
  const ms =
    interval.unit === "seconds"
      ? 1000
      : interval.unit === "minutes"
        ? 60_000
        : interval.unit === "hours"
          ? 3_600_000
          : interval.unit === "days"
            ? 86_400_000
            : 7 * 86_400_000;
  return new Date(from.getTime() + count * ms);
}

export function formatReminderIntervalHe(repeat: string): string {
  const interval = parseStoredRepeat(repeat);
  if (!interval) {
    return "";
  }
  if (interval.unit === "weekdays") {
    const names = (interval.weekdays ?? [])
      .filter((day) => day >= 0 && day <= 6)
      .sort((left, right) => left - right)
      .map((day) => WEEKDAY_HE[day]);
    if (names.length === 0) {
      return "";
    }
    if (names.length === 1) {
      return `כל ${names[0]}`;
    }
    return `כל ${names.slice(0, -1).join(", ")} ו${names[names.length - 1]}`;
  }
  if (interval.count === 1) {
    if (interval.unit === "hours") {
      return "כל שעה";
    }
    if (interval.unit === "days") {
      return "כל יום";
    }
    if (interval.unit === "weeks") {
      return "כל שבוע";
    }
    if (interval.unit === "months") {
      return "כל חודש";
    }
    if (interval.unit === "minutes") {
      return "כל דקה";
    }
    return "כל שנייה";
  }
  if (interval.unit === "hours") {
    return interval.count === 2 ? "כל שעתיים" : `כל ${interval.count} שעות`;
  }
  if (interval.unit === "days") {
    return `כל ${interval.count} ימים`;
  }
  if (interval.unit === "weeks") {
    return `כל ${interval.count} שבועות`;
  }
  if (interval.unit === "months") {
    return `כל ${interval.count} חודשים`;
  }
  if (interval.unit === "minutes") {
    return `כל ${interval.count} דקות`;
  }
  return `כל ${interval.count} שניות`;
}

export function parseReminderInterval(
  record: Record<string, unknown>,
): ReminderInterval | null {
  const listed = parseWeekdayNumberList(
    record.weekdays ?? record.days ?? record.week_days,
  );
  if (listed.length > 0) {
    return { count: 1, unit: "weekdays", weekdays: listed };
  }

  const count = asPositiveInt(record.every_count ?? record.everyCount);
  const unit = asUnit(record.every_unit ?? record.everyUnit);
  if (count && unit && COUNT_UNITS.has(unit)) {
    return { count, unit };
  }

  const raw =
    record.every ?? record.interval ?? record.every_interval ?? record.repeat;
  if (typeof raw === "number" && raw > 0) {
    return { count: Math.round(raw), unit: "seconds" };
  }
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  return parseStructuredRepeatToken(raw);
}

function parseStructuredRepeatToken(value: string): ReminderInterval | null {
  const raw = value.trim().toLowerCase();
  if (!raw || raw === "once") {
    return null;
  }
  if (raw === "hourly") {
    return { count: 1, unit: "hours" };
  }
  if (raw === "daily") {
    return { count: 1, unit: "days" };
  }
  if (raw === "weekly") {
    return { count: 1, unit: "weeks" };
  }
  if (raw === "monthly") {
    return { count: 1, unit: "months" };
  }
  const weekdaysStored = raw.match(/^weekdays:([\d,]+)$/);
  if (weekdaysStored) {
    const weekdays = parseWeekdayNumbers(weekdaysStored[1]);
    if (weekdays.length > 0) {
      return { count: 1, unit: "weekdays", weekdays };
    }
  }
  const encoded = raw.match(
    /^(\d+):(seconds|minutes|hours|days|weeks|months)$/,
  );
  if (encoded) {
    return { count: Number(encoded[1]), unit: encoded[2] as ReminderIntervalUnit };
  }
  return null;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const count = Number(value.trim());
    return count > 0 ? count : null;
  }
  return null;
}

function asUnit(value: unknown): ReminderIntervalUnit | null {
  if (typeof value !== "string") {
    return null;
  }
  const unit = value.trim().toLowerCase();
  if (UNIT_SET.has(unit)) {
    return unit as ReminderIntervalUnit;
  }
  return null;
}

function normalizeWeekdays(weekdays: number[] | undefined): number[] {
  return [
    ...new Set((weekdays ?? []).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)),
  ].sort((left, right) => left - right);
}

function parseWeekdayNumbers(raw: string): number[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
    ),
  ].sort((left, right) => left - right);
}

function asWeekdayInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const day = Number(value.trim());
    return day >= 0 && day <= 6 ? day : null;
  }
  return null;
}

function parseWeekdayNumberList(value: unknown): number[] {
  if (Array.isArray(value)) {
    return normalizeWeekdays(
      value.map((item) => asWeekdayInt(item)).filter((day): day is number => day !== null),
    );
  }
  const single = asWeekdayInt(value);
  if (single !== null) {
    return [single];
  }
  if (typeof value === "string" && /^[\d,\s]+$/.test(value.trim())) {
    return parseWeekdayNumbers(value);
  }
  return [];
}
