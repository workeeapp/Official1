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
}

const ITEM_NAME_KEYS: Record<LlmListType, string[]> = {
  shopping: ["שם פריט", "name", "item_name"],
  contacts: ["שם פרטי", "first_name", "name"],
  tasks: ["שם מטלה", "name", "task", "item_name"],
  custom: ["name", "שם", "item_name", "שם פריט"],
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

  return normalizeKey(readItemText(item, ITEM_NAME_KEYS[listType]));
}

export function hasEmployeeRecords(snapshot: EmployeeRecordSnapshot): boolean {
  return snapshot.lists.length > 0 || snapshot.filing.length > 0;
}

export function formatEmployeeContext(snapshot: EmployeeRecordSnapshot): string {
  if (!hasEmployeeRecords(snapshot)) {
    return [
      "EMPLOYEE_SAVED_DATA:",
      "There are currently no visible lists, tasks, or filings.",
      "If asked what someone needs to buy or do, say they have nothing pending.",
    ].join("\n");
  }

  return [
    "EMPLOYEE_SAVED_DATA:",
    "This is the current saved information visible to this employee.",
    "Treat it as the only source of truth. Do not mention items that are not listed here.",
    "scope=personal means only this employee can see that item.",
    "scope=shared means the listed employees can see it.",
    "When this employee asks what they need to buy or do, include every item on their own lists.",
    "When they ask about another employee, mention only that employee's current shopping/tasks in this data. Never reveal another employee's personal items.",
    JSON.stringify(
      {
        lists: snapshot.lists,
        filing: snapshot.filing,
      },
      null,
      2,
    ),
  ].join("\n");
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
): Promise<EmployeeRecordSnapshot> {
  const [ownLists, sharedItems, ownFilings] = await Promise.all([
    prisma.employeeList.findMany({
      where: { employeeId },
      include: {
        employee: { select: { name: true, nickname: true } },
        items: { orderBy: { createdAt: "asc" } },
      },
      orderBy: [{ listType: "asc" }, { name: "asc" }],
    }),
    prisma.employeeListItem.findMany({
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
      where: { employeeId },
      include: { employee: { select: { name: true, nickname: true } } },
      orderBy: { itemName: "asc" },
    }),
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

  return {
    lists,
    filing: ownFilings.map((filing) => ({
      item_name: filing.itemName,
      item_info: filing.itemInfo,
      owner: filing.employee.nickname?.trim() || filing.employee.name,
      scope: "personal" as const,
    })),
  };
}

export interface SharedItemEvent {
  notifyEmployeeIds: string[];
  metadata: LlmMetadata;
  listOwnerId: string;
  purchased?: boolean;
}

export async function applyEmployeeMetadata(
  employeeId: string,
  metadata: LlmMetadata,
  visibility?: ItemVisibility,
  actorId?: string,
): Promise<SharedItemEvent[]> {
  if (metadata.lists.length === 0 && metadata.filing.length === 0) {
    return [];
  }

  const resolved: ItemVisibility = visibility ?? {
    scope: "personal",
    addedById: employeeId,
    visibleTo: [employeeId],
  };
  const actor = actorId ?? employeeId;
  const events: SharedItemEvent[] = [];

  for (const action of metadata.lists) {
    events.push(...(await applyListAction(employeeId, action, resolved, actor)));
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

  return events;
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
): Promise<SharedItemEvent[]> {
  const events: SharedItemEvent[] = [];
  const listName = action.listName.slice(0, 100);
  const list =
    (await prisma.employeeList.findUnique({
      where: {
        employeeId_listType_name: {
          employeeId,
          listType: action.listType,
          name: listName,
        },
      },
    })) ??
    (await prisma.employeeList.create({
      data: {
        employeeId,
        listType: action.listType,
        name: listName,
      },
    }));

  for (const item of action.items) {
    const itemKey = itemIdentity(action.listType, item);
    if (!itemKey) {
      continue;
    }

    if (action.action === "remove") {
      const existing = await findMatchingItem(list.id, itemKey);
      const removedKey = existing?.itemKey ?? itemKey;
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
            lists: [{ ...action, items: [item] }],
            filing: [],
          },
          listOwnerId: employeeId,
          purchased:
            action.listType === "shopping" && actorId === employeeId,
        });
      }
      continue;
    }

    const existing = await findMatchingItem(list.id, itemKey);
    const resolvedVisibility = mergeItemVisibility(existing, visibility, employeeId);
    const nextData = toJsonValue(
      action.action === "update" && existing
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
        data: fields,
      });
    } else {
      await prisma.employeeListItem.create({
        data: {
          listId: list.id,
          itemKey,
          ...fields,
        },
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
          lists: [{ ...action, items: [item] }],
          filing: [],
        },
        listOwnerId: employeeId,
      });
    }
  }

  return events;
}

async function findMatchingItem(listId: string, itemKey: string) {
  const exact = await prisma.employeeListItem.findUnique({
    where: { listId_itemKey: { listId, itemKey } },
  });
  if (exact) {
    return exact;
  }

  const items = await prisma.employeeListItem.findMany({
    where: { listId },
  });
  return (
    items.find(
      (item) =>
        item.itemKey === itemKey ||
        item.itemKey.includes(itemKey) ||
        itemKey.includes(item.itemKey),
    ) ?? null
  );
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
  return readItemText(data, keys) || fallback;
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
