import type { ReportSection } from "@workee/shared";
import { formatReminderIntervalHe } from "@workee/shared";
import type { SpeakerContact } from "./contact.service.js";
import type { EmployeeRecordSnapshot } from "./employee-records.service.js";
import {
  reminderIsScheduledSend,
  type ReminderSnapshotRow,
} from "./reminder.service.js";

const ALL_SECTIONS: ReportSection[] = [
  "reminders",
  "sends",
  "tasks",
  "shopping",
  "filings",
  "contacts",
  "custom",
];

const SECTION_TITLES: Record<ReportSection, string> = {
  reminders: "תזכורות",
  sends: "שליחות מתוזמנות",
  tasks: "מטלות",
  shopping: "קניות",
  filings: "תיוקים",
  contacts: "אנשי קשר",
  custom: "רשימות מותאמות",
};

export function normalizeReportSections(
  sections?: ReportSection[] | null,
): ReportSection[] {
  if (!sections || sections.length === 0) {
    return [...ALL_SECTIONS];
  }
  const unique: ReportSection[] = [];
  for (const section of sections) {
    if (ALL_SECTIONS.includes(section) && !unique.includes(section)) {
      unique.push(section);
    }
  }
  return unique.length > 0 ? unique : [...ALL_SECTIONS];
}

export function formatSavedDataReport(input: {
  snapshot: EmployeeRecordSnapshot;
  contacts: SpeakerContact[];
  speakerId: string;
  speakerPhone?: string | null;
  speakerName: string;
  sections?: ReportSection[] | null;
  multiOwner?: boolean;
}): string {
  const wanted = normalizeReportSections(input.sections);
  const blocks: string[] = [];

  for (const section of wanted) {
    const body = formatSection(section, input);
    blocks.push(
      body
        ? `${SECTION_TITLES[section]}:\n${body}`
        : `${SECTION_TITLES[section]}:\n- אין`,
    );
  }

  if (blocks.length === 0) {
    return "אין נתונים שמורים להצגה.";
  }

  const heading =
    wanted.length === ALL_SECTIONS.length
      ? `דו״ח מצב עבור ${input.speakerName}:`
      : `דו״ח חלקי עבור ${input.speakerName}:`;

  return [heading, ...blocks].join("\n\n");
}

function formatSection(
  section: ReportSection,
  input: {
    snapshot: EmployeeRecordSnapshot;
    contacts: SpeakerContact[];
    speakerId: string;
    speakerPhone?: string | null;
    multiOwner?: boolean;
  },
): string {
  switch (section) {
    case "reminders":
      return formatReminderLines(
        (input.snapshot.reminders ?? []).filter(
          (row) =>
            row.status === "active" &&
            !reminderIsScheduledSend(
              row,
              input.speakerId,
              input.speakerPhone,
            ),
        ),
        input.multiOwner,
      );
    case "sends":
      return formatReminderLines(
        (input.snapshot.reminders ?? []).filter(
          (row) =>
            row.status === "active" &&
            reminderIsScheduledSend(row, input.speakerId, input.speakerPhone),
        ),
        input.multiOwner,
        true,
      );
    case "tasks":
      return formatListLines(input.snapshot, "tasks", input.multiOwner);
    case "shopping":
      return formatListLines(input.snapshot, "shopping", input.multiOwner);
    case "custom":
      return formatListLines(input.snapshot, "custom", input.multiOwner);
    case "filings":
      return formatFilingLines(input.snapshot, input.multiOwner);
    case "contacts":
      return formatContactLines(input.contacts);
    default:
      return "";
  }
}

function formatReminderLines(
  rows: ReminderSnapshotRow[],
  multiOwner?: boolean,
  asSend = false,
): string {
  if (rows.length === 0) {
    return "";
  }
  return rows
    .map((row) => {
      const parts = [row.item, row.fire_at];
      const cadence = formatReminderIntervalHe(row.repeat);
      if (cadence) {
        parts.push(cadence);
      }
      if (asSend) {
        const ping = (row.ping ?? []).filter(Boolean).join(", ");
        if (ping) {
          parts.push(`אל ${ping}`);
        }
        if (row.compose_at_fire) {
          parts.push("compose");
        } else if (row.text?.trim()) {
          parts.push(`«${row.text.trim().slice(0, 80)}»`);
        }
      }
      if (multiOwner && row.owner) {
        parts.push(`(${row.owner})`);
      }
      return `- ${parts.join(" · ")}`;
    })
    .join("\n");
}

function formatListLines(
  snapshot: EmployeeRecordSnapshot,
  listType: string,
  multiOwner?: boolean,
): string {
  const lines: string[] = [];
  for (const list of snapshot.lists) {
    if (list.list_type !== listType) {
      continue;
    }
    for (const item of list.items) {
      const label = listItemLabel(listType, item);
      if (!label) {
        continue;
      }
      const bits = [label];
      if (listType === "custom" && list.list_name) {
        bits.unshift(`[${list.list_name}]`);
      }
      if (listType === "tasks") {
        const date = readField(item, ["תאריך לביצוע", "date"]);
        const time = readField(item, ["שעה לביצוע", "time"]);
        if (date) {
          bits.push(date);
        }
        if (time) {
          bits.push(time);
        }
        if (item["יום שלם"] === true || item.all_day === true) {
          bits.push("יום שלם");
        }
      }
      if (listType === "shopping") {
        const qty = item["כמות"] ?? item.quantity;
        if (qty != null && String(qty).trim() && String(qty) !== "1") {
          bits.push(`×${qty}`);
        }
      }
      if (multiOwner && list.owner) {
        bits.push(`(${list.owner})`);
      }
      lines.push(`- ${bits.join(" · ")}`);
    }
  }
  return lines.join("\n");
}

function formatFilingLines(
  snapshot: EmployeeRecordSnapshot,
  multiOwner?: boolean,
): string {
  if (snapshot.filing.length === 0) {
    return "";
  }
  return snapshot.filing
    .map((row) => {
      const info = row.item_info?.trim();
      const owner =
        multiOwner && row.owner ? ` (${row.owner})` : "";
      return info
        ? `- ${row.item_name}: ${info}${owner}`
        : `- ${row.item_name}${owner}`;
    })
    .join("\n");
}

function formatContactLines(contacts: SpeakerContact[]): string {
  if (contacts.length === 0) {
    return "";
  }
  return contacts
    .map((row) => `- ${row.name}${row.phone ? ` · ${row.phone}` : ""}`)
    .join("\n");
}

function listItemLabel(
  listType: string,
  item: Record<string, unknown>,
): string {
  if (listType === "shopping") {
    return readField(item, ["שם פריט", "name", "item_name"]);
  }
  if (listType === "tasks") {
    return readField(item, ["שם מטלה", "name", "task", "item_name"]);
  }
  if (listType === "contacts") {
    const first = readField(item, ["שם פרטי", "first_name", "name"]);
    const last = readField(item, ["שם משפחה", "last_name", "surname"]);
    return [first, last].filter(Boolean).join(" ").trim();
  }
  for (const key of ["name", "שם", "item_name", "שם פריט", "שם החנות", "title"]) {
    const value = readField(item, [key]);
    if (value) {
      return value;
    }
  }
  for (const value of Object.values(item)) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function readField(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}
