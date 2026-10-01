import { parseReminderInterval } from "./reminder-interval.js";

export interface ParsedLlmMessage {
  response: string;
  actions: string[];
}

export type LlmListType = "shopping" | "contacts" | "tasks" | "custom";
export type LlmListActionName = "add" | "remove" | "update";
export type LlmFilingActionName = "add_filing" | "remove_filing" | "update_filing";

export interface LlmListAction {
  action: LlmListActionName;
  listType: LlmListType;
  listName: string;
  items: Record<string, unknown>[];
  targets: string[];
}

export interface LlmFilingAction {
  action: LlmFilingActionName;
  itemName: string;
  itemInfo: string;
  /** Human description for retrieval; required on add (may equal itemName). */
  itemDescription: string;
  targets: string[];
}

export interface LlmMessageAction {
  targets: string[];
  text: string;
}

export type LlmDirectoryActionName = "add" | "remove";

export interface LlmDirectoryAction {
  action: LlmDirectoryActionName;
  name: string;
  phone: string;
}

export type LlmHoldKind =
  | "directory"
  | "lists"
  | "reminders"
  | "filing"
  | "messages";

/** Draft kept while asking for a missing required field (server PENDING_ACTION_STATE). */
export interface LlmHold {
  kind: LlmHoldKind;
  need: string;
  directory: LlmDirectoryAction[];
  lists: LlmListAction[];
  reminders: LlmReminderAction[];
  filing: LlmFilingAction[];
  messages: LlmMessageAction[];
}

export type LlmReminderActionName = "add" | "remove" | "update";
export type LlmReminderRepeat =
  | "once"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly";

export interface LlmReminderAction {
  action: LlmReminderActionName;
  item: string;
  listType: LlmListType;
  date: string;
  time: string;
  repeat: LlmReminderRepeat;
  ping: string[];
  targets: string[];
  text: string;
  inSeconds: number | null;
  everyCount: number | null;
  everyUnit:
    | "seconds"
    | "minutes"
    | "hours"
    | "days"
    | "weeks"
    | "months"
    | "weekdays"
    | null;
  weekdays: number[] | null;
  confirmed: boolean;
  /** When true, text is a brief; final WhatsApp copy is written at fire time. */
  compose: boolean;
  /** "git_log" = at fire, summarize repo commits for the digest window. */
  composeSource: "" | "git_log";
  /**
   * Hours of git history for windowed digests.
   * 0 = recurring since-last-report mode (one-shot defaults to 168h at fire).
   */
  composeLookbackHours: number;
}

export interface LlmHandoffAction {
  worker: string;
}

export type LlmQuery =
  | "reminders"
  | "reminders_sent"
  | "todos"
  | "self";

export type ReportSection =
  | "reminders"
  | "sends"
  | "tasks"
  | "shopping"
  | "filings"
  | "contacts"
  | "custom"
  | "history";

/** Mutation kinds for report section "history" (add / update / remove / fire). */
export type ReportHistoryKind = "add" | "update" | "remove" | "fire";

export interface LlmMetadata {
  lists: LlmListAction[];
  filing: LlmFilingAction[];
  messages?: LlmMessageAction[];
  reminders?: LlmReminderAction[];
  directory?: LlmDirectoryAction[];
  handoff?: LlmHandoffAction | null;
  query?: LlmQuery | null;
  /** Categories for query=report. Empty/omit = full report. */
  reportSections?: ReportSection[];
  /**
   * When sections includes history: limit audit rows to these kinds.
   * Empty/omit = all kinds. Companion domain sections (shopping/tasks/…)
   * further scope history to that domain.
   */
  reportHistoryKinds?: ReportHistoryKind[];
  /**
   * Incomplete multi-turn draft: known fields while asking for `need`.
   * Server stores this as PENDING_ACTION_STATE (same idea as reminder delete confirm).
   */
  hold?: LlmHold | null;
  confirm?: boolean | null;
  targets?: string[];
}

const LIST_ACTIONS = new Set<LlmListActionName>(["add", "remove", "update"]);
const LIST_TYPES = new Set<LlmListType>(["shopping", "contacts", "tasks", "custom"]);
const FILING_ACTIONS = new Set<LlmFilingActionName>([
  "add_filing",
  "remove_filing",
  "update_filing",
]);

const REMINDER_ACTIONS = new Set<LlmReminderActionName>(["add", "remove", "update"]);
const REMINDER_REPEATS = new Set<LlmReminderRepeat>([
  "once",
  "hourly",
  "daily",
  "weekly",
  "monthly",
]);

export function emptyLlmMetadata(): LlmMetadata {
  return {
    lists: [],
    filing: [],
    messages: [],
    reminders: [],
    directory: [],
    handoff: null,
    query: null,
    reportSections: [],
    reportHistoryKinds: [],
    hold: null,
    confirm: null,
    targets: [],
  };
}

export function parseLlmMetadata(metadata: unknown): LlmMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return emptyLlmMetadata();
  }

  const meta = metadata as Record<string, unknown>;
  const defaultTargets = parseTargets(meta);
  const reportSections = parseReportSections(meta);
  const lists = Array.isArray(meta.lists)
    ? meta.lists.flatMap((entry) => {
        const action = toListAction(entry);
        if (!action) {
          return [];
        }
        return [
          {
            ...action,
            targets: action.targets.length > 0 ? action.targets : defaultTargets,
          },
        ];
      })
    : [];
  const filing = Array.isArray(meta.filing)
    ? meta.filing.flatMap((entry) => {
        const action = toFilingAction(entry);
        if (!action) {
          return [];
        }
        return [
          {
            ...action,
            targets: action.targets.length > 0 ? action.targets : defaultTargets,
          },
        ];
      })
    : [];
  const reminders = parseReminderActions(meta);
  const directory = parseDirectoryActions(meta);
  const messages = parseMessageActions(meta);
  return {
    messages,
    reminders,
    directory,
    handoff: parseHandoff(meta),
    query: parseQuery(meta),
    reportSections,
    reportHistoryKinds: parseReportHistoryKinds(meta, reportSections),
    hold: parseHold(meta, { directory, lists, reminders, filing, messages }),
    confirm: parseConfirm(meta),
    targets: defaultTargets,
    lists,
    filing,
  };
}

export function parseTargets(value: unknown): string[] {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const raw = record
    ? (record.targets ?? record.target ?? record.for ?? record.assignees)
    : value;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return [String(raw)];
  }

  if (typeof raw === "string" && raw.trim()) {
    return [raw.trim()];
  }

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      return [String(entry)];
    }
    if (typeof entry === "string" && entry.trim()) {
      return [entry.trim()];
    }
    return [];
  });
}

export function parseReplyMetadata(text: string): LlmMetadata {
  return extractLlmPayload(text)?.metadata ?? emptyLlmMetadata();
}

function toListAction(value: unknown): LlmListAction | null {
  if (!isActionRecord(value) || !LIST_ACTIONS.has(value.action as LlmListActionName)) {
    return null;
  }

  const listType = LIST_TYPES.has(value.list_type as LlmListType)
    ? (value.list_type as LlmListType)
    : "custom";
  const items = Array.isArray(value.items)
    ? value.items.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];

  let listName =
    listType === "custom" ? readText(value, ["list_name", "רשימה"]) : "";
  if (listType === "custom" && !listName) {
    listName = listNameFromItems(items);
  }
  // Models sometimes copy the new row into list_name (or a hallucinated top-level
  // name). A real row label must not become the list title — keep a distinct
  // list_name from the item when present (e.g. list_name: "בעיות").
  if (listType === "custom" && listName && items.length === 1) {
    const label = itemLabel(items[0]).trim();
    if (
      label &&
      normalizeLooseText(label) === normalizeLooseText(listName) &&
      !isTitleOnlyListItem(items[0])
    ) {
      const fromItem = listNameFromItems(items);
      listName =
        fromItem && normalizeLooseText(fromItem) !== normalizeLooseText(label)
          ? fromItem
          : "";
    }
  }

  // Named custom lists may open/share with columns only (no rows yet).
  if (items.length === 0 && !(listType === "custom" && listName)) {
    return null;
  }

  return {
    action: value.action as LlmListActionName,
    listType,
    listName,
    items,
    targets: parseTargets(value),
  };
}

function listNameFromItems(items: Record<string, unknown>[]): string {
  for (const item of items) {
    const name = readText(item, ["list_name", "listName", "רשימה"]);
    if (name) {
      return name.slice(0, 100);
    }
  }
  return "";
}

function normalizeLooseText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Sole title-like cell — opening a named list, not a real data row. */
function isTitleOnlyListItem(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return false;
  }
  const record = item as Record<string, unknown>;
  const metaKeys = new Set([
    "list_name",
    "listName",
    "רשימה",
    "list_type",
    "listType",
    "targets",
  ]);
  const titleKeys = new Set([
    "name",
    "item_name",
    "שם פריט",
    "שם",
    "title",
    "שם רשימה",
    "list_title",
  ]);
  const filled = Object.entries(record).filter(([key, value]) => {
    if (metaKeys.has(key)) {
      return false;
    }
    if (typeof value === "string") {
      return value.trim() !== "";
    }
    return value != null;
  });
  if (filled.length === 0) {
    return true;
  }
  if (filled.length !== 1) {
    return false;
  }
  return titleKeys.has(filled[0][0]);
}

function parseHandoff(meta: Record<string, unknown>): LlmHandoffAction | null {
  const raw = meta.handoff ?? meta.switch ?? meta.talk_to ?? meta.talkTo;
  if (typeof raw === "string" && raw.trim()) {
    return { worker: raw.trim() };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const worker = readText(raw as Record<string, unknown>, [
    "worker",
    "name",
    "to",
    "employee",
  ]);
  return worker ? { worker } : null;
}

function parseQuery(meta: Record<string, unknown>): LlmQuery | null {
  const raw = meta.query ?? meta.show ?? meta.list;
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "reminders" || value === "reminder") {
    return "reminders";
  }
  if (value === "reminders_sent" || value === "sent") {
    return "reminders_sent";
  }
  if (value === "todos" || value === "todo") {
    return "todos";
  }
  if (
    value === "self" ||
    value === "worker" ||
    value === "mine" ||
    value === "tasks"
  ) {
    return "self";
  }
  // Legacy "report" / status dump — ignored; the model answers in response.
  return null;
}

const REPORT_SECTION_ALIASES: Record<string, ReportSection> = {
  reminders: "reminders",
  reminder: "reminders",
  clocks: "reminders",
  תזכורות: "reminders",
  תזכורת: "reminders",
  שעונים: "reminders",
  sends: "sends",
  send: "sends",
  scheduled: "sends",
  messages: "sends",
  שליחות: "sends",
  הודעות: "sends",
  tasks: "tasks",
  task: "tasks",
  todos: "tasks",
  מטלות: "tasks",
  משימות: "tasks",
  shopping: "shopping",
  shop: "shopping",
  קניות: "shopping",
  filings: "filings",
  filing: "filings",
  תיוקים: "filings",
  תיוק: "filings",
  contacts: "contacts",
  contact: "contacts",
  directory: "contacts",
  "אנשי קשר": "contacts",
  custom: "custom",
  lists: "custom",
  list: "custom",
  רשימות: "custom",
  history: "history",
  היסטוריה: "history",
};

const REPORT_HISTORY_KIND_ALIASES: Record<string, ReportHistoryKind> = {
  add: "add",
  added: "add",
  adds: "add",
  create: "add",
  created: "add",
  נוסף: "add",
  נוספו: "add",
  התווסף: "add",
  התווספו: "add",
  הוספות: "add",
  update: "update",
  updated: "update",
  updates: "update",
  edit: "update",
  edited: "update",
  עודכן: "update",
  עודכנו: "update",
  עדכונים: "update",
  remove: "remove",
  removed: "remove",
  removes: "remove",
  delete: "remove",
  deleted: "remove",
  deletes: "remove",
  cancel: "remove",
  cancelled: "remove",
  canceled: "remove",
  מחיקות: "remove",
  נמחק: "remove",
  נמחקו: "remove",
  בוטל: "remove",
  בוטלו: "remove",
  fire: "fire",
  fired: "fire",
  sent: "fire",
  נשלח: "fire",
  נשלחו: "fire",
};

function normalizeReportSectionToken(raw: string): ReportSection | null {
  const value = raw.trim().toLowerCase();
  if (!value || value === "all" || value === "הכל" || value === "כולם") {
    return null;
  }
  return REPORT_SECTION_ALIASES[value] ?? REPORT_SECTION_ALIASES[raw.trim()] ?? null;
}

function normalizeReportHistoryKindToken(raw: string): ReportHistoryKind | null {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return null;
  }
  return (
    REPORT_HISTORY_KIND_ALIASES[value] ??
    REPORT_HISTORY_KIND_ALIASES[raw.trim()] ??
    null
  );
}

function collectReportSectionTokens(meta: Record<string, unknown>): string[] {
  const collected: string[] = [];
  const fromFields =
    meta.sections ?? meta.report ?? meta.report_sections ?? meta.reportSections;
  if (Array.isArray(fromFields)) {
    for (const entry of fromFields) {
      if (typeof entry === "string" && entry.trim()) {
        collected.push(entry.trim());
      }
    }
  } else if (typeof fromFields === "string" && fromFields.trim()) {
    collected.push(
      ...fromFields.split(/[,+|]/).map((part) => part.trim()).filter(Boolean),
    );
  }

  const queryRaw = meta.query ?? meta.show ?? meta.list;
  if (typeof queryRaw === "string") {
    const match = queryRaw.trim().match(/^report\s*[=:]\s*(.+)$/i);
    if (match?.[1]) {
      collected.push(
        ...match[1].split(/[,+|]/).map((part) => part.trim()).filter(Boolean),
      );
    }
  }
  return collected;
}

export function parseReportSections(meta: Record<string, unknown>): ReportSection[] {
  const sections: ReportSection[] = [];
  let sawHistoryKindToken = false;
  for (const token of collectReportSectionTokens(meta)) {
    const section = normalizeReportSectionToken(token);
    if (section) {
      if (!sections.includes(section)) {
        sections.push(section);
      }
      continue;
    }
    if (normalizeReportHistoryKindToken(token)) {
      sawHistoryKindToken = true;
    }
  }
  // "מה נמחק" / sections:["מחיקות"] → history with remove filter.
  if (sawHistoryKindToken && !sections.includes("history")) {
    sections.push("history");
  }
  return sections;
}

export function parseReportHistoryKinds(
  meta: Record<string, unknown>,
  sections: ReportSection[] = parseReportSections(meta),
): ReportHistoryKind[] {
  const kinds: ReportHistoryKind[] = [];
  const push = (kind: ReportHistoryKind | null) => {
    if (kind && !kinds.includes(kind)) {
      kinds.push(kind);
    }
  };

  const fromField =
    meta.history_kinds ??
    meta.historyKinds ??
    meta.report_history_kinds ??
    meta.reportHistoryKinds;
  if (Array.isArray(fromField)) {
    for (const entry of fromField) {
      if (typeof entry === "string") {
        push(normalizeReportHistoryKindToken(entry));
      }
    }
  } else if (typeof fromField === "string" && fromField.trim()) {
    for (const part of fromField.split(/[,+|]/)) {
      push(normalizeReportHistoryKindToken(part));
    }
  }

  for (const token of collectReportSectionTokens(meta)) {
    // Kind aliases that are also sections (none today) stay as sections only.
    if (normalizeReportSectionToken(token)) {
      continue;
    }
    push(normalizeReportHistoryKindToken(token));
  }

  if (kinds.length > 0 && !sections.includes("history")) {
    // Defensive: kinds without history section are ignored by the reporter.
    return kinds;
  }
  return kinds;
}

function parseConfirm(meta: Record<string, unknown>): boolean | null {
  const raw = meta.confirm ?? meta.confirmed;
  if (raw === true) {
    return true;
  }
  if (raw === false) {
    return false;
  }
  return null;
}

const HOLD_KINDS = new Set<LlmHoldKind>([
  "directory",
  "lists",
  "reminders",
  "filing",
  "messages",
]);

function parseHold(
  meta: Record<string, unknown>,
  fallback: {
    directory: LlmDirectoryAction[];
    lists: LlmListAction[];
    reminders: LlmReminderAction[];
    filing: LlmFilingAction[];
    messages: LlmMessageAction[];
  },
): LlmHold | null {
  const raw = meta.hold ?? meta.pending_hold ?? meta.pendingHold;
  if (raw == null || raw === false) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const kindRaw =
    typeof record.kind === "string"
      ? record.kind.trim().toLowerCase()
      : typeof record.action === "string"
        ? record.action.trim().toLowerCase().replace(/^complete_/, "")
        : "";
  if (!HOLD_KINDS.has(kindRaw as LlmHoldKind)) {
    return null;
  }
  const need =
    typeof record.need === "string"
      ? record.need.trim()
      : typeof record.missing === "string"
        ? record.missing.trim()
        : typeof record.ask === "string"
          ? record.ask.trim()
          : "";
  if (!need) {
    return null;
  }

  const nestedDirectory = parseDirectoryActions(record);
  const nestedReminders = parseReminderActions(record);
  const nestedMessages = parseMessageActions(record);
  const nestedLists = Array.isArray(record.lists)
    ? record.lists.flatMap((entry) => {
        const action = toListAction(entry);
        return action ? [action] : [];
      })
    : [];
  const nestedFiling = Array.isArray(record.filing)
    ? record.filing.flatMap((entry) => {
        const action = toFilingAction(entry);
        return action ? [action] : [];
      })
    : [];

  const directory =
    nestedDirectory.length > 0 ? nestedDirectory : fallback.directory;
  const lists = nestedLists.length > 0 ? nestedLists : fallback.lists;
  const reminders =
    nestedReminders.length > 0 ? nestedReminders : fallback.reminders;
  const filing = nestedFiling.length > 0 ? nestedFiling : fallback.filing;
  const messages =
    nestedMessages.length > 0 ? nestedMessages : fallback.messages;

  if (
    directory.length === 0 &&
    lists.length === 0 &&
    reminders.length === 0 &&
    filing.length === 0 &&
    messages.length === 0
  ) {
    return null;
  }

  return {
    kind: kindRaw as LlmHoldKind,
    need: need.slice(0, 200),
    directory,
    lists,
    reminders,
    filing,
    messages,
  };
}

function parseMessageActions(meta: Record<string, unknown>): LlmMessageAction[] {
  const raw = meta.messages ?? meta.relays ?? meta.outbound;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    const action = toMessageAction(entry);
    return action ? [action] : [];
  });
}

function parseReminderActions(meta: Record<string, unknown>): LlmReminderAction[] {
  const raw = meta.reminders ?? meta.schedules;
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return entries.flatMap((entry) => {
    const action = toReminderAction(entry);
    return action ? [action] : [];
  });
}

function parseDirectoryActions(meta: Record<string, unknown>): LlmDirectoryAction[] {
  const raw = meta.directory ?? meta.phonebook ?? meta.saved_contacts;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    const action = toDirectoryAction(entry);
    return action ? [action] : [];
  });
}

function toDirectoryAction(value: unknown): LlmDirectoryAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const actionRaw = String(record.action ?? "add")
    .trim()
    .toLowerCase();
  const action: LlmDirectoryActionName | null =
    actionRaw === "add" || actionRaw === "save" || actionRaw === "create"
      ? "add"
      : actionRaw === "remove" || actionRaw === "delete"
        ? "remove"
        : null;
  if (!action) {
    return null;
  }
  const name = readText(record, ["name", "שם", "contact", "label"]);
  const phone = readText(record, ["phone", "טלפון", "number", "whatsapp"]);
  if (!name || !phone) {
    return null;
  }
  return { action, name, phone };
}

function reminderActionName(value: unknown): LlmReminderActionName | null {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (REMINDER_ACTIONS.has(raw as LlmReminderActionName)) {
    return raw as LlmReminderActionName;
  }
  if (raw === "create" || raw === "new" || raw === "schedule" || raw === "set") {
    return "add";
  }
  if (raw === "delete" || raw === "cancel") {
    return "remove";
  }
  if (raw === "edit" || raw === "change") {
    return "update";
  }
  return null;
}

function toReminderAction(value: unknown): LlmReminderAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const action = reminderActionName(record.action);
  if (!action) {
    return null;
  }

  const item = readText(record, [
    "item",
    "item_name",
    "title",
    "label",
    "שם פריט",
    "שם מטלה",
    "name",
  ]);
  if (!item) {
    return null;
  }

  const listRaw = String(record.list_type ?? record.listType ?? "").trim();
  const listType = LIST_TYPES.has(listRaw as LlmListType)
    ? (listRaw as LlmListType)
    : "shopping";
  const interval = parseReminderInterval(record);
  const repeatRaw = String(record.repeat ?? "").trim().toLowerCase();
  const repeat = REMINDER_REPEATS.has(repeatRaw as LlmReminderRepeat)
    ? (repeatRaw as LlmReminderRepeat)
    : interval
      ? interval.unit === "hours"
        ? "hourly"
        : interval.unit === "days"
          ? "daily"
          : interval.unit === "weeks"
            ? "weekly"
            : interval.unit === "months"
              ? "monthly"
              : interval.unit === "weekdays"
                ? "weekly"
                : "daily"
      : "once";
  const date = readText(record, ["date"]);
  const time = parseClockField(readText(record, ["time"]));
  const inSeconds = parseInSeconds(record);

  const compose =
    record.compose === true ||
    record.compose_at_fire === true ||
    record.composeAtFire === true ||
    record.dynamic === true ||
    parseComposeSource(record) === "git_log";

  return {
    action,
    item,
    listType,
    date,
    time,
    repeat,
    ping: parseTargets({ targets: record.ping ?? record.notify ?? record.ping_targets }),
    targets: parseTargets(record),
    text: readText(record, ["text", "message", "body", "תוכן", "sentence"]),
    inSeconds,
    everyCount: interval?.count ?? null,
    everyUnit: interval?.unit ?? null,
    weekdays: interval?.weekdays ?? null,
    confirmed: record.confirmed === true || record.confirm === true,
    compose,
    composeSource: parseComposeSource(record),
    composeLookbackHours: parseComposeLookbackHours(record),
  };
}

function parseComposeLookbackHours(record: Record<string, unknown>): number {
  const minutesRaw =
    record.compose_lookback_minutes ?? record.composeLookbackMinutes;
  if (typeof minutesRaw === "number" && Number.isFinite(minutesRaw) && minutesRaw > 0) {
    return Math.min(minutesRaw / 60, 24 * 90);
  }
  if (typeof minutesRaw === "string" && /^\d+(\.\d+)?$/.test(minutesRaw.trim())) {
    const minutes = Number(minutesRaw.trim());
    return minutes > 0 ? Math.min(minutes / 60, 24 * 90) : 0;
  }

  const raw =
    record.compose_lookback_hours ??
    record.composeLookbackHours ??
    record.lookback_hours ??
    record.lookbackHours;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(raw, 24 * 90);
  }
  if (typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw.trim())) {
    const hours = Number(raw.trim());
    return hours > 0 ? Math.min(hours, 24 * 90) : 0;
  }
  return 0;
}

function parseComposeSource(
  record: Record<string, unknown>,
): "" | "git_log" {
  const raw = String(
    record.compose_source ??
      record.composeSource ??
      record.source ??
      record.compose_from ??
      "",
  )
    .trim()
    .toLowerCase();
  if (
    raw === "git" ||
    raw === "git_log" ||
    raw === "changelog" ||
    raw === "commits" ||
    raw === "digest"
  ) {
    return "git_log";
  }
  return "";
}

function parseInSeconds(value: Record<string, unknown>): number | null {
  const raw = value.in_seconds ?? value.inSeconds ?? value.in ?? value.delay;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw);
  }
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const seconds = Number(raw.trim());
    return seconds > 0 ? seconds : null;
  }
  return null;
}

function parseClockField(time: string): string {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return "";
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return "";
  }
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function toMessageAction(value: unknown): LlmMessageAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const targets = parseTargets(record);
  const text = readText(record, ["text", "message", "body", "תוכן"]);
  // Allow targets + empty text so "what to send?" can hold a draft.
  if (!text && targets.length === 0) {
    return null;
  }

  return {
    text,
    targets,
  };
}

function toFilingAction(value: unknown): LlmFilingAction | null {
  if (!isActionRecord(value) || !FILING_ACTIONS.has(value.action as LlmFilingActionName)) {
    return null;
  }

  const itemName = readText(value, ["item_name", "שם הפריט", "name"]);
  if (!itemName) {
    return null;
  }

  return {
    action: value.action as LlmFilingActionName,
    itemName,
    itemInfo: readText(value, ["item_info", "מידע נוסף", "info"]),
    itemDescription: readText(value, [
      "item_description",
      "description",
      "תיאור",
      "תיאור הפריט",
    ]),
    targets: parseTargets(value),
  };
}

function readText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function extractLlmPayload(text: string): {
  response: string;
  rawMetadata: unknown;
  metadata: LlmMetadata;
} | null {
  const parsed = extractJsonObject(text);
  if (!parsed) {
    return null;
  }

  const response =
    typeof parsed.response === "string"
      ? parsed.response.trim()
      : // Only fall back to raw text when the payload has no response field.
        text;

  return {
    response,
    rawMetadata: parsed.metadata,
    metadata: parseLlmMetadata(parsed.metadata),
  };
}

const LIST_TYPE_LABELS: Record<string, string> = {
  shopping: "shopping list",
  contacts: "contacts list",
  tasks: "tasks list",
  custom: "custom list",
};

const ACTION_LABELS: Record<string, string> = {
  add: "Add to",
  remove: "Remove from",
  update: "Update",
  add_filing: "File",
  remove_filing: "Remove filing",
  update_filing: "Update filing",
};

export function parseLlmReply(text: string): ParsedLlmMessage {
  const payload = extractLlmPayload(text);
  if (!payload) {
    return { response: text, actions: [] };
  }

  return {
    response: payload.response,
    actions: collectActionDescriptions(payload.rawMetadata),
  };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const raw = parseObject(candidate);
  if (raw) {
    return raw;
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return parseObject(candidate.slice(start, end + 1));
  }

  return null;
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function collectActionDescriptions(metadata: unknown): string[] {
  if (metadata == null) {
    return [];
  }

  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }

  const meta = metadata as Record<string, unknown>;
  const descriptions: string[] = [];

  if (meta.action != null && meta.action !== "") {
    if (typeof meta.action === "string") {
      descriptions.push(describeStandaloneAction(meta.action, meta));
    } else if (typeof meta.action === "object" && !Array.isArray(meta.action)) {
      const actionRecord = meta.action as Record<string, unknown>;
      if (actionRecord.action != null) {
        descriptions.push(describeUnknownAction(actionRecord));
      }
    }
  }

  if (Array.isArray(meta.lists)) {
    for (const list of meta.lists) {
      if (isActionRecord(list)) {
        descriptions.push(describeListAction(list));
      }
    }
  }

  if (Array.isArray(meta.filing)) {
    for (const filing of meta.filing) {
      if (isActionRecord(filing)) {
        descriptions.push(describeFilingAction(filing));
      }
    }
  }

  if (Array.isArray(meta.messages)) {
    for (const item of meta.messages) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        descriptions.push(describeMessageAction(item as Record<string, unknown>));
      }
    }
  }

  if (Array.isArray(meta.directory)) {
    for (const item of meta.directory) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const row = item as Record<string, unknown>;
      const name = readText(row, ["name", "שם"]);
      const action = String(row.action ?? "add").toLowerCase();
      descriptions.push(
        action === "remove"
          ? `Remove contact${name ? `: ${name}` : ""}`
          : `Save contact${name ? `: ${name}` : ""}`,
      );
    }
  }

  if (meta.handoff != null || meta.switch != null || meta.talk_to != null) {
    const handoff = parseHandoff(meta);
    if (handoff) {
      descriptions.push(`Handoff to ${handoff.worker}`);
    }
  }

  if (Array.isArray(meta.reminders)) {
    for (const item of meta.reminders) {
      if (isActionRecord(item)) {
        const name = readText(item, ["item", "item_name", "name"]);
        const when = [item.date, item.time, item.when].filter(
          (part): part is string => typeof part === "string" && part.trim().length > 0,
        );
        descriptions.push(
          `${item.compose === true ? "Compose" : "Remind"} ${when.join(" ") || "later"}${name ? `: ${name}` : ""}`.trim(),
        );
      }
    }
  }

  return descriptions;
}

function isActionRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).action != null &&
      (value as Record<string, unknown>).action !== "",
  );
}

function describeStandaloneAction(
  action: string,
  meta: Record<string, unknown>,
): string {
  const details = [meta.description, meta.list_type, meta.item_name]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

  if (details.length > 0) {
    return `Action: ${action} — ${details.join(" · ")}`;
  }

  return `Action: ${action}`;
}

function describeUnknownAction(record: Record<string, unknown>): string {
  if (record.list_type != null || Array.isArray(record.items)) {
    return describeListAction(record);
  }

  if (record.item_name != null || record.item_info != null) {
    return describeFilingAction(record);
  }

  return describeStandaloneAction(String(record.action), record);
}

function describeListAction(list: Record<string, unknown>): string {
  const action = String(list.action);
  const verb = ACTION_LABELS[action] ?? `Action ${action} on`;
  const listName = LIST_TYPE_LABELS[String(list.list_type ?? "")] ?? "list";
  const names = Array.isArray(list.items)
    ? list.items.map(itemLabel).filter(Boolean).join(", ")
    : "";

  const targetSuffix = describeTargets(list);
  return names
    ? `${verb} ${listName}${targetSuffix}: ${names}`
    : `${verb} ${listName}${targetSuffix}`;
}

function describeTargets(record: Record<string, unknown>): string {
  const targets = parseTargets(record);
  if (targets.length === 0) {
    return "";
  }

  if (targets.some((target) => /^(all|everyone|\*|כולם|כל אחד|כל העובדים)$/i.test(target))) {
    return " for everyone";
  }

  return ` for ${targets.join(", ")}`;
}

function describeMessageAction(record: Record<string, unknown>): string {
  const text = readText(record, ["text", "message", "body", "תוכן"]);
  const targetSuffix = describeTargets(record);
  return text
    ? `Send message${targetSuffix}: ${text}`
    : `Send message${targetSuffix}`;
}

function describeFilingAction(filing: Record<string, unknown>): string {
  const action = String(filing.action);
  const verb = ACTION_LABELS[action] ?? `Action: ${action}`;
  const name =
    typeof filing.item_name === "string" && filing.item_name.trim()
      ? filing.item_name.trim()
      : "";
  const info =
    typeof filing.item_info === "string" && filing.item_info.trim()
      ? filing.item_info.trim()
      : "";
  const description =
    typeof filing.item_description === "string" && filing.item_description.trim()
      ? filing.item_description.trim()
      : typeof filing["תיאור"] === "string" &&
          String(filing["תיאור"]).trim()
        ? String(filing["תיאור"]).trim()
        : "";

  if (name && (info || description)) {
    const extras = [info, description].filter(Boolean).join(" / ");
    return `${verb}: ${name} — ${extras}`;
  }

  if (name) {
    return `${verb}: ${name}`;
  }

  return verb;
}

export function llmItemLabel(item: unknown): string {
  return itemLabel(item);
}

function itemLabel(item: unknown): string {
  if (!item || typeof item !== "object") {
    return "";
  }

  const record = item as Record<string, unknown>;
  const keys = [
    "name",
    "item_name",
    "שם פריט",
    "שם מטלה",
    "שם פרטי",
    "task",
    "תיאור",
    "description",
  ];

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  const metaKeys = new Set([
    "list_name",
    "listName",
    "רשימה",
    "list_type",
    "listType",
    "targets",
  ]);
  const firstText = Object.entries(record).find(
    ([key, value]) =>
      !metaKeys.has(key) && typeof value === "string" && value.trim(),
  );

  return firstText && typeof firstText[1] === "string" ? firstText[1].trim() : "";
}
