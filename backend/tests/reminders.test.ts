import { describe, expect, it } from "vitest";
import type { PublicEmployee } from "@workee/shared";
import {
  formatActiveRemindersReply,
  formatJerusalemDateTime,
  formatReminderApplyNotice,
  formatReminderConfirmNotice,
  planReminderWrites,
  reminderLabelsMatch,
  resolveReminderFireAt,
  resolveReminderPingDestinations,
} from "../src/services/reminder.service.js";
import type { LlmReminderAction } from "@workee/shared";

const milkRemove: LlmReminderAction = {
  action: "remove",
  item: "חלב",
  listType: "shopping",
  date: "",
  time: "",
  repeat: "once",
  ping: [],
  targets: [],
  text: "",
  inSeconds: null,
  confirmed: false,
};

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

describe("resolveReminderFireAt", () => {
  it("uses an in-seconds delay instead of a clock hour", () => {
    const now = new Date("2026-09-24T10:00:00.000Z");
    const fireAt = resolveReminderFireAt("tomorrow", "", now, 10);
    expect(fireAt?.getTime()).toBe(now.getTime() + 10_000);
  });

  it("returns null when neither a delay nor a clock is present", () => {
    expect(resolveReminderFireAt("tomorrow", "", new Date(), null)).toBeNull();
  });

  it("fires tomorrow evening when the clock is present", () => {
    const fireAt = resolveReminderFireAt(
      "מחר",
      "20:00",
      new Date("2026-09-24T10:00:00.000Z"),
      null,
    );
    expect(fireAt?.toISOString()).toBe("2026-09-25T17:00:00.000Z");
  });

  it("shows Israel local time instead of UTC for saved reminders", () => {
    expect(formatJerusalemDateTime(new Date("2026-09-23T22:22:00.000Z"))).toBe(
      "2026-09-24 01:22",
    );
  });
});

describe("resolveReminderPingDestinations", () => {
  it("keeps a phone number when it is not an employee", () => {
    expect(
      resolveReminderPingDestinations(
        { ping: ["050-222-2222"] },
        [tal],
        tal.id,
      ),
    ).toEqual(["0502222222"]);
  });

  it("does not fall back to the speaker when only a non-employee name is given", () => {
    expect(
      resolveReminderPingDestinations({ ping: ["מיכל"] }, [tal], tal.id),
    ).toEqual([]);
  });

  it("pulls digits out of a ping token that also has a name", () => {
    expect(
      resolveReminderPingDestinations(
        { ping: ["מיכל 050-222-2222"] },
        [tal],
        tal.id,
      ),
    ).toEqual(["0502222222"]);
  });

  it("uses reminder targets as ping when ping is empty", () => {
    expect(
      resolveReminderPingDestinations(
        { ping: [], targets: ["טל"] },
        [tal],
        "other",
      ),
    ).toEqual([tal.id]);
  });

  it("maps a stored employee phone to that employee", () => {
    expect(
      resolveReminderPingDestinations(
        { ping: ["050-111-1111"] },
        [tal],
        "other",
      ),
    ).toEqual(["0501111111"]);
  });
});

describe("planReminderWrites", () => {
  it("holds a delete until the speaker confirms", () => {
    const first = planReminderWrites("conv-1", [milkRemove]);
    expect(first.apply).toEqual([]);
    expect(first.ask).toEqual([milkRemove]);
    expect(formatReminderConfirmNotice(first.ask, false, false)).toContain("חלב");

    const second = planReminderWrites("conv-1", [], [], true);
    expect(second.apply).toEqual([milkRemove]);
    expect(second.ask).toEqual([]);
  });

  it("cancels a pending delete", () => {
    planReminderWrites("conv-2", [milkRemove]);
    const cancelled = planReminderWrites("conv-2", [], [], false);
    expect(cancelled.apply).toEqual([]);
    expect(cancelled.cancelled).toBe(true);
  });

  it("asks before deleting every active reminder", () => {
    const planned = planReminderWrites(
      "conv-3",
      [{ ...milkRemove, item: "all" }],
      [
        { item: "חלב", listType: "shopping" },
        { item: "מתנה", listType: "tasks" },
      ],
    );
    expect(planned.apply).toEqual([]);
    expect(planned.ask.map((row) => row.item)).toEqual(["חלב", "מתנה"]);
    expect(formatReminderConfirmNotice(planned.ask, false, false)).toContain(
      "חלב",
    );
  });
});

describe("formatActiveRemindersReply", () => {
  it("lists only active rows from the database snapshot", () => {
    expect(
      formatActiveRemindersReply([
        {
          item: "חלב",
          list_type: "shopping",
          fire_at: "2026-09-24 22:00",
          repeat: "once",
          ping: [],
          owner: "טל",
          text: "",
          status: "active",
          sent: false,
          sent_at: null,
        },
        {
          item: "ישן",
          list_type: "tasks",
          fire_at: "2026-09-23 10:00",
          repeat: "once",
          ping: [],
          owner: "טל",
          text: "",
          status: "cancelled",
          sent: false,
          sent_at: null,
        },
      ]),
    ).toBe("התזכורות הפעילות שלך:\n- חלב (2026-09-24 22:00)");
  });
});

describe("formatReminderApplyNotice", () => {
  it("says when a reminder was stored or skipped", () => {
    expect(
      formatReminderApplyNotice({
        removed: [],
        missed: [],
        saved: [{ item: "חלב", fireAt: "2026-09-25 20:00" }],
        skipped: [],
      }),
    ).toContain("נשמרה התזכורת «חלב»");
    expect(
      formatReminderApplyNotice({
        removed: [],
        missed: [],
        saved: [],
        skipped: [{ item: "חלב", reason: "no_time" }],
      }),
    ).toContain("חסר זמן תזכורת");
  });
});

describe("reminderLabelsMatch", () => {
  it("matches a short name to the stored label", () => {
    expect(reminderLabelsMatch("לקנות חלב", "חלב")).toBe(true);
    expect(reminderLabelsMatch("חלב", "תזכורת חלב")).toBe(true);
    expect(reminderLabelsMatch("חלב", "מתנה")).toBe(false);
  });
});
