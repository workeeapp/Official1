import { describe, expect, it } from "vitest";
import {
  formatSavedDataReport,
  normalizeReportSections,
} from "../src/services/saved-report.js";

describe("normalizeReportSections", () => {
  it("defaults to every section when empty", () => {
    expect(normalizeReportSections([])).toEqual([
      "reminders",
      "sends",
      "tasks",
      "shopping",
      "filings",
      "contacts",
      "custom",
      "history",
    ]);
  });

  it("keeps a requested subset in stable order of first appearance", () => {
    expect(normalizeReportSections(["shopping", "tasks", "shopping"])).toEqual([
      "shopping",
      "tasks",
    ]);
  });
});

describe("formatSavedDataReport", () => {
  const speakerId = "tal-1";

  it("builds a full Hebrew report with empty categories marked", () => {
    const text = formatSavedDataReport({
      snapshot: {
        lists: [
          {
            list_type: "tasks",
            owner: "טל",
            items: [{ "שם מטלה": "להכין חביתה לילדים" }],
          },
          {
            list_type: "shopping",
            owner: "טל",
            items: [{ "שם פריט": "חלב", כמות: 2 }],
          },
        ],
        filing: [{ item_name: "רכב", item_info: "12-345", owner: "טל", scope: "personal" }],
        reminders: [
          {
            item: "לשתות מים",
            list_type: "tasks",
            fire_at: "2026-09-29 12:00",
            repeat: "once",
            ping: ["טל"],
            ping_ids: [speakerId],
            owner: "טל",
            text: "",
            compose_at_fire: false,
            compose_source: "",
            status: "active",
            send_status: "pending",
            sent: false,
            sent_at: null,
            last_composed_text: "",
            sent_text: "",
          },
          {
            item: "לשלוח הודעה לעמית",
            list_type: "tasks",
            fire_at: "2026-09-29 18:00",
            repeat: "once",
            ping: ["עמית"],
            ping_ids: ["amit-1"],
            owner: "טל",
            text: "בוקר טוב",
            compose_at_fire: false,
            compose_source: "",
            status: "active",
            send_status: "pending",
            sent: false,
            sent_at: null,
            last_composed_text: "",
            sent_text: "בוקר טוב",
          },
        ],
      },
      contacts: [{ id: "c1", name: "מיכל", phone: "0501234567", kind: "person" }],
      speakerId,
      speakerName: "טל",
      sections: [],
    });

    expect(text).toContain("דו״ח מצב עבור טל:");
    expect(text).toContain("תזכורות:");
    expect(text).toContain("לשתות מים");
    expect(text).toContain("שליחות (מתוזמנות והיסטוריה):");
    expect(text).toContain("לשלוח הודעה לעמית");
    expect(text).toContain("מטלות:");
    expect(text).toContain("להכין חביתה לילדים");
    expect(text).toContain("קניות:");
    expect(text).toContain("חלב");
    expect(text).toContain("תיוקים:");
    expect(text).toContain("רכב: 12-345");
    expect(text).toContain("אנשי קשר:");
    expect(text).toContain("מיכל");
  });

  it("includes done self-reminders with sent_at in the reminders section", () => {
    const text = formatSavedDataReport({
      snapshot: {
        lists: [],
        filing: [],
        reminders: [
          {
            item: "לקנות מחשבון מדעי",
            list_type: "shopping",
            fire_at: "2026-09-29 15:05",
            repeat: "once",
            ping: ["טל"],
            ping_ids: [speakerId],
            owner: "טל",
            text: "",
            compose_at_fire: false,
            compose_source: "",
            status: "done",
            send_status: "sent",
            sent: true,
            sent_at: "2026-09-29 15:05",
            last_composed_text: "",
            sent_text: "",
          },
        ],
      },
      contacts: [],
      speakerId,
      speakerName: "טל",
      sections: ["reminders"],
    });

    expect(text).toContain("תזכורות:");
    expect(text).toContain("לקנות מחשבון מדעי");
    expect(text).toContain("בוצע");
    expect(text).toContain("2026-09-29 15:05");
    expect(text).toContain("נשלח");
    expect(text).not.toContain("- אין");
  });

  it("includes cancelled reminders and mutation history", () => {
    const text = formatSavedDataReport({
      snapshot: {
        lists: [],
        filing: [],
        reminders: [
          {
            item: "לקנות מחשבון מדעי",
            list_type: "shopping",
            fire_at: "2026-09-29 15:05",
            repeat: "once",
            ping: ["טל"],
            ping_ids: [speakerId],
            owner: "טל",
            text: "",
            compose_at_fire: false,
            compose_source: "",
            status: "cancelled",
            send_status: "pending",
            sent: false,
            sent_at: null,
            changed_at: "2026-09-29 15:10",
            last_composed_text: "",
            sent_text: "",
          },
        ],
        history: [
          {
            action: "reminder_cancel",
            summary: "cancel reminder: לקנות מחשבון מדעי",
            at: "2026-09-29 15:10",
            entity_type: "Reminder",
            actor: "טל",
          },
          {
            action: "reminder_save",
            summary: "update reminder: לקנות מחשבון מדעי",
            at: "2026-09-29 15:04",
            entity_type: "Reminder",
            actor: "טל",
          },
          {
            action: "list_remove",
            summary: "remove shopping: חלב",
            at: "2026-09-29 14:00",
            entity_type: "EmployeeListItem",
            actor: "לוסי",
          },
        ],
      },
      contacts: [],
      speakerId,
      speakerName: "טל",
      sections: ["reminders", "history"],
    });

    expect(text).toContain("בוטל");
    expect(text).toContain("2026-09-29 15:10");
    expect(text).toContain("היסטוריית שינויים");
    expect(text).toContain("נמחק");
    expect(text).toContain("עודכן");
    expect(text).toContain("ע״י טל");
    expect(text).toContain("ע״י לוסי");
    expect(text).toContain("תזכורת «לקנות מחשבון מדעי»");
    expect(text).toContain("קניות «חלב»");
    expect(text).not.toContain("cancel reminder");
    expect(text).not.toContain("update reminder");
    expect(text).not.toContain("remove shopping");
  });

  it("includes done scheduled sends with sent_at and sent body", () => {
    const text = formatSavedDataReport({
      snapshot: {
        lists: [],
        filing: [],
        reminders: [
          {
            item: "לשלוח הודעה לעמית",
            list_type: "tasks",
            fire_at: "2026-09-29 09:00",
            repeat: "once",
            ping: ["עמית"],
            ping_ids: ["amit-1"],
            owner: "טל",
            text: "תקציר קצר",
            compose_at_fire: true,
            compose_source: "",
            status: "done",
            send_status: "sent",
            sent: true,
            sent_at: "2026-09-29 09:00",
            last_composed_text: "היי עמית, הנה העדכון...",
            sent_text: "היי עמית, הנה העדכון...",
          },
        ],
      },
      contacts: [],
      speakerId,
      speakerName: "טל",
      sections: ["sends"],
    });

    expect(text).toContain("שליחות (מתוזמנות והיסטוריה):");
    expect(text).toContain("בוצע");
    expect(text).toContain("נשלח");
    expect(text).toContain("אל עמית");
    expect(text).toContain("היי עמית, הנה העדכון");
  });

  it("builds a partial report for selected sections only", () => {
    const text = formatSavedDataReport({
      snapshot: {
        lists: [
          {
            list_type: "tasks",
            owner: "טל",
            items: [{ "שם מטלה": "להכין חביתה" }],
          },
        ],
        filing: [],
        reminders: [],
      },
      contacts: [],
      speakerId,
      speakerName: "טל",
      sections: ["tasks", "shopping"],
    });

    expect(text).toContain("דו״ח חלקי עבור טל:");
    expect(text).toContain("מטלות:");
    expect(text).toContain("להכין חביתה");
    expect(text).toContain("קניות:");
    expect(text).toContain("- אין");
    expect(text).not.toContain("תזכורות:");
    expect(text).not.toContain("תיוקים:");
  });

  it("lists custom list item fields, not only the owner name", () => {
    const text = formatSavedDataReport({
      snapshot: {
        lists: [
          {
            list_type: "custom",
            list_name: "שיעורי נהיגה",
            owner: "מאיה",
            items: [
              { תאריך: "היום", שעה: "16:00", נושא: "חניה" },
              { תאריך: "2026-10-03", שעה: "17:30", נושא: "כביש מהיר" },
            ],
          },
        ],
        filing: [],
        reminders: [],
      },
      contacts: [],
      speakerId,
      speakerName: "טל",
      sections: ["custom"],
      multiOwner: true,
    });

    expect(text).toContain("שיעורי נהיגה");
    expect(text).toMatch(/תאריך: \d{4}-\d{2}-\d{2}/);
    expect(text).not.toContain("תאריך: היום");
    expect(text).toContain("נושא: חניה");
    expect(text).toContain("כביש מהיר");
    expect(text).toContain("(מאיה)");
    expect(text).not.toMatch(/LIST_NAME|list_name/i);
    expect(text.split("\n").some((line) => line.trim() === "- מאיה")).toBe(
      false,
    );
  });
});
