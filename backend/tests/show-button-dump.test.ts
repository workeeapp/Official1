import { describe, expect, it } from "vitest";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import {
  composeTasksDumpWithWaiting,
  excludeItemIdsFromSnapshot,
  formatCustomItemBody,
  formatFilingDumpBody,
  formatLinkedReminderParen,
  formatNumberedItem,
  formatRelativeDayLabel,
  formatRelativeFireAt,
  formatReminderWhen,
  formatScheduleSuffix,
  formatShoppingTitle,
  formatShowDumpFromKind,
  isEmptyListDump,
  isKnownShowButtonCommand,
  isTasksShowDumpKind,
  itemMatchesDateRange,
  mapShowButtonCommandToDump,
  navigateAddressFromFilingsDump,
  partnerBucketMatches,
  partnersKey,
  shortCadenceParen,
  titleAlreadyListsPartners,
} from "../src/services/show-button-dump.js";
import {
  formatWhatsAppReplyContext,
  stripWhatsAppReplyPrefix,
} from "../src/services/whatsapp-outbound-memory.js";

describe("closed show button allowlist", () => {
  it("maps exact builtin button strings only — not free-form or suffixes", () => {
    expect(mapShowButtonCommandToDump("הצג רשימת קניות")).toBe("shopping");
    expect(mapShowButtonCommandToDump("הצג תזכורות")).toBe("reminders");
    expect(mapShowButtonCommandToDump("הצג תיוקים")).toBe("filings");
    expect(mapShowButtonCommandToDump("הצג רשימת מטלות")).toBe("tasks");
    expect(mapShowButtonCommandToDump("הצג רשימת אנשי קשר")).toBe("contacts");
    expect(mapShowButtonCommandToDump("הצג רשימת קניות בבקשה")).toBeNull();
    expect(mapShowButtonCommandToDump("הצג רשימת קניות אישית")).toBeNull();
    expect(mapShowButtonCommandToDump("מה יש לי לקנות")).toBeNull();
    expect(mapShowButtonCommandToDump("הציגי את רשימת הקניות")).toBeNull();
    expect(isKnownShowButtonCommand("הצג רשימת קניות")).toBe(true);
    expect(isKnownShowButtonCommand("הצג רשימת קניות אישית")).toBe(false);
  });

  it("maps custom list buttons only by exact equality to a live list_name", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "custom",
          list_name: "משימות לעבודה",
          owner: "טל",
          scope: "personal",
          items: [],
        },
      ],
      filing: [],
    };
    expect(mapShowButtonCommandToDump("הצג רשימת משימות לעבודה", snap)).toBe(
      "משימות לעבודה",
    );
    expect(mapShowButtonCommandToDump("הצג רשימת משימות לעבודה")).toBeNull();
    expect(
      mapShowButtonCommandToDump("הצג רשימת משימות לעבודה בבקשה", snap),
    ).toBeNull();
  });

  it("strips WhatsApp reply prefix before allowlist equality", () => {
    const wrapped = formatWhatsAppReplyContext(
      "מחקתי את האורז מרשימת הקניות.",
      "הצג רשימת קניות",
    );
    expect(stripWhatsAppReplyPrefix(wrapped)).toBe("הצג רשימת קניות");
    expect(
      isKnownShowButtonCommand(stripWhatsAppReplyPrefix(wrapped)),
    ).toBe(true);
  });
});

describe("formatFilingDumpBody", () => {
  it("labels item_info as תיאור and omits item_description", () => {
    expect(
      formatFilingDumpBody({
        filing_id: "f1",
        item_name: "כתובת מרב",
        item_info: "יערה אבן יהודה",
        item_description: "כתובת מרב",
        owner: "טל",
        scope: "personal",
      }),
    ).toBe("שם: כתובת מרב · תיאור: יערה אבן יהודה");
    expect(
      formatFilingDumpBody({
        filing_id: "f2",
        item_name: "שרון וטרינרית",
        item_info: "",
        item_description: "שרון וטרינרית",
        owner: "טל",
        scope: "personal",
      }),
    ).toBe("שם: שרון וטרינרית");
  });
});

describe("filings two-section dump", () => {
  it("splits personal vs shared with (עם) marks — no של X", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "f1",
          item_name: "רישיון",
          item_info: "בתוקף",
          item_description: "רישיון",
          owner: "טל",
          scope: "personal",
        },
        {
          filing_id: "f2",
          item_name: "קוד שער",
          item_info: "1234",
          item_description: "קוד שער",
          owner: "טל",
          scope: "shared",
          shared_with: ["טל", "מיכל"],
        },
      ],
    };
    const dump = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
    });
    expect(dump).toContain("תיוקים אישיים:");
    expect(dump).toContain("1. שם: רישיון · תיאור: בתוקף");
    expect(dump).not.toContain("מידע:");
    expect(dump).toContain("תיוקים משותפים:");
    expect(dump).toContain("1. שם: קוד שער · תיאור: 1234 (עם מיכל)");
    expect(dump).not.toContain("(עם טל)");
    expect(dump).not.toContain("של ");
  });

  it("treats scope=shared with no non-viewer partners as personal", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "f-empty",
          item_name: "לשון פנייה",
          item_info: "זכר",
          item_description: "",
          owner: "טל",
          scope: "shared",
        },
        {
          filing_id: "f-self",
          item_name: "כתובת",
          item_info: "רחוב שחם",
          item_description: "",
          owner: "טל",
          scope: "shared",
          shared_with: ["טל"],
        },
      ],
    };
    const dump = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
    })!;
    expect(dump).toContain("תיוקים אישיים:");
    expect(dump).toContain("שם: לשון פנייה · תיאור: זכר");
    expect(dump).toContain("שם: כתובת · תיאור: רחוב שחם");
    expect(dump).not.toContain("(עם ");
    expect(dump).not.toContain("תיוקים משותפים:");
  });

  it("omits empty shared filings section unless section=shared", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "f1",
          item_name: "רישיון",
          item_info: "בתוקף",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
      ],
    };
    const full = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
    })!;
    expect(full).toContain("תיוקים אישיים:");
    expect(full).toContain("רישיון");
    expect(full).not.toContain("תיוקים משותפים:");

    const sharedOnly = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
      section: "shared",
    })!;
    expect(sharedOnly).toBe("תיוקים משותפים ריקה.");
    expect(sharedOnly).not.toContain("תיוקים אישיים:");
    expect(sharedOnly).not.toMatch(/תיוקים משותפים:\s*\nריקה/);
  });

  it("never marks filing partners as the viewer even if shared_with still lists them", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "f1",
          item_name: "ת.ז",
          item_info: "",
          item_description: "ת.ז",
          owner: "מיכל",
          scope: "shared",
          shared_with: ["מיכל", "טל"],
        },
      ],
    };
    const asTal = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
      viewerAliases: ["טל"],
    })!;
    expect(asTal).toContain("תיוקים משותפים:");
    expect(asTal).toContain("(עם מיכל)");
    expect(asTal).not.toContain("(עם טל)");

    const asMichal = formatShowDumpFromKind("filings", snap, {
      viewerName: "מיכל",
      viewerAliases: ["מיכל"],
    })!;
    expect(asMichal).toContain("(עם טל)");
    expect(asMichal).not.toMatch(/\(עם מיכל\)/);
  });

  it("sets navigate address only when exactly one address-bearing filing is shown", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "a1",
          item_name: "כתובת מרב",
          item_info: "יערה אבן יהודה",
          item_description: "כתובת",
          owner: "טל",
          scope: "personal",
        },
        {
          filing_id: "f1",
          item_name: "רישיון",
          item_info: "בתוקף",
          item_description: "רישיון",
          owner: "טל",
          scope: "personal",
        },
      ],
    };
    expect(navigateAddressFromFilingsDump(snap.filing, { viewerName: "טל" })).toBe(
      "יערה אבן יהודה",
    );

    const twoAddresses: EmployeeRecordSnapshot["filing"] = [
      ...snap.filing,
      {
        filing_id: "a2",
        item_name: "כתובת עבודה",
        item_info: "הרצל 1 תל אביב",
        item_description: "",
        owner: "טל",
        scope: "personal",
      },
    ];
    expect(
      navigateAddressFromFilingsDump(twoAddresses, { viewerName: "טל" }),
    ).toBeNull();
  });
});

describe("formatShowDumpFromKind", () => {
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
      formatScheduleSuffix(
        {
          חוזר: "כל יום ראשון ב־21:00",
          exceptions: ["18.10 ב־21:30"],
        },
        "tasks",
        now,
      ),
    ).toBe("— כל יום ראשון ב־21:00 (קבוע) · 18.10 ב־21:30");
    expect(
      formatScheduleSuffix(
        {
          חוזר: "כל יום ראשון ב־21:00",
          exceptions: ["23.10 בוטל"],
        },
        "tasks",
        now,
      ),
    ).toBe("— כל יום ראשון ב־21:00 (קבוע) · 23.10 בוטל");
    expect(
      formatScheduleSuffix(
        {
          חוזר: "כל יום ראשון ב־21:00",
          exceptions: ["18.10 ב־21:30"],
          reminder: {
            fire_at: "2026-10-18 21:30",
            repeat: "custom",
            recurrence_text: "כל יום ראשון ב־20:45",
          },
        },
        "tasks",
        now,
      ),
    ).toBe(
      "— כל יום ראשון ב־21:00 (קבוע + תזכורת ב־20:45) · 18.10 ב־21:30",
    );
    expect(
      formatScheduleSuffix(
        {
          חוזר: "כל יום ראשון ב־21:00",
          reminder: {
            fire_at: "2026-10-18 21:00",
            repeat: "custom",
            recurrence_text: "כל יום ראשון ב־21:00",
          },
        },
        "tasks",
        now,
      ),
    ).toBe("— כל יום ראשון ב־21:00 (קבוע + תזכורת)");
    expect(
      formatNumberedItem(
        6,
        "חוג טיסנים",
        {
          חוזר: "כל יום ראשון ב־21:00",
          exceptions: ["18.10 ב־21:30"],
          reminder: {
            fire_at: "2026-10-18 21:30",
            repeat: "custom",
            recurrence_text: "כל יום ראשון ב־20:45",
          },
        },
        "tasks",
        { now },
      ),
    ).toBe(
      "6. חוג טיסנים — כל יום ראשון ב־21:00 (קבוע + תזכורת ב־20:45) · 18.10 ב־21:30",
    );
    expect(
      formatReminderWhen(
        {
          fire_at: "2026-10-18 20:45",
          repeat: "custom",
          recurrence_text: "כל יום ראשון ב־20:45",
          exceptions: ["18.10 ב־21:30"],
        },
        now,
      ),
    ).toBe("ראשון ב־20:45 (קבוע כל יום ראשון ב־20:45) · 18.10 ב־21:30");
    // Next fire already moved to the exception time — still keep · suffix so series vs one-off stays clear.
    expect(
      formatReminderWhen(
        {
          fire_at: "2026-10-18 21:30",
          repeat: "custom",
          recurrence_text: "כל יום ראשון ב־20:45",
          exceptions: ["18.10 ב־21:30"],
        },
        now,
      ),
    ).toBe("ראשון ב־21:30 (קבוע כל יום ראשון ב־20:45) · 18.10 ב־21:30");
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
    ).toBe("3. להתקשר לאמא (תזכורת: היום ב־19:00 (קבוע כל יום))");
    // Appointment time ≠ ping time: schedule from שעה לביצוע, paren from fire_at.
    expect(
      formatNumberedItem(
        1,
        "לאסוף את מאיה",
        {
          "תאריך לביצוע": "2026-10-16",
          "שעה לביצוע": "15:00",
          reminder: { fire_at: "2026-10-16 14:20", repeat: "none" },
        },
        "tasks",
        { now },
      ),
    ).toBe("1. לאסוף את מאיה — מחר ב־15:00 (תזכורת: מחר ב־14:20)");
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
    ).toBe("היום ב־19:00 (קבוע כל יום)");
    expect(
      formatReminderWhen(
        {
          fire_at: "2026-10-16 09:00",
          repeat: "daily",
          recurrence_text: "כל יום ב־09:00",
        },
        now,
      ),
    ).toBe("מחר ב־09:00 (קבוע כל יום)");
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
    ).toBe("8.5.2027 ב־13:00 (קבוע כל שנה)");
  });

  it("partnersKey never keeps the viewer (name or aliases)", () => {
    expect(partnersKey(["טל", "עמית"], "טל")).toBe("עמית");
    expect(partnersKey(["טל", "עמית"], "טלי", ["טל"])).toBe("עמית");
    expect(partnersKey(["טל", "עמית"], "", ["טל"])).toBe("עמית");
    expect(partnersKey(["טל"], "טל")).toBe("משותף");
    expect(partnersKey(["טל"], "", ["טל"])).toBe("משותף");
  });

  it("dumps shopping without soft-deleted rice (not in snapshot)", () => {
    const text = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טל",
    });
    expect(text).toContain("ספוג אדום - 1");
    expect(text).toContain("קמח מלא - 2");
    expect(text).toContain('עגבניות - 1 ק"ג');
    expect(text).not.toContain("אורז");
    expect(text).toContain("קניות אישיות:");
    expect(text).toContain("קניות משותפות עם מיכל:");
    expect(text).not.toContain("קניות של ");
  });

  it("Stage 2: private under אישיות; share+assign under משותפות עם X; no של X", () => {
    const threeWay: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "p1", "שם פריט": "לחם", כמות: 1 },
            {
              item_id: "a1",
              "שם פריט": "חלב",
              כמות: 1,
              assigned_by: "עמית",
            },
            {
              item_id: "s1",
              "שם פריט": "קפה",
              כמות: 1,
              shared_with: ["טל", "מיכל"],
            },
            {
              item_id: "both",
              "שם פריט": "ביצים",
              כמות: 1,
              assigned_by: "עמית",
              shared_with: ["טל", "עמית", "מיכל"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "shopping",
          list_name: "",
          owner: "מיכל",
          scope: "shared_items",
          items: [{ item_id: "out1", "שם פריט": "שמן", כמות: 1 }],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "tp1", "שם מטלה": "לטפל בעמידר" },
            {
              item_id: "ta1",
              "שם מטלה": "לבדוק שמן",
              assigned_by: "עמית",
            },
            {
              item_id: "ts1",
              "שם מטלה": "פגישה (טל, עמית)",
              shared_with: ["טל", "עמית"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "tasks",
          list_name: "",
          owner: "עמית",
          scope: "shared_items",
          items: [{ item_id: "tout1", "שם מטלה": "לעשות טסט לרכב" }],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };

    const shopping = formatShowDumpFromKind("shopping", threeWay, {
      viewerName: "טל",
    })!;
    expect(shopping).toMatch(/קניות אישיות:[\s\S]*1\. לחם - 1/);
    // Assign: partner = assigner; mark = assignee (טל).
    expect(shopping).toMatch(/קניות משותפות עם עמית:[\s\S]*חלב - 1 \(טל\)/);
    expect(shopping).toMatch(/קניות משותפות עם עמית:[\s\S]*ביצים - 1 \(טל\)/);
    // Co-share: משותפות עם מיכל + (מיכל, טל).
    expect(shopping).toMatch(
      /קניות משותפות עם מיכל:[\s\S]*קפה - 1 \(מיכל, טל\)/,
    );
    // shared_items fold into משותפות עם מיכל + (מיכל).
    expect(shopping).toMatch(/קניות משותפות עם מיכל:[\s\S]*שמן - 1 \(מיכל\)/);
    expect(shopping).not.toContain("קניות של ");
    expect(shopping).not.toContain("(עם ");

    const tasks = formatShowDumpFromKind("tasks", threeWay, {
      viewerName: "טל",
    })!;
    expect(tasks).toMatch(/מטלות אישיות:[\s\S]*לטפל בעמידר/);
    expect(tasks).toMatch(/מטלות משותפות עם עמית:[\s\S]*לבדוק שמן \(טל\)/);
    expect(tasks).toMatch(/מטלות משותפות עם עמית:[\s\S]*פגישה \(טל, עמית\)/);
    expect(tasks).not.toMatch(/פגישה \(טל, עמית\) \(/);
    expect(tasks).toMatch(/מטלות משותפות עם עמית:[\s\S]*לעשות טסט לרכב \(עמית\)/);
    expect(tasks).not.toContain("מטלות של ");
  });

  it("item co-share and scope=shared list both land under משותפות עם X", () => {
    const mixed: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "p1", "שם פריט": "לחם", כמות: 1 },
            {
              item_id: "s1",
              "שם פריט": "מלפפונים",
              כמות: 1,
              shared_with: ["טל", "עמית"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "shared",
          shared_with: ["טל", "מיכל"],
          items: [
            { item_id: "l1", "שם פריט": "קמח מלא", כמות: 1 },
            { item_id: "l2", "שם פריט": "אורז", כמות: 2 },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };

    const text = formatShowDumpFromKind("shopping", mixed, {
      viewerName: "טל",
    })!;
    expect(text).toMatch(/קניות אישיות:\n1\. לחם - 1/);
    expect(text).toMatch(
      /קניות משותפות עם עמית:[\s\S]*מלפפונים - 1 \(עמית, טל\)/,
    );
    expect(text).toMatch(
      /קניות משותפות עם מיכל:[\s\S]*קמח מלא - 1[\s\S]*אורז - 2/,
    );
    const personalOnly = text.split(/קניות משותפות עם/)[0] ?? "";
    expect(personalOnly).toContain("לחם - 1");
    expect(personalOnly).not.toContain("מלפפונים");
    expect(personalOnly).not.toContain("קמח מלא");
  });

  it("partner headers drop viewer via aliases", () => {
    const text = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טלי",
      viewerAliases: ["טל"],
    });
    expect(text).toContain("קניות משותפות עם מיכל:");
    expect(text).not.toContain("משותפות עם טל");
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
    const shopping = formatShowDumpFromKind("shopping", withListFiles, {
      viewerName: "טל",
    });
    expect(shopping).toContain("קניות אישיות 📎:");
    expect(shopping).toContain("חלב - 1 📎");

    const custom = formatShowDumpFromKind("בעיות", withListFiles, {
      viewerName: "טל",
    });
    expect(custom).toContain("רשימת «בעיות» 📎:");
    expect(custom).toContain("1. בעיה: דליפה");
  });

  it("dumps custom list rows with every column labeled", () => {
    expect(
      formatCustomItemBody(
        { שם: "טל", תיאור: "נשוי למיכל" },
        "שם",
        ["שם", "תיאור"],
      ),
    ).toBe("שם: טל · תיאור: נשוי למיכל");
    expect(
      formatCustomItemBody(
        { שם: "טל", תיאור: "נשוי למיכל", עיר: "תל אביב" },
        "שם",
        ["שם", "תיאור", "עיר"],
      ),
    ).toBe("שם: טל · תיאור: נשוי למיכל · עיר: תל אביב");
    expect(formatCustomItemBody({ שם: "טל" }, "שם", ["שם", "תיאור"])).toBe(
      "שם: טל",
    );

    const snapshot: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "custom",
          list_name: "אני ומיכל",
          owner: "טל",
          scope: "shared",
          columns: ["שם", "תיאור"],
          title_field: "שם",
          items: [
            {
              item_id: "1",
              שם: "טל",
              תיאור: "נשוי למיכל",
            },
            {
              item_id: "2",
              שם: "מיכל",
              תיאור: "נשואה לטל",
            },
          ],
        },
      ],
      filing: [],
    };
    const text = formatShowDumpFromKind("אני ומיכל", snapshot, {
      viewerName: "טל",
    });
    expect(text).toContain("רשימת «אני ומיכל»:");
    expect(text).toContain("1. שם: טל · תיאור: נשוי למיכל");
    expect(text).toContain("2. שם: מיכל · תיאור: נשואה לטל");
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
    const shopping = formatShowDumpFromKind("shopping", itemOnly, {
      viewerName: "טל",
    });
    expect(shopping).toContain("קניות אישיות:");
    expect(shopping).not.toContain("קניות אישיות 📎:");
    expect(shopping).toContain("חלב - 1 📎");

    const custom = formatShowDumpFromKind("בעיות", itemOnly, {
      viewerName: "טל",
    });
    expect(custom).toContain("רשימת «בעיות»:");
    expect(custom).not.toContain("רשימת «בעיות» 📎:");
    expect(custom).toContain("דליפה 📎");
  });

  it("dumps tasks with schedule, reminder, and partners without viewer", () => {
    const text = formatShowDumpFromKind("tasks", snapshot, {
      viewerName: "טל",
      now,
    });
    expect(text).toContain("לבדוק את הבאג הזה (תזכורת: היום ב־20:30)");
    expect(text).toContain("ללכת לשוק 🍅 📎 — שני ושלישי ב־19:00 (קבוע)");
    expect(text).toContain("חתונה של תום 📎 — 12.10.2026 ב־19:30");
    expect(text).toContain(
      "לראות מה קורה עם הביט (תזכורת: 15.11.2026 ב־09:00)",
    );
    expect(text).toContain("מטלות משותפות עם עמית:");
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
    const fromButton = formatShowDumpFromKind("tasks", snapshot, {
      viewerName: "טל",
      now,
    });
    expect(fromKind).toBe(fromButton);
    expect(formatShowDumpFromKind("shopping", snapshot, { viewerName: "טל" })).toBe(
      formatShowDumpFromKind("shopping", snapshot, { viewerName: "טל" }),
    );
  });

  it("dumps only active reminders with relative when", () => {
    const text = formatShowDumpFromKind("reminders", snapshot, { now });
    expect(text).toContain("1. לקנות חלב — מחר ב־09:00");
    expect(text).not.toContain("ישן");
    expect(text).not.toContain("2026-10-16 09:00");
  });

  it("does not override for unknown custom names", () => {
    expect(formatShowDumpFromKind("בעיות", snapshot)).toBeNull();
    expect(formatShowDumpFromKind("קניות אישית", snapshot)).toBeNull();
  });

  it("titleAlreadyListsPartners detects meeting-style titles", () => {
    expect(titleAlreadyListsPartners("פגישה (טל, עמית)", "עמית")).toBe(true);
    expect(titleAlreadyListsPartners("פגישה (טל, מיכל)", "מיכל")).toBe(true);
    expect(titleAlreadyListsPartners("קפה", "מיכל")).toBe(false);
    expect(titleAlreadyListsPartners("פגישה", "עמית")).toBe(false);
    expect(
      titleAlreadyListsPartners("פגישת עבודה (עמית, ערן)", "עמית, ערן"),
    ).toBe(true);
  });

  it("section=personal dumps only אישיות", () => {
    const personal = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טל",
      section: "personal",
    });
    const full = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טל",
    });
    expect(personal).toContain("קניות אישיות:");
    expect(personal).not.toContain("קניות משותפות עם");
    expect(full).toContain("קניות משותפות עם מיכל:");
    expect(personal).not.toBe(full);
  });

  it("section=shared dumps only משותפות עם X; partner filters the bucket", () => {
    const shared = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טל",
      section: "shared",
    });
    expect(shared).toContain("קניות משותפות עם מיכל:");
    expect(shared).not.toContain("קניות אישיות:");

    const onlyMichal = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טל",
      section: "shared",
      partner: "מיכל",
    });
    expect(onlyMichal).toContain("קניות משותפות עם מיכל:");
    expect(onlyMichal).not.toContain("קניות אישיות:");

    const missing = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טל",
      section: "shared",
      partner: "ערן",
    });
    expect(missing).toContain("אין קניות משותפות עם ערן");
    expect(missing).not.toContain("קניות משותפות עם מיכל");
  });

  it("assignee filter keeps sole-responsibility marks only", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "a1",
              "שם מטלה": "חלב עליי",
              assigned_by: "מיכל",
            },
            {
              item_id: "s1",
              "שם מטלה": "קפה משותף",
              shared_with: ["טל", "מיכל"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "tasks",
          list_name: "",
          owner: "מיכל",
          scope: "shared_items",
          items: [{ item_id: "out1", "שם מטלה": "שמן למיכל" }],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const mine = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      section: "shared",
      partner: "מיכל",
      assignee: "self",
      assigneeSelfNames: ["טל"],
    })!;
    expect(mine).toContain("חלב עליי (טל)");
    expect(mine).not.toContain("קפה משותף");
    expect(mine).not.toContain("שמן למיכל");

    const hers = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      section: "shared",
      partner: "מיכל",
      assignee: "מיכל",
      assigneeSelfNames: ["טל"],
    })!;
    expect(hers).toContain("שמן למיכל (מיכל)");
    expect(hers).not.toContain("חלב עליי");
    expect(hers).not.toContain("קפה משותף");
  });

  it("partnerBucketMatches matches exact partner segments", () => {
    expect(partnerBucketMatches("מיכל", "מיכל")).toBe(true);
    expect(partnerBucketMatches("מיכל, עמית", "מיכל")).toBe(true);
    expect(partnerBucketMatches("מיכל, עמית", "ערן")).toBe(false);
  });

  it("assignee and partner arrays OR within field and AND with dates", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "t1",
              "שם מטלה": "עליי בטווח",
              "תאריך לביצוע": "2026-10-18",
              assigned_by: "מיכל",
            },
            {
              item_id: "t2",
              "שם מטלה": "על מיכל בטווח",
              "תאריך לביצוע": "2026-10-19",
            },
            {
              item_id: "t3",
              "שם מטלה": "עליי מחוץ",
              "תאריך לביצוע": "2026-10-25",
              assigned_by: "מיכל",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "tasks",
          list_name: "",
          owner: "מיכל",
          scope: "shared_items",
          items: [
            {
              item_id: "out1",
              "שם מטלה": "שמן למיכל בטווח",
              "תאריך לביצוע": "2026-10-18",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "shared",
          shared_with: ["טל", "עמית"],
          items: [
            {
              item_id: "s1",
              "שם מטלה": "עם עמית",
              "תאריך לביצוע": "2026-10-18",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };

    const withAssignee = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      section: "shared",
      partner: ["מיכל", "עמית"],
      assignee: ["self", "מיכל"],
      assigneeSelfNames: ["טל"],
      dateFrom: "2026-10-17",
      dateTo: "2026-10-20",
    })!;
    // AND across fields: partner OR ∩ assignee OR ∩ dates — day-agenda layout.
    expect(withAssignee).toContain("עליי בטווח");
    expect(withAssignee).toContain("שמן למיכל בטווח");
    expect(withAssignee).not.toContain("עליי מחוץ");
    // Whole shared list row has no sole assignee mark → dropped when assignee set.
    expect(withAssignee).not.toContain("עם עמית");
    expect(withAssignee).not.toContain("על מיכל בטווח");
    expect(withAssignee).toMatch(/\d+\.\d+:/);

    const partnerOnly = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      section: "shared",
      partner: ["מיכל", "עמית"],
      dateFrom: "2026-10-17",
      dateTo: "2026-10-20",
    })!;
    expect(partnerOnly).toContain("עם עמית");
    expect(partnerOnly).toContain("עליי בטווח");
    expect(partnerOnly).toContain("שמן למיכל בטווח");
  });

  it("date range composes with partner/assignee on tasks; ignored for shopping", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "t1",
              "שם מטלה": "פגישה בטווח",
              "תאריך לביצוע": "2026-10-18",
              assigned_by: "מיכל",
            },
            {
              item_id: "t2",
              "שם מטלה": "מחוץ לטווח",
              "תאריך לביצוע": "2026-10-25",
              assigned_by: "מיכל",
            },
            {
              item_id: "t3",
              "שם מטלה": "חוזרת",
              חוזר: "כל יום שני",
              next_occurrences: ["2026-10-19 09:00", "2026-10-26 09:00"],
              assigned_by: "מיכל",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "s1", "שם פריט": "חלב", "תאריך לביצוע": "2026-10-25" },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };

    const tasks = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      section: "shared",
      partner: "מיכל",
      assignee: "self",
      assigneeSelfNames: ["טל"],
      dateFrom: "2026-10-17",
      dateTo: "2026-10-20",
    })!;
    expect(tasks).toContain("פגישה בטווח");
    expect(tasks).toContain("חוזרת");
    expect(tasks).not.toContain("מחוץ לטווח");
    // Standing occurrence under day header — chore HM + (קבוע), not full series alone.
    expect(tasks).toContain("— 09:00 (קבוע)");
    expect(tasks).toContain("מה־17 עד 20.10:");

    const shopping = formatShowDumpFromKind("shopping", snap, {
      viewerName: "טל",
      dateFrom: "2026-10-17",
      dateTo: "2026-10-20",
    })!;
    expect(shopping).toContain("חלב");

    expect(
      itemMatchesDateRange(
        { "תאריך לביצוע": "2026-10-18", "תאריך סיום": "2026-10-22" },
        "2026-10-20",
        "2026-10-21",
      ),
    ).toBe(true);
  });

  it("reminders dump filters by fire_at date range", () => {
    const baseReminder = {
      list_type: "tasks",
      ping: ["טל"],
      ping_ids: ["e1"],
      owner: "טל",
      text: "",
      last_composed_text: "",
      sent_text: "",
      compose_at_fire: false,
      compose_source: "",
      compose_lookback_hours: 0,
      send_status: "pending" as const,
      sent: false,
      sent_at: null,
    };
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [],
      reminders: [
        {
          ...baseReminder,
          reminder_id: "r1",
          item: "בטווח",
          fire_at: "2026-10-18 09:00",
          status: "active",
          repeat: "once",
        },
        {
          ...baseReminder,
          reminder_id: "r2",
          item: "מחוץ",
          fire_at: "2026-10-25 09:00",
          status: "active",
          repeat: "once",
        },
      ],
    };
    const text = formatShowDumpFromKind("reminders", snap, {
      now: new Date("2026-10-16T07:00:00.000Z"),
      dateFrom: "2026-10-17",
      dateTo: "2026-10-20",
    })!;
    expect(text).toContain("בטווח");
    expect(text).not.toContain("מחוץ");
  });

  it("show_dump=full: item co-share with Michal → קניות משותפות עם מיכל count ≥ 1", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "p1", "שם פריט": "לחם", כמות: 1 },
            {
              item_id: "s1",
              "שם פריט": "קפה",
              כמות: 1,
              shared_with: ["מיכל"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [{ item_id: "t1", "שם מטלה": "לטפל בעמידר" }],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [],
    };

    const text = formatShowDumpFromKind("full", snap, {
      viewerName: "טל",
      phoneBook: [{ name: "דני", phone: "0501234567" }],
    })!;

    // Shopping counts only — Stage 2: co-share under משותפות עם מיכל.
    expect(text).toMatch(/קניות אישיות: 1 פריט/);
    expect(text).toMatch(/קניות משותפות עם מיכל: 1 פריט/);
    expect(text).not.toMatch(/קניות משותפות:\s*ריקה/);
    expect(text).not.toContain("קפה"); // counts only — no item titles
    expect(text).not.toContain("לחם");

    // Tasks still enumerate.
    expect(text).toMatch(/מטלות אישיות:[\s\S]*לטפל בעמידר/);

    // Empty categories omitted (no ריק/ריקה headers).
    expect(text).not.toContain("רשימות אחרות:");
    expect(text).not.toContain("תזכורות פעילות:");
    expect(text).not.toContain("תיוקים אישיים:");
    expect(text).not.toContain("תיוקים משותפים:");
    expect(text).not.toContain("אנשי קשר אישיים:");
    expect(text).not.toContain("אנשי קשר משותפים:");
    expect(text).not.toMatch(/מטלות משותפות:\s*ריקה/);
    expect(text).not.toMatch(/ריק/);
    expect(text).toContain("ספר הטלפונים אישי:");
    expect(text).toContain("דני — 0501234567");
    expect(text).toContain("לפירוט רשימה: הצג רשימת …");
  });

  it("contacts: omits empty shared unless section=shared", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "contacts",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "c1",
              "שם פרטי": "דני",
              scope: "personal",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const full = formatShowDumpFromKind("contacts", snap, {
      viewerName: "טל",
    })!;
    expect(full).toContain("אנשי קשר אישיים:");
    expect(full).toContain("דני");
    expect(full).not.toContain("אנשי קשר משותפים:");

    const sharedOnly = formatShowDumpFromKind("contacts", snap, {
      viewerName: "טל",
      section: "shared",
    })!;
    expect(sharedOnly).toBe("אנשי קשר משותפים ריקה.");
    expect(sharedOnly).not.toContain("אנשי קשר אישיים:");
    expect(sharedOnly).not.toMatch(/אנשי קשר משותפים:\s*\nריקה/);
  });

  it("shopping countsOnly: omits empty משותפות unless section=shared", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [{ item_id: "p1", "שם פריט": "לחם", כמות: 1 }],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const counts = formatShowDumpFromKind("shopping", snap, {
      viewerName: "טל",
      countsOnly: true,
    })!;
    expect(counts).toMatch(/קניות אישיות: 1 פריט/);
    expect(counts).not.toContain("משותפות");

    const sharedCounts = formatShowDumpFromKind("shopping", snap, {
      viewerName: "טל",
      countsOnly: true,
      section: "shared",
    })!;
    expect(sharedCounts).toBe("קניות משותפות ריקה.");
    expect(sharedCounts).not.toMatch(/קניות משותפות:\s*ריקה/);
  });

  it("full dump omits empty sections; all-empty → one sentence", () => {
    const empty = formatShowDumpFromKind(
      "full",
      { lists: [], filing: [], reminders: [] },
      { viewerName: "טל" },
    )!;
    expect(empty).toBe("אין לך מידע שמור כרגע.");
    expect(empty).not.toMatch(/ריק/);

    const partnerEmpty = formatShowDumpFromKind(
      "full",
      { lists: [], filing: [], reminders: [] },
      { viewerName: "טל", section: "shared", partner: "עמית" },
    )!;
    expect(partnerEmpty).toBe("אין לך מידע משותף עם עמית כרגע.");
    expect(partnerEmpty).not.toContain("קניות");
    expect(partnerEmpty).not.toContain("תזכורות");
  });
});

describe("worker inventory tasks dump helpers", () => {
  it("recognizes tasks show_dump kinds", () => {
    expect(isTasksShowDumpKind("tasks")).toBe(true);
    expect(isTasksShowDumpKind("מטלות")).toBe(true);
    expect(isTasksShowDumpKind("shopping")).toBe(false);
    expect(isTasksShowDumpKind("full")).toBe(false);
  });

  it("excludes OPEN_JOBS shadow item_ids then dumps remaining tasks", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "לוסי",
          scope: "personal",
          items: [
            { item_id: "job-shadow", "שם מטלה": "לבדוק עם ערן: אם קנית חלב?" },
            { item_id: "standing", "שם מטלה": "להזכיר לטל לקנות חלב" },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const filtered = excludeItemIdsFromSnapshot(snap, new Set(["job-shadow"]));
    const text = formatShowDumpFromKind("tasks", filtered, {
      viewerName: "לוסי",
    })!;
    expect(text).toContain("להזכיר לטל לקנות חלב");
    expect(text).not.toContain("לבדוק עם ערן");
  });

  it("stitches ממתינים after tasks and omits empty tasks sentence when waiting", () => {
    expect(isEmptyListDump("אין מטלות שמורות.")).toBe(true);
    expect(
      composeTasksDumpWithWaiting("אין מטלות שמורות.", "ממתינים לתשובה:\n1. א"),
    ).toBe("ממתינים לתשובה:\n1. א");
    expect(
      composeTasksDumpWithWaiting(
        "מטלות אישיות:\n1. להזכיר לטל",
        "ממתינים לתשובה:\n1. א",
      ),
    ).toBe("מטלות אישיות:\n1. להזכיר לטל\n\nממתינים לתשובה:\n1. א");
    expect(
      composeTasksDumpWithWaiting("מטלות אישיות:\n1. להזכיר לטל", ""),
    ).toBe("מטלות אישיות:\n1. להזכיר לטל");
  });

  it("filters tasks by urgency", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "1", "שם מטלה": "רגיל" },
            { item_id: "2", "שם מטלה": "דחוף", urgency: "urgent" },
            { item_id: "3", "שם מטלה": "ממש דחוף", urgency: "very_urgent" },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const urgent = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      urgency: "urgent",
    })!;
    expect(urgent).toContain("דחוף");
    expect(urgent).toContain("ממש דחוף");
    expect(urgent).not.toContain("רגיל");
    const very = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      urgency: "very_urgent",
    })!;
    expect(very).toContain("ממש דחוף");
    expect(very).not.toContain("1. דחוף");
  });

  it("dumps phone_book from opts.phoneBook", () => {
    expect(isTasksShowDumpKind("phone_book")).toBe(false);
    const text = formatShowDumpFromKind("phone_book", { lists: [], filing: [] }, {
      phoneBook: [{ name: "דני", phone: "050" }],
    })!;
    expect(text).toContain("ספר הטלפונים אישי:");
    expect(text).toContain("1. דני — 050");
  });

  it("flatLayout dumps digital-worker tasks without משותפות/assignee marks", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "לוסי",
          scope: "personal",
          items: [
            {
              item_id: "1",
              "שם מטלה": "להזכיר לטל לבדוק את הביט",
              assigned_by: "טל",
              reminder: {
                reminder_id: "r1",
                fire_at: "2026-11-15T18:00:00.000Z",
                repeat: "once",
              },
            },
            {
              item_id: "2",
              "שם מטלה": "לשלוח למיכל ברכת בוקר",
              "שעה לביצוע": "09:00",
              assigned_by: "טל",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const text = formatShowDumpFromKind("tasks", snap, {
      viewerName: "לוסי",
      flatLayout: true,
      now: new Date("2026-10-17T10:00:00.000Z"),
    })!;
    expect(text).toContain("מטלות:");
    expect(text).not.toContain("משותפות");
    expect(text).not.toContain("אישיות");
    expect(text).not.toContain("(לוסי)");
    expect(text).toContain("להזכיר לטל לבדוק את הביט");
    expect(text).toMatch(/תזכורת:/);
    expect(text).toContain("לשלוח למיכל ברכת בוקר");
  });

  it("full dump with partner filters reminders, contacts, phone book like filings", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "p", "שם מטלה": "פרטי" },
            {
              item_id: "meet",
              "שם מטלה": "פגישה (טל, עמית)",
              shared_with: ["טל", "עמית"],
              scope: "shared",
              reminder: {
                reminder_id: "rem-meet",
                fire_at: "2026-10-20T18:30:00.000Z",
                repeat: "once",
              },
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "custom",
          list_name: "באגים",
          owner: "טל",
          scope: "shared",
          shared_with: ["עמית"],
          items: [{ item_id: "c1", שם: "a" }],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "custom",
          list_name: "פרטי",
          owner: "טל",
          scope: "personal",
          items: [{ item_id: "c2", שם: "b" }],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "contacts",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "ct-personal",
              "שם פרטי": "דני",
            },
            {
              item_id: "ct-shared",
              "שם פרטי": "נועה",
              scope: "shared",
              shared_with: ["טל", "עמית"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [
        {
          reminder_id: "rem-michal",
          item: "לשלוח למיכל ברכת בוקר",
          list_type: "tasks",
          fire_at: "2026-10-17T06:00:00.000Z",
          repeat: "daily",
          ping: ["מיכל"],
          ping_ids: [],
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
          reminder_id: "rem-meet",
          item: "פגישה עם עמית",
          list_type: "tasks",
          fire_at: "2026-10-20T18:30:00.000Z",
          repeat: "once",
          ping: ["טל"],
          ping_ids: [],
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
          reminder_id: "rem-ping-amit",
          item: "לשאול את עמית",
          list_type: "tasks",
          fire_at: "2026-10-18T10:00:00.000Z",
          repeat: "once",
          ping: ["עמית"],
          ping_ids: [],
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
      ],
    };
    const text = formatShowDumpFromKind("full", snap, {
      viewerName: "טל",
      section: "shared",
      partner: "עמית",
      phoneBook: [
        { name: "דני", phone: "050", scope: "personal" },
        {
          name: "שרה",
          phone: "052",
          scope: "shared",
          shared_with: ["טל", "עמית"],
        },
      ],
    })!;
    expect(text).toContain("*באגים*");
    expect(text).not.toContain("*פרטי* —");
    expect(text).not.toContain("לשלוח למיכל ברכת בוקר");
    expect(text).toContain("לשאול את עמית");
    // Linked rem-meet is folded into the task line — not a second תזכורות row.
    expect(text).toContain("פגישה (טל, עמית)");
    expect(text).toMatch(/תזכורת:/);
    expect(text).not.toContain("פגישה עם עמית");
    expect(text).toContain("נועה");
    expect(text).not.toMatch(/אנשי קשר אישיים:[\s\S]*דני/);
    expect(text).toContain("שרה");
    expect(text).toContain("ספר הטלפונים משותף");
    expect(text).not.toMatch(/ספר הטלפונים אישי:[\s\S]*דני/);
  });
});

describe("uniform standing + ping dump lines", () => {
  const now = new Date("2026-10-17T07:00:00.000Z");

  const standingSkazi = {
    item_id: "skazi-am",
    "שם מטלה": "להוריד את סקאזי לטיול",
    חוזר: "כל יום ב־08:45",
    next_occurrences: [
      "2026-10-18 08:45",
      "2026-10-19 08:45",
      "2026-10-20 08:45",
    ],
    reminder: {
      reminder_id: "r-skazi-am",
      fire_at: "2026-10-18 08:30",
      repeat: "custom",
      recurrence_text: "כל יום ב־08:30",
    },
  };

  it("list dump folds chore≠ping into one line via shared mark", () => {
    expect(
      formatNumberedItem(1, "להוריד את סקאזי לטיול", standingSkazi, "tasks", {
        now,
      }),
    ).toBe(
      "1. להוריד את סקאזי לטיול — כל יום ב־08:45 (קבוע + תזכורת ב־08:30)",
    );
    expect(
      formatScheduleSuffix(
        {
          חוזר: "כל יום ב־18:15",
          reminder: {
            fire_at: "2026-10-18 18:15",
            repeat: "custom",
            recurrence_text: "כל יום ב־18:15",
          },
        },
        "tasks",
        now,
      ),
    ).toBe("— כל יום ב־18:15 (קבוע + תזכורת)");
  });

  it("day-agenda uses same fold mark; excludes linked clock as its own line", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            standingSkazi,
            {
              item_id: "meet",
              "שם מטלה": "פגישה (טל, עמית)",
              חוזר: "כל ראשון ורביעי ב־21:30",
              next_occurrences: ["2026-10-18 21:30", "2026-10-21 21:30"],
            },
            {
              item_id: "doc",
              "שם מטלה": "ללכת לרופא",
              "תאריך לביצוע": "2026-10-18",
              "שעה לביצוע": "08:00",
              reminder: {
                reminder_id: "r-doc",
                fire_at: "2026-10-18 07:30",
                repeat: "once",
              },
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [
        {
          reminder_id: "r-skazi-am",
          item: "להוריד את סקאזי לטיול",
          list_type: "tasks",
          fire_at: "2026-10-18 08:30",
          repeat: "custom",
          recurrence_text: "כל יום ב־08:30",
          next_occurrences: ["2026-10-18 08:30", "2026-10-19 08:30"],
          ping: ["טל"],
          ping_ids: [],
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
          reminder_id: "r-michal-morning",
          item: "לשלוח למיכל ברכת בוקר",
          list_type: "tasks",
          fire_at: "2026-10-18 09:00",
          repeat: "custom",
          recurrence_text: "כל יום ב־09:00",
          next_occurrences: ["2026-10-18 09:00", "2026-10-19 09:00"],
          ping: ["טל"],
          ping_ids: [],
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
          reminder_id: "r-doc",
          item: "ללכת לרופא",
          list_type: "tasks",
          fire_at: "2026-10-18 07:30",
          repeat: "once",
          ping: ["טל"],
          ping_ids: [],
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
      ],
    };

    const agenda = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      now,
      dateFrom: "2026-10-18",
      dateTo: "2026-10-18",
    })!;

    expect(agenda).toContain("ראשון 18.10:");
    expect(agenda).toContain(
      "להוריד את סקאזי לטיול — 08:45 (קבוע + תזכורת ב־08:30)",
    );
    expect(agenda).toContain("לשלוח למיכל ברכת בוקר — 09:00 (קבוע כל יום)");
    expect(agenda).toContain("פגישה (טל, עמית) — 21:30 (קבוע)");
    expect(agenda).toContain("ללכת לרופא — 08:00");
    expect(agenda).toContain("(תזכורת:");
    // Linked clocks must not appear as their own numbered rows.
    expect(agenda).not.toMatch(/\d+\. להוריד את סקאזי לטיול — 08:30/);
    expect(agenda).not.toMatch(/\d+\. ללכת לרופא — 07:30/);

    const list = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      now,
    })!;
    expect(list).toContain(
      "להוריד את סקאזי לטיול — כל יום ב־08:45 (קבוע + תזכורת ב־08:30)",
    );

    const remOnly = formatShowDumpFromKind("reminders", snap, {
      now,
      dateFrom: "2026-10-18",
      dateTo: "2026-10-18",
    })!;
    // Bare reminders dump may still list linked clocks.
    expect(remOnly).toContain("להוריד את סקאזי לטיול");
    expect(remOnly).toContain("קבוע כל יום");
  });

  it("multi-day window header + standing occurrence per day", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [standingSkazi],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [],
    };
    const text = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      now,
      dateFrom: "2026-10-18",
      dateTo: "2026-10-20",
    })!;
    expect(text).toContain("מה־18 עד 20.10:");
    expect(text).toContain("ראשון 18.10:");
    expect(text).toContain("שני 19.10:");
    expect(text).toContain("שלישי 20.10:");
    expect(text.match(/להוריד את סקאזי לטיול — 08:45 \(קבוע \+ תזכורת ב־08:30\)/g)?.length).toBe(3);
  });

  it("reminder cadence paren is always קבוע-family", () => {
    expect(
      formatReminderWhen(
        {
          fire_at: "2026-10-18 09:00",
          repeat: "daily",
          recurrence_text: "כל יום ב־09:00",
        },
        now,
      ),
    ).toBe("מחר ב־09:00 (קבוע כל יום)");
    expect(shortCadenceParen("כל יום ב־09:00")).toBe("(כל יום)");
  });
});

describe("partner dump about_ids (birthday event)", () => {
  const now = new Date("2026-10-17T07:00:00.000Z");

  it("עם עמית includes personal all-day birthday task via reminder.about", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "bday",
              "שם מטלה": "יום ההולדת של עמית",
              "יום שלם": true,
              חוזר: "כל שנה ב־13.10",
              next_occurrences: ["2027-10-13"],
              reminder: {
                reminder_id: "r-bday",
                fire_at: "2027-10-13 09:00",
                repeat: "custom",
                recurrence_text: "כל שנה ב־13.10 ב־09:00",
                about: ["עמית"],
                about_ids: ["amit-1"],
              },
            },
            {
              item_id: "private",
              "שם מטלה": "מטלה פרטית",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [
        {
          reminder_id: "r-bday",
          item: "יום ההולדת של עמית",
          list_type: "tasks",
          fire_at: "2027-10-13 09:00",
          repeat: "custom",
          recurrence_text: "כל שנה ב־13.10 ב־09:00",
          ping: ["טל"],
          ping_ids: ["tal-1"],
          about: ["עמית"],
          about_ids: ["amit-1"],
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
          reminder_id: "r-michal",
          item: "לשלוח למיכל ברכת בוקר",
          list_type: "tasks",
          fire_at: "2026-10-18 09:00",
          repeat: "daily",
          ping: ["טל"],
          ping_ids: ["tal-1"],
          about: ["מיכל"],
          about_ids: ["michal-1"],
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
      ],
    };

    const text = formatShowDumpFromKind("full", snap, {
      viewerName: "טל",
      section: "shared",
      partner: "עמית",
      now,
    })!;
    expect(text).toContain("מטלות אישיות:");
    expect(text).toContain("יום ההולדת של עמית");
    expect(text).toContain("כל שנה ב־13.10");
    expect(text).toMatch(/קבוע \+ תזכורת/);
    expect(text).not.toMatch(/מטלות משותפות עם עמית:[\s\S]*יום ההולדת/);
    expect(text).not.toContain("מטלה פרטית");
    expect(text).not.toContain("לשלוח למיכל ברכת בוקר");
    // Linked clock folded into the task — not a second תזכורות row.
    expect(text).not.toMatch(/תזכורות פעילות:[\s\S]*יום ההולדת של עמית/);
  });

  it("standing mark shows ping day when linked fire day ≠ task event day", () => {
    const line = formatNumberedItem(
      1,
      "יום ההולדת של עמית",
      {
        "שם מטלה": "יום ההולדת של עמית",
        "יום שלם": true,
        "תאריך לביצוע": "2027-05-09",
        חוזר: "כל שנה ב־9 במאי",
        reminder: {
          reminder_id: "r1",
          fire_at: "2027-05-08 13:00",
          recurrence_text: "כל שנה ב־8 במאי ב־13:00",
        },
      },
      "tasks",
      { now },
    );
    expect(line).toContain("כל שנה ב־9 במאי");
    expect(line).toMatch(/קבוע \+ תזכורת ב־8\.5\.2027 ב־13:00/);
  });

  it("unlinked about clock alone appears under תזכורות for partner dump", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [],
      reminders: [
        {
          reminder_id: "r-bday-only",
          item: "יום ההולדת של עמית",
          list_type: "tasks",
          fire_at: "2027-10-12 09:00",
          repeat: "custom",
          recurrence_text: "כל שנה ב־12.10 ב־09:00",
          ping: ["טל"],
          ping_ids: ["tal-1"],
          about: ["עמית"],
          about_ids: ["amit-1"],
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
      ],
    };
    const text = formatShowDumpFromKind("full", snap, {
      viewerName: "טל",
      section: "shared",
      partner: "עמית",
      now,
    })!;
    expect(text).toContain("יום ההולדת של עמית");
    expect(text).toContain("תזכורות פעילות:");
  });
});
