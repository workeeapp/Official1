import { describe, expect, it } from "vitest";
import { formatJerusalemDateTime } from "@workee/shared";
import {
  canReuseExistingReminderClock,
  reminderOccurrencesInRange,
  reminderRuleSnapshot,
  resolveRecurringFireAt,
  toReminderSnapshotRow,
} from "../src/services/reminder.service.js";
import {
  RECURRENCE_DISPLAY_KEY,
  RECURRENCE_META_KEY,
  applyClockRuleToTask,
  clearItemRecurrence,
  applyOccurrenceChange,
  extractOccurrenceChange,
  extractOccurrenceDone,
  itemDoneDates,
  itemNextOccurrences,
  itemOccurrenceExceptions,
  itemOccurrencesInRange,
  keepOccurrenceMarks,
  keepRecurrenceStart,
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

  it("occurrenceRange expands a weekly clock past the short snapshot horizon", () => {
    const row = {
      fireAt: new Date("2026-10-09T08:45:00.000Z"), // Fri 11:45 Jerusalem
      repeat: "custom",
      recurrence: { freq: "weekly", interval: 1, weekdays: [5], time: "11:45" },
    };
    expect(reminderRuleSnapshot(row).next_occurrences?.some((v) => v.startsWith("2027-04-09"))).toBe(
      false,
    );
    expect(reminderOccurrencesInRange(row, "2027-04-09", "2027-04-09")).toEqual([
      "2027-04-09 11:45",
    ]);
    expect(
      reminderRuleSnapshot(row, { from: "2027-04-09", to: "2027-04-09" }).next_occurrences,
    ).toEqual(["2027-04-09 11:45"]);
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

  it("a ranged rule shows start–end in חוזר and next_occurrences", () => {
    const meeting = shapeItemRecurrence(
      {
        "שם מטלה": "פגישה (עמית, טל)",
        recurrence: { freq: "weekly", interval: 1, weekdays: [1], time: "10:00", end_time: "12:00" },
      },
      NOW,
    );
    expect(meeting.item[RECURRENCE_DISPLAY_KEY]).toBe("כל יום שני ב־10:00–12:00");
    expect(meeting.item[RECURRENCE_META_KEY]).toMatchObject({ time: "10:00", end_time: "12:00" });
    expect(itemNextOccurrences(meeting.item, NOW)?.slice(0, 2)).toEqual([
      "2026-10-12 10:00–12:00",
      "2026-10-19 10:00–12:00",
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

  it("every two weeks from a stated start keeps the cycle, even after the start passes", () => {
    // Sat 2026-10-10: «כל שבועיים ביום שישי החל מעוד 10 ימים ב־11:45».
    const saturday = new Date("2026-10-10T03:00:00.000Z");
    const kids = shapeItemRecurrence(
      {
        "שם מטלה": "לאסוף את הילדים",
        recurrence: { freq: "weekly", interval: 2, weekdays: [5], time: "11:45", start: "2026-10-20" },
      },
      saturday,
    );
    expect(kids.explicitStart).toBe(true);
    expect(itemNextOccurrences(kids.item, saturday)?.slice(0, 3)).toEqual([
      "2026-10-23 11:45",
      "2026-11-06 11:45",
      "2026-11-20 11:45",
    ]);
    const nextSaturday = new Date("2026-10-24T03:00:00.000Z");
    expect(itemNextOccurrences(kids.item, nextSaturday)?.[0]).toBe("2026-11-06 11:45");
  });

  it("itemOccurrencesInRange finds a weekly Friday far beyond the short next_occurrences horizon", () => {
    // 2027-04-09 is a Friday; short horizon (~62d / 6 slots) never reaches it from Oct 2026.
    const kids = shapeItemRecurrence(
      {
        "שם מטלה": "לאסוף את הילדים",
        recurrence: { freq: "weekly", interval: 1, weekdays: [5], time: "11:45" },
      },
      NOW,
    );
    expect(itemNextOccurrences(kids.item, NOW)?.some((v) => v.startsWith("2027-04-09"))).toBe(
      false,
    );
    expect(itemOccurrencesInRange(kids.item, "2027-04-09", "2027-04-09", NOW)).toEqual([
      "2027-04-09 11:45",
    ]);
    // A Thursday in that week must not match.
    expect(itemOccurrencesInRange(kids.item, "2027-04-08", "2027-04-08", NOW)).toEqual([]);
  });

  it("itemOccurrencesInRange keeps every-N parity for a far window", () => {
    const saturday = new Date("2026-10-10T03:00:00.000Z");
    const kids = shapeItemRecurrence(
      {
        "שם מטלה": "לאסוף את הילדים",
        recurrence: {
          freq: "weekly",
          interval: 2,
          weekdays: [5],
          time: "11:45",
          start: "2026-10-20",
        },
      },
      saturday,
    );
    // On-cycle: 2026-10-23, 11-06, 11-20, 12-04, 12-18, 2027-01-01, …
    expect(itemOccurrencesInRange(kids.item, "2026-12-04", "2026-12-04", saturday)).toEqual([
      "2026-12-04 11:45",
    ]);
    // Off-cycle Friday between 11-20 and 12-04.
    expect(itemOccurrencesInRange(kids.item, "2026-11-27", "2026-11-27", saturday)).toEqual([]);
  });

  it("an update re-sending the rule without start keeps the row's start", () => {
    const previous = {
      "שם מטלה": "x",
      [RECURRENCE_META_KEY]: { freq: "weekly", interval: 2, weekdays: [5], start: "2026-10-20" },
    };
    const shaped = shapeItemRecurrence(
      { recurrence: { freq: "weekly", interval: 2, weekdays: [5], time: "12:00" } },
      NOW,
    );
    expect(shaped.explicitStart).toBe(false);
    const merged = keepRecurrenceStart({ ...previous, ...shaped.item }, previous);
    expect(merged[RECURRENCE_META_KEY]).toMatchObject({ time: "12:00", start: "2026-10-20" });
  });

  it("items without recurrence are untouched", () => {
    const item = { "שם מטלה": "לקנות חלב" };
    expect(shapeItemRecurrence(item)).toEqual({ item, clear: false, explicitStart: false });
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
    const marked = markOccurrenceDone(gym, "2026-10-07", NOW);
    expect(itemDoneDates(marked)).toEqual(["2026-10-07"]);
    expect(marked[RECURRENCE_DISPLAY_KEY]).toBe(gym[RECURRENCE_DISPLAY_KEY]);
    expect(itemNextOccurrences(marked, NOW)?.slice(0, 2)).toEqual([
      "2026-10-08 19:00",
      "2026-10-14 19:00",
    ]);
  });

  it("a future done day hides only that day, not the ones before it", () => {
    const marked = markOccurrenceDone(gym, "2026-10-14", NOW);
    expect(itemNextOccurrences(marked, NOW)?.slice(0, 3)).toEqual([
      "2026-10-07 19:00",
      "2026-10-08 19:00",
      "2026-10-15 19:00",
    ]);
  });

  it("keeps every done day and ignores tasks without a rule", () => {
    const both = markOccurrenceDone(markOccurrenceDone(gym, "2026-10-08", NOW), "2026-10-07", NOW);
    expect(itemDoneDates(both)).toEqual(["2026-10-07", "2026-10-08"]);
    const plain = { "שם מטלה": "לקנות חלב" };
    expect(markOccurrenceDone(plain, "2026-10-07")).toBe(plain);
  });

  it("still honours a legacy done_through cutoff", () => {
    const legacy = {
      ...gym,
      [RECURRENCE_META_KEY]: {
        ...(gym[RECURRENCE_META_KEY] as Record<string, unknown>),
        done_through: "2026-10-08",
      },
    };
    expect(itemNextOccurrences(legacy, NOW)?.[0]).toBe("2026-10-14 19:00");
  });
});

describe("standing task occurrence change", () => {
  // Sat 2026-10-10: «לאסוף את הילדים כל יום שישי ב־12:00».
  const saturday = new Date("2026-10-10T03:00:00.000Z");
  const kids = shapeItemRecurrence(
    {
      "שם מטלה": "לאסוף את הילדים",
      recurrence: { freq: "weekly", interval: 1, weekdays: [5], time: "12:00" },
    },
    saturday,
  ).item;

  it("reads occurrence_change off the ACTION item", () => {
    expect(
      extractOccurrenceChange({ item_id: "a", occurrence_change: { date: "2026-10-23", cancel: true } }),
    ).toEqual({ item: { item_id: "a" }, change: { date: "2026-10-23", cancel: true } });
    expect(
      extractOccurrenceChange({ occurrence_change: { date: "2026-10-23", time: "11:0" } }).change,
    ).toBeNull();
  });

  it("cancels only 23.10; every other Friday stays", () => {
    const next = applyOccurrenceChange(kids, { date: "2026-10-23", cancel: true }, saturday);
    expect(itemNextOccurrences(next, saturday)?.slice(0, 3)).toEqual([
      "2026-10-16 12:00",
      "2026-10-30 12:00",
      "2026-11-06 12:00",
    ]);
    expect(itemOccurrenceExceptions(next, saturday)).toEqual(["23.10 בוטל"]);
    expect(next[RECURRENCE_DISPLAY_KEY]).toBe("כל יום שישי ב־12:00");
  });

  it("moves only 23.10 to 11:00", () => {
    const next = applyOccurrenceChange(kids, { date: "2026-10-23", time: "11:00" }, saturday);
    expect(itemNextOccurrences(next, saturday)?.slice(0, 3)).toEqual([
      "2026-10-16 12:00",
      "2026-10-23 11:00",
      "2026-10-30 12:00",
    ]);
    expect(itemOccurrenceExceptions(next, saturday)).toEqual(["23.10 ב־11:00"]);
  });

  it("a second change on the same day replaces the first", () => {
    const moved = applyOccurrenceChange(kids, { date: "2026-10-23", time: "11:00" }, saturday);
    const cancelled = applyOccurrenceChange(moved, { date: "2026-10-23", cancel: true }, saturday);
    expect(itemOccurrenceExceptions(cancelled, saturday)).toEqual(["23.10 בוטל"]);
  });

  it("refuses a day the rule does not land on, a past day, or a task without a rule", () => {
    expect(applyOccurrenceChange(kids, { date: "2026-10-22", cancel: true }, saturday)).toBe(kids);
    expect(applyOccurrenceChange(kids, { date: "2026-10-09", cancel: true }, saturday)).toBe(kids);
    const plain = { "שם מטלה": "לקנות חלב" };
    expect(applyOccurrenceChange(plain, { date: "2026-10-23", cancel: true }, saturday)).toBe(plain);
  });

  it("an all-day rule shows the moved day with its time", () => {
    const allDay = shapeItemRecurrence(
      { "שם מטלה": "להשקות", recurrence: { freq: "weekly", weekdays: [5] } },
      saturday,
    ).item;
    const next = applyOccurrenceChange(allDay, { date: "2026-10-23", time: "08:00" }, saturday);
    expect(itemNextOccurrences(next, saturday)?.slice(0, 3)).toEqual([
      "2026-10-16",
      "2026-10-23 08:00",
      "2026-10-30",
    ]);
  });

  it("a re-sent rule keeps the stored exceptions and done days", () => {
    const changed = markOccurrenceDone(
      applyOccurrenceChange(kids, { date: "2026-10-23", cancel: true }, saturday),
      "2026-10-16",
      saturday,
    );
    const resent = shapeItemRecurrence(
      { recurrence: { freq: "weekly", interval: 1, weekdays: [5], time: "12:30" } },
      saturday,
    ).item;
    const merged = keepOccurrenceMarks({ ...changed, ...resent }, changed);
    expect(itemNextOccurrences(merged, saturday)?.slice(0, 2)).toEqual([
      "2026-10-30 12:30",
      "2026-11-06 12:30",
    ]);
  });
});

describe("worker task mirrors its clock rule", () => {
  it("copies a calendar rule and keeps start / done marks", () => {
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

  it("drops the rule for one-shot clocks", () => {
    const task = shapeItemRecurrence(
      { "שם מטלה": "x", recurrence: { freq: "daily", time: "09:00" } },
      NOW,
    ).item;
    expect(applyClockRuleToTask(task, null)).toEqual({ "שם מטלה": "x" });
  });

  it("copies an interval rule anchored at the clock's fire time", () => {
    const task = { "שם מטלה": "להזכיר לעמית לשתות שוקו" };
    // Clock fires first at 14:00 Jerusalem, every two hours.
    const fireAt = new Date("2026-10-07T11:00:00.000Z");
    const next = applyClockRuleToTask(
      task,
      { freq: "interval", interval: 2, unit: "hours" },
      NOW,
      fireAt,
    );
    expect(next[RECURRENCE_META_KEY]).toEqual({
      freq: "interval",
      interval: 2,
      unit: "hours",
      time: "14:00",
      start: "2026-10-07",
    });
    expect(next[RECURRENCE_DISPLAY_KEY]).toBe("כל שעתיים");
    expect(itemNextOccurrences(next, NOW)?.slice(0, 3)).toEqual([
      "2026-10-07 14:00",
      "2026-10-07 16:00",
      "2026-10-07 18:00",
    ]);
  });
});

describe("standing task every X hours", () => {
  // «כל שלוש שעות אני צריך להוריד את הכלב» at 12:00 Wed 2026-10-07.
  const dog = shapeItemRecurrence(
    {
      "שם מטלה": "להוריד את הכלב",
      recurrence: { freq: "interval", interval: 3, unit: "hours" },
    },
    NOW,
  );

  it("keeps the rule, anchored now", () => {
    expect(dog.explicitStart).toBe(false);
    expect(dog.item[RECURRENCE_META_KEY]).toEqual({
      freq: "interval",
      interval: 3,
      unit: "hours",
      time: "12:00",
      start: "2026-10-07",
    });
    expect(dog.item[RECURRENCE_DISPLAY_KEY]).toBe("כל 3 שעות");
  });

  it("lists the slot due now and the ones after it, across midnight", () => {
    const later = new Date("2026-10-07T17:30:00.000Z"); // 20:30
    expect(itemNextOccurrences(dog.item, later)).toEqual([
      "2026-10-07 18:00",
      "2026-10-07 21:00",
      "2026-10-08 00:00",
      "2026-10-08 03:00",
      "2026-10-08 06:00",
      "2026-10-08 09:00",
    ]);
  });

  it("an explicit first time pins the anchor", () => {
    const shaped = shapeItemRecurrence(
      { recurrence: { freq: "interval", interval: 3, unit: "hours", time: "10:00" } },
      NOW,
    );
    expect(shaped.explicitStart).toBe(true);
    expect(itemNextOccurrences(shaped.item, NOW)?.slice(0, 2)).toEqual([
      "2026-10-07 10:00",
      "2026-10-07 13:00",
    ]);
  });

  it("an update re-sending the rule keeps the original start time", () => {
    const resent = shapeItemRecurrence(
      { recurrence: { freq: "interval", interval: 2, unit: "hours" } },
      new Date("2026-10-08T06:17:00.000Z"),
    );
    const merged = keepRecurrenceStart({ ...dog.item, ...resent.item }, dog.item);
    expect(merged[RECURRENCE_META_KEY]).toMatchObject({
      interval: 2,
      time: "12:00",
      start: "2026-10-07",
    });
  });

  it("occurrence_done true hides only the slot due now", () => {
    const at = new Date("2026-10-07T13:10:00.000Z"); // 16:10, slot 15:00 is due
    const done = extractOccurrenceDone({ occurrence_done: true }, at).doneDate!;
    const marked = markOccurrenceDone(dog.item, done, at);
    expect(itemDoneDates(marked)).toEqual(["2026-10-07 15:00"]);
    expect(itemNextOccurrences(marked, at)?.slice(0, 2)).toEqual([
      "2026-10-07 18:00",
      "2026-10-07 21:00",
    ]);
  });

  it("a slot time snaps to its slot", () => {
    expect(extractOccurrenceDone({ occurrence_done: "2026-10-07 18:05" }, NOW).doneDate).toBe(
      "2026-10-07 18:05",
    );
    const marked = markOccurrenceDone(dog.item, "2026-10-07 18:05", NOW);
    expect(itemDoneDates(marked)).toEqual(["2026-10-07 18:00"]);
  });

  it("honours count and until", () => {
    const counted = shapeItemRecurrence(
      { recurrence: { freq: "interval", interval: 3, unit: "hours", count: 3 } },
      NOW,
    ).item;
    expect(itemNextOccurrences(counted, NOW)).toEqual([
      "2026-10-07 12:00",
      "2026-10-07 15:00",
      "2026-10-07 18:00",
    ]);
    const bounded = shapeItemRecurrence(
      { recurrence: { freq: "interval", interval: 3, unit: "hours", until: "2026-10-07" } },
      NOW,
    ).item;
    expect(itemNextOccurrences(bounded, NOW)).toEqual([
      "2026-10-07 12:00",
      "2026-10-07 15:00",
      "2026-10-07 18:00",
      "2026-10-07 21:00",
    ]);
  });

  it("refuses a task that repeats faster than every 5 minutes or in seconds", () => {
    const tooFastMinutes = shapeItemRecurrence(
      { "שם מטלה": "לשתות מים", recurrence: { freq: "interval", interval: 3, unit: "minutes" } },
      NOW,
    );
    expect(tooFastMinutes.tooFrequent).toBe(true);
    expect(tooFastMinutes.item[RECURRENCE_META_KEY]).toBeUndefined();
    const seconds = shapeItemRecurrence(
      { "שם מטלה": "לשתות מים", recurrence: { freq: "interval", interval: 30, unit: "seconds" } },
      NOW,
    );
    expect(seconds.tooFrequent).toBe(true);
    expect(seconds.item[RECURRENCE_META_KEY]).toBeUndefined();
    const everyFive = shapeItemRecurrence(
      { "שם מטלה": "לשתות מים", recurrence: { freq: "interval", interval: 5, unit: "minutes" } },
      NOW,
    );
    expect(everyFive.tooFrequent).toBeUndefined();
    expect(everyFive.item[RECURRENCE_META_KEY]).toBeTruthy();
    expect(dog).not.toHaveProperty("tooFrequent");
  });

  it("refuses a single-occurrence change", () => {
    const changed = applyOccurrenceChange(
      dog.item,
      { date: "2026-10-08", cancel: true },
      NOW,
    );
    expect(changed).toBe(dog.item);
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
    expect(text).toContain("show_dump=tasks");
    expect(text).toContain("FORBIDDEN model-written agenda");
    expect(text).toContain("RECURRING / WHEN DATE ASK");
    expect(text).toContain("RETRIEVAL CONTRACT path 2");
  });
});
