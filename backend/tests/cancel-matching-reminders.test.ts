import { describe, expect, it, vi } from "vitest";

const { reminderFindMany, reminderUpdate } = vi.hoisted(() => ({
  reminderFindMany: vi.fn(),
  reminderUpdate: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: {
      findMany: reminderFindMany,
      update: reminderUpdate,
    },
    employeeListItem: {
      updateMany: vi.fn(),
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
  it("is a no-op — clocks cancel only via FK, never by key/label", async () => {
    reminderFindMany.mockResolvedValue([
      {
        id: "r-scale",
        itemKey: "להישקל",
        itemLabel: "להישקל",
        workerItemId: "w1",
        status: "active",
      },
    ]);

    const cancelled = await cancelActiveRemindersMatchingWork({
      userId: "user-1",
      itemKey: "להישקל",
      itemLabel: "להישקל",
      actorEmployeeId: "tal-1",
    });

    expect(cancelled).toEqual({
      cancelledReminders: [],
      cancelledReminderIds: [],
      removedWorkerTasks: [],
    });
    expect(reminderFindMany).not.toHaveBeenCalled();
    expect(reminderUpdate).not.toHaveBeenCalled();
  });
});
