import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmReminderAction, PublicEmployee } from "@workee/shared";

const {
  reminderFindMany,
  reminderUpdate,
  reminderCreate,
  nextCandleLighting,
} = vi.hoisted(() => ({
  reminderFindMany: vi.fn(),
  reminderUpdate: vi.fn(),
  reminderCreate: vi.fn(),
  nextCandleLighting: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: {
      findMany: reminderFindMany,
      update: reminderUpdate,
      create: reminderCreate,
    },
  },
}));
vi.mock("../src/services/audit.service.js", () => ({
  recordAuditEvent: vi.fn(),
}));
vi.mock("../src/services/reminder-fire.js", () => ({
  scheduleSoon: vi.fn(),
}));
vi.mock("../src/services/jewish.js", () => ({
  nextCandleLighting,
}));

import { applyReminders } from "../src/services/reminder.service.js";

const amit: PublicEmployee = {
  id: "amit-1",
  name: "עמית",
  surname: "",
  nickname: "עמית",
  email: null,
  phone: "972500000000",
  kind: "human",
  protected: false,
} as PublicEmployee;

const candleReminder: LlmReminderAction = {
  action: "add",
  item: "להדליק נרות",
  listType: "tasks",
  date: "",
  time: "",
  repeat: "once",
  ping: ["עמית"],
  about: [],
  targets: [],
  text: "להדליק נרות",
  inSeconds: null,
  everyCount: null,
  everyUnit: null,
  weekdays: null,
  confirmed: false,
  compose: false,
  composeSource: "",
  composeLookbackHours: 0,
  composePlace: "פתח תקווה",
  scheduleAnchor: "jewish_candles",
  scheduleOffsetMinutes: -10,
  reminderId: "",
};

describe("candle-offset reminder apply", () => {
  beforeEach(() => {
    reminderFindMany.mockReset().mockResolvedValue([]);
    reminderUpdate.mockReset();
    reminderCreate.mockReset().mockImplementation(async ({ data }) => ({
      id: "rem-candle",
      ...data,
    }));
    nextCandleLighting.mockReset();
  });

  it("sets fire_at from Hebcal as a one-shot when recurrence is omitted", async () => {
    const fireAt = new Date("2026-10-23T14:29:00.000Z");
    nextCandleLighting.mockResolvedValue(fireAt);

    const result = await applyReminders({
      userId: "u1",
      actor: amit,
      employees: [amit],
      reminders: [candleReminder],
    });

    expect(result.skipped).toEqual([]);
    expect(result.saved).toHaveLength(1);
    expect(nextCandleLighting).toHaveBeenCalledWith({
      place: "פתח תקווה",
      offsetMinutes: -10,
    });
    const data = reminderCreate.mock.calls[0]![0].data;
    expect(data.scheduleAnchor).toBe("jewish_candles");
    expect(data.scheduleOffsetMinutes).toBe(-10);
    expect(data.composePlace).toBe("פתח תקווה");
    expect(data.fireAt).toEqual(fireAt);
    expect(data.composeAtFire).toBe(false);
    expect(data.repeat).toBe("once");
    expect(data.recurrence).toBeUndefined();
  });

  it("stores weekly recurrence when the model sent כל שישי", async () => {
    const fireAt = new Date("2026-10-23T14:29:00.000Z");
    nextCandleLighting.mockResolvedValue(fireAt);

    await applyReminders({
      userId: "u1",
      actor: amit,
      employees: [amit],
      reminders: [
        {
          ...candleReminder,
          recurrence: { freq: "weekly", interval: 1, weekdays: [5] },
        },
      ],
    });

    const data = reminderCreate.mock.calls[0]![0].data;
    expect(data.recurrence).toEqual({
      freq: "weekly",
      interval: 1,
      weekdays: [5],
    });
    expect(data.fireAt).toEqual(fireAt);
  });

  it("skips when city is missing", async () => {
    const result = await applyReminders({
      userId: "u1",
      actor: amit,
      employees: [amit],
      reminders: [{ ...candleReminder, composePlace: "" }],
    });
    expect(result.saved).toEqual([]);
    expect(result.skipped).toEqual([
      { item: "להדליק נרות", reason: "no_place" },
    ]);
    expect(nextCandleLighting).not.toHaveBeenCalled();
  });
});
