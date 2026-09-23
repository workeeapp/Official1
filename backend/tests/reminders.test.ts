import { describe, expect, it } from "vitest";
import {
  formatJerusalemDateTime,
  resolveReminderFireAt,
} from "../src/services/reminder.service.js";

describe("resolveReminderFireAt", () => {
  it("uses an in-seconds delay instead of a clock hour", () => {
    const now = new Date("2026-09-24T10:00:00.000Z");
    const fireAt = resolveReminderFireAt("tomorrow", "", now, 10);
    expect(fireAt?.getTime()).toBe(now.getTime() + 10_000);
  });

  it("returns null when neither a delay nor a clock is present", () => {
    expect(resolveReminderFireAt("tomorrow", "", new Date(), null)).toBeNull();
  });

  it("shows Israel local time instead of UTC for saved reminders", () => {
    expect(formatJerusalemDateTime(new Date("2026-09-23T22:22:00.000Z"))).toBe(
      "2026-09-24 01:22",
    );
  });
});
