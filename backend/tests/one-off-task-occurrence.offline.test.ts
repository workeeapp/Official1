/**
 * Engine guard: past one-off date rewrite → treat as add (not update).
 */
import { describe, expect, it } from "vitest";
import {
  isStandingOrRecurringTask,
  messageSignalsExplicitOneOffMove,
  shouldRewritePastOneOffDateUpdateAsAdd,
  taskDueHasPassed,
} from "../src/services/one-off-task-occurrence.js";
import { RECURRENCE_META_KEY } from "../src/services/list-recurrence.js";

describe("one-off task occurrence identity (engine)", () => {
  const now = new Date("2026-11-11T12:00:00+02:00");

  it("detects a past due one-off", () => {
    expect(
      taskDueHasPassed(
        { "שם משימה": "X", "תאריך לביצוע": "2026-11-11", "שעה לביצוע": "10:00" },
        now,
      ),
    ).toBe(true);
    expect(
      taskDueHasPassed(
        { "שם משימה": "X", "תאריך לביצוע": "2026-11-11", "שעה לביצוע": "13:30" },
        now,
      ),
    ).toBe(false);
  });

  it("rewrites past one-off to a different day as add", () => {
    expect(
      shouldRewritePastOneOffDateUpdateAsAdd({
        existingData: {
          "שם משימה": "X",
          "תאריך לביצוע": "2026-11-11",
          "שעה לביצוע": "10:00",
        },
        nextData: {
          "שם משימה": "X",
          "תאריך לביצוע": "2027-02-17",
          "שעה לביצוע": "13:30",
        },
        now,
      }),
    ).toBe(true);
  });

  it("keeps same-day time correction as update", () => {
    expect(
      shouldRewritePastOneOffDateUpdateAsAdd({
        existingData: {
          "שם משימה": "X",
          "תאריך לביצוע": "2026-11-11",
          "שעה לביצוע": "10:00",
        },
        nextData: {
          "שם משימה": "X",
          "תאריך לביצוע": "2026-11-11",
          "שעה לביצוע": "15:00",
        },
        now,
      }),
    ).toBe(false);
  });

  it("does not rewrite an upcoming one-off", () => {
    expect(
      shouldRewritePastOneOffDateUpdateAsAdd({
        existingData: {
          "שם משימה": "X",
          "תאריך לביצוע": "2026-11-20",
          "שעה לביצוע": "09:00",
        },
        nextData: {
          "שם משימה": "X",
          "תאריך לביצוע": "2026-12-01",
          "שעה לביצוע": "09:00",
        },
        now,
      }),
    ).toBe(false);
  });

  it("leaves standing/recurring tasks unchanged", () => {
    const standing = {
      "שם משימה": "X",
      "תאריך לביצוע": "2026-11-11",
      "שעה לביצוע": "08:00",
      [RECURRENCE_META_KEY]: {
        freq: "weekly",
        weekdays: [0],
        time: "08:00",
        start: "2026-11-02",
      },
      חוזר: "כל יום ראשון ב־08:00",
    };
    expect(isStandingOrRecurringTask(standing)).toBe(true);
    expect(
      shouldRewritePastOneOffDateUpdateAsAdd({
        existingData: standing,
        nextData: {
          "שם משימה": "X",
          "תאריך לביצוע": "2027-02-17",
          "שעה לביצוע": "08:00",
          [RECURRENCE_META_KEY]: standing[RECURRENCE_META_KEY],
          חוזר: standing.חוזר,
        },
        now,
      }),
    ).toBe(false);
  });

  it("detects explicit move cues vs bare dated restatement", () => {
    expect(messageSignalsExplicitOneOffMove("תזיזי את המשימה למחר ב־11:00")).toBe(
      true,
    );
    expect(messageSignalsExplicitOneOffMove("תעדכני את המועד ל־17.2")).toBe(true);
    expect(messageSignalsExplicitOneOffMove("לעדכן")).toBe(true);
    expect(messageSignalsExplicitOneOffMove("כן, לעדכן את הקיים")).toBe(true);
    expect(
      messageSignalsExplicitOneOffMove("17.2 שעה 1330 משימה לדוגמה"),
    ).toBe(false);
  });

  it("keeps explicit move of a past one-off as update", () => {
    expect(
      shouldRewritePastOneOffDateUpdateAsAdd({
        existingData: {
          "שם משימה": "X",
          "תאריך לביצוע": "2026-11-11",
          "שעה לביצוע": "10:00",
        },
        nextData: {
          "שם משימה": "X",
          "תאריך לביצוע": "2027-02-17",
          "שעה לביצוע": "13:30",
        },
        now,
        allowExplicitMove: true,
      }),
    ).toBe(false);
  });
});
