const JERUSALEM_OFFSET_MS = 3 * 60 * 60 * 1000;

const WEEKDAY_ALIASES: Record<string, number> = {
  sunday: 0,
  sun: 0,
  ראשון: 0,
  monday: 1,
  mon: 1,
  שני: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  שלישי: 2,
  wednesday: 3,
  wed: 3,
  רביעי: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  חמישי: 4,
  friday: 5,
  fri: 5,
  שישי: 5,
  saturday: 6,
  sat: 6,
  שבת: 6,
};

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

export function parseStoredRepeat(value: string): ReminderInterval | null {
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
  return parseIntervalText(raw);
}

export function serializeReminderRepeat(interval: ReminderInterval | null): string {
  if (!interval || interval.count < 1) {
    return "once";
  }
  if (interval.unit === "weekdays") {
    const days = [...new Set(interval.weekdays ?? [])]
      .filter((day) => day >= 0 && day <= 6)
      .sort((left, right) => left - right);
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
  const listed = parseWeekdayList(
    record.weekdays ?? record.days ?? record.week_days,
  );
  if (listed.length > 0) {
    return { count: 1, unit: "weekdays", weekdays: listed };
  }
  const countRaw = record.every_count ?? record.everyCount;
  const unitRaw = record.every_unit ?? record.everyUnit;
  if (typeof countRaw === "number" && typeof unitRaw === "string") {
    const unit = unitRaw.trim().toLowerCase();
    if (countRaw > 0 && UNIT_SET.has(unit)) {
      return { count: Math.round(countRaw), unit: unit as ReminderIntervalUnit };
    }
  }

  const raw =
    record.every ?? record.interval ?? record.every_interval ?? record.repeat;
  if (typeof raw === "number" && raw > 0) {
    return { count: Math.round(raw), unit: "seconds" };
  }
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  return parseIntervalText(raw);
}

function parseIntervalText(text: string): ReminderInterval | null {
  const value = text.trim().toLowerCase();
  if (!value || value === "once") {
    return null;
  }

  const stored = value.match(
    /^(\d+):(seconds|minutes|hours|days|weeks|months)$/,
  );
  if (stored) {
    return { count: Number(stored[1]), unit: stored[2] as ReminderIntervalUnit };
  }

  const counted = value.match(
    /(?:every|כל)?\s*(\d+)\s*(seconds?|sec|שניות|שניה|minutes?|mins?|min|דקות|דקה|hours?|hrs?|hr|שעות|שעה|days?|ימים|יום|weeks?|שבועות|שבוע|months?|חודשים|חודש)/,
  );
  if (counted) {
    const unit = unitFromToken(counted[2]);
    const count = Number(counted[1]);
    if (unit && count > 0) {
      return { count, unit };
    }
  }

  if (/^(hourly|every hour|כל שעה)$/.test(value)) {
    return { count: 1, unit: "hours" };
  }
  if (/^(daily|every day|כל יום)$/.test(value)) {
    return { count: 1, unit: "days" };
  }
  if (/^(weekly|every week|כל שבוע)$/.test(value)) {
    return { count: 1, unit: "weeks" };
  }
  if (/^(monthly|every month|כל חודש)$/.test(value)) {
    return { count: 1, unit: "months" };
  }
  if (/^כל שעתיים$/.test(value)) {
    return { count: 2, unit: "hours" };
  }

  const weekdays = extractWeekdays(value);
  if (weekdays.length > 0) {
    return { count: 1, unit: "weekdays", weekdays };
  }
  return null;
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

function parseWeekdayList(value: unknown): number[] {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .map((item) => weekdayFromToken(String(item)))
          .filter((day): day is number => day !== null),
      ),
    ].sort((left, right) => left - right);
  }
  if (typeof value === "string" && value.trim()) {
    return extractWeekdays(value);
  }
  return [];
}

function extractWeekdays(text: string): number[] {
  const found: number[] = [];
  const tokens = text
    .toLowerCase()
    .split(/[\s,+/]+/u)
    .map((part) => part.replace(/^ו/, "").replace(/^יום/, "").trim())
    .filter(Boolean);
  for (const token of tokens) {
    const day = weekdayFromToken(token);
    if (day !== null && !found.includes(day)) {
      found.push(day);
    }
  }
  return found.sort((left, right) => left - right);
}

function weekdayFromToken(token: string): number | null {
  const key = token.trim().toLowerCase().replace(/^יום\s*/, "");
  if (key in WEEKDAY_ALIASES) {
    return WEEKDAY_ALIASES[key];
  }
  return null;
}

function unitFromToken(token: string): ReminderIntervalUnit | null {
  if (/^(s|sec|seconds?|שניות|שניה)$/.test(token)) {
    return "seconds";
  }
  if (/^(m|min|mins|minutes?|דקות|דקה)$/.test(token)) {
    return "minutes";
  }
  if (/^(h|hr|hrs|hours?|שעות|שעה)$/.test(token)) {
    return "hours";
  }
  if (/^(d|days?|ימים|יום)$/.test(token)) {
    return "days";
  }
  if (/^(w|weeks?|שבועות|שבוע)$/.test(token)) {
    return "weeks";
  }
  if (/^(mo|months?|חודשים|חודש)$/.test(token)) {
    return "months";
  }
  return null;
}
