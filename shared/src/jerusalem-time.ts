/**
 * Asia/Jerusalem wall-clock arithmetic. Israel moves between UTC+2 and UTC+3, so a
 * fixed offset drifts by an hour twice a year; every conversion goes through Intl.
 */
export const JERUSALEM_TIME_ZONE = "Asia/Jerusalem";

export interface JerusalemParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

let formatter: Intl.DateTimeFormat | null = null;

function partsFormatter(): Intl.DateTimeFormat {
  formatter ??= new Intl.DateTimeFormat("en-US", {
    timeZone: JERUSALEM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  return formatter;
}

export function jerusalemParts(value: Date): JerusalemParts {
  const parts: Record<string, string> = {};
  for (const part of partsFormatter().formatToParts(value)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

/** Milliseconds Jerusalem is ahead of UTC at that instant (2h or 3h). */
export function jerusalemOffsetMs(value: Date): number {
  const p = jerusalemParts(value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(value.getTime() / 1000) * 1000;
}

/**
 * The instant Jerusalem clocks show this wall time. Out-of-range day/month values
 * roll over like Date.UTC. A time skipped by the spring change lands an hour later.
 */
export function jerusalemWallTimeToDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstGuess = wall - jerusalemOffsetMs(new Date(wall));
  const offset = jerusalemOffsetMs(new Date(firstGuess));
  return new Date(wall - offset);
}

/** Same Jerusalem wall-clock time, `days` calendar days later. */
export function addJerusalemDays(value: Date, days: number): Date {
  const p = jerusalemParts(value);
  return jerusalemWallTimeToDate(p.year, p.month, p.day + days, p.hour, p.minute, p.second);
}

/** Same Jerusalem wall-clock time and day of month, clamped to the target month's length. */
export function addJerusalemMonths(value: Date, months: number): Date {
  const p = jerusalemParts(value);
  const target = new Date(Date.UTC(p.year, p.month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return jerusalemWallTimeToDate(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    Math.min(p.day, lastDay),
    p.hour,
    p.minute,
    p.second,
  );
}

/** YYYY-MM-DD HH:mm on Jerusalem clocks. */
export function formatJerusalemDateTime(value: Date): string {
  const p = jerusalemParts(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
