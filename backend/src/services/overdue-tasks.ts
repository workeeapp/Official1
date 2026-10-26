/**
 * Overdue speaker tasks for the new-conversation self-job.
 * Last day = תאריך סיום when a valid YYYY-MM-DD, else תאריך לביצוע.
 * Compare to Asia/Jerusalem calendar date — no speech understanding.
 */

import { jerusalemYmd } from "../utils/relative-date.js";
import { jobMetaFrom } from "./job-meta.js";

const TASK_NAME_KEYS = ["שם מטלה", "name", "task", "item_name"] as const;
const START_DATE_KEYS = ["תאריך לביצוע", "date"] as const;
const END_DATE_KEYS = ["תאריך סיום", "end_date"] as const;

const YMD_RE = /^(\d{4}-\d{2}-\d{2})/;

export type OverdueTaskRow = {
  itemId: string;
  title: string;
  lastDay: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readText(
  data: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

/** Valid calendar YYYY-MM-DD prefix, or null. */
export function ymdFromTaskValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(YMD_RE);
  if (!match) {
    return null;
  }
  const ymd = match[1]!;
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) {
    return null;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return ymd;
}

/**
 * Inclusive last calendar day of a task.
 * Prefer תאריך סיום when valid; else תאריך לביצוע.
 */
export function taskLastDay(data: unknown): string | null {
  const record = asRecord(data);
  const end = ymdFromTaskValue(readText(record, END_DATE_KEYS));
  if (end) {
    return end;
  }
  return ymdFromTaskValue(readText(record, START_DATE_KEYS));
}

export function isTaskOverdue(
  data: unknown,
  todayYmd: string = jerusalemYmd(),
): boolean {
  if (jobMetaFrom(data)) {
    return false;
  }
  const last = taskLastDay(data);
  return Boolean(last && last < todayYmd);
}

export function collectOverdueFromItems(
  items: Array<{ id: string; itemKey?: string; data: unknown }>,
  todayYmd: string = jerusalemYmd(),
): OverdueTaskRow[] {
  const rows: OverdueTaskRow[] = [];
  for (const item of items) {
    if (!isTaskOverdue(item.data, todayYmd)) {
      continue;
    }
    const data = asRecord(item.data);
    const title =
      readText(data, TASK_NAME_KEYS) ||
      (typeof item.itemKey === "string" ? item.itemKey.trim() : "") ||
      "מטלה";
    rows.push({
      itemId: item.id,
      title,
      lastDay: taskLastDay(item.data)!,
    });
  }
  return rows;
}

/** Stable ask summary for the engine-opened overdue self-job. */
export function overdueTasksAsk(titles: string[]): string {
  const n = titles.length;
  const detail = titles.join(", ");
  if (n === 1) {
    return `מטלה אחת שטרם נסגרה שעבר זמנה — ${detail}`;
  }
  return `${n} משימות שטרם נסגרו שעבר זמנן — ${detail}`;
}
