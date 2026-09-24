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
import { looksLikePhone, normalizePhoneDigits, phonesMatch } from "../utils/phone.js";
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

export function resolveSpokenMetadata(
  _message: string,
  metadata: LlmMetadata,
  _employees?: PublicEmployee[],
  _actorId?: string,
): LlmMetadata {
  return {
    lists: metadata.lists,
    filing: metadata.filing,
    messages: metadata.messages ?? [],
    reminders: metadata.reminders ?? [],
    handoff: metadata.handoff ?? null,
    query: metadata.query ?? null,
    confirm: metadata.confirm ?? null,
  };
}

export function resolveRelayMessages(
  actions: LlmMessageAction[],
): LlmMessageAction[] {
  return actions.filter(
    (action) => action.text.trim().length > 0 && action.targets.length > 0,
  );
}

export function formatMissingSendTextNotice(
  actions: LlmMessageAction[],
): string {
  const dests = actions
    .filter((action) => action.targets.length > 0 && !action.text.trim())
    .flatMap((action) => action.targets.map((target) => target.trim()))
    .filter(Boolean);
  if (dests.length === 0) {
    return "";
  }
  return dests.length === 1
    ? `מה לשלוח ל«${dests[0]}»? אפשר גם שלום.`
    : `מה לשלוח? אפשר גם שלום.`;
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

export function planPhoneRelays(
  messages: LlmMessageAction[],
  employees: PublicEmployee[],
  actorId?: string,
): Array<{ phone: string; text: string }> {
  const deliveries: Array<{ phone: string; text: string }> = [];
  const seen = new Set<string>();

  for (const action of messages) {
    if (!action.text.trim()) {
      continue;
    }
    for (const raw of action.targets) {
      if (!looksLikePhone(raw)) {
        continue;
      }
      const matched = matchEmployee(raw, employees);
      if (matched && matched.id !== actorId) {
        continue;
      }
      const phone = normalizePhoneDigits(raw);
      if (seen.has(phone)) {
        continue;
      }
      seen.add(phone);
      deliveries.push({ phone, text: action.text });
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

    const actorIncluded = targets.some((target) => target.id === input.actor.id);
    const assignment = assignmentTaskForTargets(
      input.employees,
      others,
      list,
      isAllTarget(list.targets),
    );
    const jointMeeting =
      actorIncluded && others.length > 0 && list.listType === "tasks";
    if (assignment && !jointMeeting) {
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
  const byName = employees.find((employee) => {
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
  if (byName) {
    return byName;
  }
  if (!looksLikePhone(raw)) {
    return undefined;
  }
  return employees.find(
    (employee) => employee.phone && phonesMatch(employee.phone, raw),
  );
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
