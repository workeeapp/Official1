import { beforeEach, describe, expect, it, vi } from "vitest";

const { reminderUpdate, reminderDelete, reminderFindUnique, itemUpdateMany, itemUpdate } =
  vi.hoisted(() => ({
    reminderUpdate: vi.fn(),
    reminderDelete: vi.fn(),
    reminderFindUnique: vi.fn(),
    itemUpdateMany: vi.fn(),
    itemUpdate: vi.fn(),
  }));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: {
      update: reminderUpdate,
      delete: reminderDelete,
      findUnique: reminderFindUnique,
    },
    employeeListItem: {
      updateMany: itemUpdateMany,
      update: itemUpdate,
    },
  },
}));

vi.mock("../src/config/env.js", () => ({
  getEnv: () => ({ NODE_ENV: "test" }),
}));

vi.mock("../src/services/audit.service.js", () => ({
  recordAuditEvent: vi.fn(),
}));

import {
  resolveComposeFireOutbound,
  settleFiredReminder,
} from "../src/services/reminder-fire.js";

describe("settleFiredReminder", () => {
  beforeEach(() => {
    reminderUpdate.mockReset();
    reminderDelete.mockReset();
    reminderFindUnique.mockReset().mockResolvedValue({ workerItemId: "task-1" });
    itemUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    itemUpdate.mockReset().mockResolvedValue({});
  });

  it("marks a one-shot clock done with sent_at and detaches the worker task", async () => {
    const now = new Date("2026-09-28T00:03:00.000Z");
    await settleFiredReminder(
      {
        id: "clock-1",
        fireAt: new Date("2026-09-28T00:00:00.000Z"),
        repeat: "once",
      },
      now,
      "sent",
    );

    expect(reminderDelete).not.toHaveBeenCalled();
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "clock-1" },
      data: {
        status: "done",
        sendStatus: "sent",
        sentAt: now,
        workerItemId: null,
      },
    });
    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: { reminderId: "clock-1" },
      data: { reminderId: null },
    });
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
  });

  it("keeps a repeating clock", async () => {
    reminderUpdate.mockResolvedValue({});
    await settleFiredReminder(
      {
        id: "clock-2",
        fireAt: new Date("2026-09-28T00:00:00.000Z"),
        repeat: "1:days",
      },
      new Date("2026-09-28T00:00:00.000Z"),
      "sent",
    );

    expect(reminderDelete).not.toHaveBeenCalled();
    expect(reminderUpdate).toHaveBeenCalled();
    expect(itemUpdate).not.toHaveBeenCalled();
  });
});

describe("resolveComposeFireOutbound", () => {
  it("uses the composed text and marks it for last_composed_text", () => {
    expect(
      resolveComposeFireOutbound({
        brief: "בדיחה על עדות",
        itemLabel: "לקבל בדיחה",
        composed: "למה האשכנזי…",
      }),
    ).toEqual({
      body: "למה האשכנזי…",
      lastComposedToSave: "למה האשכנזי…",
    });
  });

  it("falls back to the brief without persisting when compose fails", () => {
    expect(
      resolveComposeFireOutbound({
        brief: "בדיחה חדשה על עדות",
        itemLabel: "לקבל בדיחה",
        composed: null,
      }),
    ).toEqual({
      body: "בדיחה חדשה על עדות",
      lastComposedToSave: null,
    });
  });
});
