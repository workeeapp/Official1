/**
 * GTFS clock helpers — times may exceed 24:00 (MOT ~28h operational day).
 */

/** Parse HH:MM:SS (or H:MM:SS) to seconds since service-day midnight; allows >86400. */
export function gtfsTimeToSeconds(raw: string): number | null {
  const t = String(raw ?? "").trim();
  const m = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || !Number.isFinite(sec)) {
    return null;
  }
  return h * 3600 + min * 60 + sec;
}

/** Format seconds (may be >86400) as H:MM:SS / HH:MM:SS. */
export function secondsToGtfsTime(total: number): string {
  if (!Number.isFinite(total) || total < 0) return "";
  const sec = Math.floor(total % 60);
  const min = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return `${h}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Display HH:mm for Hebrew replies (keeps hour ≥24 when after midnight). */
export function secondsToDisplayHm(total: number): string {
  if (!Number.isFinite(total) || total < 0) return "";
  const min = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** YYYY-MM-DD → YYYYMMDD service_id / calendar date key used by MOT package. */
export function toServiceDateKey(isoDate: string): string {
  return String(isoDate ?? "")
    .trim()
    .replace(/-/g, "")
    .slice(0, 8);
}

/** Asia/Jerusalem calendar YYYY-MM-DD for a Date. */
export function jerusalemYmd(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Minutes since Jerusalem midnight for `d` (0–1439); not GTFS 28h. */
export function jerusalemMinutesSinceMidnight(d: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}
