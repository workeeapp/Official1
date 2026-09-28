import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  itemUpdate,
  itemFindUnique,
  itemDeleteMany,
  reminderUpdate,
  reminderFindFirst,
  reminderDelete,
} = vi.hoisted(() => ({
  itemUpdate: vi.fn(),
  itemFindUnique: vi.fn(),
  itemDeleteMany: vi.fn(),
  reminderUpdate: vi.fn(),
  reminderFindFirst: vi.fn(),
  reminderDelete: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    employeeListItem: {
      update: itemUpdate,
      findUnique: itemFindUnique,
      deleteMany: itemDeleteMany,
    },
    reminder: {
      update: reminderUpdate,
      findFirst: reminderFindFirst,
      delete: reminderDelete,
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
    itemDeleteMany.mockReset();
    reminderUpdate.mockReset();
    reminderFindFirst.mockReset();
    reminderDelete.mockReset();
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

  it("deletes the worker task and the clock together", async () => {
    itemDeleteMany.mockResolvedValue({ count: 1 });
    reminderDelete.mockResolvedValue({});
    await removeReminderAndLinkedWorkerTask({
      id: "r1",
      workerItemId: "w1",
    });
    expect(itemDeleteMany).toHaveBeenCalledWith({
      where: { OR: [{ reminderId: "r1" }, { id: "w1" }] },
    });
    expect(reminderDelete).toHaveBeenCalledWith({ where: { id: "r1" } });
  });

  it("deletes the clock when the worker task is removed", async () => {
    itemFindUnique.mockResolvedValue({ id: "w1", reminderId: "r1" });
    reminderFindFirst.mockResolvedValue({ id: "r1", workerItemId: "w1" });
    itemDeleteMany.mockResolvedValue({ count: 1 });
    reminderDelete.mockResolvedValue({});
    await cancelReminderLinkedToWorkerItem("w1");
    expect(itemDeleteMany).toHaveBeenCalled();
    expect(reminderDelete).toHaveBeenCalledWith({ where: { id: "r1" } });
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
