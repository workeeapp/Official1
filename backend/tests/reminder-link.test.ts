import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  itemUpdate,
  itemFindUnique,
  itemFindMany,
  itemUpdateMany,
  reminderUpdate,
  reminderFindFirst,
} = vi.hoisted(() => ({
  itemUpdate: vi.fn(),
  itemFindUnique: vi.fn(),
  itemFindMany: vi.fn(),
  itemUpdateMany: vi.fn(),
  reminderUpdate: vi.fn(),
  reminderFindFirst: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    employeeListItem: {
      update: itemUpdate,
      findUnique: itemFindUnique,
      findMany: itemFindMany,
      updateMany: itemUpdateMany,
    },
    reminder: {
      update: reminderUpdate,
      findFirst: reminderFindFirst,
    },
  },
}));

import {
  cancelReminderLinkedToWorkerItem,
  linkRemindersToWorkerTasks,
  removeReminderAndLinkedWorkerTask,
  syncLinkedWorkerTaskClock,
} from "../src/services/reminder.service.js";

describe("reminder worker link", () => {
  beforeEach(() => {
    itemUpdate.mockReset();
    itemFindUnique.mockReset();
    itemFindMany.mockReset().mockResolvedValue([]);
    itemUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    reminderUpdate.mockReset();
    reminderFindFirst.mockReset();
  });

  it("writes both foreign keys when pairing a clock to a worker task", async () => {
    itemUpdate.mockResolvedValue({});
    reminderUpdate.mockResolvedValue({});
    await linkRemindersToWorkerTasks(
      [{ id: "r1", itemKey: "לאכול פיצה", itemLabel: "לאכול פיצה" }],
      [{ id: "w1", itemKey: "להזכיר לעמית לאכול פיצה" }],
    );
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "w1" },
      data: { reminderId: "r1" },
    });
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { workerItemId: "w1" },
    });
  });

  it("soft-deletes the worker task and cancels the clock together", async () => {
    itemFindMany.mockResolvedValue([
      {
        id: "w1",
        itemKey: "להזכיר לעמית לאכול פיצה",
        data: { "שם מטלה": "להזכיר לעמית לאכול פיצה" },
        list: { employeeId: "emp-1", listType: "tasks" },
      },
    ]);
    itemUpdateMany.mockResolvedValue({ count: 1 });
    reminderUpdate.mockResolvedValue({});

    await removeReminderAndLinkedWorkerTask({
      id: "r1",
      workerItemId: "w1",
    });

    expect(itemFindMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        OR: [{ reminderId: "r1" }, { id: "w1" }],
      },
      include: { list: { select: { employeeId: true, listType: true } } },
    });
    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["w1"] } },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { status: "cancelled", workerItemId: null },
    });
  });

  it("cancels the clock when the worker task is removed", async () => {
    itemFindUnique.mockResolvedValue({ id: "w1", reminderId: "r1" });
    reminderFindFirst.mockResolvedValue({ id: "r1", workerItemId: "w1" });
    itemFindMany.mockResolvedValue([
      {
        id: "w1",
        itemKey: "task",
        data: {},
        list: { employeeId: "emp-1", listType: "tasks" },
      },
    ]);
    itemUpdateMany.mockResolvedValue({ count: 1 });
    reminderUpdate.mockResolvedValue({});

    await cancelReminderLinkedToWorkerItem("w1");

    expect(itemUpdateMany).toHaveBeenCalled();
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { status: "cancelled", workerItemId: null },
    });
  });

  it("rewrites the linked worker task clock when the reminder time changes", async () => {
    itemFindUnique.mockResolvedValue({
      id: "w1",
      itemKey: "להזכיר לך לרדת עם הכלב סקאזי לטיול מחר ב־09:00",
      data: {
        "שם מטלה": "להזכיר לך לרדת עם הכלב סקאזי לטיול מחר ב־09:00",
      },
    });
    itemUpdate.mockResolvedValue({});
    await syncLinkedWorkerTaskClock({
      reminderId: "r1",
      workerItemId: "w1",
      fireAt: new Date("2026-09-28T07:00:00.000Z"),
    });
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "w1" },
      data: expect.objectContaining({
        data: expect.objectContaining({
          "שם מטלה": "להזכיר לך לרדת עם הכלב סקאזי לטיול מחר ב־10:00",
          "שעה לביצוע": "10:00",
        }),
      }),
    });
  });
});
