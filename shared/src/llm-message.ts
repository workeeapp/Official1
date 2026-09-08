export interface ParsedLlmMessage {
  response: string;
  actions: string[];
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
  const parsed = extractJsonObject(text);
  if (!parsed) {
    return { response: text, actions: [] };
  }

  const response =
    typeof parsed.response === "string" && parsed.response.trim()
      ? parsed.response.trim()
      : text;

  return {
    response,
    actions: collectActionDescriptions(parsed.metadata),
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

  return names ? `${verb} ${listName}: ${names}` : `${verb} ${listName}`;
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
