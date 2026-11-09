/**
 * B1 — a standing task moved → which rule a linked repeating clock follows
 * (pure, no DB). Server-side, without asking (owner decision 2026-11-09).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Recurrence } from "@workee/shared";
import { formatJerusalemDateTime } from "@workee/shared";
import { followStandingTaskMove } from "../src/services/reminder.service.js";

const NOW = new Date("2030-01-01T08:00:00.000Z"); // Tuesday
const weekly = (weekdays: number[], time: string): Recurrence => ({ freq: "weekly", interval: 1, weekdays, time });

describe("followStandingTaskMove", () => {
  it("days + time change → the clock takes the new days and keeps its offset (30 min before)", () => {
    const result = followStandingTaskMove({
      taskBefore: weekly([1], "17:00"),
      taskAfter: weekly([3], "18:00"),
      clock: weekly([1], "16:30"),
      now: NOW,
    });
    expect(result?.rule).toMatchObject({ freq: "weekly", interval: 1, weekdays: [3], time: "17:30" });
    expect(formatJerusalemDateTime(result!.fireAt)).toBe("2030-01-02 17:30");
  });

  it("time-only change → same days, clock shifted by the same minutes", () => {
    const result = followStandingTaskMove({
      taskBefore: weekly([1, 4], "17:00"),
      taskAfter: weekly([4, 1], "19:15"),
      clock: weekly([4, 1], "17:00"),
      now: NOW,
    });
    expect(result?.rule).toMatchObject({ weekdays: [1, 4], time: "19:15" });
  });

  it("a clock on other days than the task's old rule does not track it → untouched", () => {
    expect(
      followStandingTaskMove({
        taskBefore: weekly([1], "17:00"),
        taskAfter: weekly([2], "17:00"),
        clock: { freq: "daily", interval: 1, time: "08:00" },
        now: NOW,
      }),
    ).toBeNull();
  });

  it("nothing changed in days or time → untouched", () => {
    expect(
      followStandingTaskMove({
        taskBefore: weekly([1], "17:00"),
        taskAfter: weekly([1], "17:00"),
        clock: weekly([1], "16:30"),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("the offset would cross midnight → untouched (never moved to a different day silently)", () => {
    expect(
      followStandingTaskMove({
        taskBefore: weekly([1], "08:00"),
        taskAfter: weekly([1], "00:10"),
        clock: weekly([1], "07:30"),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("interval rules are never followed; until / count carry over", () => {
    expect(
      followStandingTaskMove({
        taskBefore: { freq: "interval", interval: 6, unit: "hours", time: "12:00" },
        taskAfter: { freq: "interval", interval: 4, unit: "hours", time: "12:00" },
        clock: { freq: "interval", interval: 6, unit: "hours", time: "12:00" },
        now: NOW,
      }),
    ).toBeNull();
    const result = followStandingTaskMove({
      taskBefore: weekly([1], "17:00"),
      taskAfter: weekly([2], "17:00"),
      clock: { ...weekly([1], "16:00"), until: "2030-06-30", count: 10 },
      now: NOW,
    });
    expect(result?.rule).toMatchObject({ weekdays: [2], time: "16:00", until: "2030-06-30", count: 10 });
  });

  it("monthly: new month day, same offset", () => {
    const result = followStandingTaskMove({
      taskBefore: { freq: "monthly", interval: 1, monthDay: 1, time: "09:00" },
      taskAfter: { freq: "monthly", interval: 1, monthDay: 15, time: "09:00" },
      clock: { freq: "monthly", interval: 1, monthDay: 1, time: "08:00" },
      now: NOW,
    });
    expect(result?.rule).toMatchObject({ freq: "monthly", monthDay: 15, time: "08:00" });
    expect(formatJerusalemDateTime(result!.fireAt)).toBe("2030-01-15 08:00");
  });
});

describe("B1 prompt: no ask to move the linked reminder", () => {
  it("system STANDING rule: lists.update only, the server moves the reminder", () => {
    const config = (JSON.parse(readFileSync(resolve(process.cwd(), "..", "LLM.config.json"), "utf8")) as {
      systemMessage: string[];
    }).systemMessage.join("\n");
    expect(config).not.toContain("Series time change with linked clock → ask whether to move WhatsApp too");
    expect(config).toContain("the server moves the linked reminder too (no ask)");
  });
});
