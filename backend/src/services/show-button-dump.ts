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
  /** Extra viewer labels (nickname + legal name) so partner headers never keep the viewer. */
  viewerAliases?: string[];
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

const SHOW_POLITE_SUFFIX = /(?:\s+(?:בבקשה|please))+$/iu;
const SHOW_SECTION_SUFFIX = /(?:\s+(?:אישית|אישיות|משותפת|משותפות))+$/u;

const BUILTIN_SHOW_LISTS = new Set(["קניות", "מטלות", "אנשי קשר"]);

/**
 * Normalize a show-list name from an exact «הצג רשימת …» command or show_dump.
 * Strips trailing בבקשה/please. For builtins only, also strips אישית|משותפת
 * (and plural forms) so «קניות אישית» → קניות. Custom names keep אישית.
 */
export function normalizeShowListName(raw: string): string {
  let name = raw.trim().replace(SHOW_POLITE_SUFFIX, "").trim();
  if (!name) {
    return "";
  }
  const withoutSection = name.replace(SHOW_SECTION_SUFFIX, "").trim();
  if (BUILTIN_SHOW_LISTS.has(withoutSection)) {
    return withoutSection;
  }
  return name;
}

/** Map metadata.show_dump / list Hebrew labels to a dump target. */
export function resolveShowDumpKind(
  raw: string,
): { kind: "reminders" } | { kind: "list"; name: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (
    lower === "reminders" ||
    trimmed === "תזכורות" ||
    trimmed === SHOW_REMINDERS_COMMAND
  ) {
    return { kind: "reminders" };
  }
  if (lower === "shopping") {
    return { kind: "list", name: "קניות" };
  }
  if (lower === "tasks") {
    return { kind: "list", name: "מטלות" };
  }
  if (lower === "contacts") {
    return { kind: "list", name: "אנשי קשר" };
  }
  const value = normalizeShowListName(trimmed);
  if (value === "קניות") {
    return { kind: "list", name: "קניות" };
  }
  if (value === "מטלות") {
    return { kind: "list", name: "מטלות" };
  }
  if (value === "אנשי קשר") {
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
 * One-off moves/cancels append ` · 18.10 ב־21:30` from snapshot `exceptions`.
 */
export function formatReminderWhen(
  row: Pick<
    ReminderSnapshotRow,
    "fire_at" | "repeat" | "recurrence_text" | "exceptions"
  >,
  now = new Date(),
): string {
  const fireAt = row.fire_at?.trim() || "";
  const cadence = shortCadenceParen(row.recurrence_text, row.repeat);
  const extras = formatExceptionsSuffix(row.exceptions);
  if (!fireAt) {
    const base = cadence.replace(/^\(|\)$/g, "");
    return base ? `${base}${extras}` : extras.replace(/^\s*·\s*/, "");
  }
  const relative = formatRelativeFireAt(fireAt, now);
  const when = cadence ? `${relative} ${cadence}` : relative;
  return `${when}${extras}`;
}

/** « · 18.10 ב־21:30» / « · 23.10 בוטל» from snapshot exception labels. */
export function formatExceptionsSuffix(exceptions: unknown): string {
  if (!Array.isArray(exceptions) || exceptions.length === 0) {
    return "";
  }
  const labels = exceptions
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return labels.length ? ` · ${labels.join(" · ")}` : "";
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
  rawName: string,
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): string | null {
  const name = normalizeShowListName(rawName);
  if (name === "קניות") {
    return formatThreeWayDump("shopping", "קניות", snapshot, opts);
  }
  if (name === "מטלות") {
    return formatThreeWayDump("tasks", "מטלות", snapshot, opts);
  }
  if (name === "אנשי קשר") {
    return formatContactsOrCustomDump("contacts", "", snapshot, "אנשי קשר", opts);
  }
  // Unknown custom name → null (model-written). Trailing בבקשה already stripped.
  return formatContactsOrCustomDump("custom", name, snapshot, name, opts);
}

type DumpItem = {
  title: string;
  item: Record<string, unknown>;
  /** One-way assigner name → shown as «(Name)» under אישיות. */
  assignedBy?: string;
  /** Co-share partners (viewer stripped) → shown as «(עם …)» under אישיות. */
  sharedWithLabel?: string;
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
  const partnerListFiles = new Map<string, boolean>();
  const ownerListFiles = new Map<string, boolean>();
  let personalListFiles = false;
  let sharedSectionListFiles = false;
  const viewer = opts?.viewerName?.trim() ?? "";
  const aliases = opts?.viewerAliases;

  for (const list of lists) {
    const listFiles = listHasListLevelFiles(list);
    if (list.scope === "shared_items") {
      const bucket = byOwner.get(list.owner) ?? [];
      for (const item of list.items) {
        bucket.push({
          title: itemTitle(listType, item, list.title_field),
          item,
        });
      }
      byOwner.set(list.owner, bucket);
      if (listFiles) {
        ownerListFiles.set(list.owner, true);
      }
      continue;
    }

    if (list.scope === "shared") {
      const partnerKey = partnersKey(list.shared_with ?? [], viewer, aliases);
      const bucket = sharedByPartner.get(partnerKey) ?? [];
      for (const item of list.items) {
        bucket.push({
          title: itemTitle(listType, item, list.title_field),
          item,
        });
      }
      sharedByPartner.set(partnerKey, bucket);
      if (listFiles) {
        sharedSectionListFiles = true;
        partnerListFiles.set(partnerKey, true);
      }
      continue;
    }

    if (listFiles) {
      personalListFiles = true;
    }

    // personal list (may still hold shared/assigned items).
    // Item-level shared_with STAYS under אישיות as «(עם …)» so it is distinct
    // from a whole scope=shared list (which uses משותפות + partner headers).
    for (const item of list.items) {
      const assignedBy =
        typeof item.assigned_by === "string" ? item.assigned_by.trim() : "";
      const sharedWith = stringArray(item.shared_with);
      const title = itemTitle(listType, item, list.title_field);
      // assigned_by wins for the line mark (אישיות «(Name)») even if shared_with is also present.
      if (assignedBy) {
        personal.push({ title, item, assignedBy });
        continue;
      }
      if (sharedWith.length > 0) {
        const partnerKey = partnersKey(sharedWith, viewer, aliases);
        // Meetings already name partners in the title («פגישה (טל, מיכל)») —
        // skip redundant «(עם מיכל)» on the dump line.
        const showShareMark =
          Boolean(partnerKey) &&
          !titleAlreadyListsPartners(title, partnerKey);
        personal.push({
          title,
          item,
          ...(showShareMark ? { sharedWithLabel: partnerKey } : {}),
        });
        continue;
      }
      personal.push({ title, item });
    }
  }

  const blocks: string[] = [];
  blocks.push(`${label} אישיות${paperclipSuffix(personalListFiles)}:`);
  if (personal.length === 0) {
    blocks.push("ריקה");
  } else {
    blocks.push(
      ...personal.map((row, i) =>
        formatNumberedItem(i + 1, row.title, row.item, listType, {
          assignedBy: row.assignedBy,
          sharedWithLabel: row.sharedWithLabel,
          now: opts?.now,
        }),
      ),
    );
  }

  blocks.push("");
  blocks.push(`${label} משותפות${paperclipSuffix(sharedSectionListFiles)}:`);
  if (sharedByPartner.size === 0) {
    blocks.push("ריקה");
  } else {
    for (const [partners, items] of sharedByPartner) {
      blocks.push(
        `(עם ${partners})${paperclipSuffix(partnerListFiles.get(partners) === true)}`,
      );
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
    blocks.push(
      `${label} של ${owner}${paperclipSuffix(ownerListFiles.get(owner) === true)}:`,
    );
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
  const listFiles = lists.some((list) => listHasListLevelFiles(list));
  const items = lists.flatMap((list) =>
    list.items.map((item) => ({
      title: itemTitle(listType, item, list.title_field),
      item,
    })),
  );
  if (items.length === 0) {
    if (listType === "contacts") {
      return "רשימת אנשי הקשר ריקה.";
    }
    return `רשימת «${emptyLabel}»${paperclipSuffix(listFiles)} ריקה.`;
  }
  const lines = items.map((row, i) =>
    formatNumberedItem(i + 1, row.title, row.item, listType, {
      now: opts?.now,
    }),
  );
  // Contacts have no list-level files; custom lists may show a titled header + 📎.
  if (listType === "custom") {
    return [`רשימת «${emptyLabel}»${paperclipSuffix(listFiles)}:`, ...lines].join(
      "\n",
    );
  }
  return lines.join("\n");
}

/** Exported for unit tests. */
export function formatNumberedItem(
  n: number,
  title: string,
  item: Record<string, unknown>,
  listType: string,
  opts?: { assignedBy?: string; sharedWithLabel?: string; now?: Date },
): string {
  let body = title.trim() || "פריט";
  if (hasAttachments(item)) {
    body += " 📎";
  }
  // Assign vs co-share marks: «(Name)» = assigned_by; «(עם Name)» = shared_with.
  // Prefer assignedBy when both are set (matches block-placement rule).
  // Skip «(עם …)» when the title already lists those partners (meetings).
  if (opts?.assignedBy) {
    body += ` (${opts.assignedBy})`;
  } else if (
    opts?.sharedWithLabel &&
    !titleAlreadyListsPartners(body, opts.sharedWithLabel)
  ) {
    body += ` (עם ${opts.sharedWithLabel})`;
  }
  const standing =
    listType === "tasks" && Boolean(readText(item, ["חוזר", "recurrence_text"]));
  const linkedOnStanding = standing && itemHasLinkedReminder(item);
  if (listType === "tasks" || listType === "shopping") {
    const schedule = formatScheduleSuffix(item, listType, opts?.now);
    if (schedule) {
      body += ` ${schedule}`;
    }
  }
  // Standing + linked clock already folds into «(קבוע + תזכורת)» on the schedule.
  if (!linkedOnStanding) {
    const reminder = formatLinkedReminderParen(item, opts?.now);
    if (reminder) {
      body += ` ${reminder}`;
    }
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

/** True when the item carries a linked active-clock object (any non-array object). */
export function itemHasLinkedReminder(item: Record<string, unknown>): boolean {
  const raw = item.reminder;
  return Boolean(raw) && typeof raw === "object" && !Array.isArray(raw);
}

/** Standing / dated suffix: «— שני ושלישי ב־19:00 (קבוע)» or «— מחר ב־19:30».
 * Standing + linked clock → «(קבוע + תזכורת)» instead of a separate תזכורת paren.
 * Live `exceptions` append « · 18.10 ב־21:30» / « · 23.10 בוטל». */
export function formatScheduleSuffix(
  item: Record<string, unknown>,
  listType: string,
  now = new Date(),
): string {
  if (listType !== "tasks") {
    return "";
  }
  const extras = formatExceptionsSuffix(item.exceptions);
  const recurring = readText(item, ["חוזר", "recurrence_text"]);
  if (recurring) {
    const mark = itemHasLinkedReminder(item)
      ? "(קבוע + תזכורת)"
      : "(קבוע)";
    let base: string;
    if (/\(קבוע(?:\s*\+\s*תזכורת)?\)/.test(recurring)) {
      base = `— ${recurring.replace(/\(קבוע(?:\s*\+\s*תזכורת)?\)/g, mark)}`;
    } else if (/קבוע/.test(recurring)) {
      base = `— ${recurring}`;
    } else {
      base = `— ${recurring} ${mark}`;
    }
    return `${base}${extras}`;
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

/**
 * True when the item title already enumerates co-share partners inside `(…)`,
 * e.g. «פגישה (טל, עמית)» — so the dump must not also append «(עם עמית)».
 */
export function titleAlreadyListsPartners(
  title: string,
  partnerKey: string,
): boolean {
  const partners = partnerKey
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name !== "משותף");
  if (partners.length === 0) {
    return false;
  }
  const groups = [...title.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]);
  if (groups.length === 0) {
    return false;
  }
  const haystack = groups.join(" , ");
  return partners.every((name) => haystack.includes(name));
}

/**
 * Partner header body for `(עם …)` — never includes the viewer (by name or aliases).
 */
export function partnersKey(
  names: string[],
  viewerName: string,
  viewerAliases: string[] = [],
): string {
  const excluded = new Set(
    [viewerName, ...viewerAliases]
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const partners = names
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name) => !excluded.has(name));
  return partners.length > 0 ? partners.join(", ") : "משותף";
}

/** List-level files only (`has_attachments` / list attachments) — not item roll-up. */
function listHasListLevelFiles(
  list: EmployeeRecordSnapshot["lists"][number],
): boolean {
  const row = list as Record<string, unknown>;
  if (row.has_attachments === true) {
    return true;
  }
  return hasAttachments(row);
}

function paperclipSuffix(show: boolean): string {
  return show ? " 📎" : "";
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
