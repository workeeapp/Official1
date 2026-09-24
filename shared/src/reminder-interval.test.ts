import { describe, expect, it } from "vitest";
import {
  addReminderInterval,
  formatReminderIntervalHe,
  parseReminderInterval,
  parseStoredRepeat,
  serializeReminderRepeat,
} from "./reminder-interval.js";

describe("reminder interval", () => {
  it("parses named repeats and every text", () => {
    expect(parseReminderInterval({ repeat: "weekly" })).toEqual({
      count: 1,
      unit: "weeks",
    });
    expect(parseReminderInterval({ every: "2 hours" })).toEqual({
      count: 2,
      unit: "hours",
    });
    expect(parseReminderInterval({ every: "כל 4 שעות" })).toEqual({
      count: 4,
      unit: "hours",
    });
    expect(parseReminderInterval({ every: "6 hours" })).toEqual({
      count: 6,
      unit: "hours",
    });
    expect(parseReminderInterval({ every: "כל 15 דקות" })).toEqual({
      count: 15,
      unit: "minutes",
    });
    expect(parseReminderInterval({ every: "כל 30 שניות" })).toEqual({
      count: 30,
      unit: "seconds",
    });
    expect(parseReminderInterval({ every: "כל חודש" })).toEqual({
      count: 1,
      unit: "months",
    });
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
