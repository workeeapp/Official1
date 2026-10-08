import { describe, expect, it } from "vitest";
import { formatJerusalemDateTime } from "@workee/shared";
import {
  canReuseExistingReminderClock,
  reminderRuleSnapshot,
  resolveRecurringFireAt,
  toReminderSnapshotRow,
} from "../src/services/reminder.service.js";
import {
  RECURRENCE_DISPLAY_KEY,
  RECURRENCE_META_KEY,
  applyClockRuleToTask,
  clearItemRecurrence,
  extractOccurrenceDone,
  itemDoneThrough,
  itemNextOccurrences,
  markOccurrenceDone,
  shapeItemRecurrence,
  stripRecurrenceMeta,
} from "../src/services/list-recurrence.js";
import { formatSessionClockContext, upcomingCalendarWeeks } from "../src/utils/relative-date.js";

// Wed 2026-10-07 12:00 Jerusalem.
const NOW = new Date("2026-10-07T09:00:00.000Z");
const fmt = (value: Date) => formatJerusalemDateTime(value);

describe("resolveRecurringFireAt", () => {
  it("weekly Wed+Thu at 11:00 fires on the next matching day", () => {
    const out = resolveRecurringFireAt(
      { freq: "weekly", interval: 1, weekdays: [3, 4], time: "11:00" },
      "",
      "",
      NOW,
    );
    expect(out && fmt(out.fireAt)).toBe("2026-10-08 11:00");
  });

  it("takes the time from the ACTION when the rule has none", () => {
    const out = resolveRecurringFireAt({ freq: "daily", interval: 1 }, "", "15:00", NOW);
    expect(out && fmt(out.fireAt)).toBe("2026-10-07 15:00");
    expect(out?.recurrence.time).toBe("15:00");
  });

  it("needs a time for calendar rules", () => {
    expect(resolveRecurringFireAt({ freq: "daily", interval: 1 }, "", "", NOW)).toBeNull();
  });

  it("anchors a yearly birthday to the ACTION date", () => {
    const out = resolveRecurringFireAt(
      { freq: "yearly", interval: 1, time: "09:00" },
      "2026-10-13",
      "",
      NOW,
    );
    expect(out && fmt(out.fireAt)).toBe("2026-10-13 09:00");
    expect(out?.recurrence).toMatchObject({ month: 10, monthDay: 13 });
  });

  it("monthly on the 1st until December stops after December", () => {
    const out = resolveRecurringFireAt(
      { freq: "monthly", interval: 1, monthDay: 1, time: "08:00", until: "2026-12-31" },
      "",
      "",
      NOW,
    );
    expect(out && fmt(out.fireAt)).toBe("2026-11-01 08:00");
    const facts = reminderRuleSnapshot({
      fireAt: out!.fireAt,
      repeat: "1:months",
      recurrence: { freq: "monthly", interval: 1, month_day: 1, time: "08:00", until: "2026-12-31" },
    });
    expect(facts.next_occurrences).toEqual(["2026-11-01 08:00", "2026-12-01 08:00"]);
    expect(facts.recurrence_text).toBe("כל 1 לחודש ב־08:00 עד 31.12.2026");
  });

  it("interval rules behave like every_count", () => {
    const out = resolveRecurringFireAt(
      { freq: "interval", interval: 20, unit: "minutes" },
      "",
      "",
      NOW,
    );
    expect(out?.fireAt.getTime()).toBe(NOW.getTime() + 20 * 60 * 1000);
  });
});

describe("reminder snapshot rule facts", () => {
  it("counts down remaining_times", () => {
    const facts = reminderRuleSnapshot({
      fireAt: new Date("2026-10-18T06:00:00Z"),
      repeat: "10:days",
      recurrence: { freq: "daily", interval: 10, time: "09:00", count: 3 },
      occurrencesFired: 1,
    });
    expect(facts.next_occurrences).toEqual(["2026-10-18 09:00", "2026-10-28 09:00"]);
    expect(facts.remaining_times).toBe(2);
  });

  it("explains legacy repeat tokens too", () => {
    const facts = reminderRuleSnapshot({
      fireAt: new Date("2026-10-08T08:00:00Z"),
      repeat: "weekdays:3,4",
    });
    expect(facts.recurrence_text).toBe("כל רביעי וחמישי ב־11:00");
    expect(facts.next_occurrences?.slice(0, 3)).toEqual([
      "2026-10-08 11:00",
      "2026-10-14 11:00",
      "2026-10-15 11:00",
    ]);
  });

  it("one-shot rows carry no rule facts", () => {
    const row = toReminderSnapshotRow(
      {
        id: "r1",
        itemLabel: "חלב",
        listType: "shopping",
        fireAt: NOW,
        repeat: "once",
        pingIds: [],
        ownerId: "o",
        messageText: "",
        status: "active",
      },
      new Map(),
    );
    expect(row.recurrence_text).toBeUndefined();
    expect(row.next_occurrences).toBeUndefined();
  });

  it("a new recurrence is a new clock, not a text-only update", () => {
    expect(
      canReuseExistingReminderClock(
        {
          action: "add",
          text: "שתייה",
          time: "",
          inSeconds: null,
          everyCount: null,
          everyUnit: null,
          weekdays: null,
          recurrence: { freq: "daily", interval: 1, time: "10:00" },
        },
        true,
      ),
    ).toBe(false);
  });
});

describe("recurring tasks", () => {
  const gym = shapeItemRecurrence(
    {
      "שם מטלה": "ללכת לחדר כושר",
      recurrence: { freq: "weekly", interval: 1, weekdays: [2, 4], time: "19:00" },
    },
    NOW,
  );

  it("stores the rule under a reserved key with חוזר for display", () => {
    expect(gym.clear).toBe(false);
    expect(gym.item).not.toHaveProperty("recurrence");
    expect(gym.item[RECURRENCE_DISPLAY_KEY]).toBe("כל שלישי וחמישי ב־19:00");
    expect(gym.item[RECURRENCE_META_KEY]).toMatchObject({
      freq: "weekly",
      weekdays: [2, 4],
      start: "2026-10-07",
    });
    expect(stripRecurrenceMeta(gym.item)).not.toHaveProperty(RECURRENCE_META_KEY);
  });

  it("lists upcoming dates per occurrence", () => {
    expect(itemNextOccurrences(gym.item, NOW)?.slice(0, 4)).toEqual([
      "2026-10-08 19:00",
      "2026-10-13 19:00",
      "2026-10-15 19:00",
      "2026-10-20 19:00",
    ]);
  });

  it("all-day rule lists dates only, including today", () => {
    const shaped = shapeItemRecurrence(
      { "שם מטלה": "להשקות", recurrence: { freq: "weekly", weekdays: [3] } },
      NOW,
    );
    expect(itemNextOccurrences(shaped.item, NOW)?.slice(0, 2)).toEqual([
      "2026-10-07",
      "2026-10-14",
    ]);
  });

  it("null recurrence on update clears the rule", () => {
    const shaped = shapeItemRecurrence({ "שם מטלה": "ללכת לחדר כושר", recurrence: null });
    expect(shaped.clear).toBe(true);
    expect(clearItemRecurrence({ ...gym.item })).toEqual({ "שם מטלה": "ללכת לחדר כושר" });
  });

  it("items without recurrence are untouched", () => {
    const item = { "שם מטלה": "לקנות חלב" };
    expect(shapeItemRecurrence(item)).toEqual({ item, clear: false });
    expect(itemNextOccurrences(item)).toBeNull();
  });
});

describe("standing task occurrence done", () => {
  const gym = shapeItemRecurrence(
    {
      "שם מטלה": "ללכת לחדר כושר",
      recurrence: { freq: "weekly", interval: 1, weekdays: [3, 4], time: "19:00" },
    },
    NOW,
  ).item;

  it("reads occurrence_done as a date or today", () => {
    expect(extractOccurrenceDone({ item_id: "a", occurrence_done: true }, NOW)).toEqual({
      item: { item_id: "a" },
      doneDate: "2026-10-07",
    });
    expect(extractOccurrenceDone({ occurrence_done: "2026-10-06" }, NOW).doneDate).toBe(
      "2026-10-06",
    );
    expect(extractOccurrenceDone({ "שם מטלה": "x" }, NOW).doneDate).toBeNull();
  });

  it("today's done occurrence leaves next_occurrences, the row stays", () => {
    expect(itemNextOccurrences(gym, NOW)?.[0]).toBe("2026-10-07 19:00");
    const marked = markOccurrenceDone(gym, "2026-10-07");
    expect(itemDoneThrough(marked)).toBe("2026-10-07");
    expect(marked[RECURRENCE_DISPLAY_KEY]).toBe(gym[RECURRENCE_DISPLAY_KEY]);
    expect(itemNextOccurrences(marked, NOW)?.slice(0, 2)).toEqual([
      "2026-10-08 19:00",
      "2026-10-14 19:00",
    ]);
  });

  it("never moves done_through backwards and ignores tasks without a rule", () => {
    const later = markOccurrenceDone(markOccurrenceDone(gym, "2026-10-08"), "2026-10-07");
    expect(itemDoneThrough(later)).toBe("2026-10-08");
    const plain = { "שם מטלה": "לקנות חלב" };
    expect(markOccurrenceDone(plain, "2026-10-07")).toBe(plain);
  });
});

describe("worker task mirrors its clock rule", () => {
  it("copies a calendar rule and keeps start / done_through", () => {
    const task = {
      "שם מטלה": "להזכיר לעמית ללכת לחדר כושר",
      [RECURRENCE_META_KEY]: { freq: "daily", interval: 1, start: "2026-10-01", done_through: "2026-10-06" },
    };
    const next = applyClockRuleToTask(
      task,
      { freq: "weekly", interval: 1, weekdays: [2, 4], time: "19:00" },
      NOW,
    );
    expect(next[RECURRENCE_META_KEY]).toEqual({
      freq: "weekly",
      interval: 1,
      weekdays: [2, 4],
      time: "19:00",
      start: "2026-10-01",
      done_through: "2026-10-06",
    });
    expect(next[RECURRENCE_DISPLAY_KEY]).toBe("כל שלישי וחמישי ב־19:00");
  });

  it("drops the rule for interval or one-shot clocks", () => {
    const task = shapeItemRecurrence(
      { "שם מטלה": "x", recurrence: { freq: "daily", time: "09:00" } },
      NOW,
    ).item;
    expect(applyClockRuleToTask(task, null)).toEqual({ "שם מטלה": "x" });
    expect(
      applyClockRuleToTask(task, { freq: "interval", interval: 10, unit: "minutes" }),
    ).toEqual({ "שם מטלה": "x" });
  });
});

describe("SESSION_CLOCK calendar", () => {
  it("starts on this week's Sunday and spans nine weeks", () => {
    const weeks = upcomingCalendarWeeks(NOW);
    expect(weeks).toHaveLength(9);
    expect(weeks[0].startsWith("2026-10-04 ראשון, 2026-10-05 שני")).toBe(true);
    expect(weeks[2]).toContain("2026-10-20 שלישי");
  });

  it("is injected with the recurring date-answer rule", () => {
    const text = formatSessionClockContext(NOW);
    expect(text).toContain("calendar");
    expect(text).toContain("2026-10-20 שלישי");
    expect(text).toContain("(קבוע)");
    expect(text).toContain("MUST scan next_occurrences");
    expect(text).toContain("FORBIDDEN: empty day answer");
  });
});
