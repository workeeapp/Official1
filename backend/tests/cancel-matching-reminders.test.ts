import { beforeEach, describe, expect, it, vi } from "vitest";

const { reminderFindMany, reminderUpdate, itemUpdateMany } = vi.hoisted(() => ({
  reminderFindMany: vi.fn(),
  reminderUpdate: vi.fn(),
  itemUpdateMany: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: {
      findMany: reminderFindMany,
      update: reminderUpdate,
    },
    employeeListItem: {
      updateMany: itemUpdateMany,
    },
    auditEvent: {
      create: vi.fn(),
    },
  },
}));

vi.mock("../src/services/audit.service.js", () => ({
  recordAuditEvent: vi.fn(),
}));

import { cancelActiveRemindersMatchingWork } from "../src/services/reminder.service.js";

describe("cancelActiveRemindersMatchingWork", () => {
  beforeEach(() => {
    reminderFindMany.mockReset();
    reminderUpdate.mockReset().mockResolvedValue({});
    itemUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it("cancels clocks that match the removed work and leaves unrelated ones", async () => {
    reminderFindMany.mockResolvedValue([
      {
        id: "r-scale",
        itemKey: "להישקל",
        itemLabel: "להישקל",
        workerItemId: "w1",
        status: "active",
      },
      {
        id: "r-michal",
        itemKey: "לשלוח הודעה למיכל",
        itemLabel: "לשלוח הודעה למיכל",
        workerItemId: "w2",
        status: "active",
      },
    ]);

    const cancelled = await cancelActiveRemindersMatchingWork({
      userId: "user-1",
      itemKey: "להישקל",
      itemLabel: "להישקל",
      actorEmployeeId: "tal-1",
    });

    expect(cancelled).toEqual(["להישקל"]);
    expect(reminderUpdate).toHaveBeenCalledTimes(1);
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "r-scale" },
      data: { status: "cancelled", workerItemId: null },
    });
  });

  it("returns empty when no active clock matches", async () => {
    reminderFindMany.mockResolvedValue([
      {
        id: "r-michal",
        itemKey: "לשלוח הודעה למיכל",
        itemLabel: "לשלוח הודעה למיכל",
        workerItemId: null,
        status: "active",
      },
    ]);

    const cancelled = await cancelActiveRemindersMatchingWork({
      userId: "user-1",
      itemKey: "להישקל",
      itemLabel: "להישקל",
    });

    expect(cancelled).toEqual([]);
    expect(reminderUpdate).not.toHaveBeenCalled();
  });
});
