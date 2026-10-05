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
  const weekdayDates = upcomingWeekdayDates(now);
  return [
    "SESSION_CLOCK:",
    `timezone: ${clock.timezone}`,
    `current_date: ${clock.currentDate}`,
    `current_time: ${clock.currentTime}`,
    `now_iso: ${clock.nowIso}`,
    `weekday_dates: ${JSON.stringify(weekdayDates)}`,
    "weekday_dates maps היום/מחר/אתמול and Hebrew weekdays (ראשון…שבת, also יום חמישי) to YYYY-MM-DD for the next week. When the speaker says ביום חמישי / מחר, resolve via weekday_dates then match EMPLOYEE_SAVED_DATA תאריך לביצוע (and יום בשבוע when present).",
    "Use this clock when the speaker asks what is due today, tomorrow, this week/month, in N hours/days, or similar.",
    "Compare date/time fields for the question's subject only: אני/שלי → speaker personal tasks + their active_reminders in EMPLOYEE_SAVED_DATA. Do not pull WORKER_SAVED_DATA or other people's schedules into a first-person day plan.",
    "מה את/ה צריך/ה ביום X / what YOU need that day → only WORKER_SAVED_DATA rows in THIS turn whose תאריך לביצוע matches that day. If none match, say you have nothing that day — never reuse an older *saved* job claim about someone else's work. Does not affect PENDING_ACTION_STATE / hold (e.g. short היי after asking what to send).",
    "Answer in response only from the matching injected facts. The server does not filter the rows for you.",
    "When nothing matches a timed window, speak plain product Hebrew (e.g. אין לך מטלות או תזכורות בשעה הקרובה) — never jargon like מטלות מתוזמנות.",
  ].join("\n");
}

const HEBREW_WEEKDAYS = [
  "ראשון",
  "שני",
  "שלישי",
  "רביעי",
  "חמישי",
  "שישי",
  "שבת",
] as const;

/** Hebrew weekday name for a YYYY-MM-DD calendar date (UTC date parts = civil day). */
export function hebrewWeekdayFromYmd(ymd: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!match) {
    return null;
  }
  const day = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return HEBREW_WEEKDAYS[day.getUTCDay()] ?? null;
}

/** Next occurrence of each weekday label from today (inclusive), plus היום/מחר/אתמול. */
export function upcomingWeekdayDates(now = new Date()): Record<string, string> {
  const out: Record<string, string> = {
    היום: jerusalemYmd(now),
    מחר: shiftJerusalemYmd(now, 1),
    אתמול: shiftJerusalemYmd(now, -1),
  };
  for (let i = 0; i < 7; i++) {
    const ymd = shiftJerusalemYmd(now, i);
    const name = hebrewWeekdayFromYmd(ymd);
    if (!name) {
      continue;
    }
    if (!out[name]) {
      out[name] = ymd;
    }
    const withYom = `יום ${name}`;
    if (!out[withYom]) {
      out[withYom] = ymd;
    }
  }
  return out;
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
