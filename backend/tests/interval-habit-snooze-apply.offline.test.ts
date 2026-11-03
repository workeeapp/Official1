/**
 * Offline integration: Option-B snooze vs interval series clock.
 * Proves applyReminders create/update of a one-shot does not mutate the series row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmReminderAction, PublicEmployee } from "@workee/shared";

const { reminderFindMany, reminderFindFirst, reminderUpdate, reminderCreate } =
  vi.hoisted(() => ({
    reminderFindMany: vi.fn(),
    reminderFindFirst: vi.fn(),
    reminderUpdate: vi.fn(),
    reminderCreate: vi.fn(),
  }));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: {
      findMany: reminderFindMany,
      findFirst: reminderFindFirst,
      update: reminderUpdate,
      create: reminderCreate,
    },
    employeeListItem: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    employeeListItemReminderLink: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
    },
  },
}));
vi.mock("../src/services/audit.service.js", () => ({
  recordAuditEvent: vi.fn(),
}));
vi.mock("../src/services/reminder-fire.js", () => ({
  scheduleSoon: vi.fn(),
}));

import { applyReminders } from "../src/services/reminder.service.js";

const tal: PublicEmployee = {
  id: "tal-1",
  name: "טל",
  surname: "",
  nickname: "טל",
  email: null,
  phone: "972501111111",
  kind: "human",
  protected: false,
} as PublicEmployee;

const seriesFireAt = new Date("2030-06-01T08:00:00.000Z");
const seriesRecurrence = {
  freq: "interval" as const,
  interval: 1,
  unit: "hours" as const,
};

const seriesRow = {
  id: "series-water",
  userId: "u1",
  ownerId: tal.id,
  actorId: tal.id,
  itemKey: "לשתות מים",
  itemLabel: "לשתות מים",
  listType: "tasks",
  fireAt: seriesFireAt,
  repeat: "1:hours",
  recurrence: seriesRecurrence,
  occurrencesFired: 3,
  pingIds: [tal.id],
  aboutIds: [] as string[],
  messageText: "לשתות מים",
  composeAtFire: false,
  composeSource: "",
  composeLookbackHours: 0,
  composePlace: "",
  status: "active",
  workerItemId: null,
};

const snoozeRow = {
  id: "snooze-water",
  userId: "u1",
  ownerId: tal.id,
  actorId: "lucy-1",
  itemKey: "לשתות מים",
  itemLabel: "לשתות מים",
  listType: "tasks",
  fireAt: new Date("2030-06-01T07:10:00.000Z"),
  repeat: "once",
  recurrence: null,
  occurrencesFired: 0,
  pingIds: [tal.id],
  aboutIds: [] as string[],
  messageText: "לשתות מים",
  composeAtFire: false,
  composeSource: "",
  composeLookbackHours: 0,
  composePlace: "",
  status: "active",
  workerItemId: "worker-nudge-1",
};

function baseAction(
  overrides: Partial<LlmReminderAction>,
): LlmReminderAction {
  return {
    action: "add",
    item: "לשתות מים",
    listType: "tasks",
    date: "",
    time: "",
    repeat: "once",
    ping: ["טל"],
    about: [],
    targets: [],
    text: "לשתות מים",
    inSeconds: 600,
    everyCount: null,
    everyUnit: null,
    weekdays: null,
    confirmed: false,
    compose: false,
    composeSource: "",
    composeLookbackHours: 0,
    composePlace: "",
    reminderId: "",
    ...overrides,
  };
}

describe("Option B snooze apply vs interval series (offline)", () => {
  beforeEach(() => {
    reminderFindMany.mockReset();
    reminderFindFirst.mockReset();
    reminderUpdate.mockReset();
    reminderCreate.mockReset();
    reminderFindMany.mockResolvedValue([seriesRow]);
    reminderCreate.mockImplementation(async ({ data }) => ({
      ...seriesRow,
      ...data,
      id: "snooze-new",
      recurrence: data.recurrence ?? null,
      repeat: data.repeat ?? "once",
      workerItemId: null,
    }));
    reminderUpdate.mockImplementation(async ({ where, data }) => ({
      ...seriesRow,
      ...snoozeRow,
      id: where.id,
      ...data,
    }));
  });

  it("snooze add creates one-shot and never updates the series clock", async () => {
    const result = await applyReminders({
      userId: "u1",
      actor: tal,
      employees: [tal],
      reminders: [baseAction({ action: "add", inSeconds: 600 })],
    });

    expect(result.skipped).toEqual([]);
    expect(result.saved.length).toBeGreaterThanOrEqual(1);
    expect(reminderCreate).toHaveBeenCalled();
    const created = reminderCreate.mock.calls[0][0].data;
    expect(created.itemLabel).toMatch(/מים/);
    expect(created.repeat).toBe("once");
    expect(created.recurrence == null || created.recurrence === undefined).toBe(
      true,
    );
    expect(created.fireAt).not.toEqual(seriesFireAt);
    // Series row must not be rewritten by the snooze add.
    const seriesUpdates = reminderUpdate.mock.calls.filter(
      (call) => call[0].where?.id === "series-water",
    );
    expect(seriesUpdates).toEqual([]);
    expect(seriesRow.fireAt).toEqual(seriesFireAt);
    expect(seriesRow.recurrence).toEqual(seriesRecurrence);
    expect(seriesRow.id).toBe("series-water");
  });

  it("reschedule existing snooze updates only the snooze id", async () => {
    reminderFindMany.mockResolvedValue([seriesRow, snoozeRow]);
    const result = await applyReminders({
      userId: "u1",
      actor: tal,
      employees: [tal],
      reminders: [
        baseAction({
          action: "update",
          reminderId: "snooze-water",
          inSeconds: 600,
          repeat: "once",
        }),
      ],
    });

    expect(result.skipped).toEqual([]);
    expect(reminderUpdate).toHaveBeenCalled();
    for (const call of reminderUpdate.mock.calls) {
      expect(call[0].where.id).toBe("snooze-water");
      expect(call[0].where.id).not.toBe("series-water");
    }
    expect(reminderCreate).not.toHaveBeenCalled();
  });

  it("הפסיקי: reminders.remove cancels the series clock", async () => {
    reminderFindFirst.mockResolvedValue({ ...seriesRow });
    reminderFindMany.mockResolvedValue([seriesRow]);
    const result = await applyReminders({
      userId: "u1",
      actor: tal,
      employees: [tal],
      reminders: [
        baseAction({
          action: "remove",
          reminderId: "series-water",
          inSeconds: null,
        }),
      ],
    });

    expect(result.removed).toContain("לשתות מים");
    expect(reminderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "series-water" },
        data: expect.objectContaining({ status: "cancelled" }),
      }),
    );
  });
});
