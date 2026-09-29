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
