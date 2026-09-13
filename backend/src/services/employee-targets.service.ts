import {
  emptyLlmMetadata,
  isDigitalEmployee,
  llmItemLabel,
  type LlmFilingAction,
  type LlmListAction,
  type LlmMessageAction,
  type LlmMetadata,
  type PublicEmployee,
} from "@workee/shared";
import type { ItemVisibility } from "./employee-records.service.js";

const ALL_TARGET_TOKENS = /^(all|everyone|\*|כולם|כל אחד|כל העובדים)$/i;

export function employeeDisplayName(employee: PublicEmployee): string {
  return employee.nickname?.trim() || employee.name;
}

export function resolveActionTargets(
  rawTargets: string[],
  employees: PublicEmployee[],
  actorId: string,
): PublicEmployee[] {
  const actor = employees.find((employee) => employee.id === actorId);
  const fallback = actor ? [actor] : [];

  if (rawTargets.length === 0) {
    return fallback;
  }

  if (rawTargets.some((target) => ALL_TARGET_TOKENS.test(target.trim()))) {
    return employees;
  }

  const matched = new Map<string, PublicEmployee>();
  for (const raw of rawTargets) {
    const employee = matchEmployee(raw, employees);
    if (employee) {
      matched.set(employee.id, employee);
    }
  }

  return matched.size > 0 ? [...matched.values()] : fallback;
}

export function inferTargetsFromMessage(
  message: string,
  employees: PublicEmployee[],
  actorId: string,
): string[] {
  if (/(כולם|כל אחד|כל העובדים)/.test(message) || ALL_TARGET_TOKENS.test(message.trim())) {
    return ["all"];
  }

  const mentioned: string[] = [];
  for (const employee of employees) {
    if (employee.id === actorId) {
      continue;
    }
    const aliases = [
      employee.nickname,
      employee.name,
      `${employee.name} ${employee.surname}`,
      employeeDisplayName(employee),
    ].filter((value): value is string => Boolean(value && value.trim()));

    if (aliases.some((alias) => message.includes(alias.trim()))) {
      mentioned.push(employeeDisplayName(employee));
    }
  }

  return mentioned;
}

export function resolveSpokenMetadata(
  message: string,
  metadata: LlmMetadata,
  employees: PublicEmployee[],
  actorId: string,
): LlmMetadata {
  const inferred = inferTargetsFromMessage(message, employees, actorId);
  const lists = metadata.lists.map((list) =>
    retargetListAction(list, inferred, employees, actorId),
  );
  const filing = metadata.filing.map((entry) =>
    entry.targets.length > 0 ? entry : { ...entry, targets: inferred },
  );
  const hasTargetedWork =
    lists.some((list) => list.targets.length > 0) ||
    filing.some((entry) => entry.targets.length > 0);

  const messages = metadata.messages ?? [];

  if (hasTargetedWork || inferred.length === 0 || !looksLikeAssignment(message)) {
    return { lists, filing, messages };
  }

  const synthesized = synthesizeAssignment(message, inferred);
  return synthesized
    ? { lists: [...lists, synthesized], filing, messages }
    : { lists, filing, messages };
}

export function looksLikeRelayMessage(message: string): boolean {
  return (
    /תשלח(?:י)?(?:\s+הודעה)?\s+ל/.test(message) ||
    /תבדק(?:י)?\s+עם/.test(message) ||
    /(?:תגיד(?:י)?|תודיע(?:י)?|תעביר(?:י)?)\s+ל/.test(message) ||
    /(?:תשאלי?|שאלי?)\s+את/.test(message)
  );
}

export function resolveRelayMessages(
  message: string,
  actions: LlmMessageAction[],
  employees: PublicEmployee[],
  actorId: string,
): LlmMessageAction[] {
  const inferred = inferTargetsFromMessage(message, employees, actorId);
  const filled = actions
    .map((action) => ({
      text: action.text.trim(),
      targets: action.targets.length > 0 ? action.targets : inferred,
    }))
    .filter((action) => action.text.length > 0 && action.targets.length > 0);

  if (filled.length > 0) {
    return filled;
  }

  if (inferred.length === 0 || !looksLikeRelayMessage(message)) {
    return [];
  }

  const actor = employees.find((employee) => employee.id === actorId);
  return [
    {
      targets: inferred,
      text: fallbackRelayText(
        actor ? employeeDisplayName(actor) : "מישהו",
        message,
        inferred,
      ),
    },
  ];
}

export function fallbackRelayText(
  actorName: string,
  userMessage: string,
  targetNames: string[],
): string {
  const intent = extractRelayIntent(userMessage, targetNames)
    .replace(/\?+$/g, "")
    .trim();
  const checking = /תבדק|אם\s+/.test(userMessage);
  if (checking) {
    const asked = intent
      .replace(/^אם\s+/, "")
      .replace(/הוא\s+/g, "")
      .replace(/היא\s+/g, "")
      .replace(/קנתה/g, "קנית")
      .replace(/קנה/g, "קנית");
    return `${actorName} שואל אם ${asked} ?`;
  }

  return `${actorName} שואל ${intent} ?\nמה לענות לו ?`;
}

function extractRelayIntent(message: string, targetNames: string[]): string {
  const escaped = targetNames
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const name = escaped || "\\S+";
  let text = message.trim();
  const patterns = [
    new RegExp(`^תשלח(?:י)?(?:\\s+הודעה)?\\s+ל(?:${name})\\s*[-–:]\\s*`, "u"),
    new RegExp(`^תשלח(?:י)?(?:\\s+הודעה)?\\s+ל(?:${name})\\s+`, "u"),
    new RegExp(`^תבדק(?:י)?\\s+עם\\s+(?:${name})\\s+`, "u"),
    new RegExp(
      `^(?:תגיד(?:י)?|תודיע(?:י)?|תעביר(?:י)?)\\s+ל(?:${name})\\s*[-–:]?\\s*`,
      "u",
    ),
    new RegExp(`^(?:תשאלי?|שאלי?)\\s+את\\s+(?:${name})\\s+`, "u"),
  ];

  for (const pattern of patterns) {
    if (pattern.test(text)) {
      text = text.replace(pattern, "");
      break;
    }
  }

  return text.trim() || message.trim();
}

export function planRelayDeliveries(input: {
  actor: PublicEmployee;
  sender: PublicEmployee;
  employees: PublicEmployee[];
  messages: LlmMessageAction[];
}): Array<{
  employeeId: string;
  digitalEmployeeId: string;
  target: PublicEmployee;
  text: string;
}> {
  const deliveries: Array<{
    employeeId: string;
    digitalEmployeeId: string;
    target: PublicEmployee;
    text: string;
  }> = [];
  const seen = new Set<string>();

  for (const action of input.messages) {
    const targets = resolveNamedRelayTargets(
      action.targets,
      input.employees,
    ).filter(
      (target) =>
        target.id !== input.actor.id && target.id !== input.sender.id,
    );

    for (const target of targets) {
      const employeeId = isDigitalEmployee(target)
        ? input.actor.id
        : target.id;
      const digitalEmployeeId = isDigitalEmployee(target)
        ? target.id
        : input.sender.id;
      const key = `${employeeId}:${digitalEmployeeId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deliveries.push({
        employeeId,
        digitalEmployeeId,
        target,
        text: action.text,
      });
    }
  }

  return deliveries;
}

function resolveNamedRelayTargets(
  rawTargets: string[],
  employees: PublicEmployee[],
): PublicEmployee[] {
  if (rawTargets.length === 0) {
    return [];
  }

  if (rawTargets.some((target) => ALL_TARGET_TOKENS.test(target.trim()))) {
    return employees;
  }

  const matched = new Map<string, PublicEmployee>();
  for (const raw of rawTargets) {
    const employee = matchEmployee(raw, employees);
    if (employee) {
      matched.set(employee.id, employee);
    }
  }

  return [...matched.values()];
}

function retargetListAction(
  list: LlmListAction,
  inferred: string[],
  employees: PublicEmployee[],
  actorId: string,
): LlmListAction {
  const fromItems = inferTargetsFromItemLabels(list.items, employees, actorId);
  const targets =
    list.targets.length > 0
      ? list.targets
      : fromItems.length > 0
        ? fromItems
        : inferred;
  if (targets.length === 0) {
    return list;
  }

  return {
    ...list,
    targets,
    items: list.items.map((item) => stripAssigneePrefix(item, employees, actorId)),
  };
}

function inferTargetsFromItemLabels(
  items: Record<string, unknown>[],
  employees: PublicEmployee[],
  actorId: string,
): string[] {
  const found = new Set<string>();
  for (const item of items) {
    const parsed = parseAssigneePrefix(llmItemLabel(item), employees, actorId);
    if (parsed) {
      found.add(parsed.target);
    }
  }
  return [...found];
}

function parseAssigneePrefix(
  text: string,
  employees: PublicEmployee[],
  actorId: string,
): { target: string; rest: string } | null {
  const match = text.trim().match(/^(.+?)\s+צרי(?:ך|כה|כים)\s+(.+)$/);
  if (!match) {
    return null;
  }

  const employee = matchEmployee(match[1], employees);
  if (!employee || employee.id === actorId) {
    return null;
  }

  return {
    target: employeeDisplayName(employee),
    rest: match[2].trim(),
  };
}

function stripAssigneePrefix(
  item: Record<string, unknown>,
  employees: PublicEmployee[],
  actorId: string,
): Record<string, unknown> {
  const parsed = parseAssigneePrefix(llmItemLabel(item), employees, actorId);
  if (!parsed) {
    return item;
  }

  const next = { ...item };
  for (const key of ["שם מטלה", "שם פריט", "name", "task", "item_name"]) {
    if (typeof next[key] === "string") {
      next[key] = parsed.rest;
    }
  }
  return next;
}

function looksLikeAssignment(message: string): boolean {
  const trimmed = message.trim();
  return (
    /צרי(?:ך|כה|כים)\s+\S+/.test(trimmed) &&
    !/^(מה|איזה|האם|למה|כמה)(?:\s|$)/.test(trimmed) &&
    !/[?？]/.test(trimmed)
  );
}

function synthesizeAssignment(
  message: string,
  inferred: string[],
): LlmListAction | null {
  const match = message.trim().match(/צרי(?:ך|כה|כים)\s+(.+)$/);
  if (!match) {
    return null;
  }

  const rest = match[1].trim();
  if (!rest) {
    return null;
  }

  if (/^לקנות\b/.test(rest)) {
    return {
      action: "add",
      listType: "shopping",
      listName: "",
      items: [{ "שם פריט": rest.replace(/^לקנות\s+/, "") }],
      targets: inferred,
    };
  }

  return {
    action: "add",
    listType: "tasks",
    listName: "",
    items: [{ "שם מטלה": rest }],
    targets: inferred,
  };
}

export function planTargetedActions(input: {
  actor: PublicEmployee;
  employees: PublicEmployee[];
  metadata: LlmMetadata;
}): {
  applications: Array<{
    employeeId: string;
    metadata: LlmMetadata;
    visibility: ItemVisibility;
  }>;
  notifications: Array<{ employee: PublicEmployee; metadata: LlmMetadata }>;
} {
  const applications: Array<{
    employeeId: string;
    metadata: LlmMetadata;
    visibility: ItemVisibility;
  }> = [];
  const notificationBuckets = new Map<string, LlmMetadata>();

  const addNotification = (employeeId: string, metadata: LlmMetadata) => {
    if (employeeId === input.actor.id) {
      return;
    }
    const current = notificationBuckets.get(employeeId) ?? emptyLlmMetadata();
    current.lists.push(...metadata.lists);
    current.filing.push(...metadata.filing);
    notificationBuckets.set(employeeId, current);
  };

  for (const list of input.metadata.lists) {
    const targets = resolveActionTargets(
      list.targets,
      input.employees,
      input.actor.id,
    );
    const others = targets.filter((target) => target.id !== input.actor.id);
    const shared = others.length > 0 || isAllTarget(list.targets);
    const visibility = visibilityFor(input.actor.id, targets, shared);
    const metadata = { lists: [{ ...list, targets: [] }], filing: [] };

    for (const target of targets) {
      applications.push({ employeeId: target.id, metadata, visibility });
      addNotification(target.id, metadata);
    }

    const assignment = assignmentTaskForTargets(
      input.employees,
      others,
      list,
      isAllTarget(list.targets),
    );
    if (assignment) {
      applications.push({
        employeeId: input.actor.id,
        metadata: { lists: [assignment], filing: [] },
        visibility: visibilityFor(input.actor.id, [input.actor], false),
      });
    }
  }

  for (const filing of input.metadata.filing) {
    const targets = resolveActionTargets(
      filing.targets,
      input.employees,
      input.actor.id,
    );
    const others = targets.filter((target) => target.id !== input.actor.id);
    const shared = others.length > 0 || isAllTarget(filing.targets);
    const visibility = visibilityFor(input.actor.id, targets, shared);
    const metadata = { lists: [], filing: [{ ...filing, targets: [] }] };

    for (const target of targets) {
      applications.push({ employeeId: target.id, metadata, visibility });
      addNotification(target.id, metadata);
    }

    const assignment = assignmentTaskForFiling(
      input.employees,
      others,
      filing,
      isAllTarget(filing.targets),
    );
    if (assignment) {
      applications.push({
        employeeId: input.actor.id,
        metadata: { lists: [assignment], filing: [] },
        visibility: visibilityFor(input.actor.id, [input.actor], false),
      });
    }
  }

  return {
    applications,
    notifications: [...notificationBuckets.entries()].flatMap(
      ([employeeId, metadata]) => {
        const employee = input.employees.find((item) => item.id === employeeId);
        return employee ? [{ employee, metadata }] : [];
      },
    ),
  };
}

function visibilityFor(
  actorId: string,
  targets: PublicEmployee[],
  shared: boolean,
): ItemVisibility {
  const visibleTo = [...new Set([actorId, ...targets.map((target) => target.id)])];
  return {
    scope: shared ? "shared" : "personal",
    addedById: actorId,
    visibleTo,
  };
}

export function fallbackNotificationText(
  actor: PublicEmployee,
  metadata: LlmMetadata,
  options?: {
    completed?: boolean;
    purchased?: boolean;
    recipientIsOwner?: boolean;
    ownerName?: string;
  },
): string {
  const actorName = employeeDisplayName(actor);
  const items = collectItemLabels(metadata);
  const itemText = items.join(" ו") || "פריט";
  const list = metadata.lists[0];
  const purchased = options?.purchased ?? options?.completed;
  const yours = options?.recipientIsOwner !== false;
  const ownerList = yours
    ? "שלך"
    : options?.ownerName
      ? `של ${options.ownerName}`
      : "";

  if (list?.listType === "shopping") {
    if (list.action === "remove") {
      if (purchased) {
        return `${actorName} קנה ${itemText}`;
      }
      return `${actorName} הסיר ${itemText} מרשימת הקניות ${ownerList}`.trim();
    }
    if (list.action === "update") {
      return `${actorName} עדכן ${itemText} ברשימת הקניות ${ownerList}`.trim();
    }
    return `${actorName} הוסיף ${itemText} לרשימת הקניות ${ownerList}`.trim();
  }

  if (list?.listType === "tasks") {
    if (list.action === "remove") {
      return `${actorName} הסיר מטלה: ${itemText}`;
    }
    if (list.action === "update") {
      return `${actorName} עדכן מטלה: ${itemText}`;
    }
    return yours
      ? `${actorName} הוסיף לך מטלה: ${itemText}`
      : `${actorName} הוסיף מטלה ${ownerList}: ${itemText}`.trim();
  }

  if (metadata.filing.length > 0) {
    const filing = metadata.filing[0];
    const verb =
      filing.action === "remove_filing"
        ? "הסיר תיוק"
        : filing.action === "update_filing"
          ? "עדכן תיוק"
          : "הוסיף תיוק";
    return yours
      ? `${actorName} ${verb} אצלך: ${filing.itemName}`
      : `${actorName} ${verb} אצל ${options?.ownerName ?? "עובד אחר"}: ${filing.itemName}`;
  }

  return `${actorName} עדכן מידע אצלך: ${itemText}`;
}

function assignmentTaskForTargets(
  _employees: PublicEmployee[],
  others: PublicEmployee[],
  list: LlmListAction,
  targetedAll: boolean,
): LlmListAction | null {
  if (others.length === 0) {
    return null;
  }

  const targetLabel = targetLabelFor(others, targetedAll);
  const plural = targetedAll || others.length > 1;
  const items = list.items.map(llmItemLabel).filter(Boolean);
  const itemText = items.join(" ו") || "פריט";
  const verb =
    list.action === "remove" ? "להסיר" : list.action === "update" ? "לעדכן" : "לקנות";
  const name =
    list.listType === "shopping"
      ? `${targetLabel} ${plural ? "צריכים" : "צריך"} ${verb} ${itemText}`
      : list.listType === "tasks"
        ? `${targetLabel} ${plural ? "קיבלו" : "קיבל"} מטלה: ${itemText}`
        : `${targetLabel}: ${itemText}`;

  return {
    action: "add",
    listType: "tasks",
    listName: "",
    items: [{ "שם מטלה": name }],
    targets: [],
  };
}

function assignmentTaskForFiling(
  _employees: PublicEmployee[],
  others: PublicEmployee[],
  filing: LlmFilingAction,
  targetedAll: boolean,
): LlmListAction | null {
  if (others.length === 0) {
    return null;
  }

  const targetLabel = targetLabelFor(others, targetedAll);
  const plural = targetedAll || others.length > 1;
  return {
    action: "add",
    listType: "tasks",
    listName: "",
    items: [
      {
        "שם מטלה": `${targetLabel} ${plural ? "קיבלו" : "קיבל"} תיוק: ${filing.itemName}`,
      },
    ],
    targets: [],
  };
}

function targetLabelFor(others: PublicEmployee[], targetedAll: boolean): string {
  if (targetedAll) {
    return "כולם";
  }

  return others.map(employeeDisplayName).join(" ו");
}

function isAllTarget(rawTargets: string[]): boolean {
  return rawTargets.some((target) => ALL_TARGET_TOKENS.test(target.trim()));
}

function matchEmployee(
  raw: string,
  employees: PublicEmployee[],
): PublicEmployee | undefined {
  const needle = normalizeName(raw);
  return employees.find((employee) => {
    const aliases = [
      employee.nickname,
      employee.name,
      employee.surname,
      `${employee.name} ${employee.surname}`,
      employeeDisplayName(employee),
    ]
      .filter((value): value is string => Boolean(value && value.trim()))
      .map(normalizeName);

    return aliases.includes(needle);
  });
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function collectItemLabels(metadata: LlmMetadata): string[] {
  const fromLists = metadata.lists.flatMap((list) =>
    list.items.map(llmItemLabel).filter(Boolean),
  );
  const fromFiling = metadata.filing
    .map((filing) => filing.itemName)
    .filter(Boolean);
  return [...fromLists, ...fromFiling];
}
