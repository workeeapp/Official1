/**
 * Undated speaker tasks at 7×2^n day milestones (7/14/28/56…) for the
 * new-conversation self-job. Age from last touch (updatedAt), Asia/Jerusalem.
 */

import { jerusalemYmd } from "../utils/relative-date.js";
import { jobMetaFrom } from "./job-meta.js";
import { taskLastDay, ymdFromTaskValue } from "./overdue-tasks.js";

const TASK_NAME_KEYS = ["שם מטלה", "name", "task", "item_name"] as const;

export type StaleUndatedTaskRow = {
  itemId: string;
  title: string;
  ageDays: number;
  updatedAt: Date;
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

/** No usable תאריך לביצוע / תאריך סיום (and not a job row). */
export function isUndatedTask(data: unknown): boolean {
  if (jobMetaFrom(data)) {
    return false;
  }
  return taskLastDay(data) == null;
}

/** ageDays ∈ {7, 14, 28, 56, …} = 7 × 2^n. */
export function isStaleMilestoneAge(ageDays: number): boolean {
  if (!Number.isInteger(ageDays) || ageDays < 7 || ageDays % 7 !== 0) {
    return false;
  }
  const k = ageDays / 7;
  return (k & (k - 1)) === 0;
}

/** Whole calendar days from `from` to `now` in Asia/Jerusalem (0 = same day). */
export function jerusalemCalendarAgeDays(
  from: Date,
  now: Date = new Date(),
): number {
  const fromYmd = jerusalemYmd(from);
  const toYmd = jerusalemYmd(now);
  const fromParts = fromYmd.split("-").map(Number);
  const toParts = toYmd.split("-").map(Number);
  const fromUtc = Date.UTC(fromParts[0]!, fromParts[1]! - 1, fromParts[2]!);
  const toUtc = Date.UTC(toParts[0]!, toParts[1]! - 1, toParts[2]!);
  return Math.round((toUtc - fromUtc) / 86_400_000);
}

export function collectStaleUndatedFromItems(
  items: Array<{
    id: string;
    itemKey?: string;
    data: unknown;
    updatedAt: Date;
  }>,
  now: Date = new Date(),
): StaleUndatedTaskRow[] {
  const rows: StaleUndatedTaskRow[] = [];
  for (const item of items) {
    if (!isUndatedTask(item.data)) {
      continue;
    }
    const ageDays = jerusalemCalendarAgeDays(item.updatedAt, now);
    if (!isStaleMilestoneAge(ageDays)) {
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
      ageDays,
      updatedAt: item.updatedAt,
    });
  }
  return rows;
}

/** Stable ask summary for the engine-opened stale-undated self-job. */
export function staleUndatedTasksAsk(
  rows: Array<{ title: string; ageDays: number }>,
): string {
  if (rows.length === 0) {
    return "";
  }
  if (rows.length === 1) {
    const row = rows[0]!;
    return `מטלה בלי תאריך אצלך כבר ${row.ageDays} ימים — ${row.title}`;
  }
  const detail = rows
    .map((row) => `${row.title} (${row.ageDays} ימים)`)
    .join(", ");
  return `${rows.length} משימות בלי תאריך אצלך באבני דרך 7/14/28… — ${detail}`;
}

/** Re-export for tests that assert undated via date keys. */
export { ymdFromTaskValue };
