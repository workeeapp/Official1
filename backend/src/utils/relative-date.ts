/** Calendar date helpers in Asia/Jerusalem (no intent parsing — only exact relative labels). */

export function jerusalemYmd(now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Local wall-clock HH:mm in Asia/Jerusalem. */
export function jerusalemHm(now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Jerusalem",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.hour}:${parts.minute}`;
}

export type SessionClock = {
  timezone: "Asia/Jerusalem";
  currentDate: string;
  currentTime: string;
  nowIso: string;
};

/** Facts for the model to answer "today / in 2 hours / this week" against saved rows. */
export function sessionClock(now = new Date()): SessionClock {
  return {
    timezone: "Asia/Jerusalem",
    currentDate: jerusalemYmd(now),
    currentTime: jerusalemHm(now),
    nowIso: now.toISOString(),
  };
}

/**
 * Injected every chat turn. The model filters EMPLOYEE_SAVED_DATA / schedules /
 * reminders vs this clock — the server does not pre-filter for "today" questions.
 */
export function formatSessionClockContext(now = new Date()): string {
  const clock = sessionClock(now);
  return [
    "SESSION_CLOCK:",
    `timezone: ${clock.timezone}`,
    `current_date: ${clock.currentDate}`,
    `current_time: ${clock.currentTime}`,
    `now_iso: ${clock.nowIso}`,
    "Use this clock when the speaker asks what is due today, tomorrow, this week/month, in N hours/days, or similar.",
    "Compare date/time fields for the question's subject only: אני/שלי → speaker personal tasks + their active_reminders in EMPLOYEE_SAVED_DATA. Do not pull WORKER_SAVED_DATA or other people's schedules into a first-person day plan.",
    "Answer in response only — leave query empty (never query report). The server does not filter the rows for you.",
    "When nothing matches a timed window, speak plain product Hebrew (e.g. אין לך מטלות או תזכורות בשעה הקרובה) — never jargon like מטלות מתוזמנות.",
  ].join("\n");
}

function shiftJerusalemYmd(now: Date, dayDelta: number): string {
  const [year, month, day] = jerusalemYmd(now).split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + dayDelta));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Resolve exact relative day words to YYYY-MM-DD; leave other strings unchanged. */
export function resolveRelativeDateLabel(value: string, now = new Date()): string {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (
    trimmed === "היום" ||
    trimmed === "היום הזה" ||
    lower === "today"
  ) {
    return jerusalemYmd(now);
  }
  if (trimmed === "מחר" || lower === "tomorrow") {
    return shiftJerusalemYmd(now, 1);
  }
  if (trimmed === "אתמול" || lower === "yesterday") {
    return shiftJerusalemYmd(now, -1);
  }
  return value;
}

export function normalizeRelativeDatesInRecord(
  item: Record<string, unknown>,
  now = new Date(),
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    out[key] =
      typeof value === "string" ? resolveRelativeDateLabel(value, now) : value;
  }
  return out;
}
