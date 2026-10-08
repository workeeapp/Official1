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
  linkRemindersToItems,
  linkRemindersToWorkerTasks,
  pairLinkedItemsToReminders,
  removeReminderAndLinkedWorkerTask,
  syncLinkedWorkerTaskClock,
} from "../src/services/reminder.service.js";

describe("reminder worker link", () => {
  beforeEach(() => {
    itemUpdate.mockReset();
    itemFindUnique.mockReset();
    itemFindMany.mockReset();
    itemUpdateMany.mockReset();
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

  it("links same-turn speaker and shared items to their clock by the action labels", () => {
    const clocks = [
      { id: "r-nonsense", itemKey: "לבדוק שטויות", itemLabel: "לבדוק שטויות" },
      { id: "r-apples", itemKey: "ערן צריך לקנות תפוחים", itemLabel: "ערן צריך לקנות תפוחים" },
    ];
    expect(
      pairLinkedItemsToReminders(clocks, [
        { id: "eran-task", itemKey: "לבדוק שטויות", itemLabel: "לבדוק שטויות" },
        { id: "shared-apples", itemKey: "תפוחים", itemLabel: "תפוחים" },
        { id: "unrelated", itemKey: "גבינה", itemLabel: "גבינה" },
      ]),
    ).toEqual([
      { reminderId: "r-nonsense", itemId: "eran-task" },
      { reminderId: "r-apples", itemId: "shared-apples" },
    ]);
  });

  it("never pairs a lone item with a lone clock when the labels differ", () => {
    expect(
      pairLinkedItemsToReminders(
        [{ id: "r1", itemKey: "לאכול פיצה", itemLabel: "לאכול פיצה" }],
        [{ id: "i1", itemKey: "גבינה", itemLabel: "גבינה" }],
      ),
    ).toEqual([]);
  });

  it("writes only linked_reminder_id for a speaker item (no cascade link)", async () => {
    itemUpdate.mockResolvedValue({});
    await linkRemindersToItems(
      [{ id: "r1", itemKey: "לבדוק שטויות", itemLabel: "לבדוק שטויות" }],
      [{ id: "i1", itemKey: "לבדוק שטויות", itemLabel: "לבדוק שטויות" }],
    );
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "i1" },
      data: { linkedReminderId: "r1" },
    });
    expect(reminderUpdate).not.toHaveBeenCalled();
  });

  it("soft-deletes the worker task and cancels the clock together", async () => {
    itemFindMany.mockResolvedValue([
      {
        id: "w1",
        itemKey: "להזכיר לעמית לאכול פיצה",
        data: { "שם מטלה": "להזכיר לעמית לאכול פיצה" },
        list: { employeeId: "lucy", listType: "tasks" },
      },
    ]);
    itemUpdateMany.mockResolvedValue({ count: 1 });
    reminderUpdate.mockResolvedValue({});
    await removeReminderAndLinkedWorkerTask({
      id: "r1",
      workerItemId: "w1",
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
        itemKey: "להזכיר לעמית לאכול פיצה",
        data: { "שם מטלה": "להזכיר לעמית לאכול פיצה" },
        list: { employeeId: "lucy", listType: "tasks" },
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
