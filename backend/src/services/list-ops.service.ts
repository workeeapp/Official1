import { Prisma } from "@prisma/client";
import {
  isAccountOwner,
  isGuestEmployee,
  type LlmListOp,
  type LlmListOpName,
  type PublicEmployee,
} from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { recordAuditEvent } from "./audit.service.js";
import { jsonStringList, visibleListColumns } from "./employee-records.service.js";
import { employeeDisplayName, matchEmployee } from "./employee-targets.service.js";
import { toPlainJson } from "./llm-client.js";
import {
  cancelActiveRemindersMatchingWork,
  cancelReminderLinkedToWorkerItem,
} from "./reminder.service.js";

export type ListOpRefusalReason =
  | "not_found"
  | "not_owner"
  | "builtin"
  | "empty"
  | "name_taken"
  | "unknown_column"
  | "column_exists"
  | "title_column"
  | "unknown_participant";

export interface ListOpResult {
  action: LlmListOpName;
  listId: string;
  /** Product label of the list (custom name, or קניות / מטלות / אנשי קשר). */
  listLabel: string;
  applied: boolean;
  /** delete_list on a built-in list clears its items instead of deleting it. */
  cleared?: boolean;
  refusal?: { reason: ListOpRefusalReason; detail?: string };
  /** In-thread + WhatsApp notices for partners (never the actor). */
  notices: Array<{ employeeId: string; text: string }>;
  cancelledReminders: string[];
}

const BUILTIN_LABELS: Record<string, string> = {
  shopping: "קניות",
  tasks: "מטלות",
  contacts: "אנשי קשר",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LoadedList = NonNullable<Awaited<ReturnType<typeof loadList>>>;

class ListOpRefused extends Error {
  constructor(
    readonly reason: ListOpRefusalReason,
    readonly detail?: string,
  ) {
    super(reason);
  }
}

/**
 * Engine for metadata.list_ops. Each op targets one list by list_id from
 * EMPLOYEE_SAVED_DATA. alter_list applies every field atomically or nothing.
 */
export async function applyListOps(input: {
  userId: string;
  actor: PublicEmployee;
  /** Humans on the account (participant names resolve against these). */
  employees: PublicEmployee[];
  ops: LlmListOp[];
}): Promise<ListOpResult[]> {
  const results: ListOpResult[] = [];
  for (const op of input.ops) {
    results.push(await applyListOp(input, op));
  }
  return results;
}

async function applyListOp(
  input: { userId: string; actor: PublicEmployee; employees: PublicEmployee[] },
  op: LlmListOp,
): Promise<ListOpResult> {
  const list = UUID_RE.test(op.listId) ? await loadList(op.listId, input.userId) : null;
  const base: ListOpResult = {
    action: op.action,
    listId: op.listId,
    listLabel: list ? listLabel(list) : "",
    applied: false,
    notices: [],
    cancelledReminders: [],
  };
  if (!list) {
    return { ...base, refusal: { reason: "not_found" } };
  }
  const canMutate =
    list.employeeId === input.actor.id ||
    (isAccountOwner(input.actor) && list.employee.kind === "human");
  if (!canMutate) {
    return { ...base, refusal: { reason: "not_owner" } };
  }

  try {
    return op.action === "delete_list"
      ? await deleteList(input, list, base)
      : await alterList(input, list, op, base);
  } catch (error) {
    if (error instanceof ListOpRefused) {
      return { ...base, refusal: { reason: error.reason, detail: error.detail } };
    }
    throw error;
  }
}

async function loadList(listId: string, userId: string) {
  return prisma.employeeList.findFirst({
    where: { id: listId, deletedAt: null, employee: { userId } },
    include: {
      employee: { select: { id: true, kind: true } },
      items: { where: { deletedAt: null } },
    },
  });
}

async function deleteList(
  input: { userId: string; actor: PublicEmployee; employees: PublicEmployee[] },
  list: LoadedList,
  base: ListOpResult,
): Promise<ListOpResult> {
  const builtin = list.listType !== "custom";
  const now = new Date();

  // Clock links are read from the live item rows, so cancel before soft-deleting them.
  for (const item of list.items) {
    await cancelReminderLinkedToWorkerItem(item.id);
  }
  await prisma.$transaction(async (tx) => {
    await tx.employeeListItem.updateMany({
      where: { listId: list.id, deletedAt: null },
      data: { deletedAt: now, reminderId: null },
    });
    if (!builtin) {
      await tx.employeeList.update({
        where: { id: list.id },
        data: { deletedAt: now },
      });
    }
  });

  const cancelledReminders: string[] = [];
  for (const item of list.items) {
    const cascade = await cancelActiveRemindersMatchingWork({
      userId: input.userId,
      itemKey: item.itemKey,
      itemLabel: item.itemKey,
      actorEmployeeId: input.actor.id,
    });
    cancelledReminders.push(...cascade.cancelledReminders);
  }

  const label = listLabel(list);
  await recordAuditEvent({
    userId: input.userId,
    actorEmployeeId: input.actor.id,
    action: "list_delete",
    entityType: "EmployeeList",
    entityId: list.id,
    summary: builtin
      ? `clear ${list.listType} (${list.items.length} items)`
      : `delete custom «${label}» (${list.items.length} items)`,
    detail: { listType: list.listType, name: list.name, itemCount: list.items.length },
  });

  const actorName = employeeDisplayName(input.actor);
  const text = builtin
    ? `«${actorName}» ניקה את רשימת «${label}».`
    : `«${actorName}» מחק את הרשימה «${label}».`;
  return {
    ...base,
    applied: true,
    ...(builtin ? { cleared: true } : {}),
    notices: watcherIds(list, input.actor.id).map((employeeId) => ({ employeeId, text })),
    cancelledReminders,
  };
}

async function alterList(
  input: { userId: string; actor: PublicEmployee; employees: PublicEmployee[] },
  list: LoadedList,
  op: LlmListOp,
  base: ListOpResult,
): Promise<ListOpResult> {
  const newName = op.newName.trim();
  const structural =
    newName !== "" ||
    op.addColumns.length > 0 ||
    op.removeColumns.length > 0 ||
    op.renameColumns.length > 0;
  if (!structural && op.addParticipants.length === 0 && op.removeParticipants.length === 0) {
    throw new ListOpRefused("empty");
  }
  if (structural && list.listType !== "custom") {
    throw new ListOpRefused("builtin");
  }

  // Working copy; order is fixed: column renames, removals, additions, list name, participants.
  const visible = visibleListColumns(list, list.items);
  let hidden = jsonStringList(list.hiddenColumns);
  let titleField = list.titleField.trim();

  for (const rename of op.renameColumns) {
    if (!visible.includes(rename.from)) {
      throw new ListOpRefused("unknown_column", rename.from);
    }
    if (visible.includes(rename.to)) {
      throw new ListOpRefused("column_exists", rename.to);
    }
    visible.splice(visible.indexOf(rename.from), 1, rename.to);
    hidden = hidden.filter((key) => key !== rename.to);
    if (titleField === rename.from) {
      titleField = rename.to;
    }
  }

  for (const column of op.removeColumns) {
    if (!visible.includes(column)) {
      throw new ListOpRefused("unknown_column", column);
    }
    if (column === titleField) {
      throw new ListOpRefused("title_column", column);
    }
    visible.splice(visible.indexOf(column), 1);
    if (!hidden.includes(column)) {
      hidden.push(column);
    }
  }

  for (const column of op.addColumns) {
    if (visible.includes(column)) {
      throw new ListOpRefused("column_exists", column);
    }
    visible.push(column);
    hidden = hidden.filter((key) => key !== column);
  }

  const renaming = newName !== "" && newName !== list.name;
  if (renaming) {
    const clash = await prisma.employeeList.findFirst({
      where: {
        employeeId: list.employeeId,
        listType: list.listType,
        name: newName,
        deletedAt: null,
        NOT: { id: list.id },
      },
    });
    if (clash) {
      throw new ListOpRefused("name_taken", newName);
    }
  }

  const people = input.employees.filter((employee) => !isGuestEmployee(employee));
  const resolve = (name: string) => {
    const employee = matchEmployee(name, people);
    if (!employee) {
      throw new ListOpRefused("unknown_participant", name);
    }
    return employee;
  };
  const added = op.addParticipants.map(resolve).filter((row) => row.id !== list.employeeId);
  const removed = op.removeParticipants
    .map(resolve)
    .filter((row) => row.id !== list.employeeId);
  const removedIds = new Set(removed.map((row) => row.id));
  const before = idList(list.visibleTo);
  const others = uniqueIds([...before, ...added.map((row) => row.id)]).filter(
    (id) => id !== list.employeeId && !removedIds.has(id),
  );
  const participantsChanged = added.length > 0 || removed.length > 0;
  const nextScope = others.length > 0 ? "shared" : "personal";
  const nextVisibleTo = others.length > 0 ? [list.employeeId, ...others] : [];

  await prisma.$transaction(async (tx) => {
    await tx.employeeList.update({
      where: { id: list.id },
      data: {
        ...(renaming ? { name: newName } : {}),
        ...(structural ? { columns: visible, hiddenColumns: hidden, titleField } : {}),
        ...(participantsChanged ? { scope: nextScope, visibleTo: nextVisibleTo } : {}),
      },
    });
    for (const item of list.items) {
      const data = asRecord(item.data);
      const renamedData =
        op.renameColumns.length > 0 ? renameDataKeys(data, op.renameColumns) : data;
      const itemVisibleTo = idList(item.visibleTo);
      const trimmedVisibleTo = itemVisibleTo.filter((id) => !removedIds.has(id));
      const dataChanged = renamedData !== data;
      const visibilityChanged = trimmedVisibleTo.length !== itemVisibleTo.length;
      if (!dataChanged && !visibilityChanged) {
        continue;
      }
      await tx.employeeListItem.update({
        where: { id: item.id },
        data: {
          ...(dataChanged ? { data: toJsonValue(renamedData) } : {}),
          ...(visibilityChanged ? { visibleTo: trimmedVisibleTo } : {}),
        },
      });
    }
  });

  const oldLabel = listLabel(list);
  const parts = describeAlter({
    newName: renaming ? newName : "",
    op,
    added,
    removed,
  });
  await recordAuditEvent({
    userId: input.userId,
    actorEmployeeId: input.actor.id,
    action: "list_alter",
    entityType: "EmployeeList",
    entityId: list.id,
    summary: `alter ${list.listType} «${oldLabel}»: ${parts.join("; ")}`,
    detail: {
      newName: renaming ? newName : undefined,
      addColumns: op.addColumns,
      removeColumns: op.removeColumns,
      renameColumns: op.renameColumns,
      addParticipants: added.map((row) => row.id),
      removeParticipants: removed.map((row) => row.id),
    },
  });

  const text = `«${employeeDisplayName(input.actor)}» עדכן את הרשימה «${oldLabel}»: ${parts.join(", ")}.`;
  const audience = uniqueIds([...watcherIds(list, input.actor.id), ...added.map((row) => row.id)])
    .filter((id) => id !== input.actor.id);
  return {
    ...base,
    listLabel: renaming ? newName : oldLabel,
    applied: true,
    notices: audience.map((employeeId) => ({ employeeId, text })),
  };
}

function renameDataKeys(
  data: Record<string, unknown>,
  renames: Array<{ from: string; to: string }>,
): Record<string, unknown> {
  if (!renames.some((row) => row.from in data)) {
    return data;
  }
  let next = data;
  for (const { from, to } of renames) {
    if (!(from in next)) {
      continue;
    }
    const rebuilt: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
      if (key === to) {
        continue;
      }
      rebuilt[key === from ? to : key] = value;
    }
    next = rebuilt;
  }
  return next;
}

function describeAlter(input: {
  newName: string;
  op: LlmListOp;
  added: PublicEmployee[];
  removed: PublicEmployee[];
}): string[] {
  const quote = (values: string[]) => values.map((value) => `«${value}»`).join(", ");
  return [
    ...input.op.renameColumns.map(
      (row) => `העמודה «${row.from}» נקראת עכשיו «${row.to}»`,
    ),
    input.op.removeColumns.length > 0 ? `הוסרו עמודות ${quote(input.op.removeColumns)}` : "",
    input.op.addColumns.length > 0 ? `נוספו עמודות ${quote(input.op.addColumns)}` : "",
    input.newName ? `שם חדש «${input.newName}»` : "",
    input.added.length > 0 ? `שותפו ${quote(input.added.map(employeeDisplayName))}` : "",
    input.removed.length > 0
      ? `הוסרו מהשיתוף ${quote(input.removed.map(employeeDisplayName))}`
      : "",
  ].filter(Boolean);
}

/** Owner + partners who could see the list before this change, minus the actor. */
function watcherIds(list: LoadedList, actorId: string): string[] {
  return uniqueIds([list.employeeId, ...idList(list.visibleTo)]).filter(
    (id) => id !== actorId,
  );
}

function listLabel(list: { listType: string; name: string }): string {
  if (list.listType === "custom") {
    return list.name.trim() || "הרשימה";
  }
  return BUILTIN_LABELS[list.listType] ?? list.name;
}

const REFUSAL_TEXT: Record<ListOpRefusalReason, (detail: string, label: string) => string> = {
  not_found: () => "לא מצאתי את הרשימה.",
  not_owner: (_detail, label) =>
    `רק הבעלים של הרשימה${label ? ` «${label}»` : ""} יכול לשנות או למחוק אותה.`,
  builtin: (_detail, label) =>
    `ברשימת «${label}» אפשר לשנות רק את השיתוף — לא שם ולא עמודות.`,
  empty: () => "לא ציינת מה לשנות ברשימה.",
  name_taken: (detail) => `כבר יש רשימה בשם «${detail}».`,
  unknown_column: (detail, label) => `אין ברשימה «${label}» עמודה בשם «${detail}».`,
  column_exists: (detail, label) => `כבר יש ברשימה «${label}» עמודה בשם «${detail}».`,
  title_column: (detail) =>
    `אי אפשר להסיר את העמודה «${detail}» — היא מזהה כל שורה ברשימה.`,
  unknown_participant: (detail) => `לא מצאתי עובד בשם «${detail}».`,
};

/** Spoken correction when the model claimed a list change the engine refused. */
export function formatListOpRefusals(results: ListOpResult[]): string {
  return results
    .filter((row) => row.refusal)
    .map((row) => {
      const refusal = row.refusal!;
      const text = REFUSAL_TEXT[refusal.reason](refusal.detail ?? "", row.listLabel);
      return results.length > 1 || refusal.reason === "not_found"
        ? text
        : `${text} לא שיניתי את הרשימה.`;
    })
    .join("\n");
}

/** Fallback when the model left response empty after an applied list op. */
export function formatListOpFallback(results: ListOpResult[]): string {
  return results
    .filter((row) => row.applied)
    .map((row) =>
      row.action === "delete_list"
        ? row.cleared
          ? `ניקיתי את רשימת «${row.listLabel}».`
          : `מחקתי את הרשימה «${row.listLabel}».`
        : `עדכנתי את הרשימה «${row.listLabel}».`,
    )
    .join("\n");
}

function idList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : [];
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return toPlainJson(value) as Prisma.InputJsonValue;
}
