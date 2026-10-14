import { describe, expect, it } from "vitest";
import { formatJerusalemDateTime } from "./jerusalem-time.js";
import {
  anchorRecurrence,
  applyRecurrenceException,
  baseRecurrenceOccurrence,
  firstOccurrence,
  formatRecurrenceExceptionsHe,
  formatRecurrenceHe,
  isSubHourlyRecurrence,
  legacyRepeatFor,
  listOccurrences,
  nextOccurrence,
  nextRecurrenceFire,
  parseRecurrence,
  parseRecurrenceException,
  pruneRecurrenceExceptions,
  serializeRecurrence,
  withRecurrenceException,
  type Recurrence,
} from "./recurrence.js";

const fmt = (value: Date) => formatJerusalemDateTime(value);
// Wed 2026-10-07 12:00 Jerusalem (UTC+3).
const NOW = new Date("2026-10-07T09:00:00.000Z");

describe("parseRecurrence", () => {
  it("reads the model's snake_case rule", () => {
    expect(
      parseRecurrence({
        freq: "weekly",
        interval: 1,
        weekdays: [4, 2, 2],
        time: "9:30",
        until: "2026-12-31",
        count: 3,
      }),
    ).toEqual({
      freq: "weekly",
      interval: 1,
      weekdays: [2, 4],
      time: "09:30",
      until: "2026-12-31",
      count: 3,
    });
  });

  it("maps interval days to daily and rejects junk", () => {
    expect(parseRecurrence({ freq: "interval", interval: 10, unit: "days" })).toEqual({
      freq: "daily",
      interval: 10,
    });
    expect(parseRecurrence({ freq: "interval", interval: 5, unit: "minutes" })).toEqual({
      freq: "interval",
      interval: 5,
      unit: "minutes",
    });
    expect(
      parseRecurrence({ freq: "interval", interval: 3, unit: "hours", time: "10:00" }),
    ).toEqual({ freq: "interval", interval: 3, unit: "hours", time: "10:00" });
    expect(parseRecurrence({ freq: "none" })).toBeNull();
  });

  it("flags repeats faster than hourly", () => {
    expect(isSubHourlyRecurrence({ freq: "interval", interval: 10, unit: "minutes" })).toBe(true);
    expect(isSubHourlyRecurrence({ freq: "interval", interval: 30, unit: "seconds" })).toBe(true);
    expect(isSubHourlyRecurrence({ freq: "interval", interval: 1, unit: "hours" })).toBe(false);
    expect(isSubHourlyRecurrence({ freq: "daily", interval: 1, time: "09:00" })).toBe(false);
    expect(isSubHourlyRecurrence(null)).toBe(false);
    expect(parseRecurrence({ freq: "hourly" })).toBeNull();
    expect(parseRecurrence("weekly")).toBeNull();
  });
});

describe("occurrences", () => {
  it("weekly Tue+Thu at 19:00 starts this week and keeps going", () => {
    const rec: Recurrence = { freq: "weekly", interval: 1, weekdays: [2, 4], time: "19:00" };
    const first = firstOccurrence(rec, NOW);
    expect(fmt(first)).toBe("2026-10-08 19:00");
    expect(fmt(nextOccurrence(rec, first))).toBe("2026-10-13 19:00");
    expect(fmt(nextOccurrence(rec, new Date("2026-10-13T16:00:00Z")))).toBe(
      "2026-10-15 19:00",
    );
  });

  it("every two weeks skips the off week only when wrapping", () => {
    const rec: Recurrence = { freq: "weekly", interval: 2, weekdays: [0, 3], time: "10:00" };
    const sunday = firstOccurrence(rec, new Date("2026-10-03T12:00:00Z"));
    expect(fmt(sunday)).toBe("2026-10-04 10:00");
    const wednesday = nextOccurrence(rec, sunday);
    expect(fmt(wednesday)).toBe("2026-10-07 10:00");
    expect(fmt(nextOccurrence(rec, wednesday))).toBe("2026-10-18 10:00");
  });

  it("daily keeps wall time across the October DST change", () => {
    const rec: Recurrence = { freq: "daily", interval: 1, time: "15:00" };
    const before = new Date("2026-10-24T12:00:00Z");
    expect(fmt(before)).toBe("2026-10-24 15:00");
    const after = nextOccurrence(rec, before);
    expect(fmt(after)).toBe("2026-10-25 15:00");
    expect(after.toISOString()).toBe("2026-10-25T13:00:00.000Z");
  });

  it("monthly on the 31st clamps to short months", () => {
    const rec: Recurrence = { freq: "monthly", interval: 1, monthDay: 31, time: "09:00" };
    const first = firstOccurrence(rec, NOW);
    expect(fmt(first)).toBe("2026-10-31 09:00");
    const nov = nextOccurrence(rec, first);
    expect(fmt(nov)).toBe("2026-11-30 09:00");
    expect(fmt(nextOccurrence(rec, nov))).toBe("2026-12-31 09:00");
  });

  it("yearly birthday rolls to next year when already past", () => {
    const rec: Recurrence = { freq: "yearly", interval: 1, month: 3, monthDay: 2, time: "09:00" };
    const first = firstOccurrence(rec, NOW);
    expect(fmt(first)).toBe("2027-03-02 09:00");
    expect(fmt(nextOccurrence(rec, first))).toBe("2028-03-02 09:00");
  });

  it("anchors a weekly rule without weekdays to its first fire", () => {
    const anchored = anchorRecurrence(
      { freq: "weekly", interval: 1 },
      new Date("2026-10-11T07:00:00Z"),
    );
    expect(anchored).toEqual({ freq: "weekly", interval: 1, weekdays: [0], time: "10:00" });
  });

  it("all-day task occurrences include today when listing from day start", () => {
    const rec: Recurrence = { freq: "weekly", interval: 1, weekdays: [3] };
    const dayStart = new Date("2026-10-06T21:00:00Z");
    expect(fmt(firstOccurrence(rec, dayStart, true))).toBe("2026-10-07 00:00");
  });
});

describe("count and until", () => {
  it("count is the total number of occurrences", () => {
    const rec: Recurrence = { freq: "daily", interval: 10, time: "09:00", count: 3 };
    const first = firstOccurrence(rec, NOW);
    const list = listOccurrences(rec, {
      first,
      limit: 10,
      horizon: new Date("2027-12-31T00:00:00Z"),
    });
    expect(list.map(fmt)).toEqual([
      "2026-10-08 09:00",
      "2026-10-18 09:00",
      "2026-10-28 09:00",
    ]);
    expect(nextRecurrenceFire({ rec, fired: list[1], now: list[1], firedCount: 2 })).not.toBeNull();
    expect(nextRecurrenceFire({ rec, fired: list[2], now: list[2], firedCount: 3 })).toBeNull();
  });

  it("until is inclusive on the calendar day", () => {
    const rec: Recurrence = {
      freq: "monthly",
      interval: 1,
      monthDay: 1,
      time: "08:00",
      until: "2026-12-31",
    };
    const first = firstOccurrence(rec, NOW);
    const list = listOccurrences(rec, {
      first,
      limit: 10,
      horizon: new Date("2027-12-31T00:00:00Z"),
    });
    expect(list.map(fmt)).toEqual(["2026-11-01 08:00", "2026-12-01 08:00"]);
    expect(
      nextRecurrenceFire({ rec, fired: list[1], now: list[1], firedCount: 2 }),
    ).toBeNull();
  });

  it("skips occurrences missed while down", () => {
    const rec: Recurrence = { freq: "daily", interval: 1, time: "09:00" };
    const fired = new Date("2026-10-01T06:00:00Z");
    const next = nextRecurrenceFire({ rec, fired, now: NOW, firedCount: 1 });
    expect(next && fmt(next)).toBe("2026-10-08 09:00");
  });
});

describe("per-occurrence exceptions", () => {
  // Every Friday 12:00; 16.10 / 23.10 / 30.10 are Fridays.
  const fridays: Recurrence = { freq: "weekly", interval: 1, weekdays: [5], time: "12:00" };
  const horizon = new Date("2026-12-31T00:00:00Z");
  const fri16 = new Date("2026-10-16T09:00:00Z");

  it("parses, dedupes by day and round-trips exceptions", () => {
    const parsed = parseRecurrence({
      ...serializeRecurrence(fridays),
      exceptions: [
        { date: "2026-10-30", time: "9:15" },
        { date: "2026-10-23", time: "11:00" },
        { date: "2026-10-23", cancel: true },
        { date: "bad", cancel: true },
        { date: "2026-11-06" },
      ],
    });
    expect(parsed?.exceptions).toEqual([
      { date: "2026-10-23", cancel: true },
      { date: "2026-10-30", time: "09:15" },
    ]);
    expect(parseRecurrence(serializeRecurrence(parsed!))).toEqual(parsed);
    expect(parseRecurrenceException({ date: "2026-10-23", time: "25:00" })).toBeNull();
  });

  it("listOccurrences skips a cancelled day and moves a changed one", () => {
    const rec = withRecurrenceException(
      withRecurrenceException(fridays, { date: "2026-10-23", cancel: true }, "2026-10-12"),
      { date: "2026-10-30", time: "11:00" },
      "2026-10-12",
    );
    expect(listOccurrences(rec, { first: fri16, limit: 3, horizon }).map(fmt)).toEqual([
      "2026-10-16 12:00",
      "2026-10-30 11:00",
      "2026-11-06 12:00",
    ]);
    expect(formatRecurrenceExceptionsHe(rec)).toEqual(["23.10 בוטל", "30.10 ב־11:00"]);
  });

  it("a cancelled day does not use up count", () => {
    const rec = withRecurrenceException(
      { ...fridays, count: 3 },
      { date: "2026-10-23", cancel: true },
      "2026-10-12",
    );
    expect(listOccurrences(rec, { first: fri16, limit: 10, horizon }).map(fmt)).toEqual([
      "2026-10-16 12:00",
      "2026-10-30 12:00",
      "2026-11-06 12:00",
    ]);
  });

  it("nextRecurrenceFire skips a cancelled day", () => {
    const rec = withRecurrenceException(fridays, { date: "2026-10-23", cancel: true }, "2026-10-12");
    const next = nextRecurrenceFire({ rec, fired: fri16, now: fri16, firedCount: 1 });
    expect(next && fmt(next)).toBe("2026-10-30 12:00");
  });

  it("a moved fire is not repeated later the same day", () => {
    const rec = withRecurrenceException(fridays, { date: "2026-10-23", time: "11:00" }, "2026-10-12");
    const moved = nextRecurrenceFire({ rec, fired: fri16, now: fri16, firedCount: 1 });
    expect(moved && fmt(moved)).toBe("2026-10-23 11:00");
    const after = nextRecurrenceFire({ rec, fired: moved!, now: moved!, firedCount: 2 });
    expect(after && fmt(after)).toBe("2026-10-30 12:00");
  });

  it("a day moved later fires at the new time", () => {
    const rec = withRecurrenceException(fridays, { date: "2026-10-23", time: "15:30" }, "2026-10-12");
    const next = nextRecurrenceFire({ rec, fired: fri16, now: fri16, firedCount: 1 });
    expect(next && fmt(next)).toBe("2026-10-23 15:30");
    expect(fmt(baseRecurrenceOccurrence(rec, next!))).toBe("2026-10-23 12:00");
  });

  it("prunes exceptions before today", () => {
    const rec = withRecurrenceException(fridays, { date: "2026-10-16", cancel: true }, "2026-10-12");
    expect(pruneRecurrenceExceptions(rec, "2026-10-17").exceptions).toBeUndefined();
    expect(pruneRecurrenceExceptions(rec, "2026-10-16")).toBe(rec);
  });

  it("applyRecurrenceException leaves untouched days alone", () => {
    expect(applyRecurrenceException(fridays, fri16)).toBe(fri16);
  });
});

describe("formatting", () => {
  it("writes product Hebrew", () => {
    expect(
      formatRecurrenceHe({ freq: "weekly", interval: 1, weekdays: [2, 4], time: "19:00" }),
    ).toBe("כל שלישי וחמישי ב־19:00");
    expect(formatRecurrenceHe({ freq: "weekly", interval: 1, weekdays: [0], time: "10:00" })).toBe(
      "כל יום ראשון ב־10:00",
    );
    expect(formatRecurrenceHe({ freq: "daily", interval: 1, time: "15:00" })).toBe(
      "כל יום ב־15:00",
    );
    expect(
      formatRecurrenceHe({ freq: "yearly", interval: 1, month: 10, monthDay: 12, time: "09:00" }),
    ).toBe("כל שנה ב־12 באוקטובר ב־09:00");
    expect(
      formatRecurrenceHe({
        freq: "monthly",
        interval: 1,
        monthDay: 1,
        time: "08:00",
        until: "2026-12-31",
      }),
    ).toBe("כל 1 לחודש ב־08:00 עד 31.12.2026");
    expect(formatRecurrenceHe({ freq: "daily", interval: 10, count: 3 })).toBe(
      "כל 10 ימים (3 פעמים)",
    );
    expect(
      formatRecurrenceHe({ freq: "interval", interval: 3, unit: "hours", time: "10:00" }),
    ).toBe("כל 3 שעות");
    expect(formatRecurrenceHe({ freq: "interval", interval: 2, unit: "hours" })).toBe("כל שעתיים");
  });

  it("keeps a legacy repeat token", () => {
    expect(legacyRepeatFor({ freq: "weekly", interval: 1, weekdays: [3, 4] })).toBe(
      "weekdays:3,4",
    );
    expect(legacyRepeatFor({ freq: "yearly", interval: 1 })).toBe("12:months");
    expect(legacyRepeatFor({ freq: "interval", interval: 30, unit: "minutes" })).toBe(
      "30:minutes",
    );
  });
});
