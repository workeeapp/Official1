import { describe, expect, it } from "vitest";
import { JOB_META_KEY } from "../src/services/job-meta.js";
import {
  collectOverdueFromItems,
  isTaskOverdue,
  overdueTasksAsk,
  taskLastDay,
  ymdFromTaskValue,
} from "../src/services/overdue-tasks.js";

const TODAY = "2026-10-26";

describe("ymdFromTaskValue / taskLastDay", () => {
  it("accepts YYYY-MM-DD and rejects invalid calendar days", () => {
    expect(ymdFromTaskValue("2026-10-25")).toBe("2026-10-25");
    expect(ymdFromTaskValue("2026-10-25T12:00:00")).toBe("2026-10-25");
    expect(ymdFromTaskValue("היום")).toBeNull();
    expect(ymdFromTaskValue("2026-02-29")).toBeNull();
  });

  it("prefers תאריך סיום over תאריך לביצוע", () => {
    expect(
      taskLastDay({
        "שם מטלה": "נסיעה",
        "תאריך לביצוע": "2026-10-20",
        "תאריך סיום": "2026-10-24",
      }),
    ).toBe("2026-10-24");
    expect(
      taskLastDay({
        "שם מטלה": "קניות",
        "תאריך לביצוע": "2026-10-20",
      }),
    ).toBe("2026-10-20");
  });
});

describe("isTaskOverdue / collectOverdueFromItems", () => {
  it("marks past last day overdue and skips undated / ongoing / job rows", () => {
    expect(
      isTaskOverdue({ "תאריך לביצוע": "2026-10-25" }, TODAY),
    ).toBe(true);
    expect(
      isTaskOverdue(
        {
          "תאריך לביצוע": "2026-10-20",
          "תאריך סיום": "2026-10-27",
        },
        TODAY,
      ),
    ).toBe(false);
    expect(
      isTaskOverdue(
        {
          "תאריך לביצוע": "2026-10-20",
          "תאריך סיום": "2026-10-25",
        },
        TODAY,
      ),
    ).toBe(true);
    expect(isTaskOverdue({ "שם מטלה": "בלי תאריך" }, TODAY)).toBe(false);
    expect(
      isTaskOverdue(
        {
          "שם מטלה": "לבדוק עם עמית: שאלה",
          [JOB_META_KEY]: {
            kind: "job",
            askerId: "a",
            subjectId: "a",
            askerName: "עמית",
            subjectName: "עמית",
            ask: "שאלה",
            state: "open",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        },
        TODAY,
      ),
    ).toBe(false);
  });

  it("collects titles and ids for overdue rows only", () => {
    const rows = collectOverdueFromItems(
      [
        {
          id: "1",
          data: { "שם מטלה": "חלב", "תאריך לביצוע": "2026-10-20" },
        },
        {
          id: "2",
          data: {
            "שם מטלה": "נסיעה",
            "תאריך לביצוע": "2026-10-20",
            "תאריך סיום": "2026-10-30",
          },
        },
        {
          id: "3",
          data: { "שם מטלה": "דוח", "תאריך לביצוע": "2026-10-01" },
        },
      ],
      TODAY,
    );
    expect(rows).toEqual([
      { itemId: "1", title: "חלב", lastDay: "2026-10-20" },
      { itemId: "3", title: "דוח", lastDay: "2026-10-01" },
    ]);
  });
});

describe("overdueTasksAsk", () => {
  it("builds a stable Hebrew ask with count and titles", () => {
    expect(overdueTasksAsk(["חלב"])).toContain("מטלה אחת");
    expect(overdueTasksAsk(["חלב", "דוח"])).toMatch(/^2 משימות/);
    expect(overdueTasksAsk(["חלב", "דוח"])).toContain("חלב, דוח");
  });
});
