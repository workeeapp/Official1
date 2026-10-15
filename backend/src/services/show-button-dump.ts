/**
 * Engine dump for exact «הצג» button commands only — not free-form status asks.
 * Builds the spoken reply from the same live snapshot as EMPLOYEE_SAVED_DATA.
 */
import type { EmployeeRecordSnapshot } from "./employee-records.service.js";
import type { ReminderSnapshotRow } from "./reminder.service.js";

export const SHOW_REMINDERS_COMMAND = "הצג תזכורות";

const SHOW_LIST_PREFIX = "הצג רשימת ";

const TITLE_KEYS: Record<string, string[]> = {
  shopping: ["שם פריט", "name", "item_name"],
  tasks: ["שם מטלה", "name", "task", "item_name"],
  contacts: ["שם פרטי", "first_name", "name"],
};

/**
 * Parse when the whole message is exactly a SHOW button command we emit
 * (`הצג תזכורות` or `הצג רשימת <name>` including multi-word custom names).
 * Free-form asks («מה יש לי לקנות», «הציגי את הקניות») return null.
 */
export function parseExactShowButtonCommand(
  text: string,
): { kind: "reminders" } | { kind: "list"; name: string } | null {
  const trimmed = text.trim();
  if (trimmed === SHOW_REMINDERS_COMMAND) {
    return { kind: "reminders" };
  }
  if (!trimmed.startsWith(SHOW_LIST_PREFIX)) {
    return null;
  }
  const name = trimmed.slice(SHOW_LIST_PREFIX.length).trim();
  if (!name) {
    return null;
  }
  return { kind: "list", name };
}

export function isExactShowButtonCommand(text: string): boolean {
  return parseExactShowButtonCommand(text) !== null;
}

export function formatShowButtonDump(
  command: string,
  snapshot: EmployeeRecordSnapshot,
): string | null {
  const parsed = parseExactShowButtonCommand(command);
  if (!parsed) {
    return null;
  }
  if (parsed.kind === "reminders") {
    return formatRemindersDump(snapshot.reminders ?? []);
  }
  return formatListDump(parsed.name, snapshot);
}

function formatRemindersDump(rows: ReminderSnapshotRow[]): string {
  const active = rows.filter((row) => row.status === "active");
  if (active.length === 0) {
    return "אין לך תזכורות פעילות כרגע.";
  }
  return active
    .map((row, index) => {
      let title = row.item.trim() || "תזכורת";
      if (hasAttachments(row)) {
        title += " 📎";
      }
      const when = row.fire_at?.trim() || "";
      return when
        ? `${index + 1}. ${title} — ${when}`
        : `${index + 1}. ${title}`;
    })
    .join("\n");
}

function formatListDump(
  name: string,
  snapshot: EmployeeRecordSnapshot,
): string | null {
  if (name === "קניות") {
    return formatThreeWayDump("shopping", "קניות", snapshot);
  }
  if (name === "מטלות") {
    return formatThreeWayDump("tasks", "מטלות", snapshot);
  }
  if (name === "אנשי קשר") {
    return formatContactsOrCustomDump("contacts", "", snapshot, "אנשי קשר");
  }
  // Unknown custom name → null so free-form «הצג רשימת … בבקשה» stays model-written.
  return formatContactsOrCustomDump("custom", name, snapshot, name);
}

type DumpItem = {
  title: string;
  item: Record<string, unknown>;
  partnerLine?: string;
};

function formatThreeWayDump(
  listType: "shopping" | "tasks",
  label: string,
  snapshot: EmployeeRecordSnapshot,
): string {
  const lists = snapshot.lists.filter((list) => list.list_type === listType);
  const personal: DumpItem[] = [];
  const sharedByPartner = new Map<string, DumpItem[]>();
  const byOwner = new Map<string, DumpItem[]>();

  for (const list of lists) {
    if (list.scope === "shared_items") {
      const bucket = byOwner.get(list.owner) ?? [];
      for (const item of list.items) {
        bucket.push({
          title: itemTitle(listType, item, list.title_field),
          item,
        });
      }
      byOwner.set(list.owner, bucket);
      continue;
    }

    if (list.scope === "shared") {
      const partners = (list.shared_with ?? [])
        .map((name) => name.trim())
        .filter(Boolean);
      const partnerKey = partners.length > 0 ? partners.join(", ") : "משותף";
      const bucket = sharedByPartner.get(partnerKey) ?? [];
      for (const item of list.items) {
        bucket.push({
          title: itemTitle(listType, item, list.title_field),
          item,
        });
      }
      sharedByPartner.set(partnerKey, bucket);
      continue;
    }

    // personal list (may still hold shared/assigned items)
    for (const item of list.items) {
      const assignedBy =
        typeof item.assigned_by === "string" ? item.assigned_by.trim() : "";
      const sharedWith = stringArray(item.shared_with);
      if (assignedBy && sharedWith.length === 0) {
        personal.push({
          title: itemTitle(listType, item, list.title_field),
          item,
          partnerLine: assignedBy,
        });
        continue;
      }
      if (sharedWith.length > 0) {
        const partnerKey = sharedWith.join(", ");
        const bucket = sharedByPartner.get(partnerKey) ?? [];
        bucket.push({
          title: itemTitle(listType, item, list.title_field),
          item,
        });
        sharedByPartner.set(partnerKey, bucket);
        continue;
      }
      personal.push({
        title: itemTitle(listType, item, list.title_field),
        item,
      });
    }
  }

  const blocks: string[] = [];
  blocks.push(`${label} אישיות:`);
  if (personal.length === 0) {
    blocks.push("ריקה");
  } else {
    blocks.push(
      ...personal.map((row, i) =>
        formatNumberedItem(i + 1, row.title, row.item, {
          assignedBy: row.partnerLine,
        }),
      ),
    );
  }

  blocks.push("");
  blocks.push(`${label} משותפות:`);
  if (sharedByPartner.size === 0) {
    blocks.push("ריקה");
  } else {
    for (const [partners, items] of sharedByPartner) {
      blocks.push(`(עם ${partners})`);
      if (items.length === 0) {
        blocks.push("ריקה");
      } else {
        blocks.push(
          ...items.map((row, i) =>
            formatNumberedItem(i + 1, row.title, row.item),
          ),
        );
      }
    }
  }

  for (const [owner, items] of byOwner) {
    blocks.push("");
    blocks.push(`${label} של ${owner}:`);
    if (items.length === 0) {
      blocks.push("ריקה");
    } else {
      blocks.push(
        ...items.map((row, i) =>
          formatNumberedItem(i + 1, row.title, row.item),
        ),
      );
    }
  }

  return blocks.join("\n").trim();
}

function formatContactsOrCustomDump(
  listType: "contacts" | "custom",
  listName: string,
  snapshot: EmployeeRecordSnapshot,
  emptyLabel: string,
): string | null {
  const lists = snapshot.lists.filter((list) => {
    if (list.list_type !== listType) {
      return false;
    }
    if (listType === "contacts") {
      return true;
    }
    return (list.list_name ?? "").trim() === listName;
  });
  if (lists.length === 0) {
    return listType === "custom" ? null : `לא מצאתי רשימה בשם «${emptyLabel}».`;
  }
  const items = lists.flatMap((list) =>
    list.items.map((item) => ({
      title: itemTitle(listType, item, list.title_field),
      item,
    })),
  );
  if (items.length === 0) {
    return listType === "contacts"
      ? "רשימת אנשי הקשר ריקה."
      : `רשימת «${emptyLabel}» ריקה.`;
  }
  return items
    .map((row, i) => formatNumberedItem(i + 1, row.title, row.item))
    .join("\n");
}

function formatNumberedItem(
  n: number,
  title: string,
  item: Record<string, unknown>,
  opts?: { assignedBy?: string },
): string {
  let body = title.trim() || "פריט";
  if (hasAttachments(item)) {
    body += " 📎";
  }
  if (opts?.assignedBy) {
    body += ` (${opts.assignedBy})`;
  }
  let line = `${n}. ${body}`;
  const urgency = item.urgency;
  if (urgency === "urgent" || urgency === "very_urgent") {
    line = `«${line}»`;
    if (urgency === "very_urgent") {
      line += " ‼️";
    }
  }
  return line;
}

function itemTitle(
  listType: string,
  item: Record<string, unknown>,
  titleField?: string,
): string {
  if (listType === "contacts") {
    const first = readText(item, TITLE_KEYS.contacts);
    const last = readText(item, ["שם משפחה", "last_name", "surname"]);
    return [first, last].filter(Boolean).join(" ") || "איש קשר";
  }
  const keys = TITLE_KEYS[listType] ?? [];
  const titled = keys.length > 0 ? readText(item, keys) : "";
  if (titled) {
    return titled;
  }
  if (listType === "custom") {
    const field = titleField?.trim();
    if (field) {
      const named = readText(item, [field]);
      if (named) {
        return named;
      }
    }
    for (const [key, value] of Object.entries(item)) {
      if (
        key === "item_id" ||
        key === "scope" ||
        key === "owner" ||
        key === "urgency" ||
        key === "shared_with" ||
        key === "assigned_by" ||
        key === "attachments" ||
        key === "reminder"
      ) {
        continue;
      }
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return "פריט";
}

function readText(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((row): row is string => typeof row === "string")
    .map((row) => row.trim())
    .filter(Boolean);
}

function hasAttachments(row: Record<string, unknown> | ReminderSnapshotRow): boolean {
  const attachments = (row as { attachments?: unknown }).attachments;
  return Array.isArray(attachments) && attachments.length > 0;
}
