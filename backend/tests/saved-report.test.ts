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
    expect(text).toContain("שליחות מתוזמנות:");
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
});
