import { beforeEach, describe, expect, it, vi } from "vitest";

const { itemUpdate, itemFindUnique, reminderUpdate, reminderFindMany, linkFindMany } =
  vi.hoisted(() => ({
    itemUpdate: vi.fn(),
    itemFindUnique: vi.fn(),
    reminderUpdate: vi.fn(),
    reminderFindMany: vi.fn(),
    linkFindMany: vi.fn(),
  }));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    employeeListItem: { update: itemUpdate, findUnique: itemFindUnique },
    employeeListItemReminderLink: { findMany: linkFindMany },
    reminder: { update: reminderUpdate, findMany: reminderFindMany },
  },
}));
vi.mock("../src/services/audit.service.js", () => ({
  recordAuditEvent: vi.fn(),
}));

import {
  shiftDateTokens,
  shiftLinkedClocksForTaskMove,
  taskMoveDelta,
} from "../src/services/reminder.service.js";

const TASK = "tal-vet-task";
const NOW = new Date("2026-11-04T08:00:00Z");

function clock(id: string, fireAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    fireAt: new Date(fireAt),
    itemLabel: "להזכיר לטל תור לווטרינר ביום 5.11",
    itemKey: "להזכיר לטל תור לווטרינר ביום 5.11",
    messageText: "מחר (5.11) יש לך תור לווטרינר",
    repeat: "once",
    recurrence: null,
    scheduleAnchor: "",
    status: "active",
    workerItemId: `worker-${id}`,
    ...extra,
  };
}

describe("taskMoveDelta", () => {
  it("measures a date move and a time move", () => {
    expect(
      taskMoveDelta(
        { "תאריך לביצוע": "2026-11-05", "שעה לביצוע": "09:00" },
        { "תאריך לביצוע": "2026-11-12", "שעה לביצוע": "10:30" },
      ),
    ).toEqual({ oldYmd: "2026-11-05", newYmd: "2026-11-12", dayDelta: 7, minuteDelta: 90 });
  });

  it("is null when nothing moved, there was no date, or the task is standing", () => {
    expect(
      taskMoveDelta({ "תאריך לביצוע": "2026-11-05" }, { "תאריך לביצוע": "2026-11-05", "הערות": "x" }),
    ).toBeNull();
    expect(taskMoveDelta({}, { "תאריך לביצוע": "2026-11-12" })).toBeNull();
    expect(
      taskMoveDelta(
        { "תאריך לביצוע": "2026-11-05", __recurrence: { freq: "weekly", interval: 1, weekdays: [4], time: "09:00" } },
        { "תאריך לביצוע": "2026-11-12" },
      ),
    ).toBeNull();
  });

  it("ignores time when the old row had none", () => {
    expect(
      taskMoveDelta({ "תאריך לביצוע": "2026-11-05" }, { "תאריך לביצוע": "2026-11-06", "שעה לביצוע": "09:00" }),
    ).toMatchObject({ dayDelta: 1, minuteDelta: 0 });
  });
});

describe("shiftDateTokens", () => {
  it("rewrites d.m, d/m, d.m.yy(yy) and ISO forms only", () => {
    expect(shiftDateTokens("ביום 5.11", "2026-11-05", "2026-11-12")).toBe("ביום 12.11");
    expect(shiftDateTokens("ב-05/11/26", "2026-11-05", "2026-11-12")).toBe("ב-12/11/26");
    expect(shiftDateTokens("עד 28.12.2026", "2026-12-28", "2027-01-04")).toBe("עד 4.1.2027");
    expect(shiftDateTokens("2026-11-05 09:00", "2026-11-05", "2026-11-12")).toBe("2026-11-12 09:00");
    expect(shiftDateTokens("ביום 15.11 ו-5.110", "2026-11-05", "2026-11-12")).toBe("ביום 15.11 ו-5.110");
  });
});

describe("shiftLinkedClocksForTaskMove", () => {
  beforeEach(() => {
    for (const fn of [itemUpdate, itemFindUnique, reminderUpdate, reminderFindMany, linkFindMany]) {
      fn.mockReset();
    }
    itemFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id === TASK
        ? { linkedReminderId: null }
        : {
            id: where.id,
            itemKey: "להזכיר לטל תור לווטרינר ביום 5.11 21:00",
            deletedAt: null,
            data: {
              "שם משימה": "להזכיר לטל תור לווטרינר ביום 5.11 21:00",
              "תאריך לביצוע": "2026-11-04",
              "שעה לביצוע": "21:00",
            },
          },
    );
    linkFindMany.mockResolvedValue([{ reminderId: "eve" }, { reminderId: "morning" }]);
  });

  it("moves evening-before + morning clocks a week with the appointment", async () => {
    reminderFindMany.mockResolvedValue([
      clock("eve", "2026-11-04T19:00:00Z"),
      clock("morning", "2026-11-05T07:00:00Z"),
    ]);
    const shifted = await shiftLinkedClocksForTaskMove({
      listItemId: TASK,
      before: { "שם משימה": "תור לווטרינר", "תאריך לביצוע": "2026-11-05", "שעה לביצוע": "09:00" },
      after: { "שם משימה": "תור לווטרינר", "תאריך לביצוע": "2026-11-12", "שעה לביצוע": "09:00" },
      now: NOW,
    });
    expect(shifted.map((row) => [row.reminderId, row.fireAt.toISOString()])).toEqual([
      ["eve", "2026-11-11T19:00:00.000Z"],
      ["morning", "2026-11-12T07:00:00.000Z"],
    ]);
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "eve" },
      data: expect.objectContaining({
        fireAt: new Date("2026-11-11T19:00:00Z"),
        itemLabel: "להזכיר לטל תור לווטרינר ביום 12.11",
        messageText: "מחר (12.11) יש לך תור לווטרינר",
      }),
    });
    const workerWrite = itemUpdate.mock.calls.find(
      ([arg]) => arg.where.id === "worker-eve" && arg.data.data?.["תאריך לביצוע"],
    );
    expect(workerWrite?.[0].data.data).toMatchObject({
      "תאריך לביצוע": "2026-11-11",
      "שם משימה": "להזכיר לטל תור לווטרינר ביום 12.11 21:00",
    });
  });

  it("keeps wall-clock time across a DST change", async () => {
    // 2026-10-20 09:00 IDT (06:00Z) → 2026-10-27 09:00 IST (07:00Z)
    reminderFindMany.mockResolvedValue([clock("eve", "2026-10-20T06:00:00Z")]);
    const shifted = await shiftLinkedClocksForTaskMove({
      listItemId: TASK,
      before: { "תאריך לביצוע": "2026-10-20" },
      after: { "תאריך לביצוע": "2026-10-27" },
      now: new Date("2026-10-01T00:00:00Z"),
    });
    expect(shifted[0]?.fireAt.toISOString()).toBe("2026-10-27T07:00:00.000Z");
  });

  it("skips recurring clocks and clocks that would land in the past", async () => {
    reminderFindMany.mockResolvedValue([
      clock("eve", "2026-11-04T19:00:00Z"),
      clock("morning", "2026-11-05T07:00:00Z", { repeat: "weekly", recurrence: { freq: "weekly" } }),
    ]);
    const shifted = await shiftLinkedClocksForTaskMove({
      listItemId: TASK,
      before: { "תאריך לביצוע": "2026-11-05" },
      after: { "תאריך לביצוע": "2026-11-04" },
      now: new Date("2026-11-04T08:00:00Z"),
    });
    // eve → 2026-11-03 19:00Z (past) stays; morning is recurring.
    expect(shifted).toEqual([]);
    expect(reminderUpdate).not.toHaveBeenCalled();
  });

  it("does nothing when the task has no linked clocks", async () => {
    linkFindMany.mockResolvedValue([]);
    const shifted = await shiftLinkedClocksForTaskMove({
      listItemId: TASK,
      before: { "תאריך לביצוע": "2026-11-05" },
      after: { "תאריך לביצוע": "2026-11-12" },
      now: NOW,
    });
    expect(shifted).toEqual([]);
    expect(reminderFindMany).not.toHaveBeenCalled();
  });
});
