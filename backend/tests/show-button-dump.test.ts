import { describe, expect, it } from "vitest";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import {
  formatShowButtonDump,
  isExactShowButtonCommand,
  parseExactShowButtonCommand,
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
          { item_id: "2", "שם פריט": "קמח מלא" },
          { item_id: "3", "שם פריט": "נייר טואלט" },
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

  it("dumps shopping without soft-deleted rice (not in snapshot)", () => {
    const text = formatShowButtonDump("הצג רשימת קניות", snapshot);
    expect(text).toContain("ספוג אדום");
    expect(text).toContain("קמח מלא");
    expect(text).toContain("נייר טואלט");
    expect(text).not.toContain("אורז");
    expect(text).toContain("קניות אישיות:");
    expect(text).toContain("קניות משותפות:");
    expect(text).toContain("(עם טל, מיכל)");
  });

  it("dumps only active reminders", () => {
    const text = formatShowButtonDump("הצג תזכורות", snapshot);
    expect(text).toContain("1. לקנות חלב — 2026-10-16 09:00");
    expect(text).not.toContain("ישן");
  });

  it("returns null for free-form asks", () => {
    expect(formatShowButtonDump("מה יש לי לקנות", snapshot)).toBeNull();
  });

  it("does not override for unknown custom / free-form-looking names", () => {
    expect(formatShowButtonDump("הצג רשימת בעיות", snapshot)).toBeNull();
    expect(formatShowButtonDump("הצג רשימת קניות בבקשה", snapshot)).toBeNull();
  });
});
