import { Prisma } from "@prisma/client";
import type {
  EmployeeRecordField,
  EmployeeRecordsResponse,
  LlmListAction,
  LlmListType,
  LlmMetadata,
} from "@workee/shared";
import { ConflictError, NotFoundError, ValidationError } from "../utils/errors.js";
import { prisma } from "../database/prisma.js";
import { toPlainJson } from "./llm-client.js";
import {
  cancelReminderLinkedToWorkerItem,
  listReminderRowsForUser,
  toReminderSnapshotRow,
  type ReminderSnapshotRow,
} from "./reminder.service.js";

export type ItemScope = "personal" | "shared";

export interface ItemVisibility {
  scope: ItemScope;
  addedById: string;
  visibleTo: string[];
}

export interface EmployeeRecordSnapshot {
  lists: Array<{
    list_type: string;
    list_name?: string;
    owner: string;
    items: Record<string, unknown>[];
  }>;
  filing: Array<{
    item_name: string;
    item_info: string;
    owner: string;
    scope: ItemScope;
  }>;
  reminders?: ReminderSnapshotRow[];
}

const ITEM_NAME_KEYS: Record<LlmListType, string[]> = {
  shopping: ["שם פריט", "name", "item_name"],
  contacts: ["שם פרטי", "first_name", "name"],
  tasks: ["שם מטלה", "name", "task", "item_name"],
  custom: ["name", "שם", "item_name", "שם פריט", "שם החנות", "store", "title"],
};

export function itemIdentity(
  listType: LlmListType,
  item: Record<string, unknown>,
): string {
  if (listType === "contacts") {
    const first = readItemText(item, ITEM_NAME_KEYS.contacts);
    const last = readItemText(item, ["שם משפחה", "last_name", "surname"]);
    return normalizeKey([first, last].filter(Boolean).join("|"));
  }

  const fromKeys = normalizeKey(readItemText(item, ITEM_NAME_KEYS[listType]));
  if (fromKeys) {
    return fromKeys;
  }

  // Custom columns (e.g. שם החנות) may not match the built-in title keys.
  if (listType === "custom") {
    for (const value of Object.values(item)) {
      if (typeof value === "string" && value.trim()) {
        return normalizeKey(value);
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return normalizeKey(String(value));
      }
    }
  }

  return "";
}

/** Collect search needles from a list action item (any title field the model used). */
export function itemSearchNeedles(
  listType: LlmListType,
  item: Record<string, unknown>,
): string[] {
  const needles = new Set<string>();
  const primary = itemIdentity(listType, item);
  if (primary) {
    needles.add(primary);
  }
  for (const candidate of [
    "shopping",
    "tasks",
    "custom",
    "contacts",
  ] as LlmListType[]) {
    const key = itemIdentity(candidate, item);
    if (key) {
      needles.add(key);
    }
  }
  for (const value of Object.values(item)) {
    if (typeof value === "string" && value.trim()) {
      needles.add(normalizeKey(value));
    }
  }
  return [...needles].filter(Boolean);
}

export function keysLooselyMatch(stored: string, needle: string): boolean {
  const a = normalizeKey(stored);
  const b = normalizeKey(needle);
  if (!a || !b) {
    return false;
  }
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * When the model guesses the wrong list_type on remove/update, prefer the list
 * where the item actually lives. If several lists match, keep the requested type
 * when it is among them; otherwise prefer tasks over shopping.
 */
export function chooseSavedListType(
  requested: LlmListType,
  hitTypes: string[],
): LlmListType | null {
  const unique = [...new Set(hitTypes.filter(Boolean))];
  if (unique.length === 0) {
    return null;
  }
  if (unique.includes(requested)) {
    return requested;
  }
  if (unique.length === 1) {
    return unique[0] as LlmListType;
  }
  if (unique.includes("tasks")) {
    return "tasks";
  }
  if (unique.includes("shopping")) {
    return "shopping";
  }
  return unique[0] as LlmListType;
}

/** Fix spoken list names when mutations prove shopping vs tasks. */
export function alignSpokenListType(
  response: string,
  mutations: Array<{ action: string; listType: string }>,
): string {
  const removes = mutations.filter((row) => row.action === "remove");
  const types = [...new Set(removes.map((row) => row.listType))];
  if (types.length !== 1) {
    return response;
  }
  const type = types[0];
  if (type === "tasks") {
    return response
      .replaceAll("מרשימת הקניות", "מרשימת המטלות")
      .replaceAll("רשימת הקניות", "רשימת המטלות");
  }
  if (type === "shopping") {
    return response
      .replaceAll("מרשימת המטלות", "מרשימת הקניות")
      .replaceAll("רשימת המטלות", "רשימת הקניות");
  }
  return response;
}

export function alignListTypeInReply(
  llmReply: string,
  mutations: Array<{ action: string; listType: string }>,
): string {
  try {
    const parsed: unknown = JSON.parse(llmReply);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return llmReply;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.response !== "string") {
      return llmReply;
    }
    const next = alignSpokenListType(record.response, mutations);
    if (next === record.response) {
      return llmReply;
    }
    return JSON.stringify({ ...record, response: next });
  } catch {
    return alignSpokenListType(llmReply, mutations);
  }
}

export function listItemLabels(
  snapshot: EmployeeRecordSnapshot,
  listType: "shopping" | "tasks",
): string[] {
  const keys = ITEM_NAME_KEYS[listType];
  return snapshot.lists
    .filter((list) => list.list_type === listType)
    .flatMap((list) =>
      list.items.map((item) => readItemText(item, keys)).filter(Boolean),
    );
}

export function hasEmployeeRecords(snapshot: EmployeeRecordSnapshot): boolean {
  return (
    snapshot.lists.length > 0 ||
    snapshot.filing.length > 0 ||
    (snapshot.reminders?.length ?? 0) > 0
  );
}

export function formatEmployeeContext(
  snapshot: EmployeeRecordSnapshot,
  label = "EMPLOYEE_SAVED_DATA",
): string {
  if (!hasEmployeeRecords(snapshot)) {
    return [
      `${label}:`,
      "There are currently no visible lists, tasks, or filings.",
      "If asked what someone needs to buy or do, say they have nothing pending.",
    ].join("\n");
  }

  return [
    `${label}:`,
    "Only these saved items exist. Do not invent others. active_reminders is the current reminder list.",
    "filing = durable personal facts / memory (family, preferences, IDs, notes). Use them as background context in later turns (e.g. trip ideas when a family-with-kids fact is filed). Do not ignore filing when advising.",
    JSON.stringify({
      lists: snapshot.lists,
      filing: snapshot.filing,
      active_reminders: (snapshot.reminders ?? [])
        .filter((row) => row.status === "active")
        .map((row) => row.item),
      reminders: snapshot.reminders ?? [],
    }),
  ].join("\n");
}

export interface TeamScheduleEntry {
  owner: string;
  item_name: string;
  date: string;
  time: string | null;
  all_day: boolean;
}

export function formatTeamSchedules(entries: TeamScheduleEntry[]): string {
  if (entries.length === 0) {
    return [
      "TEAM_SCHEDULES:",
      "No dated tasks or meetings are currently saved for any employee.",
    ].join("\n");
  }

  return [
    "TEAM_SCHEDULES:",
    "Dated tasks and meetings only. Do not reveal other employees' shopping or filings from this.",
    JSON.stringify(entries),
  ].join("\n");
}

export async function getTeamSchedules(userId: string): Promise<TeamScheduleEntry[]> {
  const lists = await prisma.employeeList.findMany({
    where: {
      listType: "tasks",
      employee: { userId },
    },
    include: {
      employee: { select: { name: true, nickname: true } },
      items: { orderBy: { createdAt: "asc" } },
    },
  });

  const entries: TeamScheduleEntry[] = [];
  for (const list of lists) {
    const owner = list.employee.nickname?.trim() || list.employee.name;
    for (const item of list.items) {
      const data = asRecord(item.data);
      const date = readItemText(data, ["תאריך לביצוע", "date"]);
      if (!date) {
        continue;
      }
      const time = readItemText(data, ["שעה לביצוע", "time"]) || null;
      const allDayValue = data["יום שלם"];
      entries.push({
        owner,
        item_name:
          readItemText(data, ITEM_NAME_KEYS.tasks) || item.itemKey,
        date,
        time,
        all_day: allDayValue === true || allDayValue === "true",
      });
    }
  }

  return entries;
}

export function parseAssignmentNote(text: string): {
  targetLabel: string;
  items: string[];
} | null {
  const match = text
    .trim()
    .match(/^(כולם|.+?)\s+צרי(?:ך|כה|כים)\s+(?:לקנות|להסיר|לעדכן)\s+(.+)$/);
  if (!match) {
    return null;
  }

  return {
    targetLabel: match[1].trim(),
    items: match[2]
      .split(/\s+ו/)
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

const LIST_TYPE_TITLES: Record<string, string> = {
  shopping: "Shopping",
  tasks: "Tasks",
  contacts: "Contacts",
  custom: "Custom list",
};

const TITLE_KEYS: Record<string, string[]> = {
  shopping: ITEM_NAME_KEYS.shopping,
  tasks: ITEM_NAME_KEYS.tasks,
  contacts: [...ITEM_NAME_KEYS.contacts, "שם משפחה", "last_name", "surname"],
  custom: ITEM_NAME_KEYS.custom,
};

export async function getEmployeeOwnedRecords(
  employeeId: string,
): Promise<EmployeeRecordsResponse> {
  const [lists, filings] = await Promise.all([
    prisma.employeeList.findMany({
      where: { employeeId },
      include: {
        employee: { select: { name: true, nickname: true } },
        items: { orderBy: { createdAt: "asc" } },
      },
      orderBy: [{ listType: "asc" }, { name: "asc" }],
    }),
    prisma.employeeFiling.findMany({
      where: { employeeId },
      include: { employee: { select: { name: true, nickname: true } } },
      orderBy: { itemName: "asc" },
    }),
  ]);

  const names = await loadEmployeeNames([
    ...lists.flatMap((list) => list.items.map((item) => item.addedById)),
    ...filings.map((filing) => filing.addedById),
  ]);

  const groups = lists
    .filter((list) => list.items.length > 0)
    .map((list) => {
      const ownerName = list.employee.nickname?.trim() || list.employee.name;
      return {
        type: list.listType,
        title: listTitle(list.listType, list.name),
        items: list.items.map((item) =>
          toOwnedListItem(list.listType, item, names, ownerName),
        ),
      };
    });

  if (filings.length > 0) {
    groups.push({
      type: "filing",
      title: "Filings",
      items: filings.map((filing) => {
        const ownerName = filing.employee.nickname?.trim() || filing.employee.name;
        return {
          id: filing.id,
          kind: "filing" as const,
          title: filing.itemName,
          details: filing.itemInfo
            ? [{ label: "Details", value: filing.itemInfo }]
            : [],
          fields: [
            { label: "Name", value: filing.itemName },
            { label: "Details", value: filing.itemInfo },
          ],
          createdBy:
            (filing.addedById ? names.get(filing.addedById) : undefined) ??
            ownerName,
          createdAt: filing.createdAt.toISOString(),
        };
      }),
    });
  }

  return { employeeId, groups };
}

export async function updateEmployeeRecord(
  employeeId: string,
  itemId: string,
  fields: EmployeeRecordField[],
  actorId: string,
): Promise<SharedItemEvent[]> {
  const listItem = await prisma.employeeListItem.findFirst({
    where: { id: itemId, list: { employeeId } },
    include: { list: true },
  });
  if (listItem) {
    return updateOwnedListItem(listItem, fields, actorId);
  }

  const filing = await prisma.employeeFiling.findFirst({
    where: { id: itemId, employeeId },
  });
  if (filing) {
    return updateOwnedFiling(filing, fields, actorId);
  }

  throw new NotFoundError("Item not found");
}

export async function deleteEmployeeRecord(
  employeeId: string,
  itemId: string,
  actorId: string,
): Promise<SharedItemEvent[]> {
  const listItem = await prisma.employeeListItem.findFirst({
    where: { id: itemId, list: { employeeId } },
    include: { list: true },
  });
  if (listItem) {
    return deleteOwnedListItem(listItem, actorId);
  }

  const filing = await prisma.employeeFiling.findFirst({
    where: { id: itemId, employeeId },
  });
  if (filing) {
    return deleteOwnedFiling(filing, actorId);
  }

  throw new NotFoundError("Item not found");
}

export async function getEmployeeRecordSnapshot(
  employeeId: string,
  options?: { accountOwner?: boolean },
): Promise<EmployeeRecordSnapshot> {
  const owner = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { userId: true, isOwner: true, kind: true },
  });
  const seeAll =
    options?.accountOwner === true ||
    (owner?.kind !== "digital" && owner?.isOwner === true);

  const listWhere = seeAll && owner
    ? { employee: { userId: owner.userId, kind: "human" } }
    : { employeeId };
  const filingWhere = seeAll && owner
    ? { employee: { userId: owner.userId, kind: "human" } }
    : { employeeId };

  const [ownLists, sharedItems, ownFilings, reminderRows, people] = await Promise.all([
    prisma.employeeList.findMany({
      where: listWhere,
      include: {
        employee: { select: { id: true, name: true, nickname: true } },
        items: { orderBy: { createdAt: "asc" } },
      },
      orderBy: [{ listType: "asc" }, { name: "asc" }],
    }),
    seeAll
      ? Promise.resolve([])
      : prisma.employeeListItem.findMany({
          where: {
            scope: "shared",
            list: { employeeId: { not: employeeId } },
          },
          include: {
            list: {
              include: { employee: { select: { id: true, name: true, nickname: true } } },
            },
          },
          orderBy: { createdAt: "asc" },
        }),
    prisma.employeeFiling.findMany({
      where: filingWhere,
      include: { employee: { select: { name: true, nickname: true } } },
      orderBy: { itemName: "asc" },
    }),
    owner ? listReminderRowsForUser(owner.userId) : Promise.resolve([]),
    owner
      ? prisma.employee.findMany({
          where: { userId: owner.userId },
          select: { id: true, name: true, nickname: true, surname: true },
        })
      : Promise.resolve([]),
  ]);

  const currentShopping = new Map<string, Set<string>>();
  const rememberShopping = (owner: string, items: Array<{ data: unknown; itemKey?: string }>) => {
    const keys = currentShopping.get(owner) ?? new Set<string>();
    for (const item of items) {
      const record = asRecord(item.data);
      const label = readItemText(record, ITEM_NAME_KEYS.shopping) || item.itemKey || "";
      if (label) {
        keys.add(normalizeKey(label));
      }
    }
    currentShopping.set(owner, keys);
  };

  for (const list of ownLists) {
    if (list.listType === "shopping") {
      rememberShopping(
        list.employee.nickname?.trim() || list.employee.name,
        list.items,
      );
    }
  }

  const sharedByOwner = new Map<string, Map<string, Record<string, unknown>[]>>();
  for (const item of sharedItems) {
    if (!visibleToIncludes(item.visibleTo, employeeId)) {
      continue;
    }
    const owner = item.list.employee.nickname?.trim() || item.list.employee.name;
    const byType = sharedByOwner.get(owner) ?? new Map<string, Record<string, unknown>[]>();
    const items = byType.get(item.list.listType) ?? [];
    items.push(withVisibility(item.data, "shared", owner));
    byType.set(item.list.listType, items);
    sharedByOwner.set(owner, byType);
    if (item.list.listType === "shopping") {
      rememberShopping(owner, [item]);
    }
  }

  const orphanIds = ownLists.flatMap((list) =>
    list.listType === "tasks"
      ? list.items
          .filter(
            (item) =>
              Boolean(item.id) &&
              isOrphanAssignment(asRecord(item.data), currentShopping),
          )
          .map((item) => item.id)
      : [],
  );
  if (orphanIds.length > 0) {
    await prisma.employeeListItem.deleteMany({
      where: { id: { in: orphanIds } },
    });
  }

  const lists = ownLists
    .map((list) => ({
      list_type: list.listType,
      ...(list.name ? { list_name: list.name } : {}),
      owner: list.employee.nickname?.trim() || list.employee.name,
      items: list.items
        .filter((item) =>
          !isOrphanAssignment(
            asRecord(item.data),
            currentShopping,
          ),
        )
        .map((item) =>
          withVisibility(
            item.data,
            item.scope,
            list.employee.nickname?.trim() || list.employee.name,
          ),
        ),
    }))
    .filter((list) => list.items.length > 0);

  for (const [owner, byType] of sharedByOwner) {
    for (const [listType, items] of byType) {
      lists.push({
        list_type: listType,
        owner,
        items,
      });
    }
  }

  const names = new Map(
    people.map((person) => [person.id, person.nickname?.trim() || person.name]),
  );

  return {
    lists,
    filing: ownFilings.map((filing) => ({
      item_name: filing.itemName,
      item_info: filing.itemInfo,
      owner: filing.employee.nickname?.trim() || filing.employee.name,
      scope: "personal" as const,
    })),
    reminders: reminderRows
      .filter((row) => {
        if (seeAll) {
          return true;
        }
        const pings = Array.isArray(row.pingIds) ? row.pingIds.map(String) : [];
        return row.ownerId === employeeId || pings.includes(employeeId);
      })
      .map((row) => toReminderSnapshotRow(row, names)),
  };
}

export interface SharedItemEvent {
  notifyEmployeeIds: string[];
  metadata: LlmMetadata;
  listOwnerId: string;
  purchased?: boolean;
}

export interface ListItemMutation {
  action: "add" | "update" | "remove";
  itemId: string;
  employeeId: string;
  listType: string;
  itemKey: string;
}

export async function applyEmployeeRecords(
  employeeId: string,
  metadata: LlmMetadata,
  visibility?: ItemVisibility,
  actorId?: string,
): Promise<{ events: SharedItemEvent[]; mutations: ListItemMutation[] }> {
  if (metadata.lists.length === 0 && metadata.filing.length === 0) {
    return { events: [], mutations: [] };
  }

  const resolved: ItemVisibility = visibility ?? {
    scope: "personal",
    addedById: employeeId,
    visibleTo: [employeeId],
  };
  const actor = actorId ?? employeeId;
  const events: SharedItemEvent[] = [];
  const mutations: ListItemMutation[] = [];

  for (const action of metadata.lists) {
    const result = await applyListAction(employeeId, action, resolved, actor);
    events.push(...result.events);
    mutations.push(...result.mutations);
  }

  for (const action of metadata.filing) {
    if (action.action === "remove_filing") {
      await prisma.employeeFiling.deleteMany({
        where: { employeeId, itemName: action.itemName.slice(0, 200) },
      });
    } else {
      await prisma.employeeFiling.upsert({
        where: {
          employeeId_itemName: {
            employeeId,
            itemName: action.itemName.slice(0, 200),
          },
        },
        create: {
          employeeId,
          itemName: action.itemName.slice(0, 200),
          itemInfo: action.itemInfo,
          addedById: resolved.addedById,
        },
        update: {
          itemInfo: action.itemInfo,
        },
      });
    }

    const watchers = sharedAudience(resolved, employeeId, actor);
    if (watchers.length > 0) {
      events.push({
        notifyEmployeeIds: watchers,
        metadata: { lists: [], filing: [{ ...action, targets: [] }] },
        listOwnerId: employeeId,
      });
    }
  }

  return { events, mutations };
}

export async function applyEmployeeMetadata(
  employeeId: string,
  metadata: LlmMetadata,
  visibility?: ItemVisibility,
  actorId?: string,
): Promise<SharedItemEvent[]> {
  const result = await applyEmployeeRecords(
    employeeId,
    metadata,
    visibility,
    actorId,
  );
  return result.events;
}

async function updateOwnedListItem(
  existing: {
    id: string;
    itemKey: string;
    data: unknown;
    scope: string;
    addedById: string | null;
    visibleTo: unknown;
    list: { id: string; employeeId: string; listType: string; name: string };
  },
  fields: EmployeeRecordField[],
  actorId: string,
): Promise<SharedItemEvent[]> {
  const listType = existing.list.listType as LlmListType;
  const nextData = {
    ...asRecord(existing.data),
    ...fieldsToData(fields),
  };
  const nextKey = itemIdentity(listType, nextData) || existing.itemKey;
  if (!ownedItemTitle(listType, nextData, nextKey)) {
    throw new ValidationError("Item name is required", { name: "Item name is required" });
  }

  if (nextKey !== existing.itemKey) {
    const clash = await prisma.employeeListItem.findUnique({
      where: { listId_itemKey: { listId: existing.list.id, itemKey: nextKey } },
    });
    if (clash && clash.id !== existing.id) {
      throw new ConflictError("An item with this name already exists");
    }
  }

  await prisma.employeeListItem.update({
    where: { id: existing.id },
    data: {
      itemKey: nextKey,
      data: toJsonValue(nextData),
    },
  });

  return mutationEvents({
    ownerId: existing.list.employeeId,
    actorId,
    item: existing,
    itemKey: existing.itemKey,
    metadata: {
      lists: [
        {
          action: "update",
          listType,
          listName: existing.list.name,
          items: [nextData],
          targets: [],
        },
      ],
      filing: [],
    },
  });
}

async function deleteOwnedListItem(
  existing: {
    id: string;
    itemKey: string;
    data: unknown;
    scope: string;
    addedById: string | null;
    visibleTo: unknown;
    list: { employeeId: string; listType: string; name: string };
  },
  actorId: string,
): Promise<SharedItemEvent[]> {
  const listType = existing.list.listType as LlmListType;
  await prisma.employeeListItem.delete({ where: { id: existing.id } });
  const watchers = mutationAudience(existing.list.employeeId, actorId, existing);
  await deleteRelatedAssignmentTasks(
    uniqueIds([actorId, existing.list.employeeId, ...watchers]),
    existing.itemKey,
  );
  return mutationEvents({
    ownerId: existing.list.employeeId,
    actorId,
    item: existing,
    itemKey: existing.itemKey,
    metadata: {
      lists: [
        {
          action: "remove",
          listType,
          listName: existing.list.name,
          items: [asRecord(existing.data)],
          targets: [],
        },
      ],
      filing: [],
    },
  });
}

async function updateOwnedFiling(
  existing: {
    id: string;
    employeeId: string;
    itemName: string;
    itemInfo: string;
    addedById: string | null;
  },
  fields: EmployeeRecordField[],
  actorId: string,
): Promise<SharedItemEvent[]> {
  const itemName =
    fieldValue(fields, "Name") || fieldValue(fields, "שם הפריט") || existing.itemName;
  const itemInfo = fieldValue(fields, "Details") ?? existing.itemInfo;
  if (!itemName.trim()) {
    throw new ValidationError("Item name is required", { name: "Item name is required" });
  }

  await prisma.employeeFiling.update({
    where: { id: existing.id },
    data: {
      itemName: itemName.slice(0, 200),
      itemInfo,
    },
  });

  return mutationEvents({
    ownerId: existing.employeeId,
    actorId,
    item: existing,
    itemKey: existing.itemName,
    metadata: {
      lists: [],
      filing: [
        {
          action: "update_filing",
          itemName: itemName.slice(0, 200),
          itemInfo,
          targets: [],
        },
      ],
    },
  });
}

async function deleteOwnedFiling(
  existing: {
    id: string;
    employeeId: string;
    itemName: string;
    itemInfo: string;
    addedById: string | null;
  },
  actorId: string,
): Promise<SharedItemEvent[]> {
  await prisma.employeeFiling.delete({ where: { id: existing.id } });
  return mutationEvents({
    ownerId: existing.employeeId,
    actorId,
    item: existing,
    itemKey: existing.itemName,
    metadata: {
      lists: [],
      filing: [
        {
          action: "remove_filing",
          itemName: existing.itemName,
          itemInfo: existing.itemInfo,
          targets: [],
        },
      ],
    },
  });
}

function fieldsToData(fields: EmployeeRecordField[]): Record<string, unknown> {
  const numeric = new Set(["כמות", "quantity", "qty"]);
  return Object.fromEntries(
    fields
      .filter((field) => field.label.trim())
      .map((field) => {
        const value = field.value.trim();
        if (numeric.has(field.label) && value !== "" && Number.isFinite(Number(value))) {
          return [field.label, Number(value)];
        }
        return [field.label, value];
      }),
  );
}

function fieldValue(fields: EmployeeRecordField[], label: string): string {
  return fields.find((field) => field.label === label)?.value.trim() ?? "";
}

async function mutationEvents(input: {
  ownerId: string;
  actorId: string;
  item: { scope?: string; addedById?: string | null; visibleTo?: unknown };
  itemKey: string;
  metadata: LlmMetadata;
}): Promise<SharedItemEvent[]> {
  const notifyEmployeeIds = mutationAudience(input.ownerId, input.actorId, input.item);
  if (notifyEmployeeIds.length === 0) {
    return [];
  }

  return [
    {
      notifyEmployeeIds,
      metadata: input.metadata,
      listOwnerId: input.ownerId,
    },
  ];
}

function mutationAudience(
  ownerId: string,
  actorId: string,
  item: { addedById?: string | null; visibleTo?: unknown },
): string[] {
  return uniqueIds([ownerId, item.addedById, ...idList(item.visibleTo)]).filter(
    (id) => id !== actorId,
  );
}

async function applyListAction(
  employeeId: string,
  action: LlmListAction,
  visibility: ItemVisibility,
  actorId: string,
): Promise<{ events: SharedItemEvent[]; mutations: ListItemMutation[] }> {
  const events: SharedItemEvent[] = [];
  const mutations: ListItemMutation[] = [];
  const resolvedAction = await resolveListActionAgainstSaved(employeeId, action);
  const listName = resolvedAction.listName.slice(0, 100);
  const list =
    (await prisma.employeeList.findUnique({
      where: {
        employeeId_listType_name: {
          employeeId,
          listType: resolvedAction.listType,
          name: listName,
        },
      },
    })) ??
    (await prisma.employeeList.create({
      data: {
        employeeId,
        listType: resolvedAction.listType,
        name: listName,
      },
    }));

  for (const item of resolvedAction.items) {
    const itemKey =
      itemIdentity(resolvedAction.listType, item) ||
      itemSearchNeedles(resolvedAction.listType, item)[0] ||
      "";
    if (!itemKey) {
      continue;
    }

    if (resolvedAction.action === "remove") {
      const existing = await findMatchingItem(list.id, itemKey);
      const removedKey = existing?.itemKey ?? itemKey;
      if (existing?.id) {
        await cancelReminderLinkedToWorkerItem(existing.id);
        mutations.push({
          action: "remove",
          itemId: existing.id,
          employeeId,
          listType: resolvedAction.listType,
          itemKey: removedKey,
        });
      }
      await prisma.employeeListItem.deleteMany({
        where: { listId: list.id, itemKey: removedKey },
      });
      const watchers = await resolveWatchers({
        existing,
        visibility,
        ownerId: employeeId,
        actorId,
        itemKey: removedKey,
      });
      await deleteRelatedAssignmentTasks(
        [...new Set([actorId, employeeId, ...watchers])],
        removedKey,
      );
      if (removedKey !== itemKey) {
        await deleteRelatedAssignmentTasks(
          [...new Set([actorId, employeeId, ...watchers])],
          itemKey,
        );
      }
      if (watchers.length > 0) {
        events.push({
          notifyEmployeeIds: watchers,
          metadata: {
            lists: [{ ...resolvedAction, items: [item] }],
            filing: [],
          },
          listOwnerId: employeeId,
          purchased:
            resolvedAction.listType === "shopping" && actorId === employeeId,
        });
      }
      continue;
    }

    const existing = await findMatchingItem(
      list.id,
      itemKey,
      resolvedAction.action,
    );
    const resolvedVisibility = mergeItemVisibility(existing, visibility, employeeId);
    const nextData = toJsonValue(
      resolvedAction.action === "update" && existing
        ? { ...asRecord(existing.data), ...item }
        : item,
    );
    const fields = {
      data: nextData,
      scope: resolvedVisibility.scope,
      addedById: resolvedVisibility.addedById,
      visibleTo: resolvedVisibility.visibleTo,
    };

    if (existing) {
      await prisma.employeeListItem.update({
        where: { id: existing.id },
        data: {
          ...fields,
          ...(resolvedAction.action === "update" && itemKey !== existing.itemKey
            ? { itemKey }
            : {}),
        },
      });
      mutations.push({
        action: "update",
        itemId: existing.id,
        employeeId,
        listType: resolvedAction.listType,
        itemKey: existing.itemKey,
      });
    } else {
      const created = await prisma.employeeListItem.create({
        data: {
          listId: list.id,
          itemKey,
          ...fields,
        },
      });
      mutations.push({
        action: "add",
        itemId: created.id,
        employeeId,
        listType: resolvedAction.listType,
        itemKey,
      });
    }

    const watchers = await resolveWatchers({
      existing: { ...resolvedVisibility, addedById: resolvedVisibility.addedById },
      visibility: resolvedVisibility,
      ownerId: employeeId,
      actorId,
      itemKey: existing?.itemKey ?? itemKey,
    });
    if (watchers.length > 0) {
      events.push({
        notifyEmployeeIds: watchers,
        metadata: {
          lists: [{ ...resolvedAction, items: [item] }],
          filing: [],
        },
        listOwnerId: employeeId,
      });
    }
  }

  return { events, mutations };
}

async function resolveListActionAgainstSaved(
  employeeId: string,
  action: LlmListAction,
): Promise<LlmListAction> {
  if (action.action !== "remove" && action.action !== "update") {
    return action;
  }

  const needles = action.items.flatMap((item) =>
    itemSearchNeedles(action.listType, item),
  );
  if (needles.length === 0) {
    return action;
  }

  const lists = await prisma.employeeList.findMany({
    where: { employeeId },
    include: { items: true },
  });
  const hitTypes: string[] = [];
  let matchedList:
    | {
        listType: string;
        name: string;
      }
    | undefined;

  for (const list of lists) {
    const hit = list.items.some((row) =>
      needles.some((needle) => keysLooselyMatch(row.itemKey, needle)),
    );
    if (!hit) {
      continue;
    }
    hitTypes.push(list.listType);
    if (!matchedList || list.listType === action.listType) {
      matchedList = { listType: list.listType, name: list.name };
    }
  }

  const chosen = chooseSavedListType(action.listType, hitTypes);
  if (!chosen || !matchedList) {
    return action;
  }

  const list =
    lists.find((row) => row.listType === chosen) ??
    lists.find((row) => row.listType === matchedList.listType);
  if (!list) {
    return action;
  }

  return {
    ...action,
    listType: list.listType as LlmListType,
    listName: list.name,
  };
}

async function findMatchingItem(
  listId: string,
  itemKey: string,
  action?: LlmListAction["action"],
) {
  const exact = await prisma.employeeListItem.findUnique({
    where: { listId_itemKey: { listId, itemKey } },
  });
  if (exact) {
    return exact;
  }

  const items = await prisma.employeeListItem.findMany({
    where: { listId },
  });
  const fuzzy =
    items.find(
      (item) =>
        item.itemKey === itemKey ||
        item.itemKey.includes(itemKey) ||
        itemKey.includes(item.itemKey),
    ) ?? null;
  if (fuzzy) {
    return fuzzy;
  }
  if (action === "update" && items.length === 1) {
    return items[0];
  }
  return null;
}

function mergeItemVisibility(
  existing: { scope?: string; addedById?: string | null; visibleTo?: unknown } | null,
  incoming: ItemVisibility,
  ownerId: string,
): ItemVisibility {
  if (!existing) {
    return incoming;
  }

  const existingIds = idList(existing.visibleTo);
  if (incoming.scope === "shared") {
    return {
      scope: "shared",
      addedById: existing.addedById ?? incoming.addedById,
      visibleTo: uniqueIds([
        ownerId,
        incoming.addedById,
        ...incoming.visibleTo,
        ...existingIds,
      ]),
    };
  }

  if (existing.scope === "shared" || existingIds.length > 1) {
    return {
      scope: "shared",
      addedById: existing.addedById ?? incoming.addedById,
      visibleTo: uniqueIds([ownerId, existing.addedById, ...existingIds]),
    };
  }

  return incoming;
}

async function resolveWatchers(input: {
  existing: { scope?: string; addedById?: string | null; visibleTo?: unknown } | null;
  visibility: ItemVisibility;
  ownerId: string;
  actorId: string;
  itemKey: string;
}): Promise<string[]> {
  const fromItem = sharedAudience(
    input.existing ?? input.visibility,
    input.ownerId,
    input.actorId,
  );
  const fromVisibility = sharedAudience(
    input.visibility,
    input.ownerId,
    input.actorId,
  );
  const watchers = uniqueIds([...fromItem, ...fromVisibility]);
  if (watchers.length > 0) {
    return watchers;
  }

  return findAssignmentWatcherIds(input.ownerId, input.actorId, input.itemKey);
}

function sharedAudience(
  item: { scope?: string; addedById?: string | null; visibleTo?: unknown },
  ownerId: string,
  actorId: string,
): string[] {
  if (!isSharedItem(item, ownerId)) {
    return [];
  }

  return uniqueIds([
    ownerId,
    item.addedById,
    ...idList(item.visibleTo),
  ]).filter((id) => id !== actorId);
}

function isSharedItem(
  item: { scope?: string; addedById?: string | null; visibleTo?: unknown },
  ownerId: string,
): boolean {
  const audience = uniqueIds([ownerId, item.addedById, ...idList(item.visibleTo)]);
  return item.scope === "shared" || audience.length > 1;
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && Boolean(item));
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function findAssignmentWatcherIds(
  ownerId: string,
  actorId: string,
  itemKey: string,
): Promise<string[]> {
  if (!itemKey) {
    return [];
  }

  const items = await prisma.employeeListItem.findMany({
    where: {
      itemKey: { contains: itemKey },
      list: {
        listType: "tasks",
        employeeId: { not: ownerId },
      },
    },
    select: { list: { select: { employeeId: true } } },
  });

  return uniqueIds(items.map((item) => item.list.employeeId)).filter(
    (id) => id !== actorId,
  );
}

async function deleteRelatedAssignmentTasks(
  employeeIds: string[],
  itemKey: string,
): Promise<void> {
  if (employeeIds.length === 0 || !itemKey) {
    return;
  }

  await prisma.employeeListItem.deleteMany({
    where: {
      itemKey: { contains: itemKey },
      list: {
        listType: "tasks",
        employeeId: { in: employeeIds },
      },
    },
  });
}

function withVisibility(
  data: unknown,
  scope: string,
  owner: string,
): Record<string, unknown> {
  return {
    ...asRecord(data),
    scope,
    owner,
  };
}

function visibleToIncludes(visibleTo: unknown, employeeId: string): boolean {
  return Array.isArray(visibleTo) && visibleTo.includes(employeeId);
}

function isOrphanAssignment(
  data: Record<string, unknown>,
  currentShopping: Map<string, Set<string>>,
): boolean {
  const parsed = parseAssignmentNote(readItemText(data, ITEM_NAME_KEYS.tasks));
  if (!parsed) {
    return false;
  }

  const wanted = parsed.items.map(normalizeKey).filter(Boolean);
  if (wanted.length === 0) {
    return false;
  }

  const owners =
    parsed.targetLabel === "כולם"
      ? [...currentShopping.keys()]
      : [...currentShopping.keys()].filter((owner) =>
          namesOverlap(owner, parsed.targetLabel),
        );

  if (owners.length === 0) {
    return true;
  }

  return !owners.some((owner) => {
    const keys = currentShopping.get(owner);
    return Boolean(keys && wanted.some((item) => shoppingHasItem(keys, item)));
  });
}

function namesOverlap(left: string, right: string): boolean {
  const a = normalizeKey(left);
  const b = normalizeKey(right);
  return a === b || a.includes(b) || b.includes(a);
}

function shoppingHasItem(keys: Set<string>, needle: string): boolean {
  if (keys.has(needle)) {
    return true;
  }

  for (const key of keys) {
    if (key.includes(needle) || needle.includes(key)) {
      return true;
    }
  }

  return false;
}

function listTitle(listType: string, listName: string): string {
  if (listType === "custom" && listName.trim()) {
    return listName.trim();
  }
  return LIST_TYPE_TITLES[listType] ?? (listName.trim() || "List");
}

function toOwnedListItem(
  listType: string,
  item: { id: string; itemKey?: string; data: unknown; addedById?: string | null; createdAt: Date },
  names: Map<string, string>,
  ownerName: string,
): EmployeeRecordsResponse["groups"][number]["items"][number] {
  const data = asRecord(item.data);
  return {
    id: item.id,
    kind: "list",
    title: ownedItemTitle(listType, data, item.itemKey ?? ""),
    details: ownedItemDetails(listType, data),
    fields: ownedItemFields(data),
    createdBy: (item.addedById ? names.get(item.addedById) : undefined) ?? ownerName,
    createdAt: item.createdAt.toISOString(),
  };
}

function ownedItemTitle(
  listType: string,
  data: Record<string, unknown>,
  fallback: string,
): string {
  if (listType === "contacts") {
    const first = readItemText(data, ITEM_NAME_KEYS.contacts);
    const last = readItemText(data, ["שם משפחה", "last_name", "surname"]);
    return [first, last].filter(Boolean).join(" ") || fallback;
  }

  const keys = ITEM_NAME_KEYS[listType as LlmListType] ?? ITEM_NAME_KEYS.custom;
  const titled = readItemText(data, keys);
  if (titled) {
    return titled;
  }
  if (listType === "custom") {
    for (const value of Object.values(data)) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return fallback;
}

function ownedItemFields(data: Record<string, unknown>): EmployeeRecordField[] {
  return Object.entries(data)
    .filter(([, value]) => value != null && String(value).trim())
    .map(([label, value]) => ({ label, value: String(value) }));
}

function ownedItemDetails(
  listType: string,
  data: Record<string, unknown>,
): Array<{ label: string; value: string }> {
  const skip = new Set((TITLE_KEYS[listType] ?? TITLE_KEYS.custom).map((key) => key));
  return Object.entries(data)
    .filter(([key, value]) => !skip.has(key) && value != null && String(value).trim())
    .map(([label, value]) => ({ label, value: String(value) }));
}

async function loadEmployeeNames(
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = uniqueIds(ids);
  if (unique.length === 0) {
    return new Map();
  }

  const employees = await prisma.employee.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, nickname: true },
  });

  return new Map(
    employees.map((employee) => [
      employee.id,
      employee.nickname?.trim() || employee.name,
    ]),
  );
}

function readItemText(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return "";
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 255);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return toPlainJson(value) as Prisma.InputJsonValue;
}
