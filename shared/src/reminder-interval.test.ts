import { describe, expect, it } from "vitest";
import {
  addReminderInterval,
  formatReminderIntervalHe,
  parseReminderInterval,
  parseStoredRepeat,
  serializeReminderRepeat,
} from "./reminder-interval.js";

describe("reminder interval", () => {
  it("reads structured count+unit and weekday numbers only", () => {
    expect(parseReminderInterval({ repeat: "weekly" })).toEqual({
      count: 1,
      unit: "weeks",
    });
    expect(
      parseReminderInterval({ every_count: 2, every_unit: "hours" }),
    ).toEqual({
      count: 2,
      unit: "hours",
    });
    expect(parseReminderInterval({ every: "2:hours" })).toEqual({
      count: 2,
      unit: "hours",
    });
    expect(parseReminderInterval({ weekdays: [1, 3] })).toEqual({
      count: 1,
      unit: "weekdays",
      weekdays: [1, 3],
    });
    expect(parseReminderInterval({ weekdays: [0] })).toEqual({
      count: 1,
      unit: "weekdays",
      weekdays: [0],
    });
    expect(parseReminderInterval({ every: "כל 4 שעות" })).toBeNull();
    expect(parseReminderInterval({ every: "שני" })).toBeNull();
    expect(parseReminderInterval({ repeat: "once" })).toBeNull();
  });

  it("round-trips stored repeats including legacy daily", () => {
    expect(parseStoredRepeat("daily")).toEqual({ count: 1, unit: "days" });
    expect(serializeReminderRepeat({ count: 2, unit: "hours" })).toBe("2:hours");
    expect(formatReminderIntervalHe("1:weeks")).toBe("כל שבוע");
    expect(formatReminderIntervalHe("2:hours")).toBe("כל שעתיים");
    expect(formatReminderIntervalHe("4:hours")).toBe("כל 4 שעות");
  });

  it("adds calendar months and fixed hours", () => {
    const from = new Date("2026-01-15T05:05:00.000Z");
    expect(addReminderInterval(from, { count: 1, unit: "months" }).toISOString()).toBe(
      "2026-02-15T05:05:00.000Z",
    );
    expect(
      addReminderInterval(from, { count: 2, unit: "hours" }).toISOString(),
    ).toBe("2026-01-15T07:05:00.000Z");
  });
});
