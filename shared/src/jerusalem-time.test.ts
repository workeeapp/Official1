import { describe, expect, it } from "vitest";
import {
  addJerusalemDays,
  addJerusalemMonths,
  formatJerusalemDateTime,
  jerusalemOffsetMs,
  jerusalemParts,
  jerusalemWallTimeToDate,
} from "./jerusalem-time.js";

const HOUR = 60 * 60 * 1000;

describe("jerusalem time", () => {
  it("knows summer is UTC+3 and winter is UTC+2", () => {
    expect(jerusalemOffsetMs(new Date("2026-07-01T12:00:00.000Z"))).toBe(3 * HOUR);
    expect(jerusalemOffsetMs(new Date("2026-12-01T12:00:00.000Z"))).toBe(2 * HOUR);
  });

  it("maps a wall time to the right instant in each season", () => {
    expect(jerusalemWallTimeToDate(2026, 7, 1, 8, 0).toISOString()).toBe(
      "2026-07-01T05:00:00.000Z",
    );
    expect(jerusalemWallTimeToDate(2026, 12, 1, 8, 0).toISOString()).toBe(
      "2026-12-01T06:00:00.000Z",
    );
  });

  it("keeps 08:00 when a day passes over the October change", () => {
    const saturday = jerusalemWallTimeToDate(2026, 10, 24, 8, 0);
    const sunday = addJerusalemDays(saturday, 1);
    expect(formatJerusalemDateTime(sunday)).toBe("2026-10-25 08:00");
    expect(sunday.getTime() - saturday.getTime()).toBe(25 * HOUR);
  });

  it("keeps 08:00 when a day passes over the March change", () => {
    const thursday = jerusalemWallTimeToDate(2027, 3, 25, 8, 0);
    const friday = addJerusalemDays(thursday, 1);
    expect(formatJerusalemDateTime(friday)).toBe("2027-03-26 08:00");
    expect(friday.getTime() - thursday.getTime()).toBe(23 * HOUR);
  });

  it("moves a time skipped by the spring change an hour later", () => {
    expect(formatJerusalemDateTime(jerusalemWallTimeToDate(2027, 3, 26, 2, 30))).toBe(
      "2027-03-26 03:30",
    );
  });

  it("clamps the day when the next month is shorter", () => {
    const jan31 = jerusalemWallTimeToDate(2026, 1, 31, 9, 0);
    expect(formatJerusalemDateTime(addJerusalemMonths(jan31, 1))).toBe("2026-02-28 09:00");
    expect(formatJerusalemDateTime(addJerusalemMonths(jan31, 2))).toBe("2026-03-31 09:00");
  });

  it("reads the Jerusalem weekday, not the UTC one", () => {
    // 23:30 UTC on Saturday is already Sunday in Jerusalem.
    expect(jerusalemParts(new Date("2026-10-03T23:30:00.000Z")).weekday).toBe(0);
  });
});
