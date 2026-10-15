/**
 * Engine dump for exact «הצג» button commands and model `show_dump` signals.
 * Builds the spoken reply from the same live snapshot as EMPLOYEE_SAVED_DATA.
 */
import { addJerusalemDays } from "@workee/shared";
import {
  hebrewWeekdayFromYmd,
  jerusalemYmd,
} from "../utils/relative-date.js";
import type { EmployeeRecordSnapshot } from "./employee-records.service.js";
import type { ReminderSnapshotRow } from "./reminder.service.js";

export const SHOW_REMINDERS_COMMAND = "הצג תזכורות";

const SHOW_LIST_PREFIX = "הצג רשימת ";

const TITLE_KEYS: Record<string, string[]> = {
  shopping: ["שם פריט", "name", "item_name"],
  tasks: ["שם מטלה", "name", "task", "item_name"],
  contacts: ["שם פרטי", "first_name", "name"],
};

export type ShowDumpOptions = {
  /** Current speaker display name — omitted from `(עם …)` partner headers. */
  viewerName?: string;
  now?: Date;
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

/** Map metadata.show_dump / list Hebrew labels to a dump target. */
export function resolveShowDumpKind(
  raw: string,
): { kind: "reminders" } | { kind: "list"; name: string } | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  const lower = value.toLowerCase();
  if (
    lower === "reminders" ||
    value === "תזכורות" ||
    value === SHOW_REMINDERS_COMMAND
  ) {
    return { kind: "reminders" };
  }
  if (lower === "shopping" || value === "קניות") {
    return { kind: "list", name: "קניות" };
  }
  if (lower === "tasks" || value === "מטלות") {
    return { kind: "list", name: "מטלות" };
  }
  if (lower === "contacts" || value === "אנשי קשר") {
    return { kind: "list", name: "אנשי קשר" };
  }
  return { kind: "list", name: value };
}

export function formatShowButtonDump(
  command: string,
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): string | null {
  const parsed = parseExactShowButtonCommand(command);
  if (!parsed) {
    return null;
  }
  return formatResolvedShowDump(parsed, snapshot, opts);
}

/** Dump from model `show_dump` (shopping|tasks|contacts|reminders|custom name). */
export function formatShowDumpFromKind(
  kind: string,
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): string | null {
  const resolved = resolveShowDumpKind(kind);
  if (!resolved) {
    return null;
  }
  return formatResolvedShowDump(resolved, snapshot, opts);
}

function formatResolvedShowDump(
  parsed: { kind: "reminders" } | { kind: "list"; name: string },
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): string | null {
  if (parsed.kind === "reminders") {
    return formatRemindersDump(snapshot.reminders ?? [], opts?.now);
  }
  return formatListDump(parsed.name, snapshot, opts);
}

function formatRemindersDump(
  rows: ReminderSnapshotRow[],
  now = new Date(),
): string {
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
      const when = formatReminderWhen(row, now);
      return when ? `${index + 1}. ${title} — ${when}` : `${index + 1}. ${title}`;
    })
    .join("\n");
}

/**
 * Next fire + optional short cadence: «היום ב־19:00 (כל יום)» / «8.5.2027 ב־13:00 (כל שנה)».
 */
export function formatReminderWhen(
  row: Pick<ReminderSnapshotRow, "fire_at" | "repeat" | "recurrence_text">,
  now = new Date(),
): string {
  const fireAt = row.fire_at?.trim() || "";
  const cadence = shortCadenceParen(row.recurrence_text, row.repeat);
  if (!fireAt) {
    return cadence.replace(/^\(|\)$/g, "");
  }
  const relative = formatRelativeFireAt(fireAt, now);
  return cadence ? `${relative} ${cadence}` : relative;
}

/** «(כל יום)» / «(כל שנה)» from recurrence_text — strips time, calendar clause, until, count. */
export function shortCadenceParen(
  recurrenceText?: string | null,
  repeat?: string | null,
): string {
  let base = (recurrenceText ?? "").trim();
  if (!base) {
    const r = (repeat ?? "").trim().toLowerCase();
    if (r === "daily") {
      return "(כל יום)";
    }
    if (r === "weekly") {
      return "(כל שבוע)";
    }
    if (r === "monthly") {
      return "(כל חודש)";
    }
    if (r === "hourly") {
      return "(כל שעה)";
    }
    return "";
  }
  // Drop trailing clock « ב־19:00» / range « ב־19:00–20:00».
  base = base.replace(/\s+ב־\d{1,2}:\d{2}(?:–\d{1,2}:\d{2})?/g, "");
  // Drop yearly calendar « ב־8 במאי» / « ב־12 באוקטובר».
  base = base.replace(/\s+ב־\d{1,2}\s+ב[\u0590-\u05FF]+/g, "");
  // Drop until / count tail.
  base = base.replace(/\s+עד\s+\S+/g, "");
  base = base.replace(/\s+\(\d+\s+פעמים\)/g, "");
  base = base.trim();
  return base ? `(${base})` : "";
}

function formatListDump(
  name: string,
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): string | null {
  if (name === "קניות") {
    return formatThreeWayDump("shopping", "קניות", snapshot, opts);
  }
  if (name === "מטלות") {
    return formatThreeWayDump("tasks", "מטלות", snapshot, opts);
  }
  if (name === "אנשי קשר") {
    return formatContactsOrCustomDump("contacts", "", snapshot, "אנשי קשר", opts);
  }
  // Unknown custom name → null so free-form «הצג רשימת … בבקשה» stays model-written.
  return formatContactsOrCustomDump("custom", name, snapshot, name, opts);
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
  opts?: ShowDumpOptions,
): string {
  const lists = snapshot.lists.filter((list) => list.list_type === listType);
  const personal: DumpItem[] = [];
  const sharedByPartner = new Map<string, DumpItem[]>();
  const byOwner = new Map<string, DumpItem[]>();
  const viewer = opts?.viewerName?.trim() ?? "";

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
      const partnerKey = partnersKey(list.shared_with ?? [], viewer);
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
        const partnerKey = partnersKey(sharedWith, viewer);
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
        formatNumberedItem(i + 1, row.title, row.item, listType, {
          assignedBy: row.partnerLine,
          now: opts?.now,
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
            formatNumberedItem(i + 1, row.title, row.item, listType, {
              now: opts?.now,
            }),
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
          formatNumberedItem(i + 1, row.title, row.item, listType, {
            now: opts?.now,
          }),
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
  opts?: ShowDumpOptions,
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
    .map((row, i) =>
      formatNumberedItem(i + 1, row.title, row.item, listType, {
        now: opts?.now,
      }),
    )
    .join("\n");
}

/** Exported for unit tests. */
export function formatNumberedItem(
  n: number,
  title: string,
  item: Record<string, unknown>,
  listType: string,
  opts?: { assignedBy?: string; now?: Date },
): string {
  let body = title.trim() || "פריט";
  if (hasAttachments(item)) {
    body += " 📎";
  }
  if (opts?.assignedBy) {
    body += ` (${opts.assignedBy})`;
  }
  if (listType === "tasks" || listType === "shopping") {
    const schedule = formatScheduleSuffix(item, listType, opts?.now);
    if (schedule) {
      body += ` ${schedule}`;
    }
  }
  const reminder = formatLinkedReminderParen(item, opts?.now);
  if (reminder) {
    body += ` ${reminder}`;
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

/** Standing / dated suffix: «— שני ושלישי ב־19:00 (קבוע)» or «— מחר ב־19:30». */
export function formatScheduleSuffix(
  item: Record<string, unknown>,
  listType: string,
  now = new Date(),
): string {
  if (listType !== "tasks") {
    return "";
  }
  const recurring = readText(item, ["חוזר", "recurrence_text"]);
  if (recurring) {
    const withMark = /קבוע/.test(recurring)
      ? recurring
      : `${recurring} (קבוע)`;
    return `— ${withMark}`;
  }
  const date = readText(item, ["תאריך לביצוע", "date"]);
  const time = readText(item, ["שעה לביצוע", "time", "שעה"]);
  if (date && time) {
    return `— ${formatRelativeDayLabel(date, now)} ב־${normalizeHm(time)}`;
  }
  if (date) {
    return `— ${formatRelativeDayLabel(date, now)}`;
  }
  if (time) {
    return `— ${normalizeHm(time)}`;
  }
  return "";
}

/** «(תזכורת: היום ב־20:30)» — same relative when as reminder dump lines. */
export function formatLinkedReminderParen(
  item: Record<string, unknown>,
  now = new Date(),
): string {
  const raw = item.reminder;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "";
  }
  const reminder = raw as Record<string, unknown>;
  const fireAt =
    typeof reminder.fire_at === "string" ? reminder.fire_at.trim() : "";
  const recurrenceText =
    typeof reminder.recurrence_text === "string"
      ? reminder.recurrence_text.trim()
      : "";
  const repeat =
    typeof reminder.repeat === "string" ? reminder.repeat.trim() : "";
  if (!fireAt && !recurrenceText && (!repeat || repeat === "none" || repeat === "once")) {
    return "";
  }
  const when = formatReminderWhen(
    {
      fire_at: fireAt,
      repeat,
      recurrence_text: recurrenceText || undefined,
    },
    now,
  );
  return when ? `(תזכורת: ${when})` : "";
}

/**
 * Near-calendar labels vs Asia/Jerusalem today:
 * 0 היום · 1 מחר · 2 מחרתיים · 3–6 weekday · else D.M.YYYY.
 */
export function formatRelativeDayLabel(ymd: string, now = new Date()): string {
  const datePart = ymd.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return formatDisplayDate(ymd);
  }
  for (let offset = 0; offset <= 6; offset += 1) {
    const candidate = jerusalemYmd(addJerusalemDays(now, offset));
    if (candidate !== datePart) {
      continue;
    }
    if (offset === 0) {
      return "היום";
    }
    if (offset === 1) {
      return "מחר";
    }
    if (offset === 2) {
      return "מחרתיים";
    }
    return hebrewWeekdayFromYmd(datePart) ?? formatDisplayDate(datePart);
  }
  return formatDisplayDate(datePart);
}

/** «היום ב־19:00» / «מחרתיים ב־09:00» / «8.5.2027 ב־13:00». */
export function formatRelativeFireAt(fireAt: string, now: Date): string {
  const datePart = fireAt.slice(0, 10);
  const timePart = fireAt.length >= 16 ? fireAt.slice(11, 16) : "";
  const dayLabel = formatRelativeDayLabel(datePart, now);
  return timePart ? `${dayLabel} ב־${timePart}` : dayLabel;
}

/** Unpadded D.M.YYYY (e.g. 8.5.2027). */
export function formatDisplayDate(ymd: string): string {
  const match = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return ymd.trim();
  }
  return `${Number(match[3])}.${Number(match[2])}.${match[1]}`;
}

function normalizeHm(time: string): string {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) {
    return time.trim();
  }
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function partnersKey(names: string[], viewerName: string): string {
  const partners = names
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name) => !viewerName || name !== viewerName);
  return partners.length > 0 ? partners.join(", ") : "משותף";
}

/** Shopping line body: «אורז - 2» / «עגבניות - 1 ק"ג» (missing כמות → 1). */
export function formatShoppingTitle(item: Record<string, unknown>): string {
  const name =
    readText(item, TITLE_KEYS.shopping) ||
    readText(item, ["name", "item_name"]) ||
    "פריט";
  const qtyRaw = item["כמות"] ?? item.quantity ?? item.qty;
  const qty =
    typeof qtyRaw === "number" && Number.isFinite(qtyRaw)
      ? qtyRaw
      : typeof qtyRaw === "string" &&
          qtyRaw.trim() !== "" &&
          Number.isFinite(Number(qtyRaw))
        ? Number(qtyRaw)
        : 1;
  const unit = readText(item, ["יחידת מידה", "unit", "יחידה"]);
  return unit ? `${name} - ${qty} ${unit}` : `${name} - ${qty}`;
}

function itemTitle(
  listType: string,
  item: Record<string, unknown>,
  titleField?: string,
): string {
  if (listType === "shopping") {
    return formatShoppingTitle(item);
  }
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
        key === "reminder" ||
        key === "חוזר" ||
        key === "תאריך לביצוע" ||
        key === "שעה לביצוע"
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
