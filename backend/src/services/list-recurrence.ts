import {
  addJerusalemDays,
  firstOccurrence,
  formatJerusalemDateTime,
  formatRecurrenceHe,
  jerusalemParts,
  jerusalemWallTimeToDate,
  listOccurrences,
  parseRecurrence,
  serializeRecurrence,
  type Recurrence,
} from "@workee/shared";

/**
 * A standing task ("gym every Tue+Thu 19:00") stays one tasks row. The model's
 * `recurrence` is stored under a reserved key with the first day it applies;
 * `חוזר` carries the product-Hebrew rule for display. Upcoming dates are computed
 * from the stored rule every turn — the row is never copied per occurrence.
 */
export const RECURRENCE_META_KEY = "__recurrence";
export const RECURRENCE_DISPLAY_KEY = "חוזר";

const OCCURRENCE_LIMIT = 6;
const HORIZON_DAYS = 62;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function dayStart(value: Date): Date {
  const p = jerusalemParts(value);
  return jerusalemWallTimeToDate(p.year, p.month, p.day, 0, 0);
}

function ymd(value: Date): string {
  return formatJerusalemDateTime(value).slice(0, 10);
}

function wantsClear(value: unknown): boolean {
  if (value === null || value === false) {
    return true;
  }
  const freq = String(asRecord(value).freq ?? "").trim().toLowerCase();
  return freq === "none" || freq === "once";
}

/**
 * Turn the ACTION item's `recurrence` into stored fields. `clear` = the model sent
 * null / freq "none" on update, so the merged row must drop its rule.
 */
export function shapeItemRecurrence(
  item: Record<string, unknown>,
  now = new Date(),
): { item: Record<string, unknown>; clear: boolean } {
  if (!("recurrence" in item)) {
    return { item, clear: false };
  }
  const { recurrence, ...rest } = item;
  const rule = parseRecurrence(recurrence);
  if (!rule || rule.freq === "interval") {
    return { item: rest, clear: wantsClear(recurrence) };
  }
  const start = asRecord(recurrence).start;
  return {
    item: {
      ...rest,
      [RECURRENCE_META_KEY]: {
        ...serializeRecurrence(rule),
        start:
          typeof start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : ymd(now),
      },
      [RECURRENCE_DISPLAY_KEY]: formatRecurrenceHe(rule),
    },
    clear: false,
  };
}

export function clearItemRecurrence(data: Record<string, unknown>): Record<string, unknown> {
  const next = { ...data };
  delete next[RECURRENCE_META_KEY];
  delete next[RECURRENCE_DISPLAY_KEY];
  return next;
}

export function itemRecurrence(data: unknown): { rule: Recurrence; start: string } | null {
  const meta = asRecord(asRecord(data)[RECURRENCE_META_KEY]);
  const rule = parseRecurrence(meta);
  if (!rule) {
    return null;
  }
  const start = typeof meta.start === "string" ? meta.start : "";
  return { rule, start };
}

/** Reserved rule JSON never reaches the model or the UI as a column. */
export function stripRecurrenceMeta(data: Record<string, unknown>): Record<string, unknown> {
  if (!(RECURRENCE_META_KEY in data)) {
    return data;
  }
  const next = { ...data };
  delete next[RECURRENCE_META_KEY];
  return next;
}

/**
 * Upcoming dates of a standing task, from today (inclusive) — "YYYY-MM-DD HH:mm",
 * or "YYYY-MM-DD" when the rule has no time. count counts from the stored start.
 */
export function itemNextOccurrences(data: unknown, now = new Date()): string[] | null {
  const stored = itemRecurrence(data);
  if (!stored) {
    return null;
  }
  const { rule, start } = stored;
  const today = dayStart(now);
  const iso = start.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const startDay = iso
    ? jerusalemWallTimeToDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), 0, 0)
    : today;
  const horizon = addJerusalemDays(today, HORIZON_DAYS);
  let occurrences: Date[];
  if (rule.count) {
    const first = firstOccurrence(rule, startDay, true);
    occurrences = listOccurrences(rule, { first, limit: rule.count, horizon }).filter(
      (value) => value.getTime() >= today.getTime(),
    );
  } else {
    const from = startDay.getTime() > today.getTime() ? startDay : today;
    occurrences = listOccurrences(rule, {
      first: firstOccurrence(rule, from, true),
      limit: OCCURRENCE_LIMIT,
      horizon,
    });
  }
  return occurrences
    .slice(0, OCCURRENCE_LIMIT)
    .map((value) => (rule.time ? formatJerusalemDateTime(value) : ymd(value)));
}
