import { describe, expect, it } from "vitest";
import type { PublicEmployee } from "@workee/shared";
import {
  formatActiveRemindersReply,
  formatTodosReply,
  applyTimeToTaskLabel,
  canReuseExistingReminderClock,
  findMatchingActiveReminder,
  formatJerusalemDateTime,
  formatReminderApplyNotice,
  formatReminderConfirmNotice,
  formatPingLabel,
  pairWorkerItemsToReminders,
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
  compose: false,
  composeSource: "",
  composeLookbackHours: 0,
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

  it("uses weekdays numbers plus 13:30, not a weekday word in date", () => {
    const fireAt = resolveReminderFireAt(
      "",
      "13:30",
      new Date("2026-09-24T18:00:00.000Z"),
      null,
      { count: 1, unit: "weekdays", weekdays: [1] },
    );
    expect(fireAt?.toISOString()).toBe("2026-09-28T10:30:00.000Z");
  });

  it("does not treat date שני as Monday", () => {
    const fireAt = resolveReminderFireAt(
      "שני",
      "13:30",
      new Date("2026-09-24T18:00:00.000Z"),
      null,
    );
    expect(fireAt?.toISOString()).toBe("2026-09-25T10:30:00.000Z");
  });

  it("returns null when neither a delay nor a clock is present", () => {
    expect(resolveReminderFireAt("tomorrow", "", new Date(), null)).toBeNull();
  });

  it("fires on an ISO date when the clock is present", () => {
    const fireAt = resolveReminderFireAt(
      "2026-09-25",
      "20:00",
      new Date("2026-09-24T10:00:00.000Z"),
      null,
    );
    expect(fireAt?.toISOString()).toBe("2026-09-25T17:00:00.000Z");
  });

  it("does not treat date tomorrow as the next calendar day", () => {
    const fireAt = resolveReminderFireAt(
      "tomorrow",
      "20:00",
      new Date("2026-09-24T10:00:00.000Z"),
      null,
    );
    expect(fireAt?.toISOString()).toBe("2026-09-24T17:00:00.000Z");
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

  it("does not harvest digits from item or mixed ping tokens", () => {
    expect(
      resolveReminderPingDestinations(
        { ping: [], item: "היי 050-222-2222" },
        [tal],
        tal.id,
      ),
    ).toEqual([tal.id]);
    expect(
      resolveReminderPingDestinations(
        { ping: ["מיכל 050-222-2222"] },
        [tal],
        tal.id,
      ),
    ).toEqual([]);
    expect(
      resolveReminderPingDestinations(
        {
          ping: ["טל"],
          item: "לשלוח הודעה 'היום אנחנו נפגשים' למספר 0523691495",
        },
        [tal],
        tal.id,
      ),
    ).toEqual([tal.id]);
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

describe("formatPingLabel", () => {
  it("shows the employee name, not masked phone digits", () => {
    expect(formatPingLabel(tal.id, [tal])).toBe("טל");
    expect(formatPingLabel("0502222222", [tal])).toBe("…2222");
  });
});

describe("applyTimeToTaskLabel", () => {
  it("replaces an existing clock in the worker task name", () => {
    expect(
      applyTimeToTaskLabel(
        "להזכיר לך לרדת עם הכלב סקאזי לטיול מחר ב־09:00",
        "10:00",
      ),
    ).toBe("להזכיר לך לרדת עם הכלב סקאזי לטיול מחר ב־10:00");
  });

  it("appends a clock when the task name has none", () => {
    expect(applyTimeToTaskLabel("להזכיר לעמית לאכול פיצה", "08:00")).toBe(
      "להזכיר לעמית לאכול פיצה ב־08:00",
    );
  });
});

describe("pairWorkerItemsToReminders", () => {
  it("links one new clock to one worker task even when labels differ", () => {
    expect(
      pairWorkerItemsToReminders(
        [{ id: "r1", itemKey: "לקנות חלב", itemLabel: "לקנות חלב" }],
        [{ id: "w1", itemKey: "להזכיר לעמית לקנות חלב ב-08:00" }],
      ),
    ).toEqual([{ reminderId: "r1", workerItemId: "w1" }]);
  });

  it("pairs by matching item text when there are several clocks", () => {
    expect(
      pairWorkerItemsToReminders(
        [
          { id: "r1", itemKey: "חלב", itemLabel: "חלב" },
          { id: "r2", itemKey: "מייל", itemLabel: "מייל" },
        ],
        [
          { id: "w1", itemKey: "להזכיר מייל" },
          { id: "w2", itemKey: "להזכיר חלב" },
        ],
      ),
    ).toEqual([
      { reminderId: "r1", workerItemId: "w2" },
      { reminderId: "r2", workerItemId: "w1" },
    ]);
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
    const first = planReminderWrites([milkRemove], null, null);
    expect(first.apply).toEqual([]);
    expect(first.ask).toEqual([milkRemove]);
    expect(first.nextPending?.targets).toEqual(["חלב"]);
    expect(formatReminderConfirmNotice(first.ask, false, false)).toContain("חלב");
    expect(formatReminderConfirmNotice(first.ask, false, false)).toMatch(
      /לבטל את התזכורת/,
    );
    expect(formatReminderConfirmNotice(first.ask, false, false)).toMatch(
      /לא יימחקו/,
    );
    expect(
      formatReminderConfirmNotice(first.ask, false, false, {
        repeatsByItem: new Map([["חלב", "10:seconds"]]),
      }),
    ).toMatch(/כל 10 שניות/);
    expect(formatReminderConfirmNotice(first.ask, false, false)).toMatch(
      /הפריט או המטלה לא יימחקו/,
    );

    const second = planReminderWrites([], true, first.nextPending);
    expect(second.apply.map((row) => row.item)).toEqual(["חלב"]);
    expect(second.ask).toEqual([]);
    expect(second.nextPending).toBeNull();
  });

  it("cancels a pending delete", () => {
    const held = planReminderWrites([milkRemove], null, null);
    const cancelled = planReminderWrites([], false, held.nextPending);
    expect(cancelled.apply).toEqual([]);
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.nextPending).toBeNull();
  });

  it("asks only for the named items the model listed", () => {
    const planned = planReminderWrites(
      [
        { ...milkRemove, item: "חלב" },
        { ...milkRemove, item: "מתנה" },
      ],
      null,
      null,
    );
    expect(planned.apply).toEqual([]);
    expect(planned.ask.map((row) => row.item)).toEqual(["חלב", "מתנה"]);
    expect(planned.nextPending?.targets).toEqual(["חלב", "מתנה"]);
  });

  it("applies the held deletes when they confirm even if remove is sent again", () => {
    const held = planReminderWrites(
      [
        { ...milkRemove, item: "התאמן" },
        { ...milkRemove, item: "ללכת לסופר" },
      ],
      null,
      null,
    );
    const confirmed = planReminderWrites(
      [
        { ...milkRemove, item: "התאמן" },
        { ...milkRemove, item: "ללכת לסופר" },
      ],
      true,
      held.nextPending,
    );
    expect(confirmed.apply.map((row) => row.item)).toEqual([
      "התאמן",
      "ללכת לסופר",
    ]);
    expect(confirmed.ask).toEqual([]);
    expect(confirmed.nextPending).toBeNull();
  });

  it("does not expand item all into other reminders", () => {
    const planned = planReminderWrites(
      [{ ...milkRemove, item: "all" }],
      null,
      null,
    );
    expect(planned.apply).toEqual([]);
    expect(planned.ask.map((row) => row.item)).toEqual(["all"]);
  });

  it("times out a stale pending delete", () => {
    const held = planReminderWrites([milkRemove], null, null, {
      now: new Date("2026-09-28T10:00:00.000Z"),
    });
    const timedOut = planReminderWrites([], null, held.nextPending, {
      now: new Date("2026-09-28T10:20:00.000Z"),
    });
    expect(timedOut.cancelled).toBe(true);
    expect(timedOut.nextPending).toBeNull();
  });

  it("abandons pending delete when unrelated work arrives", () => {
    const held = planReminderWrites([milkRemove], null, null);
    const abandoned = planReminderWrites([], null, held.nextPending, {
      abandonPending: true,
    });
    expect(abandoned.cancelled).toBe(true);
    expect(abandoned.nextPending).toBeNull();
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
      last_composed_text: "",
      sent_text: "",
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
          ping_ids: [],
          owner: "טל",
          text: "",
          compose_at_fire: false,
          compose_source: "",
          compose_lookback_hours: 0,
          status: "active",
          send_status: "pending",
          sent: false,
          sent_at: null,
          last_composed_text: "",
          sent_text: "",
        },
        {
          item: "ישן",
          list_type: "tasks",
          fire_at: "2026-09-23 10:00",
          repeat: "once",
          ping: [],
          ping_ids: [],
          owner: "טל",
          text: "",
          compose_at_fire: false,
          compose_source: "",
          compose_lookback_hours: 0,
          status: "cancelled",
          send_status: "pending",
          sent: false,
          sent_at: null,
          last_composed_text: "",
          sent_text: "",
        },
      ]),
    ).toBe("התזכורות הפעילות שלך:\n- חלב (2026-09-24 22:00)");
  });
});

describe("formatTodosReply", () => {
  const supermarket = {
    item: "ללכת לסופר",
    list_type: "tasks",
    fire_at: "2026-09-25 21:30",
    repeat: "once",
    ping: ["טל"],
    ping_ids: [tal.id],
    owner: "טל",
    text: "",
    compose_at_fire: false,
    compose_source: "",
    compose_lookback_hours: 0,
    status: "active" as const,
    send_status: "pending" as const,
    sent: false,
    sent_at: null,
    last_composed_text: "",
    sent_text: "",
  };
  const michalSend = {
    ...supermarket,
    item: "לשלוח הודעה למיכל",
    fire_at: "2026-09-24 22:15",
    ping: ["0523691495"],
    ping_ids: ["0523691495"],
  };

  it("lists shopping, tasks, and self-reminders, not a send to someone else", () => {
    expect(
      formatTodosReply({
        shopping: ["חלב"],
        tasks: [],
        reminders: [supermarket, michalSend],
        speakerId: tal.id,
        speakerPhone: tal.phone,
      }),
    ).toBe(
      "מה שאתה צריך לעשות:\n- חלב\n- ללכת לסופר (2026-09-25 21:30)",
    );
  });

  it("speaks as Lucy about her own task", () => {
    expect(
      formatTodosReply({
        shopping: [],
        tasks: ["לבדוק מייל"],
        reminders: [],
        speakerId: "lucy-1",
        voice: "self-female",
      }),
    ).toBe("אני צריכה לבדוק מייל");
  });
});

describe("canReuseExistingReminderClock", () => {
  const base = {
    action: "update" as const,
    text: "טל מוסר: שלום",
    time: "",
    inSeconds: null,
    everyCount: null,
    everyUnit: null,
    weekdays: null,
  };

  it("reuses the clock on update even without a new time", () => {
    expect(canReuseExistingReminderClock(base, true)).toBe(true);
  });

  it("reuses the clock for a text-only add-shaped edit of an existing send", () => {
    expect(
      canReuseExistingReminderClock({ ...base, action: "add" }, true),
    ).toBe(true);
  });

  it("does not reuse when there is no existing clock", () => {
    expect(canReuseExistingReminderClock(base, false)).toBe(false);
  });

  it("does not treat a new timed add as text-only reuse", () => {
    expect(
      canReuseExistingReminderClock(
        { ...base, action: "add", time: "12:00", text: "היי" },
        true,
      ),
    ).toBe(false);
  });
});

describe("findMatchingActiveReminder", () => {
  const rows = [
    {
      itemKey: "לשלוח הודעה לעמית",
      itemLabel: "לשלוח הודעה לעמית",
      ownerId: "owner-amit",
    },
    {
      itemKey: "לקבל בדיחה בנושא עדות",
      itemLabel: "לקבל בדיחה בנושא עדות",
      ownerId: "owner-tal",
    },
  ];

  it("matches across owners by label", () => {
    const hit = findMatchingActiveReminder(rows, "לשלוח הודעה לעמית");
    expect(hit?.ownerId).toBe("owner-amit");
  });

  it("returns undefined when nothing matches", () => {
    expect(findMatchingActiveReminder(rows, "להכין חביתה")).toBeUndefined();
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
    ).toContain("מתי לשלוח");
  });

  it("notes another active clock at the same time without blocking", () => {
    const notice = formatReminderApplyNotice({
      removed: [],
      missed: [],
      saved: [
        {
          item: "לאסוף את יואב מהחוג",
          fireAt: "2026-09-29 10:00",
          sameTimeOthers: ["להזמין כרטיסים"],
        },
      ],
      skipped: [],
    });
    expect(notice).toContain("נשמרה התזכורת «לאסוף את יואב מהחוג»");
    expect(notice).toContain("יש לך כבר תזכורת אחרת באותה שעה");
    expect(notice).toContain("להזמין כרטיסים");
    expect(notice).not.toContain("לעדכן");
  });

  it("notes a compose-at-fire brief was stored", () => {
    expect(
      formatReminderApplyNotice({
        removed: [],
        missed: [],
        saved: [
          {
            item: "לשלוח ברכת בוקר לעמית",
            fireAt: "2026-09-30 09:00",
            ping: "עמית",
            composeAtFire: true,
          },
        ],
        skipped: [],
      }),
    ).toContain("נשמרה הנחיה להודעה מתוזמנת");
  });
});

describe("reminderLabelsMatch", () => {
  it("matches a short name to the stored label", () => {
    expect(reminderLabelsMatch("לקנות חלב", "חלב")).toBe(true);
    expect(reminderLabelsMatch("חלב", "תזכורת חלב")).toBe(true);
    expect(reminderLabelsMatch("חלב", "מתנה")).toBe(false);
  });
});
