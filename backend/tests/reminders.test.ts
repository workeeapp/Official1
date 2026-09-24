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
  toReminderSnapshotRow,
  unknownDestNames,
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
  everyCount: null,
  everyUnit: null,
  weekdays: null,
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

  it("uses the interval as the first ping when there is no clock", () => {
    const now = new Date("2026-09-24T10:00:00.000Z");
    const fireAt = resolveReminderFireAt("", "", now, null, {
      count: 1,
      unit: "hours",
    });
    expect(fireAt?.toISOString()).toBe("2026-09-24T11:00:00.000Z");
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

  it("rolls a clock that already passed today to tomorrow", () => {
    const fireAt = resolveReminderFireAt(
      "",
      "08:05",
      new Date("2026-09-24T17:25:00.000Z"),
      null,
    );
    expect(fireAt?.toISOString()).toBe("2026-09-25T05:05:00.000Z");
  });

  it("keeps a clock that is still later today", () => {
    const fireAt = resolveReminderFireAt(
      "",
      "08:05",
      new Date("2026-09-24T04:00:00.000Z"),
      null,
    );
    expect(fireAt?.toISOString()).toBe("2026-09-24T05:05:00.000Z");
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

  it("pulls digits out of the reminder item when ping is empty", () => {
    expect(
      resolveReminderPingDestinations(
        { ping: [], item: "היי 050-222-2222" },
        [tal],
        tal.id,
      ),
    ).toEqual(["0502222222"]);
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

  it("uses a phone in the item even if ping is the speaker", () => {
    expect(
      resolveReminderPingDestinations(
        {
          ping: ["טל"],
          item: "לשלוח הודעה 'היום אנחנו נפגשים' למספר 0523691495",
        },
        [tal],
        tal.id,
      ),
    ).toEqual(["0523691495"]);
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

describe("unknown dest", () => {
  it("treats מיכל as an unknown name and asks for the number", () => {
    expect(unknownDestNames({ ping: ["מיכל"] }, [tal])).toEqual(["מיכל"]);
    expect(
      formatReminderApplyNotice({
        removed: [],
        missed: [],
        skipped: [{ item: "היי", reason: "no_phone", dest: "מיכל" }],
      }),
    ).toBe("אין לי מספר ל«מיכל». מה המספר?");
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

    const confirmed = planReminderWrites(
      "conv-3",
      [{ ...milkRemove, item: "all", confirmed: true }],
      [
        { item: "חלב", listType: "shopping" },
        { item: "מתנה", listType: "tasks" },
      ],
    );
    expect(confirmed.apply.map((row) => row.item)).toEqual(["חלב", "מתנה"]);
    expect(confirmed.apply.some((row) => row.item === "all")).toBe(false);
  });
});

describe("toReminderSnapshotRow", () => {
  it("does not treat a finished clock as sent when WhatsApp failed", () => {
    expect(
      toReminderSnapshotRow(
        {
          itemLabel: "חלב",
          listType: "shopping",
          fireAt: new Date("2026-09-24T17:08:00.000Z"),
          repeat: "once",
          pingIds: [],
          ownerId: tal.id,
          messageText: "",
          status: "done",
          sendStatus: "failed",
          sentAt: null,
        },
        new Map([[tal.id, "טל"]]),
      ),
    ).toMatchObject({
      status: "done",
      send_status: "failed",
      sent: false,
      sent_at: null,
    });
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
          send_status: "pending",
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
          send_status: "pending",
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
