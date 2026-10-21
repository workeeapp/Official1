import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmReminderAction, PublicEmployee } from "@workee/shared";

const {
  reminderFindFirst,
  reminderUpdate,
  itemFindMany,
  itemFindUnique,
  itemUpdateMany,
} = vi.hoisted(() => ({
  reminderFindFirst: vi.fn(),
  reminderUpdate: vi.fn(),
  itemFindMany: vi.fn(),
  itemFindUnique: vi.fn(),
  itemUpdateMany: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: { findFirst: reminderFindFirst, update: reminderUpdate },
    employeeListItem: {
      findMany: itemFindMany,
      findUnique: itemFindUnique,
      updateMany: itemUpdateMany,
    },
  },
}));
vi.mock("../src/services/audit.service.js", () => ({ recordAuditEvent: vi.fn() }));

import {
  applyReminders,
  formatReminderApplyNotice,
  formatReminderDeleteFallback,
} from "../src/services/reminder.service.js";

const tal: PublicEmployee = {
  id: "tal-1",
  name: "טל",
  surname: "",
  nickname: "טל",
  email: null,
  phone: "972501111111",
  kind: "human",
  protected: false,
};

const removeAction: LlmReminderAction = {
  action: "remove",
  item: "חתונה של תום",
  listType: "tasks",
  date: "",
  time: "",
  repeat: "once",
  ping: [],
  about: [],
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
  composePlace: "",
  reminderId: "rem-cascaded",
};

describe("same-turn cascade + reminders.remove", () => {
  beforeEach(() => {
    reminderFindFirst.mockReset();
    reminderUpdate.mockReset();
    itemFindMany.mockReset().mockResolvedValue([]);
    itemFindUnique.mockReset().mockResolvedValue(null);
    itemUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it("treats remove of an already-cascaded id as success, not miss", async () => {
    reminderFindFirst.mockResolvedValue(null);

    const result = await applyReminders({
      userId: "u1",
      actor: tal,
      employees: [tal],
      reminders: [removeAction],
      alreadyCancelledReminderIds: ["rem-cascaded"],
    });

    expect(result.removed).toEqual(["חתונה של תום"]);
    expect(result.missed).toEqual([]);
    expect(result.removedWorkerTasks).toEqual([]);
    expect(formatReminderApplyNotice(result)).toBe("");
    expect(reminderUpdate).not.toHaveBeenCalled();
  });

  it("still reports miss when the id was not cascaded this turn", async () => {
    reminderFindFirst.mockResolvedValue(null);

    const result = await applyReminders({
      userId: "u1",
      actor: tal,
      employees: [tal],
      reminders: [removeAction],
      alreadyCancelledReminderIds: [],
    });

    expect(result.removed).toEqual([]);
    expect(result.missed).toEqual(["חתונה של תום"]);
    expect(result.removedWorkerTasks).toEqual([]);
    expect(formatReminderApplyNotice(result)).toContain(
      "לא נמצאה תזכורת פעילה בשם: חתונה של תום",
    );
  });

  it("returns the linked worker task soft-deleted with the clock", async () => {
    const fireAt = new Date("2026-10-21T17:00:00.000Z");
    reminderFindFirst.mockResolvedValue({
      id: "rem-cascaded",
      userId: "u1",
      ownerId: tal.id,
      status: "active",
      itemLabel: "לקנות חלב",
      fireAt,
      pingIds: [tal.id],
      workerItemId: "worker-task-1",
    });
    itemFindUnique.mockResolvedValue({
      id: "worker-task-1",
      addedById: tal.id,
      visibleTo: [tal.id],
    });
    itemFindMany.mockResolvedValue([
      {
        id: "worker-task-1",
        itemKey: "להזכיר לטל לקנות חלב",
        data: { "שם מטלה": "להזכיר לטל לקנות חלב" },
        list: { employeeId: "lucy-1", listType: "tasks" },
      },
    ]);
    reminderUpdate.mockResolvedValue({});

    const result = await applyReminders({
      userId: "u1",
      actor: tal,
      employees: [tal],
      reminders: [{ ...removeAction, item: "לקנות חלב" }],
      alreadyCancelledReminderIds: [],
    });

    expect(result.removed).toEqual(["לקנות חלב"]);
    expect(result.missed).toEqual([]);
    expect(result.removedWorkerTasks).toEqual([
      {
        id: "worker-task-1",
        itemKey: "להזכיר לטל לקנות חלב",
        itemLabel: "להזכיר לטל לקנות חלב",
        employeeId: "lucy-1",
      },
    ]);
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "rem-cascaded" },
      data: { status: "cancelled", workerItemId: null },
    });
  });
});

describe("formatReminderDeleteFallback", () => {
  it("names a single cancelled clock", () => {
    expect(formatReminderDeleteFallback(["לקנות חלב"])).toBe(
      'מחקתי את התזכורת «לקנות חלב».',
    );
  });

  it("counts several cancelled clocks", () => {
    expect(formatReminderDeleteFallback(["חלב", "מים"])).toBe(
      "מחקתי 2 תזכורות.",
    );
  });
});
