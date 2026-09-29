import { beforeEach, describe, expect, it, vi } from "vitest";

const { reminderUpdate, reminderDelete } = vi.hoisted(() => ({
  reminderUpdate: vi.fn(),
  reminderDelete: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: {
      update: reminderUpdate,
      delete: reminderDelete,
    },
  },
}));

vi.mock("../src/config/env.js", () => ({
  getEnv: () => ({ NODE_ENV: "test" }),
}));

import {
  resolveComposeFireOutbound,
  settleFiredReminder,
} from "../src/services/reminder-fire.js";

describe("settleFiredReminder", () => {
  beforeEach(() => {
    reminderUpdate.mockReset();
    reminderDelete.mockReset();
  });

  it("deletes a one-shot clock so the linked worker task cascades away", async () => {
    await settleFiredReminder(
      {
        id: "clock-1",
        fireAt: new Date("2026-09-28T00:00:00.000Z"),
        repeat: "once",
      },
      new Date("2026-09-28T00:03:00.000Z"),
      "sent",
    );

    expect(reminderDelete).toHaveBeenCalledWith({ where: { id: "clock-1" } });
    expect(reminderUpdate).not.toHaveBeenCalled();
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
