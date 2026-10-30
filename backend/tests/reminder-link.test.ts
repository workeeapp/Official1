import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  itemUpdate,
  itemFindUnique,
  itemFindMany,
  itemUpdateMany,
  reminderUpdate,
  reminderFindFirst,
  employeeFindMany,
  linkCreate,
  linkFindUnique,
} = vi.hoisted(() => ({
  itemUpdate: vi.fn(),
  itemFindUnique: vi.fn(),
  itemFindMany: vi.fn(),
  itemUpdateMany: vi.fn(),
  reminderUpdate: vi.fn(),
  reminderFindFirst: vi.fn(),
  employeeFindMany: vi.fn(),
  linkCreate: vi.fn(),
  linkFindUnique: vi.fn(),
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
    employeeListItemReminderLink: {
      create: linkCreate,
      findUnique: linkFindUnique,
    },
    reminder: {
      update: reminderUpdate,
      findFirst: reminderFindFirst,
    },
  },
}));

import {
  cancelReminderLinkedToWorkerItem,
  itemsFromListMutationsForSoftLink,
  linkRemindersToItems,
  linkRemindersToWorkerTasks,
  listLiveHumanItemsForReminderLink,
  pairLinkedItemsToReminders,
  removeReminderAndLinkedWorkerTask,
  shareWorkerTaskWithPingRecipients,
  syncLinkedWorkerTaskClock,
  unionSoftLinkItemCandidates,
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
    linkCreate.mockReset();
    linkFindUnique.mockReset();
    linkFindUnique.mockResolvedValue(null);
    linkCreate.mockResolvedValue({});
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

  it("links same-turn items to clocks by exact itemKey only", () => {
    const clocks = [
      { id: "r-nonsense", itemKey: "לבדוק שטויות", itemLabel: "לבדוק שטויות" },
      { id: "r-apples", itemKey: "תפוחים", itemLabel: "תפוחים" },
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
    // Fuzzy substring (תפוחים inside a longer clock key) must not pair.
    expect(
      pairLinkedItemsToReminders(
        [{ id: "r-long", itemKey: "ערן צריך לקנות תפוחים", itemLabel: "ערן צריך לקנות תפוחים" }],
        [{ id: "shared-apples", itemKey: "תפוחים", itemLabel: "תפוחים" }],
      ),
    ).toEqual([]);
  });

  it("never pairs a lone item with a lone clock when the labels differ", () => {
    expect(
      pairLinkedItemsToReminders(
        [{ id: "r1", itemKey: "לאכול פיצה", itemLabel: "לאכול פיצה" }],
        [{ id: "i1", itemKey: "גבינה", itemLabel: "גבינה" }],
      ),
    ).toEqual([]);
  });

  it("writes join row for a speaker item (no cascade / no legacy FK write)", async () => {
    await linkRemindersToItems(
      [{ id: "r1", itemKey: "לבדוק שטויות", itemLabel: "לבדוק שטויות" }],
      [{ id: "i1", itemKey: "לבדוק שטויות", itemLabel: "לבדוק שטויות" }],
    );
    expect(linkCreate).toHaveBeenCalledWith({
      data: { listItemId: "i1", reminderId: "r1" },
    });
    expect(itemUpdate).not.toHaveBeenCalled();
    expect(reminderUpdate).not.toHaveBeenCalled();
  });

  it("soft-links a new clock to an existing live human row by exact key (REUSE, no list mutate)", async () => {
    itemFindMany.mockResolvedValue([
      {
        id: "existing-maya",
        itemKey: "לאסוף את מאיה",
        data: {
          "שם מטלה": "לאסוף את מאיה",
          "תאריך לביצוע": "2026-10-23",
          "שעה לביצוע": "15:00",
        },
      },
    ]);
    const live = await listLiveHumanItemsForReminderLink({
      userId: "user-1",
      humanIds: [TAL],
    });
    expect(itemsFromListMutationsForSoftLink([], [TAL])).toEqual([]);
    await linkRemindersToItems(
      [
        {
          id: "r-ping",
          itemKey: "לאסוף את מאיה",
          itemLabel: "לאסוף את מאיה",
        },
      ],
      live,
    );
    expect(linkCreate).toHaveBeenCalledWith({
      data: { listItemId: "existing-maya", reminderId: "r-ping" },
    });
  });

  it("unions same-turn mutate with live rows so REUSE still links when another list mutates", async () => {
    itemFindMany.mockResolvedValue([
      {
        id: "existing-maya",
        itemKey: "לאסוף את מאיה",
        data: { "שם מטלה": "לאסוף את מאיה" },
      },
    ]);
    const sameTurn = itemsFromListMutationsForSoftLink(
      [
        {
          action: "add",
          itemId: "unrelated-milk",
          itemKey: "חלב",
          itemLabel: "חלב",
          employeeId: TAL,
        },
      ],
      [TAL],
    );
    const live = await listLiveHumanItemsForReminderLink({
      userId: "user-1",
      humanIds: [TAL],
    });
    const candidates = unionSoftLinkItemCandidates(sameTurn, live);
    expect(candidates.map((row) => row.id).sort()).toEqual([
      "existing-maya",
      "unrelated-milk",
    ]);
    await linkRemindersToItems(
      [
        {
          id: "r-ping",
          itemKey: "לאסוף את מאיה",
          itemLabel: "לאסוף את מאיה",
        },
      ],
      candidates,
    );
    expect(linkCreate).toHaveBeenCalledWith({
      data: { listItemId: "existing-maya", reminderId: "r-ping" },
    });
  });

  it("unionSoftLinkItemCandidates prefers same-turn row when ids collide", () => {
    expect(
      unionSoftLinkItemCandidates(
        [{ id: "i1", itemKey: "new-key", itemLabel: "new" }],
        [{ id: "i1", itemKey: "old-key", itemLabel: "old" }],
      ),
    ).toEqual([{ id: "i1", itemKey: "new-key", itemLabel: "new" }]);
  });

  it("includes same-turn lists.update rows for soft-link (not only add)", () => {
    const rows = itemsFromListMutationsForSoftLink(
      [
        {
          action: "update",
          itemId: "morning",
          itemKey: "להוריד את סקאזי לטיול",
          itemLabel: "להוריד את סקאזי לטיול",
          employeeId: TAL,
        },
        {
          action: "add",
          itemId: "evening",
          itemKey: "להוריד את סקאזי לטיול ערב",
          itemLabel: "להוריד את סקאזי לטיול ערב",
          employeeId: TAL,
        },
        {
          action: "remove",
          itemId: "gone",
          itemKey: "חוג",
          itemLabel: "חוג",
          employeeId: TAL,
        },
        {
          action: "add",
          listShell: true,
          itemId: "shell",
          itemKey: "",
          itemLabel: "",
          employeeId: TAL,
        },
        {
          action: "add",
          itemId: "worker",
          itemKey: "להזכיר",
          itemLabel: "להזכיר",
          employeeId: LUCY,
        },
      ],
      [TAL],
    );
    expect(rows).toEqual([
      {
        id: "morning",
        itemKey: "להוריד את סקאזי לטיול",
        itemLabel: "להוריד את סקאזי לטיול",
      },
      {
        id: "evening",
        itemKey: "להוריד את סקאזי לטיול ערב",
        itemLabel: "להוריד את סקאזי לטיול ערב",
      },
    ]);
  });

  it("soft-links a same-turn update row to a matching new clock", async () => {
    const items = itemsFromListMutationsForSoftLink(
      [
        {
          action: "update",
          itemId: "skazi-am",
          itemKey: "להוריד את סקאזי לטיול",
          itemLabel: "להוריד את סקאזי לטיול",
          employeeId: TAL,
        },
      ],
      [TAL],
    );
    await linkRemindersToItems(
      [
        {
          id: "r-0830",
          itemKey: "להוריד את סקאזי לטיול",
          itemLabel: "להוריד את סקאזי לטיול",
        },
      ],
      items,
    );
    expect(linkCreate).toHaveBeenCalledWith({
      data: { listItemId: "skazi-am", reminderId: "r-0830" },
    });
  });

  it("soft-link skips when reminder already linked to another item (no steal)", async () => {
    linkFindUnique.mockResolvedValue({ listItemId: "other-item" });
    await linkRemindersToItems(
      [{ id: "r1", itemKey: "חלב", itemLabel: "חלב" }],
      [{ id: "i1", itemKey: "חלב", itemLabel: "חלב" }],
    );
    expect(linkCreate).not.toHaveBeenCalled();
  });

  it("soft-link appends a second clock on an item that already has one", async () => {
    linkFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    await linkRemindersToItems(
      [
        { id: "r-am", itemKey: "וטרינר", itemLabel: "וטרינר" },
        { id: "r-pm", itemKey: "וטרינר", itemLabel: "וטרינר" },
      ],
      [{ id: "task-1", itemKey: "וטרינר", itemLabel: "וטרינר" }],
    );
    // Exact key pairs one clock per pass; first clock wins the itemKey slot.
    expect(linkCreate).toHaveBeenCalledTimes(1);
    expect(linkCreate).toHaveBeenCalledWith({
      data: { listItemId: "task-1", reminderId: "r-am" },
    });
  });

  it("pairs morning update + evening add to two clocks by distinct keys", () => {
    const items = itemsFromListMutationsForSoftLink(
      [
        {
          action: "update",
          itemId: "am",
          itemKey: "להוריד את סקאזי לטיול",
          itemLabel: "להוריד את סקאזי לטיול",
          employeeId: TAL,
        },
        {
          action: "add",
          itemId: "pm",
          itemKey: "להוריד את סקאזי לטיול ערב",
          itemLabel: "להוריד את סקאזי לטיול ערב",
          employeeId: TAL,
        },
      ],
      [TAL],
    );
    expect(
      pairLinkedItemsToReminders(
        [
          {
            id: "r-am",
            itemKey: "להוריד את סקאזי לטיול",
            itemLabel: "להוריד את סקאזי לטיול",
          },
          {
            id: "r-pm",
            itemKey: "להוריד את סקאזי לטיול ערב",
            itemLabel: "להוריד את סקאזי לטיול ערב",
          },
        ],
        items,
      ),
    ).toEqual([
      { reminderId: "r-am", itemId: "am" },
      { reminderId: "r-pm", itemId: "pm" },
    ]);
  });

  it("loads live human shopping/tasks for re-linking existing rows", async () => {
    itemFindMany.mockResolvedValue([
      {
        id: "existing-1",
        itemKey: "לקנות חלב",
        data: { "שם פריט": "לקנות חלב" },
      },
      {
        id: "existing-2",
        itemKey: "לבדוק באג",
        data: { "שם מטלה": "לבדוק באג" },
      },
    ]);
    const rows = await listLiveHumanItemsForReminderLink({
      userId: "user-1",
      humanIds: [TAL],
    });
    expect(rows).toEqual([
      { id: "existing-1", itemKey: "לקנות חלב", itemLabel: "לקנות חלב" },
      { id: "existing-2", itemKey: "לבדוק באג", itemLabel: "לבדוק באג" },
    ]);
    expect(itemFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          list: expect.objectContaining({
            listType: { in: ["shopping", "tasks"] },
            employeeId: { in: [TAL] },
          }),
        }),
      }),
    );
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
    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: { linkedReminderId: "r1", deletedAt: null },
      data: { linkedReminderId: null },
    });
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { status: "cancelled", workerItemId: null },
    });
  });

  it("cancels the clock when the worker task is removed", async () => {
    itemFindUnique.mockResolvedValue({ id: "w1", reminderId: "r1" });
    reminderFindFirst.mockResolvedValue({
      id: "r1",
      workerItemId: "w1",
      itemLabel: "להזכיר לעמית לאכול פיצה",
      status: "active",
    });
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
    const linked = await cancelReminderLinkedToWorkerItem("w1");
    expect(linked).toEqual({
      reminderId: "r1",
      label: "להזכיר לעמית לאכול פיצה",
    });
    expect(itemUpdateMany).toHaveBeenCalled();
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { status: "cancelled", workerItemId: null },
    });
  });

  it("clears speaker linkedReminderId when the clock is cancelled", async () => {
    itemFindMany.mockResolvedValue([]);
    itemUpdateMany.mockResolvedValue({ count: 1 });
    reminderUpdate.mockResolvedValue({});
    await removeReminderAndLinkedWorkerTask({
      id: "r1",
      workerItemId: "w1",
      label: "לקנות חלב",
    });
    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: { linkedReminderId: "r1", deletedAt: null },
      data: { linkedReminderId: null },
    });
  });

  it("cancels via item.linkedReminderId when reminderId is empty", async () => {
    itemFindUnique.mockResolvedValue({
      id: "speaker-1",
      reminderId: null,
      linkedReminderId: "r-soft",
    });
    reminderFindFirst
      .mockResolvedValueOnce({
        id: "r-soft",
        workerItemId: null,
        itemLabel: "לקנות חלב",
        status: "active",
      })
      .mockResolvedValueOnce(null);
    itemFindMany.mockResolvedValue([]);
    itemUpdateMany.mockResolvedValue({ count: 0 });
    reminderUpdate.mockResolvedValue({});
    const linked = await cancelReminderLinkedToWorkerItem("speaker-1");
    expect(linked).toEqual({ reminderId: "r-soft", label: "לקנות חלב" });
    expect(reminderFindFirst).toHaveBeenCalledWith({
      where: {
        status: "active",
        OR: [{ workerItemId: "speaker-1" }, { id: { in: ["r-soft"] } }],
      },
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

  it("keeps appointment chore T1 when the ping clock moves to T2", async () => {
    itemFindUnique.mockResolvedValue({
      id: "w1",
      itemKey: "להזכיר לטל לאסוף את מאיה",
      data: {
        "שם מטלה": "להזכיר לטל לאסוף את מאיה",
        "תאריך לביצוע": "2026-10-21",
        "שעה לביצוע": "15:00",
      },
    });
    itemUpdate.mockResolvedValue({});
    // 14:20 Asia/Jerusalem
    await syncLinkedWorkerTaskClock({
      reminderId: "r1",
      workerItemId: "w1",
      fireAt: new Date("2026-10-21T11:20:00.000Z"),
    });
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "w1" },
      data: expect.objectContaining({
        data: expect.objectContaining({
          "שם מטלה": "להזכיר לטל לאסוף את מאיה",
          "תאריך לביצוע": "2026-10-21",
          "שעה לביצוע": "15:00",
        }),
      }),
    });
    const written = itemUpdate.mock.calls[0][0].data.data as Record<
      string,
      unknown
    >;
    expect(written["שעה לביצוע"]).toBe("15:00");
    expect(written["שעה לביצוע"]).not.toBe("14:20");
  });

  it("mirrors an every-2-hours clock onto the worker task, anchored at its fire", async () => {
    itemFindUnique.mockResolvedValue({
      id: "w1",
      itemKey: "להזכיר לעמית לשתות שוקו",
      data: { "שם מטלה": "להזכיר לעמית לשתות שוקו" },
    });
    itemUpdate.mockResolvedValue({});
    await syncLinkedWorkerTaskClock({
      reminderId: "r1",
      workerItemId: "w1",
      fireAt: new Date("2026-10-07T11:00:00.000Z"),
      rule: { freq: "interval", interval: 2, unit: "hours" },
    });
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "w1" },
      data: expect.objectContaining({
        data: expect.objectContaining({
          __recurrence: {
            freq: "interval",
            interval: 2,
            unit: "hours",
            time: "14:00",
            start: "2026-10-07",
          },
          חוזר: "כל שעתיים",
        }),
      }),
    });
  });
});
