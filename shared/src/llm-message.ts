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
  targets: string[];
}

export interface LlmMessageAction {
  targets: string[];
  text: string;
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
}

export interface LlmHandoffAction {
  worker: string;
}

export type LlmQuery = "reminders" | "reminders_sent";

export interface LlmMetadata {
  lists: LlmListAction[];
  filing: LlmFilingAction[];
  messages?: LlmMessageAction[];
  reminders?: LlmReminderAction[];
  handoff?: LlmHandoffAction | null;
  query?: LlmQuery | null;
  confirm?: boolean | null;
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
    handoff: null,
    query: null,
    confirm: null,
  };
}

export function parseLlmMetadata(metadata: unknown): LlmMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return emptyLlmMetadata();
  }

  const meta = metadata as Record<string, unknown>;
  const defaultTargets = parseTargets(meta);
  return {
    messages: parseMessageActions(meta),
    reminders: parseReminderActions(meta),
    handoff: parseHandoff(meta),
    query: parseQuery(meta),
    confirm: parseConfirm(meta),
    lists: Array.isArray(meta.lists)
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
      : [],
    filing: Array.isArray(meta.filing)
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
      : [],
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

  if (items.length === 0) {
    return null;
  }

  return {
    action: value.action as LlmListActionName,
    listType,
    listName: listType === "custom" ? readText(value, ["list_name", "name", "רשימה"]) : "",
    items,
    targets: parseTargets(value),
  };
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
  return null;
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
  };
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
  const text = readText(record, ["text", "message", "body", "תוכן"]);
  if (!text) {
    return null;
  }

  return {
    text,
    targets: parseTargets(record),
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
    typeof parsed.response === "string" && parsed.response.trim()
      ? parsed.response.trim()
      : text;

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
          `Remind ${when.join(" ") || "later"}${name ? `: ${name}` : ""}`.trim(),
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

  if (name && info) {
    return `${verb}: ${name} — ${info}`;
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
  ];

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  const firstText = Object.values(record).find(
    (value) => typeof value === "string" && value.trim(),
  );

  return typeof firstText === "string" ? firstText.trim() : "";
}
