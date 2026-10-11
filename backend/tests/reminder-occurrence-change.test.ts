import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatJerusalemDateTime } from "@workee/shared";

const { reminderFindFirst, reminderUpdate } = vi.hoisted(() => ({
  reminderFindFirst: vi.fn(),
  reminderUpdate: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: { findFirst: reminderFindFirst, update: reminderUpdate },
  },
}));
vi.mock("../src/services/audit.service.js", () => ({ recordAuditEvent: vi.fn() }));
vi.mock("../src/services/reminder-fire.js", () => ({ scheduleSoon: vi.fn() }));

import {
  applyReminderOccurrenceChange,
  reminderRuleSnapshot,
} from "../src/services/reminder.service.js";

// Mon 2026-10-12 01:00 Jerusalem.
const NOW = new Date("2026-10-11T22:00:00.000Z");
const fmt = (value: Date | null) => (value ? formatJerusalemDateTime(value) : null);

const clock = {
  id: "rem-1",
  userId: "u1",
  ownerId: "amit-1",
  itemKey: "לאסוף את הילדים",
  itemLabel: "לאסוף את הילדים",
  listType: "tasks",
  // Next fire: Fri 2026-10-16 12:00.
  fireAt: new Date("2026-10-16T09:00:00Z"),
  repeat: "weekdays:5",
  recurrence: { freq: "weekly", interval: 1, weekdays: [5], time: "12:00" },
  occurrencesFired: 0,
  pingIds: ["amit-1"],
  status: "active",
  workerItemId: null,
};

function change(date: string, extra: { cancel?: boolean; time?: string }) {
  return applyReminderOccurrenceChange({
    userId: "u1",
    actorEmployeeId: "amit-1",
    reminderId: "rem-1",
    change: { date, ...extra },
    now: NOW,
  });
}

describe("applyReminderOccurrenceChange", () => {
  beforeEach(() => {
    reminderFindFirst.mockReset().mockResolvedValue(clock);
    reminderUpdate.mockReset().mockImplementation(async ({ data }) => ({ ...clock, ...data }));
  });

  it("cancelling the next fire moves fireAt to the following Friday", async () => {
    const out = await change("2026-10-16", { cancel: true });
    expect(fmt(out?.fireAt ?? null)).toBe("2026-10-23 12:00");
    const data = reminderUpdate.mock.calls[0][0].data;
    expect(data.recurrence.exceptions).toEqual([{ date: "2026-10-16", cancel: true }]);
  });

  it("a later day keeps the next fire and stores the exception", async () => {
    const out = await change("2026-10-23", { time: "11:00" });
    expect(fmt(out?.fireAt ?? null)).toBe("2026-10-16 12:00");
    const data = reminderUpdate.mock.calls[0][0].data;
    expect(data.recurrence.exceptions).toEqual([{ date: "2026-10-23", time: "11:00" }]);
    const facts = reminderRuleSnapshot({ ...clock, recurrence: data.recurrence });
    expect(facts.next_occurrences?.slice(0, 3)).toEqual([
      "2026-10-16 12:00",
      "2026-10-23 11:00",
      "2026-10-30 12:00",
    ]);
  });

  it("moving the next fire earlier that day fires at the new time", async () => {
    const out = await change("2026-10-16", { time: "11:00" });
    expect(fmt(out?.fireAt ?? null)).toBe("2026-10-16 11:00");
  });

  it("refuses a day the clock does not land on or a one-off clock", async () => {
    expect(await change("2026-10-22", { cancel: true })).toBeNull();
    reminderFindFirst.mockResolvedValue({ ...clock, repeat: "once", recurrence: null });
    expect(await change("2026-10-16", { cancel: true })).toBeNull();
    expect(reminderUpdate).not.toHaveBeenCalled();
  });
});
