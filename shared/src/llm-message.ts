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
export type LlmReminderRepeat = "once" | "daily";

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
}

export interface LlmMetadata {
  lists: LlmListAction[];
  filing: LlmFilingAction[];
  messages?: LlmMessageAction[];
  reminders?: LlmReminderAction[];
}

const LIST_ACTIONS = new Set<LlmListActionName>(["add", "remove", "update"]);
const LIST_TYPES = new Set<LlmListType>(["shopping", "contacts", "tasks", "custom"]);
const FILING_ACTIONS = new Set<LlmFilingActionName>([
  "add_filing",
  "remove_filing",
  "update_filing",
]);

const REMINDER_ACTIONS = new Set<LlmReminderActionName>(["add", "remove", "update"]);
const REMINDER_REPEATS = new Set<LlmReminderRepeat>(["once", "daily"]);

export function emptyLlmMetadata(): LlmMetadata {
  return { lists: [], filing: [], messages: [], reminders: [] };
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

  if (typeof raw === "string" && raw.trim()) {
    return [raw.trim()];
  }

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
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
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    const action = toReminderAction(entry);
    return action ? [action] : [];
  });
}

function toReminderAction(value: unknown): LlmReminderAction | null {
  if (!isActionRecord(value) || !REMINDER_ACTIONS.has(value.action as LlmReminderActionName)) {
    return null;
  }

  const item = readText(value, ["item", "item_name", "שם פריט", "שם מטלה", "name"]);
  if (!item) {
    return null;
  }

  const listType = LIST_TYPES.has(value.list_type as LlmListType)
    ? (value.list_type as LlmListType)
    : "shopping";
  const repeat = REMINDER_REPEATS.has(value.repeat as LlmReminderRepeat)
    ? (value.repeat as LlmReminderRepeat)
    : "once";
  const when = readText(value, ["when"]);
  const date = readText(value, ["date", "יום", "relative"]) || parseWhenDate(when);
  const time = readText(value, ["time", "שעה"]) || parseWhenTime(when);

  return {
    action: value.action as LlmReminderActionName,
    item,
    listType,
    date,
    time,
    repeat,
    ping: parseTargets({ targets: value.ping ?? value.notify ?? value.ping_targets }),
    targets: parseTargets(value),
    text: readText(value, ["text", "message", "body", "תוכן", "sentence"]),
    inSeconds: parseInSeconds(value),
  };
}

function parseInSeconds(value: Record<string, unknown>): number | null {
  const raw = value.in_seconds ?? value.inSeconds ?? value.in ?? value.delay;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw);
  }
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  const text = raw.trim().toLowerCase();
  const seconds = text.match(/(?:in\s+)?(\d+)\s*(?:s|sec|secs|second|seconds|שניות|שניה)/);
  if (seconds) {
    return Number(seconds[1]);
  }
  const minutes = text.match(/(?:in\s+)?(\d+)\s*(?:m|min|mins|minute|minutes|דקות|דקה)/);
  if (minutes) {
    return Number(minutes[1]) * 60;
  }
  return null;
}

function parseWhenDate(when: string): string {
  const trimmed = when.trim();
  if (!trimmed) {
    return "";
  }
  const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) {
    return iso[1];
  }
  const first = trimmed.split(/\s+/)[0] ?? "";
  return first;
}

function parseWhenTime(when: string): string {
  const match = when.match(/\b(\d{1,2}:\d{2})\b/);
  return match?.[1] ?? "";
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
