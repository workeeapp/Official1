import { describe, expect, it } from "vitest";
import {
  formatSessionClockContext,
  jerusalemHm,
  jerusalemYmd,
  normalizeRelativeDatesInRecord,
  resolveRelativeDateLabel,
  sessionClock,
} from "../src/utils/relative-date.js";

describe("relative-date", () => {
  const noonUtc = new Date("2026-09-29T12:00:00.000Z");

  it("resolves היום / מחר / אתמול to YYYY-MM-DD in Jerusalem", () => {
    const today = jerusalemYmd(noonUtc);
    expect(resolveRelativeDateLabel("היום", noonUtc)).toBe(today);
    expect(resolveRelativeDateLabel("מחר", noonUtc)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(resolveRelativeDateLabel("מחר", noonUtc)).not.toBe(today);
    expect(resolveRelativeDateLabel("אתמול", noonUtc)).not.toBe(today);
  });

  it("leaves concrete dates and other text unchanged", () => {
    expect(resolveRelativeDateLabel("2026-10-01", noonUtc)).toBe("2026-10-01");
    expect(resolveRelativeDateLabel("חניה", noonUtc)).toBe("חניה");
  });

  it("normalizes relative labels inside item records", () => {
    expect(
      normalizeRelativeDatesInRecord(
        { תאריך: "היום", נושא: "חניה" },
        noonUtc,
      ),
    ).toEqual({
      תאריך: jerusalemYmd(noonUtc),
      נושא: "חניה",
    });
  });

  it("builds a Jerusalem session clock for ask-time filtering", () => {
    const clock = sessionClock(noonUtc);
    expect(clock.timezone).toBe("Asia/Jerusalem");
    expect(clock.currentDate).toBe(jerusalemYmd(noonUtc));
    expect(clock.currentTime).toBe(jerusalemHm(noonUtc));
    expect(clock.currentTime).toMatch(/^\d{2}:\d{2}$/);
    expect(clock.nowIso).toBe(noonUtc.toISOString());
  });

  it("formats SESSION_CLOCK context for the model", () => {
    const text = formatSessionClockContext(noonUtc);
    expect(text).toContain("SESSION_CLOCK:");
    expect(text).toContain(`current_date: ${jerusalemYmd(noonUtc)}`);
    expect(text).toContain(`current_time: ${jerusalemHm(noonUtc)}`);
    expect(text).toContain("Asia/Jerusalem");
    expect(text).toContain("does not filter the rows for you");
    expect(text).toContain("מטלות מתוזמנות");
    expect(text).toContain("אני/שלי");
    expect(text).toContain("WORKER_SAVED_DATA");
    expect(text).toContain("מה את");
    expect(text).toContain("MUST scan next_occurrences");
    expect(text).toContain("FORBIDDEN: empty day answer when the asked YYYY-MM-DD appears");
  });
});
