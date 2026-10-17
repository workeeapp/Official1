import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmReminderAction, PublicEmployee } from "@workee/shared";

const { reminderFindFirst, reminderUpdate, itemFindMany, itemUpdateMany } =
  vi.hoisted(() => ({
    reminderFindFirst: vi.fn(),
    reminderUpdate: vi.fn(),
    itemFindMany: vi.fn(),
    itemUpdateMany: vi.fn(),
  }));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: { findFirst: reminderFindFirst, update: reminderUpdate },
    employeeListItem: { findMany: itemFindMany, updateMany: itemUpdateMany },
  },
}));
vi.mock("../src/services/audit.service.js", () => ({ recordAuditEvent: vi.fn() }));

import {
  applyReminders,
  formatReminderApplyNotice,
} from "../src/services/reminder.service.js";

const tal: PublicEmployee = {
  id: "tal-1",
  name: "טל",
  surname: "",
  nickname: "טל",
  email: null,
  phone: "972501111111",
  kind: "human",
  protected: false,
};

const removeAction: LlmReminderAction = {
  action: "remove",
  item: "חתונה של תום",
  listType: "tasks",
  date: "",
  time: "",
  repeat: "once",
  ping: [],
  about: [],
  targets: [],
  text: "",
  inSeconds: null,
  everyCount: null,
  everyUnit: null,
  weekdays: null,
  confirmed: false,
  compose: false,
  composeSource: "",
  composeLookbackHours: 0,
  reminderId: "rem-cascaded",
};

describe("same-turn cascade + reminders.remove", () => {
  beforeEach(() => {
    reminderFindFirst.mockReset();
    reminderUpdate.mockReset();
    itemFindMany.mockReset().mockResolvedValue([]);
    itemUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it("treats remove of an already-cascaded id as success, not miss", async () => {
    reminderFindFirst.mockResolvedValue(null);

    const result = await applyReminders({
      userId: "u1",
      actor: tal,
      employees: [tal],
      reminders: [removeAction],
      alreadyCancelledReminderIds: ["rem-cascaded"],
    });

    expect(result.removed).toEqual(["חתונה של תום"]);
    expect(result.missed).toEqual([]);
    expect(formatReminderApplyNotice(result)).toBe("");
    expect(reminderUpdate).not.toHaveBeenCalled();
  });

  it("still reports miss when the id was not cascaded this turn", async () => {
    reminderFindFirst.mockResolvedValue(null);

    const result = await applyReminders({
      userId: "u1",
      actor: tal,
      employees: [tal],
      reminders: [removeAction],
      alreadyCancelledReminderIds: [],
    });

    expect(result.removed).toEqual([]);
    expect(result.missed).toEqual(["חתונה של תום"]);
    expect(formatReminderApplyNotice(result)).toContain(
      "לא נמצאה תזכורת פעילה בשם: חתונה של תום",
    );
  });
});
