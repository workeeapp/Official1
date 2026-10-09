import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  itemUpdate,
  itemFindUnique,
  itemFindMany,
  itemUpdateMany,
  reminderUpdate,
  reminderFindFirst,
  employeeFindMany,
} = vi.hoisted(() => ({
  itemUpdate: vi.fn(),
  itemFindUnique: vi.fn(),
  itemFindMany: vi.fn(),
  itemUpdateMany: vi.fn(),
  reminderUpdate: vi.fn(),
  reminderFindFirst: vi.fn(),
  employeeFindMany: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    employee: {
      findMany: employeeFindMany,
    },
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
  shareWorkerTaskWithPingRecipients,
  syncLinkedWorkerTaskClock,
} from "../src/services/reminder.service.js";

const AMIT = "11111111-1111-4111-8111-111111111111";
const TAL = "22222222-2222-4222-8222-222222222222";
const GUEST = "33333333-3333-4333-8333-333333333333";
const LUCY = "44444444-4444-4444-8444-444444444444";

describe("reminder worker link", () => {
  beforeEach(() => {
    itemUpdate.mockReset();
    itemFindUnique.mockReset();
    itemFindMany.mockReset();
    itemUpdateMany.mockReset();
    reminderUpdate.mockReset();
    reminderFindFirst.mockReset();
    employeeFindMany.mockReset();
  });

  it("involves the human the clock pings without sharing the worker task", async () => {
    itemUpdate.mockResolvedValue({});
    reminderUpdate.mockResolvedValue({ ownerId: AMIT, pingIds: [TAL] });
    employeeFindMany.mockResolvedValue([
      { id: TAL, name: "טל", nickname: null },
    ]);
    itemFindUnique.mockResolvedValue({
      id: "w1",
      scope: "personal",
      addedById: AMIT,
      visibleTo: [AMIT, LUCY],
      deletedAt: null,
    });
    await linkRemindersToWorkerTasks(
      [{ id: "r1", itemKey: "לקנות חלב", itemLabel: "לקנות חלב" }],
      [{ id: "w1", itemKey: "להזכיר לטל לקנות חלב" }],
    );
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "w1" },
      data: { visibleTo: [AMIT, LUCY, TAL] },
    });
  });

  it("keeps a self-nudge worker task personal", async () => {
    await shareWorkerTaskWithPingRecipients({
      workerItemId: "w1",
      ownerId: AMIT,
      pingIds: [AMIT],
    });
    expect(employeeFindMany).not.toHaveBeenCalled();
    expect(itemUpdate).not.toHaveBeenCalled();
  });

  it("skips phone destinations and guest recipients", async () => {
    employeeFindMany.mockResolvedValue([
      { id: GUEST, name: "אורח", nickname: null },
    ]);
    await shareWorkerTaskWithPingRecipients({
      workerItemId: "w1",
      ownerId: AMIT,
      pingIds: ["972501234567", GUEST],
    });
    expect(employeeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [GUEST] }, kind: "human" },
      }),
    );
    expect(itemUpdate).not.toHaveBeenCalled();
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
