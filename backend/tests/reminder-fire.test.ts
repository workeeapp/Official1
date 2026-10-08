import { beforeEach, describe, expect, it, vi } from "vitest";

const { reminderUpdate, reminderUpdateMany, reminderDelete, reminderFindUnique, itemUpdateMany, itemUpdate } =
  vi.hoisted(() => ({
    reminderUpdate: vi.fn(),
    reminderUpdateMany: vi.fn(),
    reminderDelete: vi.fn(),
    reminderFindUnique: vi.fn(),
    itemUpdateMany: vi.fn(),
    itemUpdate: vi.fn(),
  }));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: {
      update: reminderUpdate,
      updateMany: reminderUpdateMany,
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

const { continueJobAfterNudge, activateScheduledJob } = vi.hoisted(() => ({
  continueJobAfterNudge: vi.fn(),
  activateScheduledJob: vi.fn(),
}));

vi.mock("../src/services/jobs.service.js", () => ({
  continueJobAfterNudge,
  activateScheduledJob,
}));

import {
  claimDueReminder,
  resolveComposeFireOutbound,
  settleFiredReminder,
} from "../src/services/reminder-fire.js";

describe("claimDueReminder", () => {
  beforeEach(() => {
    reminderUpdateMany.mockReset();
  });

  it("claims a due active row by parking fireAt", async () => {
    reminderUpdateMany.mockResolvedValue({ count: 1 });
    const now = new Date("2026-10-01T22:00:00.000Z");
    await expect(claimDueReminder("clock-1", now)).resolves.toBe(true);
    expect(reminderUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "clock-1",
        status: "active",
        fireAt: { lte: now },
      },
      data: {
        fireAt: new Date(now.getTime() + 120_000),
      },
    });
  });

  it("returns false when another worker already claimed the row", async () => {
    reminderUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      claimDueReminder("clock-1", new Date("2026-10-01T22:00:00.000Z")),
    ).resolves.toBe(false);
  });
});

describe("settleFiredReminder", () => {
  beforeEach(() => {
    reminderUpdate.mockReset();
    reminderDelete.mockReset();
    reminderFindUnique.mockReset().mockResolvedValue({ workerItemId: "task-1" });
    itemUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    itemUpdate.mockReset().mockResolvedValue({});
    activateScheduledJob.mockReset().mockResolvedValue(false);
    continueJobAfterNudge.mockReset();
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

  it("advances a recurring clock by its rule and counts the fire", async () => {
    // Thu 2026-10-08 19:00 Jerusalem.
    const fired = new Date("2026-10-08T16:00:00.000Z");
    await settleFiredReminder(
      {
        id: "clock-1",
        fireAt: fired,
        repeat: "weekdays:2,4",
        recurrence: { freq: "weekly", interval: 1, weekdays: [2, 4], time: "19:00" },
        occurrencesFired: 0,
      },
      new Date(fired.getTime() + 60_000),
      "sent",
    );
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "clock-1" },
      data: {
        fireAt: new Date("2026-10-13T16:00:00.000Z"),
        sendStatus: "sent",
        sentAt: expect.any(Date),
        occurrencesFired: 1,
      },
    });
  });

  it("finishes a recurring clock when count is reached", async () => {
    const fired = new Date("2026-10-28T06:00:00.000Z");
    await settleFiredReminder(
      {
        id: "clock-1",
        fireAt: fired,
        repeat: "10:days",
        recurrence: { freq: "daily", interval: 10, time: "09:00", count: 3 },
        occurrencesFired: 2,
      },
      new Date(fired.getTime() + 60_000),
      "sent",
    );
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "clock-1" },
      data: expect.objectContaining({ status: "done", occurrencesFired: 3 }),
    });
  });

  it("hands a fired job nudge to the job so it is freed and its follow-ups continue", async () => {
    continueJobAfterNudge.mockReset();
    const nudge = {
      kind: "nudge",
      askerId: "amit",
      askerName: "עמית",
      subjectId: "eran",
      subjectName: "ערן",
      ask: "מה שלומך?",
      state: "open",
      createdAt: "2026-09-28T00:00:00.000Z",
      jobItemId: "job-1",
      auto: true,
    };
    itemUpdate.mockResolvedValue({ id: "task-1", data: { __job: nudge } });
    const now = new Date("2026-09-28T00:03:00.000Z");
    await settleFiredReminder(
      {
        id: "clock-1",
        fireAt: new Date("2026-09-28T00:00:00.000Z"),
        repeat: "once",
        userId: "u1",
      },
      now,
      "sent",
    );
    expect(continueJobAfterNudge).toHaveBeenCalledWith({
      userId: "u1",
      nudgeItemId: "task-1",
      nudge: expect.objectContaining({ kind: "nudge", jobItemId: "job-1", auto: true }),
      now,
    });
  });

  it("does not touch jobs when a plain worker task fires", async () => {
    continueJobAfterNudge.mockReset();
    await settleFiredReminder(
      {
        id: "clock-1",
        fireAt: new Date("2026-09-28T00:00:00.000Z"),
        repeat: "once",
        userId: "u1",
      },
      new Date("2026-09-28T00:03:00.000Z"),
      "sent",
    );
    expect(continueJobAfterNudge).not.toHaveBeenCalled();
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

  it("activates a deferred job and keeps the worker task on one-shot fire", async () => {
    activateScheduledJob.mockResolvedValue(true);
    const now = new Date("2026-09-28T00:03:00.000Z");
    await settleFiredReminder(
      {
        id: "clock-1",
        fireAt: new Date("2026-09-28T00:00:00.000Z"),
        repeat: "once",
        userId: "u1",
      },
      now,
      "sent",
    );
    expect(activateScheduledJob).toHaveBeenCalledWith({
      userId: "u1",
      workerItemId: "task-1",
      now,
    });
    expect(itemUpdate).not.toHaveBeenCalled();
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "clock-1" },
      data: {
        status: "done",
        sendStatus: "sent",
        sentAt: now,
        workerItemId: null,
      },
    });
  });

  it("activates a deferred job when a recurring schedule clock advances", async () => {
    activateScheduledJob.mockResolvedValue(true);
    const fired = new Date("2026-10-08T16:00:00.000Z");
    await settleFiredReminder(
      {
        id: "clock-1",
        fireAt: fired,
        repeat: "weekdays:1",
        recurrence: { freq: "weekly", interval: 1, weekdays: [1], time: "14:00" },
        occurrencesFired: 0,
        userId: "u1",
      },
      new Date(fired.getTime() + 60_000),
      "sent",
    );
    expect(activateScheduledJob).toHaveBeenCalledWith({
      userId: "u1",
      workerItemId: "task-1",
      now: expect.any(Date),
    });
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
