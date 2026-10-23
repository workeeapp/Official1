/**
 * Engine dump from model `show_dump` (+ section/partner). Builds the spoken
 * reply from the same live snapshot as EMPLOYEE_SAVED_DATA.
 * Dump intent never comes from free-form user text — only ACTION fields, or a
 * closed equality allowlist of known UI button command strings.
 */
import {
  addJerusalemDays,
  normalizeShowDumpListName,
  type LlmShowDumpSection,
} from "@workee/shared";
import {
  hebrewWeekdayFromYmd,
  jerusalemYmd,
} from "../utils/relative-date.js";
import {
  builtinListHebrew,
  builtinListTypeFromHebrew,
  isBuiltinListType,
  SHOW_FILINGS_COMMAND,
  SHOW_REMINDERS_COMMAND,
  showListButtonCommand,
  staticShowButtonDumpMap,
} from "./builtin-lists.js";
import type { EmployeeRecordSnapshot } from "./employee-records.service.js";
import type { ReminderSnapshotRow } from "./reminder.service.js";

export {
  SHOW_REMINDERS_COMMAND,
  SHOW_FILINGS_COMMAND,
  SHOW_LIST_PREFIX,
} from "./builtin-lists.js";

/** Opaque button payloads the engine emits — equality only, no prefix/regex. */
const STATIC_SHOW_BUTTON_DUMP = staticShowButtonDumpMap();

const TITLE_KEYS: Record<string, string[]> = {
  shopping: ["שם פריט", "name", "item_name"],
  tasks: ["שם מטלה", "name", "task", "item_name"],
  contacts: ["שם פרטי", "first_name", "name"],
};

export type ShowDumpOptions = {
  /**
   * Subject of the dump (speaker, or about-person when show_dump_about).
   * Omitted from co-share / partner filter keys.
   */
  viewerName?: string;
  /** Extra viewer labels (nickname + legal name) so partner keys never keep the viewer. */
  viewerAliases?: string[];
  now?: Date;
  /** shopping/tasks: personal | shared | omit for full dump (filters rows). */
  section?: LlmShowDumpSection | null;
  /**
   * With section=shared: keep rows whose partnerFilterKey matches.
   * string | string[] — multiple = OR.
   */
  partner?: string | string[] | null;
  /**
   * Responsibility filter: `self` | display name(s).
   * string | string[] — multiple = OR.
   * `self` matches assigneeSelfNames (speaker), even when dumping about someone else.
   */
  assignee?: string | string[] | null;
  /** When assignee=self — speaker display names / nicknames. */
  assigneeSelfNames?: string[];
  /** Inclusive YYYY-MM-DD — tasks/reminders only. */
  dateFrom?: string | null;
  /** Inclusive YYYY-MM-DD — tasks/reminders only. */
  dateTo?: string | null;
  /**
   * Urgency filter: urgent = urgent|very_urgent; very_urgent = only that.
   * null = no filter.
   */
  urgency?: "urgent" | "very_urgent" | null;
  /**
   * shopping/tasks: one header with counts only (no item lines).
   * Used by show_dump=full for קניות.
   */
  countsOnly?: boolean;
  /**
   * Digital-worker book: one numbered list without assign/co-share marks
   * (`assigned_by` means asker, not human co-share).
   */
  flatLayout?: boolean;
  /** SPEAKER_CONTACTS rows for show_dump=full / phone_book ספר הטלפונים. */
  phoneBook?: PhoneBookDumpRow[];
  /**
   * When true, empty dumps stay "" (no Hebrew empty sentence).
   * Used before composeTasksDumpWithWaiting so emptiness is structural.
   */
  omitEmptySentence?: boolean;
};

/** Phone-book dump row (directory / SPEAKER_CONTACTS). */
export type PhoneBookDumpRow = {
  name: string;
  phone?: string;
  scope?: "personal" | "shared";
  /** Partner display names when shared (may include owner). */
  shared_with?: string[];
};

/** Normalize dump filter name(s) to a trimmed list. */
export function dumpFilterNames(
  value: string | string[] | null | undefined,
): string[] {
  if (value == null) {
    return [];
  }
  const parts = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = typeof part === "string" ? part.trim() : "";
    if (trimmed && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  }
  return out;
}

function partnerFilterLabel(partners: string[]): string {
  if (partners.length === 0) {
    return "";
  }
  if (partners.length === 1) {
    return partners[0]!;
  }
  return partners.join(" או ");
}

/**
 * Closed allowlist: exact UI button command → show_dump value.
 * Custom lists: only when command equals «הצג רשימת <list_name>» for a live
 * custom list in the snapshot (opaque button id), never free-form variants.
 */
export function mapShowButtonCommandToDump(
  text: string,
  snapshot?: Pick<EmployeeRecordSnapshot, "lists"> | null,
): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const staticKind = STATIC_SHOW_BUTTON_DUMP[trimmed];
  if (staticKind) {
    return staticKind;
  }
  if (!snapshot) {
    return null;
  }
  for (const list of snapshot.lists) {
    if (list.list_type !== "custom") {
      continue;
    }
    const listName = (list.list_name ?? "").trim();
    if (!listName) {
      continue;
    }
    if (trimmed === showListButtonCommand(listName)) {
      return listName;
    }
  }
  return null;
}

/** True when the message is an exact known show-button command string. */
export function isKnownShowButtonCommand(
  text: string,
  snapshot?: Pick<EmployeeRecordSnapshot, "lists"> | null,
): boolean {
  return mapShowButtonCommandToDump(text, snapshot) !== null;
}

/** Map metadata.show_dump labels to a dump target (no section/polite stripping). */
export function resolveShowDumpKind(
  raw: string,
):
  | { kind: "full" }
  | { kind: "reminders" }
  | { kind: "filings" }
  | { kind: "phone_book" }
  | { kind: "list"; name: string }
  | null {
  const trimmed = normalizeShowDumpListName(raw);
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (
    lower === "full" ||
    trimmed === "הכל" ||
    trimmed === "סיכום" ||
    trimmed === "סיכום מלא"
  ) {
    return { kind: "full" };
  }
  if (
    lower === "reminders" ||
    trimmed === "תזכורות" ||
    trimmed === SHOW_REMINDERS_COMMAND
  ) {
    return { kind: "reminders" };
  }
  if (
    lower === "filings" ||
    trimmed === "תיוקים" ||
    trimmed === SHOW_FILINGS_COMMAND
  ) {
    return { kind: "filings" };
  }
  if (
    lower === "phone_book" ||
    lower === "phonebook" ||
    trimmed === "ספר הטלפונים"
  ) {
    return { kind: "phone_book" };
  }
  if (isBuiltinListType(lower)) {
    return {
      kind: "list",
      name: builtinListHebrew(lower),
    };
  }
  const fromHebrew = builtinListTypeFromHebrew(trimmed);
  if (fromHebrew) {
    return { kind: "list", name: builtinListHebrew(fromHebrew) };
  }
  return { kind: "list", name: trimmed };
}

/** One numbered dump line for LAST_NUMBERED_DUMP (model copies id on line-index turns). */
export type LastNumberedDumpLine = {
  n: number;
  id: string;
  kind: string;
  title_stem: string;
  /** When numbering restarts (day YMD, full-dump section, ממתינים). */
  section?: string;
};

type DumpTextResult = { text: string; lines: LastNumberedDumpLine[] };

function emptyDumpResult(text = ""): DumpTextResult {
  return { text, lines: [] };
}

export function formatLastNumberedDumpContext(
  lines: LastNumberedDumpLine[],
): string {
  if (lines.length === 0) {
    return "";
  }
  return [
    "LAST_NUMBERED_DUMP:",
    "Spoken dump indices («3» / «ל3» / «תמחק את 3») map to these rows from the last numbered dump. Copy id (+ kind) for that n; if section is set and several sections restart at 1, require a matching section or ASK which. Never invent ids. Never treat n as EMPLOYEE_SAVED_DATA array index.",
    JSON.stringify(lines),
  ].join("\n");
}

/** Dump from model `show_dump` (+ optional section/partner on opts). */
export function formatShowDumpFromKind(
  kind: string,
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): string | null {
  return formatShowDumpWithLineMap(kind, snapshot, opts).text;
}

/** Same dump text as formatShowDumpFromKind, plus LAST_NUMBERED_DUMP lines. */
export function formatShowDumpWithLineMap(
  kind: string,
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): { text: string | null; lines: LastNumberedDumpLine[] } {
  const resolved = resolveShowDumpKind(kind);
  if (!resolved) {
    return { text: null, lines: [] };
  }
  return formatResolvedShowDump(resolved, snapshot, opts);
}

function formatResolvedShowDump(
  parsed:
    | { kind: "full" }
    | { kind: "reminders" }
    | { kind: "filings" }
    | { kind: "phone_book" }
    | { kind: "list"; name: string },
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): { text: string | null; lines: LastNumberedDumpLine[] } {
  if (parsed.kind === "full") {
    const full = formatFullDump(snapshot, opts);
    return { text: full.text || null, lines: full.lines };
  }
  if (parsed.kind === "reminders") {
    const body = formatRemindersDump(snapshot.reminders ?? [], opts);
    if (body.text) {
      return body;
    }
    return {
      text: opts?.omitEmptySentence ? "" : "אין לך תזכורות פעילות כרגע.",
      lines: [],
    };
  }
  if (parsed.kind === "filings") {
    const body = formatFilingsDump(snapshot.filing ?? [], opts);
    if (body.text) {
      return body;
    }
    return {
      text: opts?.omitEmptySentence ? "" : emptyFilingsSentence(opts),
      lines: [],
    };
  }
  if (parsed.kind === "phone_book") {
    const body = formatPhoneBookDump(opts?.phoneBook, opts);
    if (body.text) {
      return body;
    }
    return {
      text: opts?.omitEmptySentence ? "" : emptyPhoneBookSentence(opts),
      lines: [],
    };
  }
  return formatListDump(parsed.name, snapshot, opts);
}

/** One-line empty when a focused shopping/tasks dump has nothing. */
export function emptyListDumpSentence(
  label: string,
  opts?: ShowDumpOptions,
): string {
  const section = opts?.section ?? null;
  const partnerFilters = dumpFilterNames(opts?.partner);
  if (section === "personal") {
    return `אין ${label} אישיות.`;
  }
  if (section === "shared" && partnerFilters.length > 0) {
    return `אין ${label} משותפות עם ${partnerFilterLabel(partnerFilters)}.`;
  }
  if (section === "shared") {
    return `אין ${label} משותפות.`;
  }
  return `אין ${label} שמורות.`;
}

/** Assign mark shown to both parties — no arrows, no bare name. */
export function formatAssignResponsibilityMark(
  assignee: string,
  assigner: string,
): string {
  const who = assignee.trim();
  const from = assigner.trim();
  if (who && from) {
    return `באחריות ${who} · מאת ${from}`;
  }
  if (who) {
    return `באחריות ${who}`;
  }
  if (from) {
    return `מאת ${from}`;
  }
  return "";
}

/** Parse assignee from «באחריות X · מאת Y». */
export function extractAssigneeFromMark(mark: string): string | undefined {
  const trimmed = mark.trim();
  const full = trimmed.match(/^באחריות\s+(.+?)\s+·\s+מאת\s+/);
  if (full?.[1]?.trim()) {
    return full[1].trim();
  }
  const only = trimmed.match(/^באחריות\s+(.+)$/);
  if (only?.[1]?.trim() && !only[1].includes("·")) {
    return only[1].trim();
  }
  return undefined;
}

function emptyFilingsSentence(opts?: ShowDumpOptions): string {
  const section = opts?.section ?? null;
  const partners = dumpFilterNames(opts?.partner);
  if (section === "shared" && partners.length > 0) {
    return `אין תיוקים משותפים עם ${partnerFilterLabel(partners)}.`;
  }
  if (section === "shared") {
    return "אין תיוקים משותפים.";
  }
  if (section === "personal") {
    return "אין תיוקים אישיים.";
  }
  return "אין תיוקים שמורים.";
}

function emptyPhoneBookSentence(opts?: ShowDumpOptions): string {
  const section = opts?.section ?? null;
  const partners = dumpFilterNames(opts?.partner);
  if (section === "shared" && partners.length > 0) {
    return `אין אנשי קשר בספר הטלפונים המשותף עם ${partnerFilterLabel(partners)}.`;
  }
  if (section === "shared" || partners.length > 0) {
    return "אין אנשי קשר משותפים בספר הטלפונים.";
  }
  if (section === "personal") {
    return "אין אנשי קשר אישיים בספר הטלפונים.";
  }
  return "ספר הטלפונים ריק.";
}

function emptyContactsSentence(opts?: ShowDumpOptions): string {
  const section = opts?.section ?? null;
  const partners = dumpFilterNames(opts?.partner);
  if (section === "shared" && partners.length > 0) {
    return `אין אנשי קשר משותפים עם ${partnerFilterLabel(partners)}.`;
  }
  if (section === "shared") {
    return "אין אנשי קשר משותפים.";
  }
  if (section === "personal") {
    return "אין אנשי קשר אישיים.";
  }
  return "אין אנשי קשר שמורים.";
}

function emptyFullDumpSentence(opts?: ShowDumpOptions): string {
  const partners = dumpFilterNames(opts?.partner);
  if (partners.length > 0) {
    return `אין לך מידע משותף עם ${partnerFilterLabel(partners)} כרגע.`;
  }
  if (opts?.section === "shared") {
    return "אין לך מידע משותף כרגע.";
  }
  if (opts?.section === "personal") {
    return "אין לך מידע אישי שמור כרגע.";
  }
  return "אין לך מידע שמור כרגע.";
}

/**
 * Bare overview («מה יש לי» / הציגי הכל): stitch Stage-2 category dumps.
 * Shopping = counts only; tasks = full item lines; custom = counts; then
 * reminders / filings / contacts / phone book.
 */
export function formatFullDump(
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): DumpTextResult {
  const sections: string[] = [];
  const lines: LastNumberedDumpLine[] = [];

  const pushBlock = (block: DumpTextResult | string, section?: string) => {
    if (typeof block === "string") {
      const trimmed = block.trim();
      if (trimmed) {
        sections.push(trimmed);
      }
      return;
    }
    const trimmed = block.text.trim();
    if (trimmed) {
      sections.push(trimmed);
    }
    for (const line of block.lines) {
      lines.push(
        section && !line.section ? { ...line, section } : line,
      );
    }
  };

  pushBlock(
    formatThreeWayDump("shopping", "קניות", snapshot, {
      ...opts,
      countsOnly: true,
    }),
  );
  pushBlock(formatThreeWayDump("tasks", "מטלות", snapshot, opts), "tasks");
  pushBlock(formatCustomListsCountsDump(snapshot, opts));

  const partnerNeedles = dumpFilterNames(opts?.partner);
  const partnerOnly =
    Boolean(opts?.section === "shared") || partnerNeedles.length > 0;

  const linkedIds = linkedReminderIdsFromTasks(snapshot);
  const partnerLinkedIds = partnerOnly
    ? linkedReminderIdsFromPartnerTasks(snapshot, opts)
    : new Set<string>();
  const reminderRows = (snapshot.reminders ?? []).filter((row) => {
    // Never re-list a clock already folded into a task line.
    if (linkedIds.has(row.reminder_id)) {
      return false;
    }
    if (partnerOnly) {
      return reminderInvolvesPartner(row, partnerNeedles, partnerLinkedIds);
    }
    return true;
  });
  const remBody = formatRemindersDump(reminderRows, opts, "reminders");
  if (remBody.text) {
    sections.push(`תזכורות פעילות:\n${remBody.text}`);
    lines.push(...remBody.lines);
  }

  pushBlock(formatFilingsDump(snapshot.filing ?? [], opts), "filings");

  const hasContacts = snapshot.lists.some(
    (list) => list.list_type === "contacts",
  );
  if (hasContacts) {
    const contacts = formatContactsOrCustomDump(
      "contacts",
      "",
      snapshot,
      builtinListHebrew("contacts"),
      opts,
    );
    if (contacts) {
      pushBlock(contacts, "contacts");
    }
  }

  pushBlock(formatPhoneBookDump(opts?.phoneBook, opts), "phone_book");

  if (sections.length === 0) {
    return emptyDumpResult(emptyFullDumpSentence(opts));
  }

  sections.push("לפירוט רשימה: הצג רשימת …");
  return { text: sections.join("\n\n"), lines };
}

function hebrewItemCount(n: number): string {
  return n === 1 ? "1 פריט" : `${n} פריטים`;
}

/**
 * Raw share names for custom full-dump count marks / partner filter.
 * Whole-list shared → list.shared_with; shared_items → item shared_with or owner;
 * else item co-share partners.
 */
function customListCountShareNames(
  list: EmployeeRecordSnapshot["lists"][number],
): string[] {
  if (list.scope === "shared") {
    return (list.shared_with ?? [])
      .map((name) => name.trim())
      .filter(Boolean);
  }
  if (list.scope === "shared_items") {
    const fromItems = list.items.flatMap((item) => stringArray(item.shared_with));
    if (fromItems.length > 0) {
      return fromItems;
    }
    const owner = (list.owner ?? "").trim();
    return owner ? [owner] : [];
  }
  return list.items.flatMap((item) => stringArray(item.shared_with));
}

function customListHasShareSignal(
  list: EmployeeRecordSnapshot["lists"][number],
): boolean {
  if (list.scope === "shared" || list.scope === "shared_items") {
    return true;
  }
  return list.items.some((item) => stringArray(item.shared_with).length > 0);
}

/** Custom lists: one count line each (FULL DUMP רשימות אחרות). */
function formatCustomListsCountsDump(
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): string {
  const customs = snapshot.lists.filter((list) => list.list_type === "custom");
  const viewer = opts?.viewerName?.trim() ?? "";
  const aliases = opts?.viewerAliases ?? [];
  const section = opts?.section ?? null;
  const partnerNeedles = dumpFilterNames(opts?.partner);
  const lines: string[] = [];
  for (const list of customs) {
    const hasShare = customListHasShareSignal(list);
    if (section === "personal" && (list.scope === "shared" || list.scope === "shared_items")) {
      continue;
    }
    if (section === "shared" && !hasShare) {
      continue;
    }
    const shareNames = customListCountShareNames(list);
    const partners =
      shareNames.length > 0
        ? partnersKey(shareNames, viewer, aliases)
        : "";
    if (
      partnerNeedles.length > 0 &&
      !partnerNeedles.some((needle) =>
        partnerBucketMatches(partners || "משותף", needle),
      )
    ) {
      continue;
    }
    const name = (list.list_name ?? "").trim() || "ללא שם";
    const n = list.items.length;
    if (n === 0) {
      continue;
    }
    // Display = all involved (מיכל, טל); filter key above stays partners-only.
    const mark =
      partners && partners !== "משותף"
        ? allInvolvedNames(shareNames, viewer, aliases)
        : "";
    const withMark = mark ? ` (${mark})` : "";
    lines.push(`*${name}*${withMark} — ${hebrewItemCount(n)}`);
  }
  if (lines.length === 0) {
    return "";
  }
  return ["רשימות אחרות:", ...lines].join("\n");
}

/**
 * Phone book dump — one header + co-share marks (same rules as contacts).
 */
export function formatPhoneBookDump(
  phoneBook: PhoneBookDumpRow[] | undefined,
  opts?: ShowDumpOptions,
): DumpTextResult {
  const rows = phoneBook ?? [];
  const viewer = (opts?.viewerName ?? "").trim();
  const aliases = (opts?.viewerAliases ?? []).map((name) => name.trim());
  const viewerNames = new Set(
    [viewer, ...aliases].map((name) => name.trim()).filter(Boolean),
  );
  const collected: DumpItem[] = rows.map((row) => {
    const name = row.name.trim() || "איש קשר";
    const phone = (row.phone ?? "").trim();
    const title = phone ? `${name} — ${phone}` : name;
    const sharedWith = (row.shared_with ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
    const partners = sharedWith.filter((value) => !viewerNames.has(value));
    const isShared = row.scope === "shared" && partners.length > 0;
    const allInvolved = isShared
      ? allInvolvedNames(sharedWith, viewer, aliases)
      : "";
    const partnerFilterKey = isShared
      ? partnersKey(sharedWith, viewer, aliases)
      : "";
    return {
      title,
      item: row as unknown as Record<string, unknown>,
      isShared,
      ...(partnerFilterKey ? { partnerFilterKey } : {}),
      ...(allInvolved ? { responsibilityMark: allInvolved } : {}),
    };
  });
  const kept = filterDumpRows(collected, "phone_book", opts);
  // Phone-book rows have no contact_id in the dump payload — omit LAST_NUMBERED_DUMP ids.
  const { text } = formatSingleHeaderDump("ספר הטלפונים", "phone_book", kept, opts);
  return { text, lines: [] };
}

/** Conditional watch clock («תעדכני אותי אם…») — gate is structured compose_condition. */
function isConditionalWatchReminder(
  rem: Pick<ReminderSnapshotRow, "compose_condition">,
): boolean {
  const gate = rem.compose_condition;
  return gate != null && typeof gate === "object" && !Array.isArray(gate);
}

/** reminder_ids of conditional watches — their worker tasks must not flood day agenda. */
function conditionalWatchReminderIds(
  reminders: ReminderSnapshotRow[],
): Set<string> {
  const ids = new Set<string>();
  for (const rem of reminders) {
    if (!isConditionalWatchReminder(rem)) {
      continue;
    }
    const id = rem.reminder_id?.trim();
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

/** reminder_id values already shown via LINKED REMINDER on a task line. */
function linkedReminderIdsFromTasks(
  snapshot: EmployeeRecordSnapshot,
): Set<string> {
  const ids = new Set<string>();
  for (const list of snapshot.lists) {
    if (list.list_type !== "tasks") {
      continue;
    }
    for (const item of list.items) {
      const id = reminderIdFromTaskItem(item);
      if (id) {
        ids.add(id);
      }
    }
  }
  return ids;
}

function reminderIdFromTaskItem(
  item: Record<string, unknown>,
): string | null {
  const raw = item.reminder;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const id = (raw as { reminder_id?: unknown }).reminder_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/**
 * Partner bucket key for a tasks item (same rules as formatThreeWayDump),
 * or null when the row is personal / unshared.
 */
export function taskItemPartnerBucketKey(
  list: EmployeeRecordSnapshot["lists"][number],
  item: Record<string, unknown>,
  viewer: string,
  aliases: string[],
): string | null {
  if (list.scope === "shared_items") {
    return (list.owner ?? "").trim() || "משותף";
  }
  if (list.scope === "shared") {
    return partnersKey(list.shared_with ?? [], viewer, aliases);
  }
  const assignedBy =
    typeof item.assigned_by === "string" ? item.assigned_by.trim() : "";
  if (assignedBy) {
    return assignedBy;
  }
  const sharedWith = stringArray(item.shared_with);
  if (sharedWith.length > 0) {
    return partnersKey(sharedWith, viewer, aliases);
  }
  return null;
}

/** Linked reminder ids on tasks that partner-bucket with the dump partner(s). */
export function linkedReminderIdsFromPartnerTasks(
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): Set<string> {
  const needles = dumpFilterNames(opts?.partner);
  const viewer = (opts?.viewerName ?? "").trim();
  const aliases = (opts?.viewerAliases ?? []).map((name) => name.trim());
  const ids = new Set<string>();
  if (needles.length === 0 && opts?.section !== "shared") {
    return ids;
  }
  for (const list of snapshot.lists) {
    if (list.list_type !== "tasks") {
      continue;
    }
    for (const item of list.items) {
      const bucket = taskItemPartnerBucketKey(list, item, viewer, aliases);
      if (!bucket) {
        continue;
      }
      if (
        needles.length > 0 &&
        !needles.some((needle) => partnerBucketMatches(bucket, needle))
      ) {
        continue;
      }
      const id = reminderIdFromTaskItem(item);
      if (id) {
        ids.add(id);
      }
    }
  }
  return ids;
}

/** Partner dump: clock involves partner via ping, about_ids, or linked shared task. */
export function reminderInvolvesPartner(
  row: ReminderSnapshotRow,
  partnerNeedles: string[],
  partnerLinkedIds: Set<string>,
): boolean {
  if (partnerLinkedIds.has(row.reminder_id)) {
    return true;
  }
  if (partnerNeedles.length === 0) {
    // section=shared with no named partner — keep clocks linked to any shared task.
    return false;
  }
  const pings = (row.ping ?? []).map((name) => name.trim()).filter(Boolean);
  if (
    partnerNeedles.some((needle) =>
      pings.some(
        (ping) => ping === needle || partnerBucketMatches(ping, needle),
      ),
    )
  ) {
    return true;
  }
  const about = (row.about ?? []).map((name) => name.trim()).filter(Boolean);
  return partnerNeedles.some((needle) =>
    about.some(
      (name) => name === needle || partnerBucketMatches(name, needle),
    ),
  );
}

/** Linked reminder on a task item is about one of the partner needles. */
export function itemReminderAboutMatchesPartner(
  item: Record<string, unknown>,
  partnerNeedles: string[],
): boolean {
  if (partnerNeedles.length === 0) {
    return false;
  }
  const raw = item.reminder;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  const rem = raw as Record<string, unknown>;
  const aboutNames = Array.isArray(rem.about)
    ? rem.about.map((value) => String(value).trim()).filter(Boolean)
    : [];
  return partnerNeedles.some((needle) =>
    aboutNames.some(
      (name) => name === needle || partnerBucketMatches(name, needle),
    ),
  );
}

/** Labeled filing line: «שם: … · תיאור: … · מידע לחיפוש: …» (תיאור = item_info; omit empty). */
export function formatFilingDumpBody(
  row: EmployeeRecordSnapshot["filing"][number],
): string {
  const parts: string[] = [];
  const name = row.item_name?.trim() ?? "";
  const info = row.item_info?.trim() ?? "";
  const findHelper = row.item_description?.trim() ?? "";
  if (name) {
    parts.push(`שם: ${name}`);
  }
  if (info) {
    parts.push(`תיאור: ${info}`);
  }
  if (findHelper) {
    parts.push(`מידע לחיפוש: ${findHelper}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "תיוק";
}

/**
 * Address text from a filing row for Waze: prefer item_info, else item_name
 * when the name encodes a place (כתובת / מגורים / …).
 */
export function filingDumpAddressText(
  row: EmployeeRecordSnapshot["filing"][number],
): string | null {
  const name = row.item_name?.trim() ?? "";
  const info = row.item_info?.trim() ?? "";
  if (!/כתובת|מגורים|address|מיקום|רחוב/i.test(name)) {
    return null;
  }
  return info || name || null;
}

/** Filings visible under section/partner (same set as the dump lines). */
export function visibleFilingsForDump(
  rows: EmployeeRecordSnapshot["filing"],
  opts?: ShowDumpOptions,
): EmployeeRecordSnapshot["filing"] {
  const viewer = (opts?.viewerName ?? "").trim();
  const aliases = (opts?.viewerAliases ?? []).map((name) => name.trim());
  const section = opts?.section ?? null;
  const partnerNeedles = dumpFilterNames(opts?.partner);
  const viewerNames = new Set(
    [viewer, ...aliases].map((name) => name.trim()).filter(Boolean),
  );
  const out: EmployeeRecordSnapshot["filing"] = [];
  for (const row of rows) {
    const partners = (row.shared_with ?? [])
      .map((name) => name.trim())
      .filter(Boolean)
      .filter((name) => !viewerNames.has(name));
    // Same as contacts: shared section only when a non-viewer partner remains.
    const isShared = row.scope === "shared" && partners.length > 0;
    if (isShared) {
      if (section === "personal") {
        continue;
      }
      if (
        partnerNeedles.length > 0 &&
        !partnerNeedles.some(
          (needle) =>
            partners.some((name) => name.includes(needle)) ||
            partners.join(", ").includes(needle),
        )
      ) {
        continue;
      }
      out.push(row);
    } else if (section !== "shared") {
      out.push(row);
    }
  }
  return out;
}

/**
 * When a filings dump shows exactly one address-bearing row, that address for Waze.
 */
export function navigateAddressFromFilingsDump(
  rows: EmployeeRecordSnapshot["filing"],
  opts?: ShowDumpOptions,
): string | null {
  const addresses = visibleFilingsForDump(rows, opts)
    .map(filingDumpAddressText)
    .filter((value): value is string => Boolean(value));
  return addresses.length === 1 ? addresses[0]! : null;
}

/**
 * Filings dump — one header; co-share `(A, B)` and assign `(באחריות X · מאת Y)`
 * same as shopping/tasks.
 */
export function formatFilingsDump(
  rows: EmployeeRecordSnapshot["filing"],
  opts?: ShowDumpOptions,
): DumpTextResult {
  const viewer = (opts?.viewerName ?? "").trim();
  const aliases = (opts?.viewerAliases ?? []).map((name) => name.trim());
  const viewerNames = new Set(
    [viewer, ...aliases].map((name) => name.trim()).filter(Boolean),
  );
  const collected: DumpItem[] = rows.map((row) => {
    const title = formatFilingDumpBody(row);
    const assignedBy = (row.assigned_by ?? "").trim();
    const sharedWith = (row.shared_with ?? [])
      .map((name) => name.trim())
      .filter(Boolean);
    const partners = sharedWith.filter((name) => !viewerNames.has(name));
    if (assignedBy && partners.length === 0) {
      const owner = (row.owner ?? "").trim();
      const assignee = owner || viewer;
      const mark = formatAssignResponsibilityMark(assignee, assignedBy);
      return {
        title,
        item: row as unknown as Record<string, unknown>,
        isShared: true,
        partnerFilterKey: assignedBy,
        assigneeName: assignee || undefined,
        ...(mark ? { responsibilityMark: mark } : {}),
      };
    }
    const isShared = row.scope === "shared" && partners.length > 0;
    const allInvolved = isShared
      ? allInvolvedNames(sharedWith, viewer, aliases)
      : "";
    const partnerFilterKey = isShared
      ? partnersKey(sharedWith, viewer, aliases)
      : "";
    return {
      title,
      item: row as unknown as Record<string, unknown>,
      isShared,
      ...(partnerFilterKey ? { partnerFilterKey } : {}),
      ...(allInvolved ? { responsibilityMark: allInvolved } : {}),
    };
  });
  const kept = filterDumpRows(collected, "filings", opts);
  return formatSingleHeaderDump("תיוקים", "filings", kept, opts);
}

function formatRemindersDump(
  rows: ReminderSnapshotRow[],
  opts?: ShowDumpOptions,
  section?: string,
): DumpTextResult {
  const now = opts?.now ?? new Date();
  const active = rows.filter((row) => {
    if (row.status !== "active") {
      return false;
    }
    return reminderMatchesDateRange(row, opts?.dateFrom, opts?.dateTo);
  });
  if (active.length === 0) {
    return emptyDumpResult();
  }
  const lines: LastNumberedDumpLine[] = [];
  const text = active
    .map((row, index) => {
      const n = index + 1;
      const stem = row.item.trim() || "תזכורת";
      let title = stem;
      if (hasAttachments(row)) {
        title += " 📎";
      }
      const when = formatReminderWhen(row, now);
      const id = row.reminder_id?.trim() ?? "";
      if (id) {
        lines.push({
          n,
          id,
          kind: "reminders",
          title_stem: stem,
          ...(section ? { section } : {}),
        });
      }
      return when ? `${n}. ${title} — ${when}` : `${n}. ${title}`;
    })
    .join("\n");
  return { text, lines };
}

/** YYYY-MM-DD from a date / datetime string. */
export function ymdFromDumpValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1]! : null;
}

function ymdInInclusiveRange(
  ymd: string,
  from: string | null | undefined,
  to: string | null | undefined,
): boolean {
  if (from && ymd < from) {
    return false;
  }
  if (to && ymd > to) {
    return false;
  }
  return true;
}

/**
 * Tasks: keep when date span [תאריך לביצוע, תאריך סיום] or any
 * next_occurrences day intersects [from, to]. No date filter → keep all.
 * Untimed / undated rows drop out when a range is set.
 */
export function itemMatchesDateRange(
  item: Record<string, unknown>,
  dateFrom?: string | null,
  dateTo?: string | null,
): boolean {
  const from = dateFrom?.trim().slice(0, 10) || null;
  const to = dateTo?.trim().slice(0, 10) || null;
  if (!from && !to) {
    return true;
  }
  const start = ymdFromDumpValue(item["תאריך לביצוע"] ?? item.date);
  const end = ymdFromDumpValue(item["תאריך סיום"]) ?? start;
  if (start && end) {
    // [start, end] intersects [from, to] (inclusive; null bound = open).
    if ((!from || end >= from) && (!to || start <= to)) {
      return true;
    }
  }
  const next = item.next_occurrences;
  if (Array.isArray(next)) {
    for (const occ of next) {
      const ymd = ymdFromDumpValue(occ);
      if (ymd && ymdInInclusiveRange(ymd, from, to)) {
        return true;
      }
    }
  }
  return false;
}

/** Reminders: filter by fire_at calendar day when a dump date range is set. */
export function reminderMatchesDateRange(
  row: Pick<ReminderSnapshotRow, "fire_at" | "next_occurrences">,
  dateFrom?: string | null,
  dateTo?: string | null,
): boolean {
  const from = dateFrom?.trim().slice(0, 10) || null;
  const to = dateTo?.trim().slice(0, 10) || null;
  if (!from && !to) {
    return true;
  }
  const ymd = ymdFromDumpValue(row.fire_at);
  if (ymd && ymdInInclusiveRange(ymd, from, to)) {
    return true;
  }
  const next = row.next_occurrences;
  if (Array.isArray(next)) {
    for (const occ of next) {
      const occYmd = ymdFromDumpValue(occ);
      if (occYmd && ymdInInclusiveRange(occYmd, from, to)) {
        return true;
      }
    }
  }
  return false;
}

function hasDumpDateRange(opts?: ShowDumpOptions): boolean {
  return Boolean(opts?.dateFrom?.trim() || opts?.dateTo?.trim());
}

type AgendaSlot = {
  ymd: string;
  /** Sort key HH:mm or empty for all-day. */
  sortHm: string;
  id: string;
  kind: "tasks" | "reminders";
  title_stem: string;
  /** Fully formatted numbered line (number filled when emitting). */
  formatLine: (n: number) => string;
};

/**
 * Day-agenda layout for tasks dumps with show_dump_from/to.
 * Expands next_occurrences into day buckets; each row uses the shared standing/ping mark.
 * Unlinked clocks in range appear as their own lines; linked clocks stay folded into the task.
 */
export function formatTasksDayAgendaDump(
  rows: Array<{
    title: string;
    item: Record<string, unknown>;
    responsibilityMark?: string;
  }>,
  reminders: ReminderSnapshotRow[],
  opts?: ShowDumpOptions,
  /** reminder_ids already folded into a task line — never list again. */
  linkedReminderIds: Set<string> = new Set(),
): DumpTextResult {
  const from = opts?.dateFrom?.trim().slice(0, 10) || null;
  const to = opts?.dateTo?.trim().slice(0, 10) || null;
  const now = opts?.now ?? new Date();
  const slots: AgendaSlot[] = [];
  // Same rule as clocks: mashov/market/… watches are the digital worker's job.
  // Their standing worker task still carries interval next_occurrences (every
  // 5–60m) — without this skip, one Friday button prints the same line ~24–288×.
  const watchReminderIds = conditionalWatchReminderIds(reminders);

  for (const row of rows) {
    const linkedId = reminderIdFromTaskItem(row.item);
    if (linkedId && watchReminderIds.has(linkedId)) {
      continue;
    }
    slots.push(...expandTaskAgendaSlots(row, from, to, now));
  }

  const partnerNeedles = dumpFilterNames(opts?.partner);
  const partnerOnly =
    Boolean(opts?.section === "shared") || partnerNeedles.length > 0;

  for (const rem of reminders) {
    if (rem.status !== "active") {
      continue;
    }
    if (linkedReminderIds.has(rem.reminder_id)) {
      continue;
    }
    // Conditional watches (compose_condition) are the digital worker's job —
    // ping=speaker makes them visible in the snapshot, but they must not flood
    // the speaker's day agenda (hourly expansion etc.). Inventory / about=worker.
    if (isConditionalWatchReminder(rem)) {
      continue;
    }
    if (partnerOnly) {
      // Partner day-agenda: only clocks that ping the partner.
      if (!reminderInvolvesPartner(rem, partnerNeedles, new Set())) {
        continue;
      }
    }
    slots.push(...expandReminderAgendaSlots(rem, from, to, now));
  }

  if (slots.length === 0) {
    return emptyDumpResult();
  }

  slots.sort((a, b) => {
    if (a.ymd !== b.ymd) {
      return a.ymd.localeCompare(b.ymd);
    }
    if (a.sortHm !== b.sortHm) {
      if (!a.sortHm) {
        return 1;
      }
      if (!b.sortHm) {
        return -1;
      }
      return a.sortHm.localeCompare(b.sortHm);
    }
    return 0;
  });

  const byDay = new Map<string, AgendaSlot[]>();
  for (const slot of slots) {
    const bucket = byDay.get(slot.ymd) ?? [];
    bucket.push(slot);
    byDay.set(slot.ymd, bucket);
  }

  const textLines: string[] = [];
  const mapLines: LastNumberedDumpLine[] = [];
  const dayKeys = [...byDay.keys()].sort();
  if (from && to && from !== to) {
    textLines.push(formatAgendaWindowHeader(from, to));
    textLines.push("");
  }
  for (const ymd of dayKeys) {
    const daySlots = byDay.get(ymd) ?? [];
    textLines.push(formatDayAgendaHeader(ymd));
    daySlots.forEach((slot, i) => {
      const n = i + 1;
      textLines.push(slot.formatLine(n));
      if (slot.id) {
        mapLines.push({
          n,
          id: slot.id,
          kind: slot.kind,
          title_stem: slot.title_stem,
          section: ymd,
        });
      }
    });
    textLines.push("");
  }
  return { text: textLines.join("\n").trim(), lines: mapLines };
}

function expandTaskAgendaSlots(
  row: {
    title: string;
    item: Record<string, unknown>;
    responsibilityMark?: string;
  },
  from: string | null,
  to: string | null,
  now: Date,
): AgendaSlot[] {
  const item = row.item;
  const recurring = readText(item, ["חוזר", "recurrence_text"]);
  const next = item.next_occurrences;
  if (recurring && Array.isArray(next) && next.length > 0) {
    const slots: AgendaSlot[] = [];
    // One slot per calendar day — interval polls (כל 5 דקות / כל שעה) must not
    // mint a numbered line for every fire time on that day.
    const seenDays = new Set<string>();
    for (const occ of next) {
      const ymd = ymdFromDumpValue(occ);
      if (!ymd || !ymdInInclusiveRange(ymd, from, to)) {
        continue;
      }
      if (seenDays.has(ymd)) {
        continue;
      }
      seenDays.add(ymd);
      const hm =
        extractHmFromText(recurring) ?? hmFromDumpValue(occ) ?? "";
      const stem = row.title.trim() || "מטלה";
      const id = String(item.item_id ?? "").trim();
      slots.push({
        ymd,
        sortHm: hm,
        id,
        kind: "tasks",
        title_stem: stem,
        formatLine: (n) =>
          formatAgendaStandingLine(n, row.title, item, hm, {
            responsibilityMark: row.responsibilityMark,
            now,
          }),
      });
    }
    return slots;
  }

  const start = ymdFromDumpValue(item["תאריך לביצוע"] ?? item.date);
  const end = ymdFromDumpValue(item["תאריך סיום"]) ?? start;
  if (!start) {
    return [];
  }
  const time = readText(item, ["שעה לביצוע", "time", "שעה"]);
  const hm = time ? normalizeHm(time) : "";
  // Multi-day span: one slot on the first day that intersects the window.
  const ymd =
    from && start < from && end && end >= from
      ? from
      : start;
  if (!ymdInInclusiveRange(ymd, from, to)) {
    return [];
  }
  const oneOffStem = row.title.trim() || "מטלה";
  const oneOffId = String(item.item_id ?? "").trim();
  return [
    {
      ymd,
      sortHm: hm,
      id: oneOffId,
      kind: "tasks",
      title_stem: oneOffStem,
      formatLine: (n) =>
        formatAgendaOneOffLine(n, row.title, item, hm, {
          responsibilityMark: row.responsibilityMark,
          now,
        }),
    },
  ];
}

function expandReminderAgendaSlots(
  row: ReminderSnapshotRow,
  from: string | null,
  to: string | null,
  now: Date,
): AgendaSlot[] {
  const next = row.next_occurrences;
  if (Array.isArray(next) && next.length > 0) {
    const slots: AgendaSlot[] = [];
    // One clock line per day (interval series otherwise floods the agenda).
    const seenDays = new Set<string>();
    const seriesHm =
      extractHmFromText(row.recurrence_text ?? "") ??
      hmFromDumpValue(row.fire_at) ??
      "";
    for (const occ of next) {
      const ymd = ymdFromDumpValue(occ);
      if (!ymd || !ymdInInclusiveRange(ymd, from, to)) {
        continue;
      }
      if (seenDays.has(ymd)) {
        continue;
      }
      seenDays.add(ymd);
      const hm = seriesHm || hmFromDumpValue(occ) || "";
      const stem = row.item.trim() || "תזכורת";
      slots.push({
        ymd,
        sortHm: hm,
        id: row.reminder_id?.trim() ?? "",
        kind: "reminders",
        title_stem: stem,
        formatLine: (n) => formatAgendaReminderLine(n, row, hm, now),
      });
    }
    if (slots.length > 0) {
      return slots;
    }
  }
  const ymd = ymdFromDumpValue(row.fire_at);
  if (!ymd || !ymdInInclusiveRange(ymd, from, to)) {
    return [];
  }
  const hm = hmFromDumpValue(row.fire_at) ?? "";
  const stem = row.item.trim() || "תזכורת";
  return [
    {
      ymd,
      sortHm: hm,
      id: row.reminder_id?.trim() ?? "",
      kind: "reminders",
      title_stem: stem,
      formatLine: (n) => formatAgendaReminderLine(n, row, hm, now),
    },
  ];
}

/** HH:mm from «YYYY-MM-DD HH:mm» / ISO-ish dump values. */
function hmFromDumpValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(/(?:^|\s)(\d{1,2}:\d{2})(?:\s|$)/);
  return match ? normalizeHm(match[1]) : null;
}

/** «ראשון 18.10:» */
export function formatDayAgendaHeader(ymd: string): string {
  const weekday = hebrewWeekdayFromYmd(ymd.trim().slice(0, 10));
  const short = formatShortDayMonth(ymd);
  return weekday ? `${weekday} ${short}:` : `${short}:`;
}

/** «מה־18 עד 24.10:» / «מה־28.9 עד 4.10:» */
export function formatAgendaWindowHeader(from: string, to: string): string {
  const fromParts = parseYmdParts(from);
  const toParts = parseYmdParts(to);
  if (!fromParts || !toParts) {
    return `מה־${from} עד ${to}:`;
  }
  if (fromParts.month === toParts.month && fromParts.year === toParts.year) {
    return `מה־${fromParts.day} עד ${toParts.day}.${toParts.month}:`;
  }
  return `מה־${fromParts.day}.${fromParts.month} עד ${toParts.day}.${toParts.month}:`;
}

function parseYmdParts(
  ymd: string,
): { year: number; month: number; day: number } | null {
  const match = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function formatShortDayMonth(ymd: string): string {
  const parts = parseYmdParts(ymd);
  if (!parts) {
    return ymd.trim();
  }
  return `${parts.day}.${parts.month}`;
}

/**
 * Standing occurrence under a day header — same schedule suffix as the flat
 * tasks dump (`formatScheduleSuffix`), so series + exceptions stay consistent
 * («כל שני ורביעי ב־19:00 (קבוע) · 28.10 ב־18:00»). Day bucketing still uses
 * occurrence HM only for sort/filter; it is not a second display dialect.
 */
export function formatAgendaStandingLine(
  n: number,
  title: string,
  item: Record<string, unknown>,
  _occurrenceHm: string,
  opts?: { responsibilityMark?: string; now?: Date },
): string {
  let body = title.trim() || "פריט";
  if (hasAttachments(item)) {
    body += " 📎";
  }
  if (hasLinkedLists(item)) {
    body += " 🗂️";
  }
  body += taskPlacePhoneMarks(item);
  if (opts?.responsibilityMark?.trim()) {
    const mark = opts.responsibilityMark.trim();
    if (!titleAlreadyListsPartners(body, mark)) {
      body += ` (${mark})`;
    }
  }
  const suffix = formatScheduleSuffix(
    item,
    "tasks",
    opts?.now ?? new Date(),
  );
  if (suffix) {
    body += ` ${suffix}`;
  }
  return wrapUrgencyLine(`${n}. ${body}`, item.urgency);
}

/** One-off under a day header: chore HM + optional «(תזכורת: …)» via shared paren helper. */
export function formatAgendaOneOffLine(
  n: number,
  title: string,
  item: Record<string, unknown>,
  occurrenceHm: string,
  opts?: { responsibilityMark?: string; now?: Date },
): string {
  let body = title.trim() || "פריט";
  if (hasAttachments(item)) {
    body += " 📎";
  }
  if (hasLinkedLists(item)) {
    body += " 🗂️";
  }
  body += taskPlacePhoneMarks(item);
  if (opts?.responsibilityMark?.trim()) {
    const mark = opts.responsibilityMark.trim();
    if (!titleAlreadyListsPartners(body, mark)) {
      body += ` (${mark})`;
    }
  }
  const hm = occurrenceHm.trim();
  if (hm) {
    body += ` — ${hm}`;
  }
  const reminder = formatLinkedReminderParen(item, opts?.now);
  if (reminder) {
    body += ` ${reminder}`;
  }
  return wrapUrgencyLine(`${n}. ${body}`, item.urgency);
}

/** Clock-only agenda line: «1. title — 09:00 (קבוע כל יום)». */
export function formatAgendaReminderLine(
  n: number,
  row: ReminderSnapshotRow,
  occurrenceHm: string,
  now = new Date(),
): string {
  let title = row.item.trim() || "תזכורת";
  if (hasAttachments(row)) {
    title += " 📎";
  }
  const hm = occurrenceHm.trim() || hmFromDumpValue(row.fire_at) || "";
  const hasExceptions = exceptionLabels(row.exceptions).length > 0;
  const cadence = standingCadenceParen(
    shortCadenceParen(row.recurrence_text, row.repeat, {
      keepSeriesClock: hasExceptions,
    }),
  );
  let body = title;
  if (hm) {
    body += ` — ${hm}`;
  } else {
    const relative = formatRelativeFireAt(row.fire_at, now);
    if (relative) {
      body += ` — ${relative}`;
    }
  }
  if (cadence) {
    body += ` ${cadence}`;
  }
  const extras = formatExceptionsSuffix(row.exceptions);
  return `${n}. ${body}${extras}`;
}

function wrapUrgencyLine(line: string, urgency: unknown): string {
  if (urgency === "urgent" || urgency === "very_urgent") {
    let out = `«${line}»`;
    if (urgency === "very_urgent") {
      out += " ‼️";
    }
    return out;
  }
  return line;
}

/**
 * Next fire + optional short cadence: «היום ב־19:00 (קבוע כל יום)» / «8.5.2027 ב־13:00 (קבוע כל שנה)».
 * One-off moves/cancels always append ` · 18.10 ב־21:30` from snapshot `exceptions`
 * (even when that day is already the primary `fire_at`) so standing + exception stay visible.
 * Cadence paren is labeled «קבוע …» so the series rule is not read as the next-fire time.
 * `flatCadence`: linked-task `(תזכורת: …)` uses « · קבוע כל יום» (no nested paren).
 */
export function formatReminderWhen(
  row: Pick<
    ReminderSnapshotRow,
    "fire_at" | "repeat" | "recurrence_text" | "exceptions"
  >,
  now = new Date(),
  opts?: { flatCadence?: boolean },
): string {
  const fireAt = row.fire_at?.trim() || "";
  const hasExceptions = exceptionLabels(row.exceptions).length > 0;
  const cadence = standingCadenceParen(
    shortCadenceParen(row.recurrence_text, row.repeat, {
      keepSeriesClock: hasExceptions,
    }),
  );
  const extras = formatExceptionsSuffix(row.exceptions);
  if (!fireAt) {
    const base = cadence.replace(/^\(|\)$/g, "");
    return base ? `${base}${extras}` : extras.replace(/^\s*·\s*/, "");
  }
  const relative = formatRelativeFireAt(fireAt, now);
  let when = relative;
  if (cadence) {
    if (opts?.flatCadence) {
      const flat = cadence.replace(/^\(|\)$/g, "").trim();
      when = flat ? `${relative} · ${flat}` : relative;
    } else {
      when = `${relative} ${cadence}`;
    }
  }
  return `${when}${extras}`;
}

/** «(כל יום)» → «(קבוע כל יום)» so reminder dumps name the standing rule. */
export function standingCadenceParen(cadence: string): string {
  const trimmed = cadence.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    return trimmed;
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner || inner.startsWith("קבוע")) {
    return trimmed;
  }
  return `(קבוע ${inner})`;
}

/** « · 18.10 ב־21:30» / « · 23.10 בוטל» from snapshot exception labels. */
export function formatExceptionsSuffix(exceptions: unknown): string {
  const labels = exceptionLabels(exceptions);
  return labels.length ? ` · ${labels.join(" · ")}` : "";
}

function exceptionLabels(exceptions: unknown): string[] {
  if (!Array.isArray(exceptions) || exceptions.length === 0) {
    return [];
  }
  return exceptions
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * «(כל יום)» / «(כל שנה)» from recurrence_text — strips time, calendar clause, until, count.
 * With keepSeriesClock (when exceptions exist): keep « ב־HH:mm» so the series time
 * stays visible next to a moved fire_at.
 */
export function shortCadenceParen(
  recurrenceText?: string | null,
  repeat?: string | null,
  options?: { keepSeriesClock?: boolean },
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
  if (!options?.keepSeriesClock) {
    // Drop trailing clock « ב־19:00» / range « ב־19:00–20:00».
    base = base.replace(/\s+ב־\d{1,2}:\d{2}(?:–\d{1,2}:\d{2})?/g, "");
  }
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
): { text: string | null; lines: LastNumberedDumpLine[] } {
  const name = normalizeShowDumpListName(rawName);
  const builtin = builtinListTypeFromHebrew(name);
  const omitEmpty = opts?.omitEmptySentence === true;
  if (builtin === "shopping" || builtin === "tasks") {
    const label = builtinListHebrew(builtin);
    const body = formatThreeWayDump(builtin, label, snapshot, opts);
    if (body.text) {
      return body;
    }
    if (omitEmpty) {
      return emptyDumpResult("");
    }
    if (builtin === "tasks" && hasDumpDateRange(opts)) {
      return emptyDumpResult("אין מטלות בטווח התאריכים.");
    }
    return emptyDumpResult(emptyListDumpSentence(label, opts));
  }
  if (builtin === "contacts") {
    const body = formatContactsOrCustomDump(
      "contacts",
      "",
      snapshot,
      builtinListHebrew("contacts"),
      opts,
    );
    if (body === null) {
      return { text: null, lines: [] };
    }
    if (body.text) {
      return body;
    }
    return emptyDumpResult(omitEmpty ? "" : emptyContactsSentence(opts));
  }
  const customBody = formatContactsOrCustomDump(
    "custom",
    name,
    snapshot,
    name,
    opts,
  );
  if (customBody === null) {
    return { text: null, lines: [] };
  }
  if (customBody.text) {
    return customBody;
  }
  if (omitEmpty) {
    return emptyDumpResult("");
  }
  return emptyDumpResult(emptyCustomListSentence(name, snapshot, opts));
}

type DumpItem = {
  title: string;
  item: Record<string, unknown>;
  /**
   * Mark body (no parens): co-share «מיכל, טל»; assign «באחריות מיכל · מאת טל».
   */
  responsibilityMark?: string;
  /** List-level 📎 for this row's source list. */
  listFiles?: boolean;
  /** True when row is assign / co-share / shared list / shared_items. */
  isShared?: boolean;
  /** Partner filter key (assigner, co-share partners, list owner, …). */
  partnerFilterKey?: string;
  /** Sole assignee when this is an assign row (for באחריות filter). */
  assigneeName?: string;
};

type ListDumpType =
  | "shopping"
  | "tasks"
  | "contacts"
  | "custom"
  | "filings"
  | "phone_book";

/** 0 = personal, 1 = co-share / whole shared list, 2 = assign. */
function dumpItemKindRank(row: DumpItem): number {
  const mark = row.responsibilityMark?.trim() ?? "";
  if (
    Boolean(row.assigneeName?.trim()) ||
    mark.startsWith("באחריות")
  ) {
    return 2;
  }
  if (row.isShared === true) {
    return 1;
  }
  return 0;
}

/** Stable cluster: personal → co-share → assign (one header, no sub-blocks). */
export function clusterDumpRowsByKind<T extends DumpItem>(rows: T[]): T[] {
  return [...rows]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const delta = dumpItemKindRank(a.row) - dumpItemKindRank(b.row);
      return delta !== 0 ? delta : a.index - b.index;
    })
    .map(({ row }) => row);
}

/**
 * Row mark for shopping/tasks (assign vs co-share). Worker flatLayout skips marks.
 */
function resolveShoppingTasksRowMeta(
  list: EmployeeRecordSnapshot["lists"][number],
  item: Record<string, unknown>,
  title: string,
  viewer: string,
  aliases: string[],
  skipMarks: boolean,
): Pick<
  DumpItem,
  "responsibilityMark" | "isShared" | "partnerFilterKey" | "assigneeName"
> {
  if (skipMarks) {
    return { isShared: false };
  }
  if (list.scope === "shared") {
    return {
      isShared: true,
      partnerFilterKey: partnersKey(list.shared_with ?? [], viewer, aliases),
    };
  }
  if (list.scope === "shared_items") {
    const owner = (list.owner ?? "").trim() || "משותף";
    const sharedWith = stringArray(item.shared_with);
    if (sharedWith.length > 0) {
      const allInvolved = allInvolvedNames(sharedWith, viewer, aliases);
      const showMark =
        Boolean(allInvolved) && !titleAlreadyListsPartners(title, allInvolved);
      return {
        isShared: true,
        partnerFilterKey: partnersKey(sharedWith, viewer, aliases),
        ...(showMark ? { responsibilityMark: allInvolved } : {}),
      };
    }
    const assignedBy =
      typeof item.assigned_by === "string" ? item.assigned_by.trim() : "";
    const assigner = assignedBy || viewer;
    const mark = formatAssignResponsibilityMark(owner, assigner);
    return {
      isShared: true,
      partnerFilterKey: owner,
      assigneeName: owner,
      ...(mark ? { responsibilityMark: mark } : {}),
    };
  }
  const assignedBy =
    typeof item.assigned_by === "string" ? item.assigned_by.trim() : "";
  if (assignedBy) {
    const assignee =
      (list.owner ?? "").trim() ||
      viewer ||
      (aliases.map((name) => name.trim()).find(Boolean) ?? "");
    const mark = formatAssignResponsibilityMark(assignee, assignedBy);
    return {
      isShared: true,
      partnerFilterKey: assignedBy,
      assigneeName: assignee || undefined,
      ...(mark ? { responsibilityMark: mark } : {}),
    };
  }
  const sharedWith = stringArray(item.shared_with);
  if (sharedWith.length > 0) {
    const allInvolved = allInvolvedNames(sharedWith, viewer, aliases);
    const showMark =
      Boolean(allInvolved) && !titleAlreadyListsPartners(title, allInvolved);
    return {
      isShared: true,
      partnerFilterKey: partnersKey(sharedWith, viewer, aliases),
      ...(showMark ? { responsibilityMark: allInvolved } : {}),
    };
  }
  return { isShared: false };
}

function collectListDumpRows(
  listType: ListDumpType,
  lists: EmployeeRecordSnapshot["lists"],
  opts?: ShowDumpOptions,
): DumpItem[] {
  const viewer = opts?.viewerName?.trim() ?? "";
  const aliases = (opts?.viewerAliases ?? []).map((name) => name.trim());
  const skipMarks = opts?.flatLayout === true && (listType === "shopping" || listType === "tasks");
  const rows: DumpItem[] = [];

  for (const list of lists) {
    const listFiles = listHasListLevelFiles(list);
    for (const item of list.items) {
      const title =
        listType === "custom"
          ? formatCustomItemBody(item, list.title_field, list.columns)
          : itemTitle(listType, item, list.title_field);

      if (listType === "custom") {
        const mark = customItemCoShareMark(list, item, viewer, aliases);
        const isShared =
          list.scope === "shared" ||
          list.scope === "shared_items" ||
          Boolean(mark);
        const partnerFilterKey = mark
          ? partnersKey(
              stringArray(item.shared_with).length > 0
                ? stringArray(item.shared_with)
                : [(list.owner ?? "").trim()].filter(Boolean),
              viewer,
              aliases,
            )
          : list.scope === "shared"
            ? partnersKey(list.shared_with ?? [], viewer, aliases)
            : "";
        rows.push({
          title,
          item,
          listFiles,
          isShared,
          ...(partnerFilterKey ? { partnerFilterKey } : {}),
          ...(mark ? { responsibilityMark: mark } : {}),
        });
        continue;
      }

      if (listType === "contacts") {
        let mark: string | undefined;
        let isShared = false;
        let partnerFilterKey = "";
        if (list.scope === "shared") {
          isShared = true;
          const itemPartners = stringArray(item.shared_with);
          const names =
            itemPartners.length > 0
              ? itemPartners
              : (list.shared_with ?? []);
          partnerFilterKey = partnersKey(names, viewer, aliases);
          const allInvolved = allInvolvedNames(names, viewer, aliases);
          if (allInvolved && !titleAlreadyListsPartners(title, allInvolved)) {
            mark = allInvolved;
          }
        } else if (list.scope === "shared_items") {
          isShared = true;
          const owner = (list.owner ?? "").trim();
          const itemPartners = stringArray(item.shared_with);
          const names =
            itemPartners.length > 0
              ? itemPartners
              : owner
                ? [owner]
                : [];
          partnerFilterKey = partnersKey(names, viewer, aliases);
          const allInvolved = allInvolvedNames(
            names.length > 0 ? names : [owner].filter(Boolean),
            viewer,
            aliases,
          );
          if (allInvolved && !titleAlreadyListsPartners(title, allInvolved)) {
            mark = allInvolved;
          }
        } else {
          const sharedWith = stringArray(item.shared_with);
          const itemScoped =
            item.scope === "shared" && sharedWith.length > 0;
          if (itemScoped) {
            isShared = true;
            partnerFilterKey = partnersKey(sharedWith, viewer, aliases);
            const allInvolved = allInvolvedNames(sharedWith, viewer, aliases);
            if (allInvolved && !titleAlreadyListsPartners(title, allInvolved)) {
              mark = allInvolved;
            }
          }
        }
        rows.push({
          title,
          item,
          listFiles,
          isShared,
          ...(partnerFilterKey ? { partnerFilterKey } : {}),
          ...(mark ? { responsibilityMark: mark } : {}),
        });
        continue;
      }

      const meta = resolveShoppingTasksRowMeta(
        list,
        item,
        title,
        viewer,
        aliases,
        skipMarks,
      );
      rows.push({
        title,
        item,
        listFiles,
        ...meta,
      });
    }
  }
  return rows;
}

function filterDumpRows(
  rows: DumpItem[],
  listType: ListDumpType,
  opts?: ShowDumpOptions,
): DumpItem[] {
  const section = opts?.section ?? null;
  const partnerFilters = dumpFilterNames(opts?.partner);

  let kept = rows.filter((row) => {
    const shared = row.isShared === true;
    if (section === "personal" && shared) {
      return false;
    }
    if (section === "shared" && !shared) {
      return false;
    }
    if (partnerFilters.length > 0) {
      const key = row.partnerFilterKey ?? "";
      if (
        !partnerFilters.some((needle) =>
          partnerBucketMatches(key || "משותף", needle),
        )
      ) {
        return false;
      }
    }
    if (
      !itemMatchesAssigneeFilter(
        row.responsibilityMark,
        opts,
        row.assigneeName,
      )
    ) {
      return false;
    }
    if (!itemMatchesUrgencyFilter(row.item, opts?.urgency)) {
      return false;
    }
    if (
      listType === "tasks" &&
      !itemMatchesDateRange(row.item, opts?.dateFrom, opts?.dateTo)
    ) {
      return false;
    }
    return true;
  });

  // Partner-filtered tasks: also keep personal about-X rows.
  if (
    listType === "tasks" &&
    section === "shared" &&
    partnerFilters.length > 0
  ) {
    const seen = new Set(
      kept.map((row) => String(row.item.item_id ?? "")).filter(Boolean),
    );
    for (const row of rows) {
      if (row.isShared) {
        continue;
      }
      if (!itemReminderAboutMatchesPartner(row.item, partnerFilters)) {
        continue;
      }
      if (
        !itemMatchesAssigneeFilter(
          row.responsibilityMark,
          opts,
          row.assigneeName,
        ) ||
        !itemMatchesUrgencyFilter(row.item, opts?.urgency) ||
        !itemMatchesDateRange(row.item, opts?.dateFrom, opts?.dateTo)
      ) {
        continue;
      }
      const id = String(row.item.item_id ?? "");
      if (id && seen.has(id)) {
        continue;
      }
      if (id) {
        seen.add(id);
      }
      kept = [...kept, row];
    }
  }

  return clusterDumpRowsByKind(kept);
}

/**
 * FULL DUMP shopping count line label for one bucket (no leading spaces).
 * Personal → «אישיות»; co-share/assign → «(mark)» all-involved / באחריות.
 */
function shoppingCountBucketLabel(
  row: DumpItem,
  viewer: string,
  aliases: string[],
): { kind: number; label: string } {
  const kind = dumpItemKindRank(row);
  const mark = row.responsibilityMark?.trim() ?? "";
  if (kind === 2) {
    if (mark) {
      return { kind, label: `(${mark})` };
    }
    const who = row.assigneeName?.trim();
    return {
      kind,
      label: who ? `(באחריות ${who})` : "(באחריות)",
    };
  }
  if (kind === 1) {
    if (mark) {
      return { kind, label: `(${mark})` };
    }
    const key = (row.partnerFilterKey ?? "").trim();
    if (!key || key === "משותף") {
      return { kind, label: "(משותף)" };
    }
    const names = key
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const involved = allInvolvedNames(names, viewer, aliases);
    return {
      kind,
      label: involved ? `(${involved})` : "(משותף)",
    };
  }
  return { kind: 0, label: "אישיות" };
}

/** FULL DUMP קניות: breakdown by personal / co-share / assign (counts only). */
function formatShoppingCountsBreakdown(
  label: string,
  rows: DumpItem[],
  opts?: ShowDumpOptions,
): string {
  if (rows.length === 0) {
    return "";
  }
  const viewer = opts?.viewerName?.trim() ?? "";
  const aliases = (opts?.viewerAliases ?? []).map((name) => name.trim());
  const headerFiles = rows.some((row) => row.listFiles);
  const groups = new Map<
    string,
    { kind: number; label: string; count: number; order: number }
  >();
  let order = 0;
  for (const row of rows) {
    const bucket = shoppingCountBucketLabel(row, viewer, aliases);
    const existing = groups.get(bucket.label);
    if (existing) {
      existing.count += 1;
      continue;
    }
    groups.set(bucket.label, {
      kind: bucket.kind,
      label: bucket.label,
      count: 1,
      order: order++,
    });
  }
  const sorted = [...groups.values()].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind - b.kind;
    }
    return a.order - b.order;
  });
  return [
    `${label}${paperclipSuffix(headerFiles)}:`,
    ...sorted.map(
      (group) => `${group.label} — ${hebrewItemCount(group.count)}`,
    ),
  ].join("\n");
}

function dumpItemId(listType: ListDumpType, item: Record<string, unknown>): string {
  if (listType === "filings") {
    return String(item.filing_id ?? "").trim();
  }
  if (listType === "phone_book") {
    return "";
  }
  return String(item.item_id ?? "").trim();
}

function dumpItemTitleStem(
  listType: ListDumpType,
  row: DumpItem,
): string {
  const item = row.item;
  if (listType === "shopping") {
    return (
      readText(item, TITLE_KEYS.shopping) ||
      row.title.replace(/\s*-\s*\d+\s*$/, "").trim() ||
      "פריט"
    );
  }
  if (listType === "tasks") {
    return readText(item, TITLE_KEYS.tasks) || row.title.trim() || "מטלה";
  }
  if (listType === "contacts") {
    return readText(item, TITLE_KEYS.contacts) || row.title.trim() || "איש קשר";
  }
  if (listType === "filings") {
    return String(item.item_name ?? "").trim() || row.title.trim() || "תיוק";
  }
  if (listType === "custom") {
    return row.title.trim() || "פריט";
  }
  return row.title.trim() || "פריט";
}

function formatSingleHeaderDump(
  label: string,
  listType: ListDumpType,
  rows: DumpItem[],
  opts?: ShowDumpOptions,
  reminders: ReminderSnapshotRow[] = [],
  linkedReminderIds: Set<string> = new Set(),
): DumpTextResult {
  const headerFiles = rows.some((row) => row.listFiles);
  if (opts?.countsOnly === true) {
    if (listType === "shopping") {
      return emptyDumpResult(formatShoppingCountsBreakdown(label, rows, opts));
    }
    const n = rows.length;
    return emptyDumpResult(
      n === 0
        ? ""
        : `${label}${paperclipSuffix(headerFiles)}: ${hebrewItemCount(n)}`,
    );
  }
  if (listType === "tasks" && hasDumpDateRange(opts)) {
    return formatTasksDayAgendaDump(rows, reminders, opts, linkedReminderIds);
  }
  if (rows.length === 0) {
    return emptyDumpResult();
  }
  const lines: LastNumberedDumpLine[] = [];
  const text = [
    `${label}${paperclipSuffix(headerFiles)}:`,
    ...rows.map((row, i) => {
      const n = i + 1;
      const id = dumpItemId(listType, row.item);
      if (id) {
        lines.push({
          n,
          id,
          kind: listType,
          title_stem: dumpItemTitleStem(listType, row),
        });
      }
      return formatNumberedItem(n, row.title, row.item, listType, {
        responsibilityMark: row.responsibilityMark,
        now: opts?.now,
      });
    }),
  ].join("\n");
  return { text, lines };
}

function formatThreeWayDump(
  listType: "shopping" | "tasks",
  label: string,
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): DumpTextResult {
  const lists = snapshot.lists.filter((list) => list.list_type === listType);
  const collected = collectListDumpRows(listType, lists, opts);
  const kept = filterDumpRows(collected, listType, opts);
  return formatSingleHeaderDump(
    label,
    listType,
    kept,
    opts,
    snapshot.reminders ?? [],
    linkedReminderIdsFromTasks(snapshot),
  );
}

/** Co-share mark: partners then viewer — e.g. «מיכל, טל». */
export function allInvolvedNames(
  names: string[],
  viewerName: string,
  viewerAliases: string[] = [],
): string {
  const viewer = viewerName.trim();
  const partners = partnersKey(names, viewerName, viewerAliases);
  if (!viewer) {
    return partners === "משותף" ? "" : partners;
  }
  if (!partners || partners === "משותף") {
    return viewer;
  }
  return `${partners}, ${viewer}`;
}

/** Urgency dump filter: urgent = urgent|very_urgent; very_urgent = exact. */
export function itemMatchesUrgencyFilter(
  item: Record<string, unknown>,
  urgency?: "urgent" | "very_urgent" | null,
): boolean {
  if (!urgency) {
    return true;
  }
  const value = item.urgency;
  if (urgency === "very_urgent") {
    return value === "very_urgent";
  }
  return value === "urgent" || value === "very_urgent";
}

/** Assignee filter against assign row / mark (sole assignee only when filter set). */
export function itemMatchesAssigneeFilter(
  responsibilityMark: string | undefined,
  opts?: Pick<ShowDumpOptions, "assignee" | "assigneeSelfNames" | "viewerName" | "viewerAliases">,
  assigneeName?: string,
): boolean {
  const assignees = dumpFilterNames(opts?.assignee);
  if (assignees.length === 0) {
    return true;
  }
  const mark = (responsibilityMark ?? "").trim();
  const sole =
    (assigneeName ?? "").trim() ||
    extractAssigneeFromMark(mark) ||
    "";
  // Multi-party co-share has no single owner — drop when filtering by assignee.
  if (!sole && (mark.includes(",") || mark.includes("·"))) {
    return false;
  }
  const matchAgainst = sole || mark;
  if (!matchAgainst) {
    return false;
  }
  // Each assignee is OR'd; `self` = speaking human only (assigneeSelfNames).
  const selfNames = (opts?.assigneeSelfNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  return assignees.some((raw) => {
    const needles =
      raw.toLowerCase() === "self" ? selfNames : [raw];
    return needles.some((name) => name === matchAgainst);
  });
}

/** Drop list items whose item_id is in `itemIds` (OPEN_JOBS shadows before dump). */
export function excludeItemIdsFromSnapshot(
  snapshot: EmployeeRecordSnapshot,
  itemIds: ReadonlySet<string>,
): EmployeeRecordSnapshot {
  if (itemIds.size === 0) {
    return snapshot;
  }
  return {
    ...snapshot,
    lists: snapshot.lists
      .map((list) => ({
        ...list,
        items: list.items.filter((raw) => {
          const item = raw as Record<string, unknown>;
          const id =
            typeof item.item_id === "string"
              ? item.item_id.trim()
              : typeof item.itemId === "string"
                ? item.itemId.trim()
                : typeof item.id === "string"
                  ? item.id.trim()
                  : "";
          return !id || !itemIds.has(id);
        }),
      }))
      .filter((list) => list.items.length > 0),
  };
}

/**
 * Stitch a tasks dump with an optional ממתינים (OPEN_JOBS) block.
 * Empty tasks ("" / null) + waiting → waiting only. No Hebrew parsing.
 */
export function composeTasksDumpWithWaiting(
  tasksDump: string | null,
  waitingDump: string,
): string | null {
  const waiting = waitingDump.trim();
  const tasks = (tasksDump ?? "").trim();
  if (!waiting) {
    return tasks || null;
  }
  if (!tasks) {
    return waiting;
  }
  return `${tasks}\n\n${waiting}`;
}

/** True when show_dump resolves to the built-in tasks list. */
export function isTasksShowDumpKind(kind: string): boolean {
  const resolved = resolveShowDumpKind(kind);
  return resolved?.kind === "list" && resolved.name === "מטלות";
}

/**
 * Non-owner ABOUT X: keep only rows involving that person from the speaker's
 * already-visible snapshot (no private rows of X).
 */
export function filterSnapshotForAboutPerson(
  snapshot: EmployeeRecordSnapshot,
  aboutName: string,
  aboutAliases: string[] = [],
): EmployeeRecordSnapshot {
  const needles = new Set(
    [aboutName, ...aboutAliases]
      .map((name) => name.trim())
      .filter(Boolean),
  );
  if (needles.size === 0) {
    return { lists: [], filing: [], reminders: [] };
  }
  const nameHit = (value: string | undefined | null) =>
    Boolean(value && needles.has(value.trim()));
  const namesHit = (values: string[] | undefined) =>
    (values ?? []).some((name) => nameHit(name));

  const lists = snapshot.lists
    .map((list) => {
      if (list.list_type === "custom") {
        if (list.scope === "shared_items" && nameHit(list.owner)) {
          return list;
        }
        if (list.scope === "shared" && namesHit(list.shared_with)) {
          return list;
        }
        if (nameHit(list.owner) || namesHit(list.shared_with)) {
          return list;
        }
        const items = list.items.filter((item) =>
          namesHit(stringArray(item.shared_with)),
        );
        if (items.length === 0) {
          return null;
        }
        return { ...list, items };
      }
      if (list.list_type !== "shopping" && list.list_type !== "tasks" && list.list_type !== "contacts") {
        // Other non-builtin: keep if owner is about or shared_with includes them.
        if (nameHit(list.owner) || namesHit(list.shared_with)) {
          return list;
        }
        return null;
      }
      if (list.scope === "shared_items" && nameHit(list.owner)) {
        return list;
      }
      if (list.scope === "shared" && namesHit(list.shared_with)) {
        return list;
      }
      if (list.scope === "personal" || !list.scope) {
        if (nameHit(list.owner)) {
          return list;
        }
        const items = list.items.filter((item) => {
          const assignedBy =
            typeof item.assigned_by === "string" ? item.assigned_by.trim() : "";
          if (nameHit(assignedBy)) {
            return true;
          }
          return namesHit(stringArray(item.shared_with));
        });
        if (items.length === 0) {
          return null;
        }
        return { ...list, items };
      }
      return null;
    })
    .filter((row): row is EmployeeRecordSnapshot["lists"][number] => row !== null);

  const filing = (snapshot.filing ?? []).filter((row) => {
    if (nameHit(row.owner)) {
      return true;
    }
    return namesHit(row.shared_with);
  });

  return { lists, filing, reminders: [] };
}

/** Partner bucket key contains the requested partner name (exact segment). */
export function partnerBucketMatches(
  bucketKey: string,
  partner: string,
): boolean {
  const needle = partner.trim();
  if (!needle) {
    return true;
  }
  if (bucketKey === needle) {
    return true;
  }
  return bucketKey.split(",").some((part) => part.trim() === needle);
}

/**
 * Row mark for a custom-list item: assign `(באחריות X · מאת Y)` or co-share
 * `(A, B)`. Whole-list scope=shared → no per-line mark.
 */
export function customItemCoShareMark(
  list: EmployeeRecordSnapshot["lists"][number],
  item: Record<string, unknown>,
  viewerName: string,
  viewerAliases: string[] = [],
): string | undefined {
  if (list.scope === "shared") {
    return undefined;
  }
  const assignedBy =
    typeof item.assigned_by === "string" ? item.assigned_by.trim() : "";
  const sharedWith = stringArray(item.shared_with);
  if (assignedBy && sharedWith.length === 0) {
    const owner = (list.owner ?? "").trim() || viewerName.trim();
    const mark = formatAssignResponsibilityMark(owner, assignedBy);
    return mark.trim() ? mark : undefined;
  }
  if (sharedWith.length > 0) {
    const mark = allInvolvedNames(sharedWith, viewerName, viewerAliases);
    return mark.trim() ? mark : undefined;
  }
  if (list.scope === "shared_items") {
    const owner = (list.owner ?? "").trim();
    if (!owner) {
      return undefined;
    }
    if (assignedBy) {
      const mark = formatAssignResponsibilityMark(owner, assignedBy);
      return mark.trim() ? mark : undefined;
    }
    const mark = allInvolvedNames([owner], viewerName, viewerAliases);
    return mark.trim() ? mark : undefined;
  }
  return undefined;
}

function formatContactsOrCustomDump(
  listType: "contacts" | "custom",
  listName: string,
  snapshot: EmployeeRecordSnapshot,
  emptyLabel: string,
  opts?: ShowDumpOptions,
): DumpTextResult | null {
  const normalizedListName = normalizeShowDumpListName(listName);
  const lists = snapshot.lists.filter((list) => {
    if (list.list_type !== listType) {
      return false;
    }
    if (listType === "contacts") {
      return true;
    }
    return (
      (list.list_name ?? "").trim() === normalizedListName
    );
  });
  if (lists.length === 0) {
    const label = normalizeShowDumpListName(emptyLabel) || emptyLabel;
    return emptyDumpResult(`לא מצאתי רשימה בשם «${label}».`);
  }
  const collected = collectListDumpRows(listType, lists, opts);
  const kept = filterDumpRows(collected, listType, opts);
  if (kept.length === 0) {
    return emptyDumpResult();
  }
  const header =
    listType === "contacts" ? emptyLabel : `רשימת «${emptyLabel}»`;
  return formatSingleHeaderDump(header, listType, kept, opts);
}

/** Focused custom-list empty sentence (not used in FULL DUMP sections). */
function emptyCustomListSentence(
  listName: string,
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): string {
  const name = listName.trim() || "ללא שם";
  const lists = snapshot.lists.filter(
    (list) =>
      list.list_type === "custom" && (list.list_name ?? "").trim() === name,
  );
  const listFiles = lists.some((list) => listHasListLevelFiles(list));
  const section = opts?.section ?? null;
  const partnerNeedles = dumpFilterNames(opts?.partner);
  if (section === "shared" || partnerNeedles.length > 0) {
    return `רשימת «${name}»${paperclipSuffix(listFiles)} — אין פריטים משותפים תואמים.`;
  }
  if (section === "personal") {
    return `רשימת «${name}»${paperclipSuffix(listFiles)} — אין פריטים אישיים.`;
  }
  return `רשימת «${name}»${paperclipSuffix(listFiles)} ריקה.`;
}

/**
 * Drop `ב־HH:mm` from a dump title when it matches chore `שעה לביצוע`
 * (synced into שם מטלה by applyTimeToTaskLabel) so we do not print
 * «ב־09:00 — 09:00».
 */
export function stripMatchingTitleClock(title: string, hm: string): string {
  const want = normalizeHm(hm);
  if (!want) {
    return title.trim();
  }
  return title
    .replace(/\s*ב־(\d{1,2}:\d{2})\b/g, (full, clock: string) =>
      normalizeHm(clock) === want ? "" : full,
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Linked reminder is a series (not a one-shot). */
export function linkedReminderIsRecurring(item: Record<string, unknown>): boolean {
  const raw = item.reminder;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  const reminder = raw as Record<string, unknown>;
  const recurrenceText =
    typeof reminder.recurrence_text === "string"
      ? reminder.recurrence_text.trim()
      : "";
  if (recurrenceText) {
    return true;
  }
  const repeat =
    typeof reminder.repeat === "string" ? reminder.repeat.trim() : "";
  return Boolean(repeat) && repeat !== "none" && repeat !== "once";
}

/** Exported for unit tests. */
export function formatNumberedItem(
  n: number,
  title: string,
  item: Record<string, unknown>,
  listType: string,
  opts?: {
    /** Assign = assignee only; co-share = all involved — no «עם» prefix. */
    responsibilityMark?: string;
    /** @deprecated Stage-1 assign mark — prefer responsibilityMark. */
    assignedBy?: string;
    /** @deprecated Stage-1 co-share — prefer responsibilityMark (no עם). */
    sharedWithLabel?: string;
    now?: Date;
  },
): string {
  let body = title.trim() || "פריט";
  const choreTimeRaw =
    listType === "tasks" || listType === "shopping"
      ? readText(item, ["שעה לביצוע", "time", "שעה"])
      : "";
  const choreHm = choreTimeRaw ? normalizeHm(choreTimeRaw) : "";
  if (choreHm) {
    body = stripMatchingTitleClock(body, choreHm) || "פריט";
  }
  if (hasAttachments(item)) {
    body += " 📎";
  }
  if (hasLinkedLists(item)) {
    body += " 🗂️";
  }
  if (listType === "tasks") {
    body += taskPlacePhoneMarks(item);
  }
  // responsibilityMark = co-share «(מיכל, טל)» or assign «(באחריות … · מאת …)».
  // sharedWithLabel is legacy; prefer responsibilityMark (no «עם»).
  if (opts?.responsibilityMark?.trim()) {
    const mark = opts.responsibilityMark.trim();
    if (!titleAlreadyListsPartners(body, mark)) {
      body += ` (${mark})`;
    }
  } else if (opts?.assignedBy?.trim()) {
    body += ` (${opts.assignedBy.trim()})`;
  } else if (
    opts?.sharedWithLabel?.trim() &&
    !titleAlreadyListsPartners(body, opts.sharedWithLabel.trim())
  ) {
    body += ` (${opts.sharedWithLabel.trim()})`;
  }
  const standing =
    listType === "tasks" && Boolean(readText(item, ["חוזר", "recurrence_text"]));
  const linkedOnStanding = standing && itemHasLinkedReminder(item);
  const reminderHm = linkedReminderSeriesHm(item);
  // Worker daily sends often have linked recurring clock + שעה לביצוע but no חוזר.
  const foldRecurringWithoutStanding =
    listType === "tasks" &&
    !standing &&
    linkedReminderIsRecurring(item) &&
    Boolean(choreHm) &&
    Boolean(reminderHm) &&
    choreHm === reminderHm;
  if (listType === "tasks" || listType === "shopping") {
    const schedule = formatScheduleSuffix(item, listType, opts?.now);
    if (schedule) {
      body += ` ${schedule}`;
    }
  }
  // Standing + linked clock folds into «(קבוע + תזכורת)» on the schedule suffix.
  // Matching chore HM + recurring linked (no חוזר) uses the same fold mark.
  if (foldRecurringWithoutStanding) {
    body += ` ${standingLinkedReminderMark(item, `ב־${choreHm}`)}`;
  } else if (!linkedOnStanding) {
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

/**
 * Standing + linked clock mark. Same when as the chore → «(קבוע + תזכורת)»;
 * different time → «(קבוע + תזכורת ב־20:45)»; different calendar day →
 * «(קבוע + תזכורת ב־8.5.2027 ב־13:00)». Same rule for any task (not birthday-only).
 */
export function standingLinkedReminderMark(
  item: Record<string, unknown>,
  standingRuleText: string,
): string {
  if (!itemHasLinkedReminder(item)) {
    return "(קבוע)";
  }
  const taskYmd = taskEventYmd(item);
  const remYmd = linkedReminderYmd(item);
  const taskHm = extractHmFromText(standingRuleText);
  const reminderHm = linkedReminderSeriesHm(item);
  if (taskYmd && remYmd && taskYmd !== remYmd) {
    const day = formatDisplayDate(remYmd);
    return reminderHm
      ? `(קבוע + תזכורת ב־${day} ב־${reminderHm})`
      : `(קבוע + תזכורת ב־${day})`;
  }
  if (reminderHm && reminderHm !== taskHm) {
    return `(קבוע + תזכורת ב־${reminderHm})`;
  }
  return "(קבוע + תזכורת)";
}

/** HH:mm from «ב־21:00» / «ב־21:00–22:00» in product-Hebrew rule text. */
function extractHmFromText(text: string): string | null {
  const match = text.match(/ב־(\d{1,2}:\d{2})/);
  return match ? normalizeHm(match[1]) : null;
}

/** Task event day YYYY-MM-DD from תאריך לביצוע or first next_occurrence. */
function taskEventYmd(item: Record<string, unknown>): string | null {
  const date = readText(item, ["תאריך לביצוע", "date"]).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return date;
  }
  const next = item.next_occurrences;
  if (Array.isArray(next) && typeof next[0] === "string") {
    const ymd = next[0].trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      return ymd;
    }
  }
  return null;
}

/** Linked reminder fire day YYYY-MM-DD (Jerusalem wall from fire_at). */
function linkedReminderYmd(item: Record<string, unknown>): string | null {
  const raw = item.reminder;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const fireAt = String((raw as Record<string, unknown>).fire_at ?? "").trim();
  if (!fireAt) {
    return null;
  }
  const space = fireAt.match(/^(\d{4}-\d{2}-\d{2})(?:\s|$)/);
  if (space) {
    return space[1]!;
  }
  const iso = Date.parse(fireAt);
  if (!Number.isNaN(iso)) {
    return jerusalemYmd(new Date(iso));
  }
  return null;
}

/** Series ping HH:mm from linked `reminder` (recurrence_text first, else fire_at). */
function linkedReminderSeriesHm(item: Record<string, unknown>): string | null {
  const raw = item.reminder;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const reminder = raw as Record<string, unknown>;
  const recurrenceText =
    typeof reminder.recurrence_text === "string"
      ? reminder.recurrence_text.trim()
      : "";
  const fromRule = extractHmFromText(recurrenceText);
  if (fromRule) {
    return fromRule;
  }
  const fireAt =
    typeof reminder.fire_at === "string" ? reminder.fire_at.trim() : "";
  const fromFire = fireAt.match(/(?:^|\s)(\d{1,2}:\d{2})(?:\s|$)/);
  return fromFire ? normalizeHm(fromFire[1]) : null;
}

/** Standing / dated suffix: «— שני ושלישי ב־19:00 (קבוע)» or «— מחר ב־19:30».
 * Standing + linked clock → «(קבוע + תזכורת)» / «(קבוע + תזכורת ב־20:45)» when ping ≠ chore time.
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
    const mark = standingLinkedReminderMark(item, recurring);
    let base: string;
    if (/\(קבוע(?:\s*\+\s*תזכורת(?:\s+ב־[^)]+)?)?\)/.test(recurring)) {
      base = `— ${recurring.replace(/\(קבוע(?:\s*\+\s*תזכורת(?:\s+ב־[^)]+)?)?\)/g, mark)}`;
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

/** «(תזכורת: היום ב־20:30)» — flat cadence « · קבוע כל יום» (no nested paren). */
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
  const exceptions = Array.isArray(reminder.exceptions)
    ? reminder.exceptions.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : undefined;
  const when = formatReminderWhen(
    {
      fire_at: fireAt,
      repeat,
      recurrence_text: recurrenceText || undefined,
      ...(exceptions ? { exceptions } : {}),
    },
    now,
    { flatCadence: true },
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
 * Non-viewer partners joined as «A, B» — never includes the viewer (by name or aliases).
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

const CUSTOM_META_KEYS = new Set([
  "item_id",
  "scope",
  "owner",
  "urgency",
  "shared_with",
  "assigned_by",
  "attachments",
  "linked_lists",
  "linked_from_items",
  "reminder",
  "חוזר",
  "recurrence_text",
  "תאריך לביצוע",
  "שעה לביצוע",
  "תאריך סיום",
  "שעת סיום",
  "next_occurrences",
  "done_dates",
  "exceptions",
  "יום בשבוע",
  "יום בשבוע סיום",
]);

/**
 * Custom list line: every non-empty column as «מפתח: ערך», joined with ·.
 * Includes title_field. Example: «שם: טל · תיאור: נשוי למיכל».
 */
export function formatCustomItemBody(
  item: Record<string, unknown>,
  titleField?: string,
  columns?: string[],
): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  const pushField = (key: string, value: unknown) => {
    const col = key.trim();
    if (!col || CUSTOM_META_KEYS.has(col) || seen.has(col)) {
      return;
    }
    if (typeof value !== "string" || !value.trim()) {
      return;
    }
    seen.add(col);
    parts.push(`${col}: ${value.trim()}`);
  };

  if (Array.isArray(columns) && columns.length > 0) {
    for (const col of columns) {
      if (typeof col !== "string") {
        continue;
      }
      pushField(col, item[col.trim()]);
    }
  } else {
    const titleKey = (titleField ?? "").trim();
    if (titleKey) {
      pushField(titleKey, item[titleKey]);
    }
    for (const [key, value] of Object.entries(item)) {
      pushField(key, value);
    }
  }

  return parts.length > 0 ? parts.join(" · ") : "פריט";
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
      if (CUSTOM_META_KEYS.has(key)) {
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

/** Tasks host with one or more linked shopping/custom lists. */
function hasLinkedLists(row: Record<string, unknown>): boolean {
  const linked = row.linked_lists;
  return Array.isArray(linked) && linked.length > 0;
}

/** Task dump marks: 📍 when כתובת set, 📞 when טלפון set (after 📎/🗂️). */
export function taskPlacePhoneMarks(item: Record<string, unknown>): string {
  let marks = "";
  if (readText(item, ["כתובת", "address"])) {
    marks += " 📍";
  }
  if (readText(item, ["טלפון", "phone", "telephone"])) {
    marks += " 📞";
  }
  return marks;
}
