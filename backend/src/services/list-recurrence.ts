import {
  addJerusalemDays,
  firstOccurrence,
  formatJerusalemDateTime,
  formatRecurrenceExceptionsHe,
  formatRecurrenceHe,
  isSubHourlyRecurrence,
  jerusalemParts,
  jerusalemWallTimeToDate,
  listOccurrences,
  nextOccurrence,
  parseRecurrence,
  parseRecurrenceException,
  pruneRecurrenceExceptions,
  serializeRecurrence,
  withinUntil,
  withRecurrenceException,
  type Recurrence,
  type RecurrenceException,
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
): {
  item: Record<string, unknown>;
  clear: boolean;
  explicitStart: boolean;
  /** Every N seconds / minutes: the whole item is refused. */
  tooFrequent?: true;
} {
  if (!("recurrence" in item)) {
    return { item, clear: false, explicitStart: false };
  }
  const { recurrence, ...rest } = item;
  if (isSubHourlyRecurrence(recurrence)) {
    return { item: rest, clear: false, explicitStart: false, tooFrequent: true };
  }
  const parsed = parseRecurrence(recurrence);
  if (!parsed) {
    return { item: rest, clear: wantsClear(recurrence), explicitStart: false };
  }
  const raw = asRecord(recurrence).start;
  const hasStart = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
  const isInterval = parsed.freq === "interval";
  // An interval rule is anchored by start + time; an explicit time pins the anchor too.
  const explicitStart = hasStart || (isInterval && Boolean(parsed.time));
  const rule: Recurrence =
    isInterval && !parsed.time ? { ...parsed, time: clockOf(now) } : parsed;
  return {
    item: {
      ...rest,
      [RECURRENCE_META_KEY]: {
        ...serializeRecurrence(rule),
        start: hasStart ? (raw as string).trim() : ymd(now),
      },
      [RECURRENCE_DISPLAY_KEY]: formatRecurrenceHe(rule),
    },
    clear: false,
    explicitStart,
  };
}

function clockOf(value: Date): string {
  return formatJerusalemDateTime(value).slice(11, 16);
}

/**
 * lists.update that re-sends a rule without `start` keeps the row's original start
 * (and, for interval rules, its start time), so the cycle does not shift to the edit moment.
 */
export function keepRecurrenceStart(
  data: Record<string, unknown>,
  previous: unknown,
): Record<string, unknown> {
  const meta = asRecord(data[RECURRENCE_META_KEY]);
  const prevMeta = asRecord(asRecord(previous)[RECURRENCE_META_KEY]);
  const prevStart = prevMeta.start;
  const rule = parseRecurrence(meta);
  if (!rule || typeof prevStart !== "string" || !prevStart) {
    return data;
  }
  const prevRule = parseRecurrence(prevMeta);
  const keepTime =
    rule.freq === "interval" && prevRule?.freq === "interval" && prevRule.time
      ? { time: prevRule.time }
      : {};
  return { ...data, [RECURRENCE_META_KEY]: { ...meta, start: prevStart, ...keepTime } };
}

/**
 * A re-sent rule replaces the stored one; keep the per-occurrence marks (done days,
 * one-off exceptions) the new rule did not carry itself.
 */
export function keepOccurrenceMarks(
  data: Record<string, unknown>,
  previous: unknown,
): Record<string, unknown> {
  const meta = asRecord(data[RECURRENCE_META_KEY]);
  const prev = asRecord(asRecord(previous)[RECURRENCE_META_KEY]);
  if (!parseRecurrence(meta) || !parseRecurrence(prev)) {
    return data;
  }
  const carried: Record<string, unknown> = {};
  for (const key of [DONE_DATES_KEY, LEGACY_DONE_THROUGH_KEY, "exceptions"]) {
    if (!(key in meta) && key in prev) {
      carried[key] = prev[key];
    }
  }
  return Object.keys(carried).length
    ? { ...data, [RECURRENCE_META_KEY]: { ...meta, ...carried } }
    : data;
}

/** lists.update field: this occurrence of a standing task was done (true = today, or YYYY-MM-DD). */
export const OCCURRENCE_DONE_KEY = "occurrence_done";
const DONE_DATES_KEY = "done_dates";
/** Older rows stored a single cutoff; still honoured on read. */
const LEGACY_DONE_THROUGH_KEY = "done_through";

export function extractOccurrenceDone(
  item: Record<string, unknown>,
  now = new Date(),
): { item: Record<string, unknown>; doneDate: string | null } {
  if (!(OCCURRENCE_DONE_KEY in item)) {
    return { item, doneDate: null };
  }
  const { [OCCURRENCE_DONE_KEY]: raw, ...rest } = item;
  if (typeof raw === "string") {
    const slot = raw.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/);
    if (slot) {
      return { item: rest, doneDate: `${slot[1]} ${slot[2]}` };
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
      return { item: rest, doneDate: raw.trim() };
    }
  }
  const today = raw === true || (typeof raw === "string" && raw.trim() !== "");
  return { item: rest, doneDate: today ? ymd(now) : null };
}

/**
 * Record that a standing task's occurrence on `doneDate` is done. Only that occurrence
 * drops out of next_occurrences; the row and its rule stay. Calendar rules mark a day
 * (YYYY-MM-DD); interval rules mark one slot (YYYY-MM-DD HH:mm). Marks before today
 * are dropped from storage. No-op on a task without a rule.
 */
export function markOccurrenceDone(
  data: Record<string, unknown>,
  doneDate: string,
  now = new Date(),
): Record<string, unknown> {
  const meta = asRecord(data[RECURRENCE_META_KEY]);
  const stored = itemRecurrence(data);
  if (!stored) {
    return data;
  }
  const mark =
    stored.rule.freq === "interval"
      ? intervalDoneSlot(stored.rule, stored.start, doneDate, now)
      : doneDate.slice(0, 10);
  if (!mark) {
    return data;
  }
  const today = ymd(now);
  const doneDates = [...new Set([...itemDoneDates(data), mark])]
    .filter((day) => day >= today || day === mark)
    .sort();
  return {
    ...data,
    [RECURRENCE_META_KEY]: { ...meta, [DONE_DATES_KEY]: doneDates },
  };
}

/** Occurrences explicitly marked done (YYYY-MM-DD, or YYYY-MM-DD HH:mm for interval rules), sorted. */
export function itemDoneDates(data: unknown): string[] {
  const meta = asRecord(asRecord(data)[RECURRENCE_META_KEY]);
  const raw = Array.isArray(meta[DONE_DATES_KEY]) ? (meta[DONE_DATES_KEY] as unknown[]) : [];
  return raw
    .filter(
      (day): day is string =>
        typeof day === "string" && /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(day),
    )
    .sort();
}

/** `key` is a day for calendar rules and a "YYYY-MM-DD HH:mm" slot for interval rules. */
function isOccurrenceDone(data: unknown, key: string): boolean {
  const meta = asRecord(asRecord(data)[RECURRENCE_META_KEY]);
  const legacy = meta[LEGACY_DONE_THROUGH_KEY];
  if (typeof legacy === "string" && legacy && key.slice(0, 10) <= legacy) {
    return true;
  }
  return itemDoneDates(data).includes(key);
}

/** First occurrence of an interval rule: its start day at its start time (Jerusalem). */
function intervalAnchor(rule: Recurrence, start: string): Date | null {
  const iso = start.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!iso) {
    return null;
  }
  const clock = (rule.time ?? "00:00").match(/^(\d{2}):(\d{2})$/);
  return jerusalemWallTimeToDate(
    Number(iso[1]),
    Number(iso[2]),
    Number(iso[3]),
    clock ? Number(clock[1]) : 0,
    clock ? Number(clock[2]) : 0,
  );
}

function intervalStepMs(rule: Recurrence, anchor: Date): number {
  return Math.max(1000, nextOccurrence(rule, anchor).getTime() - anchor.getTime());
}

/** Index of the last slot at or before `at` (-1 when `at` is before the first slot). */
function intervalSlotIndex(anchor: Date, step: number, at: Date): number {
  return Math.floor((at.getTime() - anchor.getTime()) / step);
}

/**
 * Which slot a done mark refers to. A slot time snaps to the slot at or before it; a day
 * means the slot due now when it is today, else that day's first slot.
 */
function intervalDoneSlot(
  rule: Recurrence,
  start: string,
  doneDate: string,
  now: Date,
): string | null {
  const anchor = intervalAnchor(rule, start);
  if (!anchor) {
    return null;
  }
  const step = intervalStepMs(rule, anchor);
  const slotAt = (index: number) => new Date(anchor.getTime() + Math.max(0, index) * step);
  const timed = doneDate.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (timed) {
    const at = jerusalemWallTimeToDate(
      Number(timed[1]),
      Number(timed[2]),
      Number(timed[3]),
      Number(timed[4]),
      Number(timed[5]),
    );
    return formatJerusalemDateTime(slotAt(intervalSlotIndex(anchor, step, at)));
  }
  if (doneDate === ymd(now)) {
    return formatJerusalemDateTime(slotAt(intervalSlotIndex(anchor, step, now)));
  }
  const day = doneDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!day) {
    return null;
  }
  const dayStartAt = jerusalemWallTimeToDate(Number(day[1]), Number(day[2]), Number(day[3]), 0, 0);
  const index = Math.ceil((dayStartAt.getTime() - anchor.getTime()) / step);
  const slot = slotAt(index);
  return ymd(slot) === doneDate ? formatJerusalemDateTime(slot) : null;
}

/** lists.update field: change one occurrence of a standing task ({date, cancel} / {date, time}). */
export const OCCURRENCE_CHANGE_KEY = "occurrence_change";

export function extractOccurrenceChange(item: Record<string, unknown>): {
  item: Record<string, unknown>;
  change: RecurrenceException | null;
} {
  if (!(OCCURRENCE_CHANGE_KEY in item)) {
    return { item, change: null };
  }
  const { [OCCURRENCE_CHANGE_KEY]: raw, ...rest } = item;
  return { item: rest, change: parseRecurrenceException(raw) };
}

/** True when `day` (YYYY-MM-DD) is one of the rule's own occurrence days on/after its start. */
function isRuleOccurrenceDay(rule: Recurrence, start: string, day: string): boolean {
  const startIso = start.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dayIso = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dayIso || (startIso && day < start)) {
    return false;
  }
  const from = startIso
    ? jerusalemWallTimeToDate(Number(startIso[1]), Number(startIso[2]), Number(startIso[3]), 0, 0)
    : jerusalemWallTimeToDate(Number(dayIso[1]), Number(dayIso[2]), Number(dayIso[3]), 0, 0);
  let cursor = firstOccurrence(rule, from, true);
  for (let guard = 0; ymd(cursor) < day && guard < 5000; guard += 1) {
    cursor = nextOccurrence(rule, cursor);
  }
  return ymd(cursor) === day;
}

/**
 * Store a one-off change for a single occurrence (same day replaces). Refused (data
 * returned unchanged) on a task without a rule, a past day, or a day the rule does
 * not land on.
 */
export function applyOccurrenceChange(
  data: Record<string, unknown>,
  change: RecurrenceException,
  now = new Date(),
): Record<string, unknown> {
  const stored = itemRecurrence(data);
  const today = ymd(now);
  if (
    !stored ||
    stored.rule.freq === "interval" ||
    change.date < today ||
    !isRuleOccurrenceDay(stored.rule, stored.start, change.date)
  ) {
    return data;
  }
  const updated = withRecurrenceException(stored.rule, change, today);
  const { exceptions: _previous, ...meta } = asRecord(data[RECURRENCE_META_KEY]);
  return {
    ...data,
    [RECURRENCE_META_KEY]: { ...meta, ...serializeRecurrence(updated) },
  };
}

/** Product-Hebrew list of the row's one-off changes («23.10 בוטל», «23.10 ב־11:00»). */
export function itemOccurrenceExceptions(data: unknown, now = new Date()): string[] {
  const stored = itemRecurrence(data);
  return stored ? formatRecurrenceExceptionsHe(pruneRecurrenceExceptions(stored.rule, ymd(now))) : [];
}

/**
 * A worker task FK-linked to a clock mirrors the clock's rule, so «מה את צריכה
 * לעשות ביום שלישי» lists it per occurrence. An interval rule is anchored at the clock's
 * `anchor` (its fire time) so the task's slots match the clock. One-shot clocks drop the rule.
 */
export function applyClockRuleToTask(
  data: Record<string, unknown>,
  rule: Recurrence | null,
  now = new Date(),
  anchor?: Date,
): Record<string, unknown> {
  if (!rule) {
    return RECURRENCE_META_KEY in data ? clearItemRecurrence(data) : data;
  }
  const meta = asRecord(data[RECURRENCE_META_KEY]);
  const isInterval = rule.freq === "interval";
  const start =
    isInterval && anchor ? ymd(anchor) : typeof meta.start === "string" ? meta.start : ymd(now);
  const prevTime = typeof meta.time === "string" ? meta.time : "";
  const mirrored: Recurrence = isInterval
    ? { ...rule, time: anchor ? clockOf(anchor) : rule.time || prevTime || clockOf(now) }
    : rule;
  const marks = Object.fromEntries(
    [DONE_DATES_KEY, LEGACY_DONE_THROUGH_KEY]
      .filter((key) => key in meta)
      .map((key) => [key, meta[key]]),
  );
  return {
    ...data,
    [RECURRENCE_META_KEY]: {
      ...serializeRecurrence(mirrored),
      start,
      ...marks,
    },
    [RECURRENCE_DISPLAY_KEY]: formatRecurrenceHe(mirrored),
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
 * "YYYY-MM-DD HH:mm–HH:mm" when the rule has an end_time, or "YYYY-MM-DD" when the
 * rule has no time. count counts from the stored start.
 */
export function itemNextOccurrences(data: unknown, now = new Date()): string[] | null {
  const stored = itemRecurrence(data);
  if (!stored) {
    return null;
  }
  const { rule, start } = stored;
  if (rule.freq === "interval") {
    return intervalNextOccurrences(data, rule, start, now);
  }
  const today = dayStart(now);
  const iso = start.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const startDay = iso
    ? jerusalemWallTimeToDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), 0, 0)
    : today;
  const horizon = addJerusalemDays(today, HORIZON_DAYS);
  const pending = (value: Date) =>
    value.getTime() >= today.getTime() && !isOccurrenceDone(data, ymd(value));
  let occurrences: Date[];
  if (rule.count) {
    const first = firstOccurrence(rule, startDay, true);
    occurrences = listOccurrences(rule, { first, limit: rule.count, horizon }).filter(pending);
  } else {
    // Walk from the start (not from today) so every-N cycles keep their parity.
    let first = firstOccurrence(rule, startDay, true);
    for (let guard = 0; first.getTime() < today.getTime() && guard < 5000; guard += 1) {
      first = nextOccurrence(rule, first);
    }
    occurrences = listOccurrences(rule, {
      first,
      limit: OCCURRENCE_LIMIT + 1,
      horizon,
    }).filter(pending);
  }
  const movedDays = new Set(
    (rule.exceptions ?? []).filter((entry) => entry.time).map((entry) => entry.date),
  );
  return occurrences.slice(0, OCCURRENCE_LIMIT).map((value) => {
    const moved = movedDays.has(ymd(value));
    if (!rule.time && !moved) {
      return ymd(value);
    }
    const at = formatJerusalemDateTime(value);
    // A moved day keeps only its new start; the rule's end belongs to the rule's slot.
    return rule.endTime && !moved ? `${at}–${rule.endTime}` : at;
  });
}

/**
 * Interval slots: the one due now (unless done) and the ones after it. Computed from the
 * anchor directly so short intervals on old rows stay cheap.
 */
function intervalNextOccurrences(
  data: unknown,
  rule: Recurrence,
  start: string,
  now: Date,
): string[] {
  const anchor = intervalAnchor(rule, start) ?? now;
  const step = intervalStepMs(rule, anchor);
  const out: string[] = [];
  let index = Math.max(0, intervalSlotIndex(anchor, step, now));
  for (let guard = 0; guard < 1000 && out.length < OCCURRENCE_LIMIT; guard += 1, index += 1) {
    if (rule.count && index >= rule.count) {
      break;
    }
    const slot = new Date(anchor.getTime() + index * step);
    if (!withinUntil(rule, slot)) {
      break;
    }
    const key = formatJerusalemDateTime(slot);
    if (!isOccurrenceDone(data, key)) {
      out.push(key);
    }
  }
  return out;
}
