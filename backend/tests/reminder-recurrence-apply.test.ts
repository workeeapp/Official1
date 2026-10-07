import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmReminderAction, PublicEmployee } from "@workee/shared";

const { reminderFindMany, reminderUpdate, reminderCreate } = vi.hoisted(() => ({
  reminderFindMany: vi.fn(),
  reminderUpdate: vi.fn(),
  reminderCreate: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: { findMany: reminderFindMany, update: reminderUpdate, create: reminderCreate },
  },
}));
vi.mock("../src/services/audit.service.js", () => ({ recordAuditEvent: vi.fn() }));
vi.mock("../src/services/reminder-fire.js", () => ({ scheduleSoon: vi.fn() }));

import { Prisma } from "@prisma/client";
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

const base: LlmReminderAction = {
  action: "update",
  item: "לשלם ארנונה",
  listType: "tasks",
  date: "",
  time: "",
  repeat: "once",
  ping: [],
  targets: [],
  text: "",
  inSeconds: null,
  everyCount: null,
  everyUnit: null,
  weekdays: null,
  confirmed: false,
  compose: false,
  composeSource: "",
  composeLookbackHours: 0,
  reminderId: "rem-1",
};

const existing = {
  id: "rem-1",
  userId: "u1",
  ownerId: amit.id,
  itemKey: "לשלם ארנונה",
  itemLabel: "לשלם ארנונה",
  listType: "tasks",
  fireAt: new Date("2030-11-01T07:00:00Z"),
  repeat: "1:months",
  recurrence: { freq: "monthly", interval: 1, month_day: 1, time: "09:00" },
  occurrencesFired: 2,
  pingIds: [amit.id],
  messageText: "",
  composeAtFire: false,
  composeSource: "",
  composeLookbackHours: 0,
  status: "active",
  workerItemId: null,
};

async function run(reminder: LlmReminderAction) {
  return applyReminders({
    userId: "u1",
    actor: amit,
    employees: [amit],
    reminders: [reminder],
  });
}

describe("applyReminders recurrence updates", () => {
  beforeEach(() => {
    reminderFindMany.mockReset().mockResolvedValue([existing]);
    reminderUpdate.mockReset().mockImplementation(async ({ data }) => ({ ...existing, ...data }));
    reminderCreate.mockReset();
  });

  it("replaces the rule when the speaker changes the repeat", async () => {
    await run({
      ...base,
      recurrence: { freq: "weekly", interval: 1, weekdays: [1], time: "09:00" },
    });
    const data = reminderUpdate.mock.calls[0][0].data;
    expect(data.recurrence).toEqual({ freq: "weekly", interval: 1, weekdays: [1], time: "09:00" });
    expect(data.repeat).toBe("weekdays:1");
    expect(data.occurrencesFired).toBe(0);
  });

  it("keeps the rule on a text-only update", async () => {
    await run({ ...base, text: "לשלם ארנונה באתר העירייה" });
    const data = reminderUpdate.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("recurrence");
    expect(data.repeat).toBe("1:months");
    expect(data.fireAt).toEqual(existing.fireAt);
  });

  it("freq none stops repeating and keeps the next fire", async () => {
    await run({ ...base, recurrence: null });
    const data = reminderUpdate.mock.calls[0][0].data;
    expect(data.recurrence).toBe(Prisma.DbNull);
    expect(data.repeat).toBe("once");
    expect(data.fireAt).toEqual(existing.fireAt);
  });
});
