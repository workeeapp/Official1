import { describe, expect, it } from "vitest";
import { JOB_META_KEY } from "../src/services/job-meta.js";
import {
  collectStaleUndatedFromItems,
  isStaleMilestoneAge,
  isUndatedTask,
  jerusalemCalendarAgeDays,
  staleUndatedTasksAsk,
} from "../src/services/stale-undated-tasks.js";

describe("isStaleMilestoneAge", () => {
  it("accepts 7×2^n and rejects others", () => {
    expect(isStaleMilestoneAge(7)).toBe(true);
    expect(isStaleMilestoneAge(14)).toBe(true);
    expect(isStaleMilestoneAge(28)).toBe(true);
    expect(isStaleMilestoneAge(56)).toBe(true);
    expect(isStaleMilestoneAge(112)).toBe(true);
    expect(isStaleMilestoneAge(0)).toBe(false);
    expect(isStaleMilestoneAge(6)).toBe(false);
    expect(isStaleMilestoneAge(8)).toBe(false);
    expect(isStaleMilestoneAge(21)).toBe(false);
    expect(isStaleMilestoneAge(42)).toBe(false);
  });
});

describe("isUndatedTask / collectStaleUndatedFromItems", () => {
  it("skips dated and job rows", () => {
    expect(isUndatedTask({ "שם מטלה": "א", "תאריך לביצוע": "2026-10-01" })).toBe(
      false,
    );
    expect(
      isUndatedTask({
        "שם מטלה": "לבדוק",
        [JOB_META_KEY]: {
          kind: "job",
          askerId: "a",
          subjectId: "a",
          askerName: "עמית",
          subjectName: "עמית",
          ask: "x",
          state: "open",
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      }),
    ).toBe(false);
    expect(isUndatedTask({ "שם מטלה": "בנק" })).toBe(true);
  });

  it("collects only undated rows at milestone ages", () => {
    const now = new Date("2026-10-26T12:00:00.000Z");
    const daysAgo = (n: number) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - n);
      return d;
    };
    const rows = collectStaleUndatedFromItems(
      [
        {
          id: "1",
          data: { "שם מטלה": "בנק" },
          updatedAt: daysAgo(7),
        },
        {
          id: "2",
          data: { "שם מטלה": "חלב", "תאריך לביצוע": "2026-10-01" },
          updatedAt: daysAgo(7),
        },
        {
          id: "3",
          data: { "שם מטלה": "דוח" },
          updatedAt: daysAgo(8),
        },
        {
          id: "4",
          data: { "שם מטלה": "ביטוח" },
          updatedAt: daysAgo(14),
        },
      ],
      now,
    );
    expect(rows.map((r) => r.itemId)).toEqual(["1", "4"]);
    expect(rows[0]?.ageDays).toBe(7);
    expect(rows[1]?.ageDays).toBe(14);
  });
});

describe("jerusalemCalendarAgeDays / staleUndatedTasksAsk", () => {
  it("counts whole Jerusalem calendar days", () => {
    const from = new Date("2026-10-19T22:00:00.000Z");
    const now = new Date("2026-10-26T10:00:00.000Z");
    expect(jerusalemCalendarAgeDays(from, now)).toBeGreaterThanOrEqual(6);
  });

  it("builds ask copy for one or many", () => {
    expect(
      staleUndatedTasksAsk([{ title: "בנק", ageDays: 7 }]),
    ).toContain("7 ימים");
    expect(
      staleUndatedTasksAsk([
        { title: "בנק", ageDays: 7 },
        { title: "ביטוח", ageDays: 14 },
      ]),
    ).toMatch(/^2 משימות/);
  });
});
