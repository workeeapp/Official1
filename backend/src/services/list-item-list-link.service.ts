import { parseAttachmentIds } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { recordAuditEvent } from "./audit.service.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LINKABLE_LIST_TYPES = new Set(["shopping", "custom"]);

export type LinkedListRef = {
  list_id: string;
  list_type: string;
  list_name: string;
};

export type LinkedFromItemRef = {
  item_id: string;
  list_type: string;
  title: string;
};

export type LinkedListByName = {
  listType: string;
  listName: string;
};

const ITEM_LINK_ID_KEYS = ["linked_list_ids", "linkedListIds"];
const ITEM_UNLINK_ID_KEYS = ["unlink_list_ids", "unlinkListIds"];
const ITEM_LINK_NAME_KEYS = ["linked_lists", "linkedLists"];

/** Link fields ride on the ACTION item but are join rows, never item data. */
export function splitItemListLinks(record: Record<string, unknown>): {
  item: Record<string, unknown>;
  linkedListIds: string[];
  linkedLists: LinkedListByName[];
  unlinkListIds: string[];
} {
  const item: Record<string, unknown> = {};
  let linkedListIds: string[] = [];
  let unlinkListIds: string[] = [];
  let linkedLists: LinkedListByName[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (ITEM_LINK_ID_KEYS.includes(key)) {
      linkedListIds = [...linkedListIds, ...parseAttachmentIds(value)];
    } else if (ITEM_UNLINK_ID_KEYS.includes(key)) {
      unlinkListIds = [...unlinkListIds, ...parseAttachmentIds(value)];
    } else if (ITEM_LINK_NAME_KEYS.includes(key)) {
      linkedLists = [...linkedLists, ...parseLinkedListsByName(value)];
    } else {
      item[key] = value;
    }
  }
  return {
    item,
    linkedListIds: [...new Set(linkedListIds)],
    linkedLists: dedupeLinkedByName(linkedLists),
    unlinkListIds: [...new Set(unlinkListIds)],
  };
}

function parseLinkedListsByName(value: unknown): LinkedListByName[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: LinkedListByName[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const row = raw as Record<string, unknown>;
    const listTypeRaw =
      typeof row.list_type === "string"
        ? row.list_type.trim()
        : typeof row.listType === "string"
          ? row.listType.trim()
          : "";
    const listNameRaw =
      typeof row.list_name === "string"
        ? row.list_name.trim()
        : typeof row.listName === "string"
          ? row.listName.trim()
          : typeof row["רשימה"] === "string"
            ? row["רשימה"].trim()
            : "";
    if (!LINKABLE_LIST_TYPES.has(listTypeRaw)) {
      continue;
    }
    out.push({
      listType: listTypeRaw,
      listName: listTypeRaw === "shopping" ? "" : listNameRaw.slice(0, 100),
    });
  }
  return out;
}

function dedupeLinkedByName(rows: LinkedListByName[]): LinkedListByName[] {
  const seen = new Set<string>();
  const out: LinkedListByName[] = [];
  for (const row of rows) {
    const key = `${row.listType}\0${row.listName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(row);
  }
  return out;
}

function displayListName(listType: string, name: string): string {
  const trimmed = name.trim();
  if (trimmed) {
    return trimmed;
  }
  if (listType === "shopping") {
    return "קניות";
  }
  return trimmed;
}

/**
 * Resolve and apply linked_list_ids / linked_lists / unlink_list_ids on a
 * tasks host item. Visibility stays independent — linking never auto-shares.
 */
export async function applyListItemListLinks(input: {
  actorId: string;
  listItemId: string;
  hostListId: string;
  hostListType: string;
  linkedListIds?: string[];
  linkedLists?: LinkedListByName[];
  unlinkListIds?: string[];
}): Promise<{ linked: number; detached: number }> {
  const attachIds = input.linkedListIds ?? [];
  const byName = input.linkedLists ?? [];
  const detach = input.unlinkListIds ?? [];
  if (attachIds.length === 0 && byName.length === 0 && detach.length === 0) {
    return { linked: 0, detached: 0 };
  }
  if (input.hostListType !== "tasks") {
    return { linked: 0, detached: 0 };
  }

  const actor = await prisma.employee.findUnique({
    where: { id: input.actorId },
    select: { id: true, userId: true, isOwner: true },
  });
  if (!actor) {
    return { linked: 0, detached: 0 };
  }

  const resolvedIds = await resolveLinkableListIds({
    actor,
    hostListId: input.hostListId,
    linkedListIds: attachIds,
    linkedLists: byName,
  });

  let linked = 0;
  for (const listId of resolvedIds) {
    const existing = await prisma.listItemListLink.findUnique({
      where: {
        listItemId_listId: {
          listItemId: input.listItemId,
          listId,
        },
      },
      select: { id: true },
    });
    if (existing) {
      continue;
    }
    await prisma.listItemListLink.create({
      data: {
        listItemId: input.listItemId,
        listId,
        addedById: input.actorId,
      },
    });
    linked += 1;
  }

  let detached = 0;
  const detachIds = detach.filter((id) => UUID_RE.test(id));
  if (detachIds.length > 0) {
    const removed = await prisma.listItemListLink.deleteMany({
      where: {
        listItemId: input.listItemId,
        listId: { in: detachIds },
      },
    });
    detached = removed.count;
  }

  if (linked > 0 || detached > 0) {
    await recordAuditEvent({
      userId: actor.userId,
      actorEmployeeId: input.actorId,
      action: linked > 0 ? "list_item_list_link" : "list_item_list_unlink",
      entityType: "EmployeeListItem",
      entityId: input.listItemId,
      summary: `linked_lists +${linked} -${detached}`,
    });
  }
  return { linked, detached };
}

async function resolveLinkableListIds(input: {
  actor: { id: string; userId: string; isOwner: boolean };
  hostListId: string;
  linkedListIds: string[];
  linkedLists: LinkedListByName[];
}): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (listId: string) => {
    if (seen.has(listId) || listId === input.hostListId) {
      return;
    }
    seen.add(listId);
    out.push(listId);
  };

  const idCandidates = [
    ...new Set(input.linkedListIds.map((id) => id.trim()).filter((id) => UUID_RE.test(id))),
  ];
  if (idCandidates.length > 0) {
    const rows = await prisma.employeeList.findMany({
      where: {
        id: { in: idCandidates },
        deletedAt: null,
        listType: { in: [...LINKABLE_LIST_TYPES] },
        employee: { userId: input.actor.userId },
      },
      select: {
        id: true,
        employeeId: true,
        scope: true,
        visibleTo: true,
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of idCandidates) {
      const row = byId.get(id);
      if (!row || !actorCanSeeList(input.actor, row)) {
        continue;
      }
      push(row.id);
    }
  }

  for (const named of input.linkedLists) {
    if (!LINKABLE_LIST_TYPES.has(named.listType)) {
      continue;
    }
    if (named.listType === "custom" && !named.listName.trim()) {
      continue;
    }
    const matches = await prisma.employeeList.findMany({
      where: {
        deletedAt: null,
        listType: named.listType,
        name: named.listType === "shopping" ? "" : named.listName,
        employee: { userId: input.actor.userId },
      },
      select: {
        id: true,
        employeeId: true,
        scope: true,
        visibleTo: true,
      },
    });
    const visible = matches.filter((row) => actorCanSeeList(input.actor, row));
    if (visible.length === 1) {
      push(visible[0]!.id);
    }
  }

  return out;
}

function actorCanSeeList(
  actor: { id: string; isOwner: boolean },
  list: { employeeId: string; scope: string; visibleTo: unknown },
): boolean {
  if (list.employeeId === actor.id || actor.isOwner) {
    return true;
  }
  if (list.scope !== "shared") {
    return false;
  }
  const visible = Array.isArray(list.visibleTo)
    ? list.visibleTo.map(String)
    : [];
  return visible.includes(actor.id);
}

type SnapshotShape = {
  lists: Array<{
    list_id?: string;
    list_type?: string;
    list_name?: string;
    items: Record<string, unknown>[];
  }>;
};

/**
 * Adds `linked_lists` on task items and `linked_from_items` on shopping/custom lists.
 */
export async function withLinkedListRefs<T extends SnapshotShape>(
  snapshot: T,
): Promise<T> {
  const itemIdOf = (item: Record<string, unknown>) =>
    typeof item.item_id === "string" ? item.item_id : "";
  const listItemIds = snapshot.lists.flatMap((list) =>
    list.items.map(itemIdOf).filter(Boolean),
  );
  const listIds = snapshot.lists.flatMap((list) =>
    list.list_id ? [list.list_id] : [],
  );
  if (listItemIds.length === 0 && listIds.length === 0) {
    return snapshot;
  }

  const links = await prisma.listItemListLink.findMany({
    where: {
      OR: [
        ...(listItemIds.length > 0 ? [{ listItemId: { in: listItemIds } }] : []),
        ...(listIds.length > 0 ? [{ listId: { in: listIds } }] : []),
      ],
      list: { deletedAt: null, listType: { in: [...LINKABLE_LIST_TYPES] } },
      listItem: { deletedAt: null, list: { listType: "tasks", deletedAt: null } },
    },
    include: {
      list: { select: { id: true, listType: true, name: true } },
      listItem: {
        select: {
          id: true,
          itemKey: true,
          data: true,
          list: { select: { listType: true, titleField: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  if (links.length === 0) {
    return snapshot;
  }

  const byItem = new Map<string, LinkedListRef[]>();
  const byList = new Map<string, LinkedFromItemRef[]>();
  for (const link of links) {
    const listRef: LinkedListRef = {
      list_id: link.list.id,
      list_type: link.list.listType,
      list_name: displayListName(link.list.listType, link.list.name),
    };
    const itemRefs = byItem.get(link.listItemId) ?? [];
    if (!itemRefs.some((row) => row.list_id === listRef.list_id)) {
      itemRefs.push(listRef);
      byItem.set(link.listItemId, itemRefs);
    }

    const title = taskTitleFromData(
      link.listItem.data,
      link.listItem.itemKey,
      link.listItem.list.titleField,
    );
    const fromRef: LinkedFromItemRef = {
      item_id: link.listItemId,
      list_type: "tasks",
      title,
    };
    const listRefs = byList.get(link.listId) ?? [];
    if (!listRefs.some((row) => row.item_id === fromRef.item_id)) {
      listRefs.push(fromRef);
      byList.set(link.listId, listRefs);
    }
  }

  return {
    ...snapshot,
    lists: snapshot.lists.map((list) => {
      const items = list.items.map((item) => {
        const own = byItem.get(itemIdOf(item));
        return own && own.length > 0 ? { ...item, linked_lists: own } : item;
      });
      const fromItems = list.list_id ? byList.get(list.list_id) : undefined;
      return {
        ...list,
        items,
        ...(fromItems && fromItems.length > 0
          ? { linked_from_items: fromItems }
          : {}),
      };
    }),
  } as T;
}

function taskTitleFromData(
  data: unknown,
  fallback: string,
  titleField: string,
): string {
  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  for (const key of ["שם מטלה", "name", "task", "item_name", titleField]) {
    const trimmed = key.trim();
    if (!trimmed) {
      continue;
    }
    const value = record[trimmed];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback.trim() || "מטלה";
}
