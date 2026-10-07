import { jerusalemParts, jerusalemWallTimeToDate } from "./jerusalem-time.js";
import type { ReminderInterval } from "./reminder-interval.js";

/**
 * One structured repeat rule for clocks and tasks, emitted by the model as
 * `recurrence` and stored as-is. All calendar math runs on Asia/Jerusalem wall time.
 */
export const RECURRENCE_FREQS = ["interval", "daily", "weekly", "monthly", "yearly"] as const;
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number];
export type RecurrenceUnit = "seconds" | "minutes" | "hours";

export interface Recurrence {
  freq: RecurrenceFreq;
  /** Every N units / days / weeks / months / years. */
  interval: number;
  /** Only for freq=interval. */
  unit?: RecurrenceUnit;
  /** 0 = Sunday … 6 = Saturday (weekly). */
  weekdays?: number[];
  /** 1–31 (monthly / yearly); clamped to short months. */
  monthDay?: number;
  /** 1–12 (yearly). */
  month?: number;
  /** HH:mm on Jerusalem clocks. */
  time?: string;
  /** Last allowed calendar day, YYYY-MM-DD, inclusive. */
  until?: string;
  /** Total occurrences, including the first. */
  count?: number;
}

const UNIT_MS: Record<RecurrenceUnit, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
};

const WEEKDAY_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const MONTH_HE = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.round(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return parsed >= 1 ? parsed : null;
  }
  return null;
}

function clockText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return "";
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return "";
  }
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function ymdText(value: unknown): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
    ? value.trim()
    : "";
}

function weekdayList(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : [];
  return [
    ...new Set(
      raw
        .map((entry) => (typeof entry === "string" ? Number(entry.trim()) : entry))
        .filter(
          (day): day is number => typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6,
        ),
    ),
  ].sort((left, right) => left - right);
}

/** Read the model's `recurrence` object (snake or camel case). null / "none" → no repeat. */
export function parseRecurrence(value: unknown): Recurrence | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  let freq = String(record.freq ?? record.frequency ?? "").trim().toLowerCase();
  if (!freq || freq === "none" || freq === "once") {
    return null;
  }
  const unitRaw = String(record.unit ?? "").trim().toLowerCase();
  if (freq === "interval") {
    if (unitRaw === "days") {
      freq = "daily";
    } else if (unitRaw === "weeks") {
      freq = "weekly";
    } else if (unitRaw === "months") {
      freq = "monthly";
    } else if (unitRaw === "years") {
      freq = "yearly";
    } else if (!(unitRaw in UNIT_MS)) {
      return null;
    }
  }
  if (!(RECURRENCE_FREQS as readonly string[]).includes(freq)) {
    return null;
  }
  const kind = freq as RecurrenceFreq;
  const interval = positiveInt(record.interval ?? record.every) ?? 1;
  const weekdays = weekdayList(record.weekdays ?? record.days);
  const monthDayRaw = positiveInt(record.month_day ?? record.monthDay ?? record.day);
  const monthDay = monthDayRaw && monthDayRaw <= 31 ? monthDayRaw : null;
  const monthRaw = positiveInt(record.month);
  const month = monthRaw && monthRaw <= 12 ? monthRaw : null;
  const time = clockText(record.time);
  const until = ymdText(record.until);
  const count = positiveInt(record.count ?? record.times);
  return {
    freq: kind,
    interval,
    ...(kind === "interval" ? { unit: unitRaw as RecurrenceUnit } : {}),
    ...(kind === "weekly" && weekdays.length > 0 ? { weekdays } : {}),
    ...((kind === "monthly" || kind === "yearly") && monthDay ? { monthDay } : {}),
    ...(kind === "yearly" && month ? { month } : {}),
    ...(time && kind !== "interval" ? { time } : {}),
    ...(until ? { until } : {}),
    ...(count ? { count } : {}),
  };
}

/** Stored / injected JSON shape (snake case, same as the model emits). */
export function serializeRecurrence(rec: Recurrence): Record<string, unknown> {
  return {
    freq: rec.freq,
    interval: rec.interval,
    ...(rec.unit ? { unit: rec.unit } : {}),
    ...(rec.weekdays?.length ? { weekdays: rec.weekdays } : {}),
    ...(rec.monthDay ? { month_day: rec.monthDay } : {}),
    ...(rec.month ? { month: rec.month } : {}),
    ...(rec.time ? { time: rec.time } : {}),
    ...(rec.until ? { until: rec.until } : {}),
    ...(rec.count ? { count: rec.count } : {}),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function clockOf(rec: Recurrence, fallback: { hour: number; minute: number }) {
  const match = rec.time?.match(/^(\d{2}):(\d{2})$/);
  return match
    ? { hour: Number(match[1]), minute: Number(match[2]) }
    : { hour: fallback.hour, minute: fallback.minute };
}

function ymdOf(value: Date): string {
  const p = jerusalemParts(value);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Fill the fields the rule needs from its first occurrence (weekday, day of month, time). */
export function anchorRecurrence(rec: Recurrence, first: Date): Recurrence {
  if (rec.freq === "interval") {
    return rec;
  }
  const p = jerusalemParts(first);
  const time =
    rec.time ?? `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return {
    ...rec,
    time,
    ...(rec.freq === "weekly" && !rec.weekdays?.length ? { weekdays: [p.weekday] } : {}),
    ...((rec.freq === "monthly" || rec.freq === "yearly") && !rec.monthDay
      ? { monthDay: p.day }
      : {}),
    ...(rec.freq === "yearly" && !rec.month ? { month: p.month } : {}),
  };
}

/** The occurrence right after `prev` (which is itself an occurrence). Ignores until/count. */
export function nextOccurrence(rec: Recurrence, prev: Date): Date {
  if (rec.freq === "interval") {
    return new Date(prev.getTime() + rec.interval * UNIT_MS[rec.unit ?? "hours"]);
  }
  const p = jerusalemParts(prev);
  const { hour, minute } = clockOf(rec, p);
  if (rec.freq === "daily") {
    return jerusalemWallTimeToDate(p.year, p.month, p.day + rec.interval, hour, minute);
  }
  if (rec.freq === "weekly") {
    const days = rec.weekdays?.length ? rec.weekdays : [p.weekday];
    for (let step = 1; step <= 7; step += 1) {
      const weekday = (p.weekday + step) % 7;
      if (!days.includes(weekday)) {
        continue;
      }
      // Weeks start on Sunday; skip whole weeks only when the rule wraps into the next one.
      const extra = p.weekday + step >= 7 ? (rec.interval - 1) * 7 : 0;
      return jerusalemWallTimeToDate(p.year, p.month, p.day + step + extra, hour, minute);
    }
  }
  if (rec.freq === "monthly") {
    const total = p.month - 1 + rec.interval;
    const year = p.year + Math.floor(total / 12);
    const month = (total % 12) + 1;
    const day = Math.min(rec.monthDay ?? p.day, daysInMonth(year, month));
    return jerusalemWallTimeToDate(year, month, day, hour, minute);
  }
  const year = p.year + rec.interval;
  const month = rec.month ?? p.month;
  const day = Math.min(rec.monthDay ?? p.day, daysInMonth(year, month));
  return jerusalemWallTimeToDate(year, month, day, hour, minute);
}

/**
 * Soonest occurrence after `from` (or at it, when inclusive). A rule without a time
 * uses the wall time of `from` — pass the start of a day to list all-day tasks.
 */
export function firstOccurrence(rec: Recurrence, from: Date, inclusive = false): Date {
  const ok = (value: Date) =>
    inclusive ? value.getTime() >= from.getTime() : value.getTime() > from.getTime();
  if (rec.freq === "interval") {
    return inclusive ? from : nextOccurrence(rec, from);
  }
  const p = jerusalemParts(from);
  const { hour, minute } = clockOf(rec, p);
  const at = (year: number, month: number, day: number) =>
    jerusalemWallTimeToDate(year, month, day, hour, minute);
  if (rec.freq === "daily") {
    const today = at(p.year, p.month, p.day);
    return ok(today) ? today : at(p.year, p.month, p.day + 1);
  }
  if (rec.freq === "weekly") {
    const days = rec.weekdays?.length ? rec.weekdays : [p.weekday];
    for (let step = 0; step <= 7; step += 1) {
      const candidate = at(p.year, p.month, p.day + step);
      if (days.includes((p.weekday + step) % 7) && ok(candidate)) {
        return candidate;
      }
    }
    return at(p.year, p.month, p.day + 7);
  }
  if (rec.freq === "monthly") {
    for (let offset = 0; offset < 3; offset += 1) {
      const total = p.month - 1 + offset;
      const year = p.year + Math.floor(total / 12);
      const month = (total % 12) + 1;
      const candidate = at(year, month, Math.min(rec.monthDay ?? p.day, daysInMonth(year, month)));
      if (ok(candidate)) {
        return candidate;
      }
    }
  }
  const month = rec.month ?? p.month;
  for (let offset = 0; offset < 3; offset += 1) {
    const year = p.year + offset;
    const candidate = at(year, month, Math.min(rec.monthDay ?? p.day, daysInMonth(year, month)));
    if (ok(candidate)) {
      return candidate;
    }
  }
  return at(p.year + 1, month, rec.monthDay ?? p.day);
}

export function withinUntil(rec: Recurrence, value: Date): boolean {
  return !rec.until || ymdOf(value) <= rec.until;
}

/**
 * The next fire after one occurrence just fired, or null when the rule is finished
 * (count reached, or past until). Occurrences missed while the server was down are skipped.
 */
export function nextRecurrenceFire(input: {
  rec: Recurrence;
  fired: Date;
  now: Date;
  /** Occurrences fired so far, including the one that just fired. */
  firedCount: number;
}): Date | null {
  if (input.rec.count && input.firedCount >= input.rec.count) {
    return null;
  }
  let next = nextOccurrence(input.rec, input.fired);
  for (let guard = 0; next.getTime() <= input.now.getTime() && guard < 5000; guard += 1) {
    next = nextOccurrence(input.rec, next);
  }
  return withinUntil(input.rec, next) ? next : null;
}

/** Upcoming occurrences, bounded by limit, horizon, until and the remaining count. */
export function listOccurrences(
  rec: Recurrence,
  input: {
    first: Date;
    limit: number;
    horizon: Date;
    /** Occurrences already fired before `first`. */
    firedCount?: number;
  },
): Date[] {
  const out: Date[] = [];
  let cursor = input.first;
  const fired = input.firedCount ?? 0;
  for (let guard = 0; guard < 1000 && out.length < input.limit; guard += 1) {
    if (cursor.getTime() > input.horizon.getTime() || !withinUntil(rec, cursor)) {
      break;
    }
    if (rec.count && fired + out.length >= rec.count) {
      break;
    }
    out.push(cursor);
    cursor = nextOccurrence(rec, cursor);
  }
  return out;
}

/** Legacy every_count/every_unit/weekdays clocks expressed as a rule. */
export function recurrenceFromInterval(interval: ReminderInterval): Recurrence {
  const count = Math.max(1, interval.count);
  switch (interval.unit) {
    case "seconds":
    case "minutes":
    case "hours":
      return { freq: "interval", interval: count, unit: interval.unit };
    case "days":
      return { freq: "daily", interval: count };
    case "weeks":
      return { freq: "weekly", interval: count };
    case "months":
      return { freq: "monthly", interval: count };
    case "weekdays":
      return { freq: "weekly", interval: 1, weekdays: interval.weekdays ?? [] };
  }
}

/** Compact Reminders.repeat token so older readers still see a repeating clock. */
export function legacyRepeatFor(rec: Recurrence): string {
  switch (rec.freq) {
    case "interval":
      return `${rec.interval}:${rec.unit ?? "hours"}`;
    case "daily":
      return `${rec.interval}:days`;
    case "weekly":
      return rec.interval === 1 && rec.weekdays?.length
        ? `weekdays:${rec.weekdays.join(",")}`
        : `${rec.interval}:weeks`;
    case "monthly":
      return `${rec.interval}:months`;
    case "yearly":
      return `${rec.interval * 12}:months`;
  }
}

function joinHe(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} ו${names[names.length - 1]}`;
}

function unitPhrase(count: number, one: string, two: string, many: string): string {
  if (count === 1) {
    return one;
  }
  return count === 2 ? two : `${count} ${many}`;
}

function formatYmdHe(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  return `${day}.${month}.${year}`;
}

/** Product Hebrew, e.g. «כל שלישי וחמישי ב־19:00», «כל שנה ב־12 באוקטובר». */
export function formatRecurrenceHe(rec: Recurrence): string {
  let base: string;
  switch (rec.freq) {
    case "interval": {
      const unit = rec.unit ?? "hours";
      base =
        unit === "hours"
          ? `כל ${unitPhrase(rec.interval, "שעה", "שעתיים", "שעות")}`
          : unit === "minutes"
            ? `כל ${unitPhrase(rec.interval, "דקה", "2 דקות", "דקות")}`
            : `כל ${unitPhrase(rec.interval, "שנייה", "2 שניות", "שניות")}`;
      break;
    }
    case "daily":
      base = `כל ${unitPhrase(rec.interval, "יום", "יומיים", "ימים")}`;
      break;
    case "weekly": {
      const names = (rec.weekdays ?? []).map((day) => WEEKDAY_HE[day]);
      const days = names.length === 1 ? `יום ${names[0]}` : joinHe(names);
      base =
        rec.interval === 1
          ? days
            ? `כל ${days}`
            : "כל שבוע"
          : `כל ${unitPhrase(rec.interval, "שבוע", "שבועיים", "שבועות")}${days ? ` ב${days}` : ""}`;
      break;
    }
    case "monthly":
      base =
        rec.interval === 1
          ? rec.monthDay
            ? `כל ${rec.monthDay} לחודש`
            : "כל חודש"
          : `כל ${unitPhrase(rec.interval, "חודש", "חודשיים", "חודשים")}${rec.monthDay ? ` ב־${rec.monthDay} לחודש` : ""}`;
      break;
    case "yearly": {
      const when =
        rec.month && rec.monthDay ? ` ב־${rec.monthDay} ב${MONTH_HE[rec.month - 1]}` : "";
      base = `כל ${unitPhrase(rec.interval, "שנה", "שנתיים", "שנים")}${when}`;
      break;
    }
  }
  const parts = [base];
  if (rec.time) {
    parts.push(`ב־${rec.time}`);
  }
  if (rec.until) {
    parts.push(`עד ${formatYmdHe(rec.until)}`);
  }
  const text = parts.join(" ");
  return rec.count ? `${text} (${rec.count} פעמים)` : text;
}
