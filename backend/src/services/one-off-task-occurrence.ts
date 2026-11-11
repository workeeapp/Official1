/**
 * One-off timed task occurrence identity — generic, domain-agnostic.
 *
 * Same title ≠ same event. A past one-off whose calendar date is rewritten to a
 * different day is treated as a NEW occurrence (engine converts update → add),
 * UNLESS the speaker explicitly asked to move/reschedule that occurrence.
 * Standing / recurring rows are never rewritten this way.
 *
 * Due comparisons use the turn's pinned wall clock (the same Date that builds
 * SESSION_CLOCK for that sendChatMessage), interpreted in Asia/Jerusalem via
 * jerusalemWallTimeToDate / formatJerusalemDateTime.
 */
import {
  formatJerusalemDateTime,
  jerusalemWallTimeToDate,
} from "@workee/shared";
import { itemRecurrence } from "./list-recurrence.js";
import { ymdFromTaskValue } from "./overdue-tasks.js";

/**
 * Generic move/reschedule cues (Hebrew product language). Not domain-specific.
 * Also accepts bare «לעדכן» / «עדכן» after an ASK (new vs update).
 */
const EXPLICIT_ONE_OFF_MOVE_RE =
  /(?:לעדכן|תזיז|תזיזי|תזיזו|תעדכן|תעדכני|תעדכנו|תשנ[היו]\s+את\s+(?:המועד|התאריך)|הזיז[יו]?|תדח[היו]|תעביר[יו]?|תעבירי|reschedule|\bmove\b)/iu;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readText(data: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const raw = data[key];
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }
  }
  return "";
}

/** Standing / recurring task — leave series move / occurrence paths alone. */
export function isStandingOrRecurringTask(data: unknown): boolean {
  if (itemRecurrence(data)) {
    return true;
  }
  const record = asRecord(data);
  return Boolean(readText(record, ["חוזר"]));
}

export function taskDueYmd(data: unknown): string | null {
  const record = asRecord(data);
  for (const key of ["תאריך לביצוע", "תאריך", "date", "day"]) {
    const ymd = ymdFromTaskValue(record[key]);
    if (ymd) {
      return ymd;
    }
  }
  return null;
}

export function taskDueTimeHm(data: unknown): string | null {
  const raw = readText(asRecord(data), ["שעה לביצוע", "time"]);
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Due instant in Jerusalem wall time; all-day → start of that local day. */
export function taskDueAt(data: unknown): Date | null {
  const ymd = taskDueYmd(data);
  if (!ymd) {
    return null;
  }
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) {
    return null;
  }
  const hm = taskDueTimeHm(data);
  if (hm) {
    const [hour, minute] = hm.split(":").map(Number);
    return jerusalemWallTimeToDate(y, m, d, hour!, minute!);
  }
  return jerusalemWallTimeToDate(y, m, d, 0, 0);
}

export function taskDueHasPassed(data: unknown, now = new Date()): boolean {
  const due = taskDueAt(data);
  if (!due) {
    return false;
  }
  return due.getTime() < now.getTime();
}

/**
 * True when the speaker message clearly asks to move/reschedule an existing
 * occurrence (vs stating a new dated chore with a reused title).
 */
export function messageSignalsExplicitOneOffMove(message: string): boolean {
  const text = message.trim();
  if (!text) {
    return false;
  }
  if (/^(?:לעדכן|עדכן)$/u.test(text)) {
    return true;
  }
  return EXPLICIT_ONE_OFF_MOVE_RE.test(text);
}

/**
 * Unsafe silent rewrite: one-off row whose due already passed, and the update
 * moves it to a different calendar day — unless an explicit move was requested.
 * Same-day time corrections stay updates.
 */
export function shouldRewritePastOneOffDateUpdateAsAdd(input: {
  existingData: unknown;
  nextData: unknown;
  now?: Date;
  /** Speaker asked to move/reschedule the existing occurrence. */
  allowExplicitMove?: boolean;
}): boolean {
  if (input.allowExplicitMove) {
    return false;
  }
  if (isStandingOrRecurringTask(input.existingData)) {
    return false;
  }
  if (isStandingOrRecurringTask(input.nextData)) {
    return false;
  }
  const oldYmd = taskDueYmd(input.existingData);
  const newYmd = taskDueYmd(input.nextData);
  if (!oldYmd || !newYmd || oldYmd === newYmd) {
    return false;
  }
  if (!taskDueHasPassed(input.existingData, input.now ?? new Date())) {
    return false;
  }
  return true;
}

/** Debug / audit helper — not product speech. */
export function describePastOneOffRewrite(input: {
  existingData: unknown;
  nextData: unknown;
  now?: Date;
}): string {
  const oldYmd = taskDueYmd(input.existingData) ?? "?";
  const newYmd = taskDueYmd(input.nextData) ?? "?";
  const nowLabel = formatJerusalemDateTime(input.now ?? new Date());
  return `past_one_off_date_rewrite ${oldYmd}→${newYmd} at ${nowLabel}`;
}
