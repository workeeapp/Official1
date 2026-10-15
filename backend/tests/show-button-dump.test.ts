import { describe, expect, it } from "vitest";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import {
  formatLinkedReminderParen,
  formatNumberedItem,
  formatRelativeDayLabel,
  formatRelativeFireAt,
  formatReminderWhen,
  formatScheduleSuffix,
  formatShoppingTitle,
  formatShowButtonDump,
  formatShowDumpFromKind,
  isExactShowButtonCommand,
  parseExactShowButtonCommand,
  partnersKey,
  shortCadenceParen,
} from "../src/services/show-button-dump.js";
import {
  formatWhatsAppReplyContext,
  stripWhatsAppReplyPrefix,
} from "../src/services/whatsapp-outbound-memory.js";

describe("exact show button commands", () => {
  it("matches button commands only", () => {
    expect(isExactShowButtonCommand("הצג רשימת קניות")).toBe(true);
    expect(isExactShowButtonCommand("הצג תזכורות")).toBe(true);
    expect(isExactShowButtonCommand("הצג רשימת משימות לעבודה")).toBe(true);
    expect(isExactShowButtonCommand("מה יש לי לקנות")).toBe(false);
    expect(isExactShowButtonCommand("הציגי את רשימת הקניות")).toBe(false);
    expect(parseExactShowButtonCommand("הצג רשימת קניות בבקשה")).toEqual({
      kind: "list",
      name: "קניות בבקשה",
    });
  });

  it("strips WhatsApp reply prefix", () => {
    const wrapped = formatWhatsAppReplyContext(
      "מחקתי את האורז מרשימת הקניות.",
      "הצג רשימת קניות",
    );
    expect(stripWhatsAppReplyPrefix(wrapped)).toBe("הצג רשימת קניות");
    expect(isExactShowButtonCommand(stripWhatsAppReplyPrefix(wrapped))).toBe(
      true,
    );
  });
});

describe("formatShowButtonDump", () => {
  const snapshot: EmployeeRecordSnapshot = {
    lists: [
      {
        list_type: "shopping",
        list_name: "",
        owner: "טל",
        scope: "personal",
        items: [{ item_id: "1", "שם פריט": "ספוג אדום" }],
      },
      {
        list_type: "shopping",
        list_name: "",
        owner: "טל",
        scope: "shared",
        shared_with: ["טל", "מיכל"],
        items: [
          { item_id: "2", "שם פריט": "קמח מלא", כמות: 2 },
          {
            item_id: "3",
            "שם פריט": "עגבניות",
            כמות: 1,
            "יחידת מידה": 'ק"ג',
          },
        ],
      },
      {
        list_type: "tasks",
        list_name: "",
        owner: "טל",
        scope: "personal",
        items: [
          {
            item_id: "t1",
            "שם מטלה": "לבדוק את הבאג הזה",
            reminder: { reminder_id: "r3", fire_at: "2026-10-15 20:30", repeat: "none" },
          },
          {
            item_id: "t2",
            "שם מטלה": "ללכת לשוק 🍅",
            חוזר: "שני ושלישי ב־19:00",
            attachments: [{ id: "a1" }],
          },
          {
            item_id: "t3",
            "שם מטלה": "חתונה של תום",
            "תאריך לביצוע": "2026-10-12",
            "שעה לביצוע": "19:30",
            attachments: [{ id: "a2" }],
          },
          {
            item_id: "t4",
            "שם מטלה": "לראות מה קורה עם הביט",
            reminder: {
              reminder_id: "r4",
              fire_at: "2026-11-15 09:00",
              repeat: "none",
            },
          },
        ],
      },
      {
        list_type: "tasks",
        list_name: "",
        owner: "טל",
        scope: "shared",
        shared_with: ["טל", "עמית"],
        items: [
          {
            item_id: "t5",
            "שם מטלה": "פגישה (טל, עמית)",
            חוזר: "ראשון ורביעי ב־21:30",
          },
        ],
      },
    ],
    filing: [],
    reminders: [
      {
        reminder_id: "r1",
        item: "לקנות חלב",
        list_type: "tasks",
        fire_at: "2026-10-16 09:00",
        repeat: "none",
        ping: ["טל"],
        ping_ids: ["e1"],
        owner: "טל",
        text: "",
        last_composed_text: "",
        sent_text: "",
        compose_at_fire: false,
        compose_source: "",
        compose_lookback_hours: 0,
        status: "active",
        send_status: "pending",
        sent: false,
        sent_at: null,
      },
      {
        reminder_id: "r2",
        item: "ישן",
        list_type: "tasks",
        fire_at: "2026-10-10 09:00",
        repeat: "none",
        ping: ["טל"],
        ping_ids: ["e1"],
        owner: "טל",
        text: "",
        last_composed_text: "",
        sent_text: "",
        compose_at_fire: false,
        compose_source: "",
        compose_lookback_hours: 0,
        status: "done",
        send_status: "sent",
        sent: true,
        sent_at: "2026-10-10 09:00",
      },
    ],
  };

  const now = new Date("2026-10-15T10:00:00+03:00");

  it("dumps shopping with quantity (default 1) and unit", () => {
    expect(formatShoppingTitle({ "שם פריט": "אורז", כמות: 2 })).toBe("אורז - 2");
    expect(
      formatShoppingTitle({
        "שם פריט": "עגבניות",
        כמות: 1,
        "יחידת מידה": 'ק"ג',
      }),
    ).toBe('עגבניות - 1 ק"ג');
    expect(formatShoppingTitle({ "שם פריט": "חלב" })).toBe("חלב - 1");
  });

  it("formats relative day labels for near calendar dates", () => {
    expect(formatRelativeDayLabel("2026-10-15", now)).toBe("היום");
    expect(formatRelativeDayLabel("2026-10-16", now)).toBe("מחר");
    expect(formatRelativeDayLabel("2026-10-17", now)).toBe("מחרתיים");
    expect(formatRelativeDayLabel("2026-10-18", now)).toBe("ראשון");
    expect(formatRelativeDayLabel("2026-10-21", now)).toBe("רביעי");
    expect(formatRelativeDayLabel("2026-10-12", now)).toBe("12.10.2026");
    expect(formatRelativeDayLabel("2026-11-15", now)).toBe("15.11.2026");
    expect(formatRelativeFireAt("2026-10-17 09:00", now)).toBe(
      "מחרתיים ב־09:00",
    );
    expect(formatRelativeFireAt("2026-10-18 14:30", now)).toBe("ראשון ב־14:30");
  });

  it("formats schedule and linked reminder like status lines", () => {
    expect(
      formatScheduleSuffix(
        { חוזר: "שני ושלישי ב־19:00" },
        "tasks",
        now,
      ),
    ).toBe("— שני ושלישי ב־19:00 (קבוע)");
    expect(
      formatScheduleSuffix(
        { "תאריך לביצוע": "2026-10-15", "שעה לביצוע": "19:30" },
        "tasks",
        now,
      ),
    ).toBe("— היום ב־19:30");
    expect(
      formatScheduleSuffix(
        { "תאריך לביצוע": "2026-10-16", "שעה לביצוע": "09:00" },
        "tasks",
        now,
      ),
    ).toBe("— מחר ב־09:00");
    expect(
      formatScheduleSuffix(
        { "תאריך לביצוע": "2026-10-17", "שעה לביצוע": "11:00" },
        "tasks",
        now,
      ),
    ).toBe("— מחרתיים ב־11:00");
    expect(
      formatScheduleSuffix(
        { "תאריך לביצוע": "2026-10-18", "שעה לביצוע": "20:00" },
        "tasks",
        now,
      ),
    ).toBe("— ראשון ב־20:00");
    expect(
      formatScheduleSuffix(
        { "תאריך לביצוע": "2026-10-12", "שעה לביצוע": "19:30" },
        "tasks",
        now,
      ),
    ).toBe("— 12.10.2026 ב־19:30");
    expect(
      formatScheduleSuffix(
        { "תאריך לביצוע": "2027-05-08", "שעה לביצוע": "13:00" },
        "tasks",
        now,
      ),
    ).toBe("— 8.5.2027 ב־13:00");
    expect(
      formatLinkedReminderParen(
        { reminder: { fire_at: "2026-10-15 20:30", repeat: "none" } },
        now,
      ),
    ).toBe("(תזכורת: היום ב־20:30)");
    expect(
      formatLinkedReminderParen(
        { reminder: { fire_at: "2026-10-17 09:00", repeat: "none" } },
        now,
      ),
    ).toBe("(תזכורת: מחרתיים ב־09:00)");
    expect(
      formatLinkedReminderParen(
        { reminder: { fire_at: "2026-11-15 09:00", repeat: "none" } },
        now,
      ),
    ).toBe("(תזכורת: 15.11.2026 ב־09:00)");
    expect(
      formatNumberedItem(
        1,
        "ללכת לשוק 🍅",
        { חוזר: "שני ושלישי ב־19:00", attachments: [{ id: "a" }] },
        "tasks",
        { now },
      ),
    ).toBe("1. ללכת לשוק 🍅 📎 — שני ושלישי ב־19:00 (קבוע)");
    expect(
      formatScheduleSuffix(
        {
          חוזר: "כל יומיים ב־15:00",
          reminder: {
            fire_at: "2026-10-15 15:00",
            repeat: "custom",
            recurrence_text: "כל יומיים ב־15:00",
          },
        },
        "tasks",
        now,
      ),
    ).toBe("— כל יומיים ב־15:00 (קבוע + תזכורת)");
    expect(
      formatNumberedItem(
        5,
        "לקחת אקמול",
        {
          חוזר: "כל יומיים ב־15:00",
          reminder: {
            fire_at: "2026-10-15 15:00",
            repeat: "custom",
            recurrence_text: "כל יומיים ב־15:00",
          },
        },
        "tasks",
        { now },
      ),
    ).toBe("5. לקחת אקמול — כל יומיים ב־15:00 (קבוע + תזכורת)");
    expect(
      formatNumberedItem(
        5,
        "לקחת אקמול",
        {
          חוזר: "כל יומיים ב־15:00",
          reminder: {
            fire_at: "2026-10-15 15:00",
            repeat: "custom",
            recurrence_text: "כל יומיים ב־15:00",
          },
        },
        "tasks",
        { now },
      ),
    ).not.toContain("(תזכורת:");
    expect(
      formatNumberedItem(
        2,
        "לבדוק באג",
        { reminder: { fire_at: "2026-10-15 20:30", repeat: "none" } },
        "tasks",
        { now },
      ),
    ).toBe("2. לבדוק באג (תזכורת: היום ב־20:30)");
    expect(
      formatNumberedItem(
        3,
        "להתקשר לאמא",
        {
          reminder: {
            fire_at: "2026-10-15 19:00",
            repeat: "daily",
            recurrence_text: "כל יום ב־19:00",
          },
        },
        "tasks",
        { now },
      ),
    ).toBe("3. להתקשר לאמא (תזכורת: היום ב־19:00 (כל יום))");
  });

  it("formats reminder dump lines like מה התזכורות שלי", () => {
    expect(shortCadenceParen("כל יום ב־19:00")).toBe("(כל יום)");
    expect(shortCadenceParen("כל שנה ב־8 במאי ב־13:00")).toBe("(כל שנה)");
    expect(
      formatReminderWhen(
        {
          fire_at: "2026-10-15 19:00",
          repeat: "daily",
          recurrence_text: "כל יום ב־19:00",
        },
        now,
      ),
    ).toBe("היום ב־19:00 (כל יום)");
    expect(
      formatReminderWhen(
        {
          fire_at: "2026-10-16 09:00",
          repeat: "daily",
          recurrence_text: "כל יום ב־09:00",
        },
        now,
      ),
    ).toBe("מחר ב־09:00 (כל יום)");
    expect(
      formatReminderWhen(
        { fire_at: "2026-10-17 09:00", repeat: "none" },
        now,
      ),
    ).toBe("מחרתיים ב־09:00");
    expect(
      formatReminderWhen(
        { fire_at: "2026-10-18 14:00", repeat: "none" },
        now,
      ),
    ).toBe("ראשון ב־14:00");
    expect(
      formatReminderWhen(
        { fire_at: "2026-11-15 09:00", repeat: "none" },
        now,
      ),
    ).toBe("15.11.2026 ב־09:00");
    expect(
      formatReminderWhen(
        {
          fire_at: "2027-05-08 13:00",
          repeat: "none",
          recurrence_text: "כל שנה ב־8 במאי ב־13:00",
        },
        now,
      ),
    ).toBe("8.5.2027 ב־13:00 (כל שנה)");
  });

  it("partnersKey never keeps the viewer (name or aliases)", () => {
    expect(partnersKey(["טל", "עמית"], "טל")).toBe("עמית");
    expect(partnersKey(["טל", "עמית"], "טלי", ["טל"])).toBe("עמית");
    expect(partnersKey(["טל", "עמית"], "", ["טל"])).toBe("עמית");
    expect(partnersKey(["טל"], "טל")).toBe("משותף");
    expect(partnersKey(["טל"], "", ["טל"])).toBe("משותף");
  });

  it("dumps shopping without soft-deleted rice (not in snapshot)", () => {
    const text = formatShowButtonDump("הצג רשימת קניות", snapshot, {
      viewerName: "טל",
    });
    expect(text).toContain("ספוג אדום - 1");
    expect(text).toContain("קמח מלא - 2");
    expect(text).toContain('עגבניות - 1 ק"ג');
    expect(text).not.toContain("אורז");
    expect(text).toContain("קניות אישיות:");
    expect(text).toContain("קניות משותפות:");
    expect(text).toContain("(עם מיכל)");
    expect(text).not.toContain("(עם טל, מיכל)");
  });

  it("drops viewer from (עם …) via aliases when viewerName mismatches", () => {
    const text = formatShowButtonDump("הצג רשימת קניות", snapshot, {
      viewerName: "טלי",
      viewerAliases: ["טל"],
    });
    expect(text).toContain("(עם מיכל)");
    expect(text).not.toContain("(עם טל");
  });

  it("puts 📎 on list headers only for list-level has_attachments", () => {
    const withListFiles: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          has_attachments: true,
          items: [
            {
              item_id: "1",
              "שם פריט": "חלב",
              attachments: [{ id: "a1" }],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "custom",
          list_name: "בעיות",
          owner: "טל",
          scope: "personal",
          has_attachments: true,
          items: [{ item_id: "c1", בעיה: "דליפה" }],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const shopping = formatShowButtonDump("הצג רשימת קניות", withListFiles, {
      viewerName: "טל",
    });
    expect(shopping).toContain("קניות אישיות 📎:");
    expect(shopping).toContain("חלב - 1 📎");

    const custom = formatShowButtonDump("הצג רשימת בעיות", withListFiles, {
      viewerName: "טל",
    });
    expect(custom).toContain("רשימת «בעיות» 📎:");
    expect(custom).toContain("1. דליפה");
  });

  it("does not put header 📎 when only items have files", () => {
    const itemOnly: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "1",
              "שם פריט": "חלב",
              attachments: [{ id: "a1" }],
            },
          ],
        },
        {
          list_type: "custom",
          list_name: "בעיות",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "c1",
              בעיה: "דליפה",
              attachments: [{ id: "a2" }],
            },
          ],
        },
      ],
      filing: [],
    };
    const shopping = formatShowButtonDump("הצג רשימת קניות", itemOnly, {
      viewerName: "טל",
    });
    expect(shopping).toContain("קניות אישיות:");
    expect(shopping).not.toContain("קניות אישיות 📎:");
    expect(shopping).toContain("חלב - 1 📎");

    const custom = formatShowButtonDump("הצג רשימת בעיות", itemOnly, {
      viewerName: "טל",
    });
    expect(custom).toContain("רשימת «בעיות»:");
    expect(custom).not.toContain("רשימת «בעיות» 📎:");
    expect(custom).toContain("דליפה 📎");
  });

  it("dumps tasks with schedule, reminder, and partners without viewer", () => {
    const text = formatShowButtonDump("הצג רשימת מטלות", snapshot, {
      viewerName: "טל",
      now,
    });
    expect(text).toContain("לבדוק את הבאג הזה (תזכורת: היום ב־20:30)");
    expect(text).toContain("ללכת לשוק 🍅 📎 — שני ושלישי ב־19:00 (קבוע)");
    expect(text).toContain("חתונה של תום 📎 — 12.10.2026 ב־19:30");
    expect(text).toContain(
      "לראות מה קורה עם הביט (תזכורת: 15.11.2026 ב־09:00)",
    );
    expect(text).toContain("(עם עמית)");
    expect(text).toContain("פגישה (טל, עמית) — ראשון ורביעי ב־21:30 (קבוע)");
  });

  it("show_dump tasks prints linked reminders the same as the button", () => {
    const fromKind = formatShowDumpFromKind("tasks", snapshot, {
      viewerName: "טל",
      now,
    });
    expect(fromKind).toContain("(תזכורת: היום ב־20:30)");
    expect(fromKind).toContain("(תזכורת: 15.11.2026 ב־09:00)");
  });

  it("dumps from show_dump kind the same as the button command", () => {
    const fromKind = formatShowDumpFromKind("tasks", snapshot, {
      viewerName: "טל",
      now,
    });
    const fromButton = formatShowButtonDump("הצג רשימת מטלות", snapshot, {
      viewerName: "טל",
      now,
    });
    expect(fromKind).toBe(fromButton);
    expect(formatShowDumpFromKind("shopping", snapshot, { viewerName: "טל" })).toBe(
      formatShowButtonDump("הצג רשימת קניות", snapshot, { viewerName: "טל" }),
    );
  });

  it("dumps only active reminders with relative when", () => {
    const text = formatShowButtonDump("הצג תזכורות", snapshot, { now });
    expect(text).toContain("1. לקנות חלב — מחר ב־09:00");
    expect(text).not.toContain("ישן");
    expect(text).not.toContain("2026-10-16 09:00");
  });

  it("returns null for free-form asks", () => {
    expect(formatShowButtonDump("מה יש לי לקנות", snapshot)).toBeNull();
  });

  it("does not override for unknown custom / free-form-looking names", () => {
    expect(formatShowButtonDump("הצג רשימת בעיות", snapshot)).toBeNull();
    expect(formatShowButtonDump("הצג רשימת קניות בבקשה", snapshot)).toBeNull();
  });
});
