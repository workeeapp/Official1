import { Prisma } from "@prisma/client";
import {
  isGuestEmployee,
  parseJobUrgency,
  type EmployeeRecordField,
  type EmployeeRecordsResponse,
  type JobUrgency,
  type LlmListAction,
  type LlmListType,
  type LlmMetadata,
} from "@workee/shared";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { normalizeRelativeDatesInRecord } from "../utils/relative-date.js";
import { hebrewWeekdayFromYmd } from "../utils/relative-date.js";
import { prisma } from "../database/prisma.js";
import { recordAuditEvent } from "./audit.service.js";
import { jobMetaFrom, stripJobMeta } from "./job-meta.js";
import {
  clearItemRecurrence,
  extractOccurrenceDone,
  itemDoneThrough,
  itemNextOccurrences,
  markOccurrenceDone,
  shapeItemRecurrence,
  stripRecurrenceMeta,
} from "./list-recurrence.js";
import { toPlainJson } from "./llm-client.js";
import {
  cancelActiveRemindersMatchingWork,
  cancelReminderLinkedToWorkerItem,
  formatJerusalemDateTime,
  listReminderRowsForUser,
  reminderRuleSnapshot,
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
    /** Copy into list_ops.list_id for alter_list / delete_list. */
    list_id?: string;
    list_type: string;
    list_name?: string;
    /** Custom lists only: visible columns and the column that names each row. */
    columns?: string[];
    title_field?: string;
    owner: string;
    scope: ItemScope;
    /** Partner display names when scope is shared (includes owner). */
    shared_with?: string[];
    items: Record<string, unknown>[];
  }>;
  filing: Array<{
    filing_id: string;
    item_name: string;
    item_info: string;
    item_description: string;
    owner: string;
    scope: ItemScope;
  }>;
  reminders?: ReminderSnapshotRow[];
}

const ITEM_NAME_KEYS: Record<LlmListType, string[]> = {
  shopping: ["שם פריט", "name", "item_name"],
  contacts: ["שם פרטי", "first_name", "name"],
  tasks: ["שם מטלה", "name", "task", "item_name"],
  // Custom lists have dynamic columns — never hardcode field names here.
  custom: [],
};

/** List-level metadata that must never become a custom row identity. */
const CUSTOM_ITEM_META_KEYS = new Set([
  "list_name",
  "listName",
  "רשימה",
  "list_type",
  "listType",
  "targets",
  "item_id",
  "itemId",
  "scope",
  "owner",
  "urgency",
  "דחיפות",
]);

/** Read urgency from an ACTION item; undefined when the model omitted it. */
export function readItemUrgency(
  item: Record<string, unknown>,
): JobUrgency | undefined {
  if (!("urgency" in item) && !("דחיפות" in item)) {
    return undefined;
  }
  return parseJobUrgency(item.urgency ?? item["דחיפות"]);
}

/** Inject into EMPLOYEE_SAVED_DATA only when not normal (same as OPEN_JOBS). */
export function urgencySnapshotField(
  urgency: unknown,
): Record<string, unknown> {
  const parsed = parseJobUrgency(urgency);
  return parsed === "normal" ? {} : { urgency: parsed };
}

/** Read a DB id from an ACTION item / row (jobs-style job_id aliases). */
export function readItemId(record: Record<string, unknown>): string {
  for (const key of ["item_id", "itemId", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function customItemDataEntries(
  item: Record<string, unknown>,
): Array<[string, unknown]> {
  return Object.entries(item).filter(([key]) => !CUSTOM_ITEM_META_KEYS.has(key));
}

/** "שם חדש" / "שם מטלה חדש" / "name new" → base column "שם" / "שם מטלה" / "name". */
const DRAFT_FIELD_RE = /^(.+?)\s+(חדש|חדשה|new)$/i;

function draftBaseField(key: string): string | null {
  const match = key.trim().match(DRAFT_FIELD_RE);
  return match?.[1]?.trim() || null;
}

/**
 * Collapse update-draft keys ("X חדש") onto real columns and drop leftovers.
 * Keeps list display / saved data as current values only — never old + new side by side.
 */
export function normalizeListItemData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  const drafts: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(data)) {
    if (CUSTOM_ITEM_META_KEYS.has(key)) {
      continue;
    }
    const base = draftBaseField(key);
    if (base) {
      drafts.push([base, value]);
      continue;
    }
    next[key] = value;
  }
  for (const [base, value] of drafts) {
    next[base] = value;
  }
  return next;
}

/** Merge an update patch onto existing item data, collapsing "X חדש" onto X. */
export function mergeListItemData(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return normalizeListItemData({ ...existing, ...patch });
}

export function jsonStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
      )
    : [];
}

/** Custom list columns: declared + seen in live rows, minus removed (hidden) columns. */
export function visibleListColumns(
  list: { columns?: unknown; hiddenColumns?: unknown },
  items: Array<{ data: unknown }>,
): string[] {
  const hidden = new Set(jsonStringList(list.hiddenColumns));
  const columns: string[] = [];
  const push = (key: string) => {
    if (!hidden.has(key) && !columns.includes(key)) {
      columns.push(key);
    }
  };
  for (const key of jsonStringList(list.columns)) {
    push(key);
  }
  for (const item of items) {
    for (const key of Object.keys(
      stripRecurrenceMeta(stripJobMeta(normalizeListItemData(asRecord(item.data)))),
    )) {
      push(key);
    }
  }
  return columns;
}

export function withoutHiddenColumns(
  data: Record<string, unknown>,
  hiddenColumns: unknown,
): Record<string, unknown> {
  const hidden = jsonStringList(hiddenColumns);
  if (hidden.length === 0) {
    return data;
  }
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !hidden.includes(key)),
  );
}

function firstCustomDataValue(item: Record<string, unknown>): string {
  for (const [, value] of customItemDataEntries(item)) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

export function itemIdentity(
  listType: LlmListType,
  item: Record<string, unknown>,
  titleField = "",
): string {
  if (listType === "contacts") {
    const first = readItemText(item, ITEM_NAME_KEYS.contacts);
    const last = readItemText(item, ["שם משפחה", "last_name", "surname"]);
    return normalizeKey([first, last].filter(Boolean).join("|"));
  }

  if (listType === "custom") {
    const field = titleField.trim();
    if (field) {
      const titled = readItemText(item, [field]);
      if (titled) {
        return normalizeKey(titled);
      }
    }
    return normalizeKey(firstCustomDataValue(item));
  }

  return normalizeKey(readItemText(item, ITEM_NAME_KEYS[listType]));
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
  for (const [, value] of customItemDataEntries(item)) {
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

/**
 * When the model leaves response empty after a successful apply, give the
 * speaker a short Hebrew confirmation so WhatsApp/UI are not blank.
 */
export function formatAppliedMutationFallback(
  listMutations: ListItemMutation[],
  filingMutations: FilingMutation[] = [],
): string {
  const removes = listMutations.filter(
    (row) => row.action === "remove" && !row.listShell,
  );
  if (removes.length === 1) {
    const row = removes[0]!;
    const list =
      row.listName?.trim() ||
      (row.listType === "shopping"
        ? "קניות"
        : row.listType === "tasks"
          ? "מטלות"
          : "הרשימה");
    return `הסרתי את «${row.itemLabel}» מרשימת «${list}».`;
  }
  if (removes.length > 1) {
    return `הסרתי ${removes.length} פריטים.`;
  }
  const updates = listMutations.filter(
    (row) => row.action === "update" && !row.listShell,
  );
  if (updates.length === 1) {
    const row = updates[0]!;
    const list = row.listName?.trim() || "הרשימה";
    return `עדכנתי את «${row.itemLabel}» ברשימת «${list}».`;
  }
  if (updates.length > 1) {
    return `עדכנתי ${updates.length} פריטים.`;
  }
  const adds = listMutations.filter(
    (row) => row.action === "add" && !row.listShell,
  );
  if (adds.length === 1) {
    const row = adds[0]!;
    const list = row.listName?.trim() || "הרשימה";
    return `הוספתי את «${row.itemLabel}» לרשימת «${list}».`;
  }
  if (adds.length > 1) {
    return `הוספתי ${adds.length} פריטים.`;
  }
  if (filingMutations.length === 1) {
    const row = filingMutations[0]!;
    const verb =
      row.action === "remove"
        ? "הסרתי תיוק"
        : row.action === "update"
          ? "עדכנתי תיוק"
          : "הוספתי תיוק";
    return `${verb}: «${row.itemName}».`;
  }
  if (listMutations.length > 0 || filingMutations.length > 0) {
    return "בוצע.";
  }
  return "";
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
    "Only these saved items exist. Do not invent others. active_reminders and reminders are pending clocks only (status=active). Past scheduled sends are not listed as history — answer only from live rows here when asked what is still scheduled.",
    "LIVE FACTS THIS TURN (saved lists/tasks/reminders/day plans only): if an earlier assistant reply named a saved task, reminder, or day-plan item that is NOT in this JSON now, do not repeat it as still visible (e.g. do not resurrect להזכיר למאיוש… from prior turns). This does NOT cancel a question you just asked (send text, missing phone/time) — the answer still completes it.",
    "MUTATE BY ID (like OPEN_JOBS job_id): every list item has item_id, every filing has filing_id, every reminder has reminder_id. lists.remove / lists.update / remove_filing / update_filing / reminders remove|update MUST copy that id from THIS turn — never omit it, never invent it, never speak ids aloud. With a matching id the server applies immediately (no delete-confirm). The server ignores remove/update without a matching id.",
    "filing = durable personal facts / memory (family, preferences, IDs, notes). Each row has filing_id, item_name, item_description (תיאור — use this to find the right filing), and optional item_info. Use them as background context in later turns. Do not ignore filing when advising.",
    "lists may include scope=personal|shared. When scope=shared, shared_with lists partner names — say the list is shared with those people; never call it only the owner's private list. Empty items=[] means the list exists but has no rows — say it is empty when relevant.",
    "List items may include urgency (urgent / very_urgent only — normal is omitted). When listing, append «דחוף» / «דחוף מאוד» on that • line. מה יש לי דחוף → only those rows.",
    "Each list has list_id (copy into list_ops for alter_list / delete_list — never speak it). Custom lists also show columns (current column names) and title_field (the column that names each row).",
    JSON.stringify({
      lists: snapshot.lists,
      filing: snapshot.filing,
      active_reminders: (snapshot.reminders ?? [])
        .filter((row) => row.status === "active")
        .map((row) => ({
          reminder_id: row.reminder_id,
          item: row.item,
        })),
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

type RecordSpeaker = {
  userId: string;
  isOwner: boolean;
  kind: string;
  name: string;
  nickname: string | null;
};

/** Human list/filing scope: account-owner sees all humans; everyone else sees self only. */
type HumanRecordScope =
  | { employeeId: string }
  | { employee: { userId: string; kind: "human" } };

/**
 * Single ownership gate for EMPLOYEE_SAVED_DATA and TEAM_SCHEDULES.
 * Guests never seeAll. Human is_owner (or accountOwner override) sees all humans on the account.
 */
async function resolveRecordVisibility(
  employeeId: string,
  options?: { accountOwner?: boolean },
): Promise<{
  speaker: RecordSpeaker | null;
  guestMode: boolean;
  seeAll: boolean;
  listWhere: HumanRecordScope;
  filingWhere: HumanRecordScope;
}> {
  const speaker = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      userId: true,
      isOwner: true,
      kind: true,
      name: true,
      nickname: true,
    },
  });
  const guestMode = Boolean(speaker && isGuestEmployee(speaker));
  const seeAll =
    !guestMode &&
    (options?.accountOwner === true ||
      (speaker?.kind !== "digital" && speaker?.isOwner === true));
  const scope: HumanRecordScope =
    seeAll && speaker
      ? { employee: { userId: speaker.userId, kind: "human" } }
      : { employeeId };
  return {
    speaker,
    guestMode,
    seeAll,
    listWhere: scope,
    filingWhere: scope,
  };
}

export type WorkerTaskRow = {
  addedById?: string | null;
  visibleTo?: unknown;
  reminderId?: string | null;
  data?: unknown;
};

export type WorkerReminderLink = { ownerId: string; pingIds: unknown };

/**
 * Everyone a digital-worker task involves: who asked for it, everyone in its
 * visible_to, the linked clock's owner and recipients, and an open job's asker
 * and subject. They can see it in WORKER_SAVED_DATA and act on it.
 */
export function workerTaskInvolvedIds(
  item: WorkerTaskRow,
  remindersById: ReadonlyMap<string, WorkerReminderLink>,
): {
  askers: string[];
  recipients: string[];
  all: string[];
} {
  const job = jobMetaFrom(item.data);
  const reminder = item.reminderId
    ? remindersById.get(item.reminderId.trim())
    : undefined;
  const pings = Array.isArray(reminder?.pingIds)
    ? reminder.pingIds.map(String).filter(Boolean)
    : [];
  const askers = uniqueIds([
    item.addedById ?? "",
    reminder?.ownerId ?? "",
    job?.askerId ?? "",
  ]);
  const recipients = uniqueIds([...pings, job?.subjectId ?? ""]);
  return {
    askers,
    recipients,
    all: uniqueIds([...askers, ...recipients, ...idList(item.visibleTo)]),
  };
}

/** True when a digital-worker list item involves this human speaker (not someone else). */
export function workerItemTiedToSpeaker(
  item: WorkerTaskRow,
  speakerId: string,
  remindersById: ReadonlyMap<string, WorkerReminderLink>,
): boolean {
  return workerTaskInvolvedIds(item, remindersById).all.includes(speakerId);
}

export async function loadWorkerReminderLinks(
  items: Array<{ reminderId?: string | null }>,
): Promise<Map<string, WorkerReminderLink>> {
  const reminderIds = [
    ...new Set(
      items
        .map((item) => item.reminderId?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (reminderIds.length === 0 || !prisma.reminder?.findMany) {
    return new Map();
  }
  const reminders = await prisma.reminder.findMany({
    where: { id: { in: reminderIds } },
    select: { id: true, ownerId: true, pingIds: true },
  });
  return new Map(reminders.map((row) => [row.id, row] as const));
}

function filterListItemsTiedToSpeaker<
  T extends {
    items: Array<WorkerTaskRow>;
  },
>(
  lists: T[],
  speakerId: string,
  remindersById: ReadonlyMap<string, WorkerReminderLink>,
): T[] {
  return lists.map((list) => ({
    ...list,
    items: list.items.filter((item) =>
      workerItemTiedToSpeaker(item, speakerId, remindersById),
    ),
  }));
}

/**
 * How this viewer relates to a worker task, so the model phrases it for them:
 * asked_by = who asked, for = who it pings / asks, viewer_is = asker | subject | self | other.
 */
function workerTaskViewerFields(
  item: WorkerTaskRow,
  viewerId: string,
  remindersById: ReadonlyMap<string, WorkerReminderLink>,
  names: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const { askers, recipients } = workerTaskInvolvedIds(item, remindersById);
  const nameOf = (id: string) => names.get(id) ?? "";
  const askedBy = askers.map(nameOf).filter(Boolean);
  const forNames = recipients.map(nameOf).filter(Boolean);
  const isAsker = askers.includes(viewerId);
  const isSubject = recipients.includes(viewerId);
  const viewerIs =
    isAsker && isSubject
      ? "self"
      : isAsker
        ? "asker"
        : isSubject
          ? "subject"
          : "other";
  return {
    ...(askedBy.length > 0 ? { asked_by: askedBy[0] } : {}),
    ...(forNames.length > 0 ? { for: forNames } : {}),
    viewer_is: viewerIs,
  };
}

export function formatTeamSchedules(entries: TeamScheduleEntry[]): string {
  if (entries.length === 0) {
    return [
      "TEAM_SCHEDULES:",
      "No dated tasks or meetings are currently visible for this speaker.",
    ].join("\n");
  }

  return [
    "TEAM_SCHEDULES:",
    "Dated tasks/meetings visible under the same ownership rules as EMPLOYEE_SAVED_DATA (owners: all humans; non-owners: speaker only). For conflict checks and «מה יש לX ביום…» when that person is in scope.",
    "Each row has owner — that person owns the item. For «מה אני צריך לעשות / מה יש לי» use ONLY the current speaker's rows from EMPLOYEE_SAVED_DATA (and their active_reminders) — do NOT list other owners as the speaker's work.",
    JSON.stringify(entries),
  ].join("\n");
}

/**
 * Same visibility gate as EMPLOYEE_SAVED_DATA (`resolveRecordVisibility` / seeAll).
 * Pass the speaker employee id — never dump every human's dated tasks for a non-owner.
 */
export async function getTeamSchedules(
  employeeId: string,
  options?: { accountOwner?: boolean },
): Promise<TeamScheduleEntry[]> {
  const { speaker, guestMode, listWhere } = await resolveRecordVisibility(
    employeeId,
    options,
  );
  if (!speaker || guestMode) {
    return [];
  }

  const lists = await prisma.employeeList.findMany({
    where: {
      listType: "tasks",
      deletedAt: null,
      ...listWhere,
    },
    include: {
      employee: { select: { name: true, nickname: true } },
      items: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
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
      where: { employeeId, deletedAt: null },
      include: {
        employee: { select: { name: true, nickname: true } },
        items: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
      },
      orderBy: [{ listType: "asc" }, { name: "asc" }],
    }),
    prisma.employeeFiling.findMany({
      where: { employeeId, deletedAt: null },
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
      const titleName =
        list.name.trim() ||
        (list.listType === "custom"
          ? deriveCustomListName(list.items.map((item) => asRecord(item.data)))
          : "");
      return {
        type: list.listType,
        title: listTitle(list.listType, titleName),
        items: list.items.map((item) =>
          toOwnedListItem(
            list.listType,
            { ...item, data: withoutHiddenColumns(asRecord(item.data), list.hiddenColumns) },
            names,
            ownerName,
            list.titleField,
          ),
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
          details: [
            ...(filing.itemDescription
              ? [{ label: "Description", value: filing.itemDescription }]
              : []),
            ...(filing.itemInfo
              ? [{ label: "Details", value: filing.itemInfo }]
              : []),
          ],
          fields: [
            { label: "Name", value: filing.itemName },
            { label: "Description", value: filing.itemDescription ?? "" },
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
    where: { id: itemId, deletedAt: null, list: { employeeId } },
    include: { list: true },
  });
  if (listItem) {
    return updateOwnedListItem(listItem, fields, actorId);
  }

  const filing = await prisma.employeeFiling.findFirst({
    where: { id: itemId, employeeId, deletedAt: null },
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
    where: { id: itemId, deletedAt: null, list: { employeeId } },
    include: { list: true },
  });
  if (listItem) {
    return deleteOwnedListItem(listItem, actorId);
  }

  const filing = await prisma.employeeFiling.findFirst({
    where: { id: itemId, employeeId, deletedAt: null },
  });
  if (filing) {
    return deleteOwnedFiling(filing, actorId);
  }

  throw new NotFoundError("Item not found");
}

export async function getEmployeeRecordSnapshot(
  employeeId: string,
  options?: {
    accountOwner?: boolean;
    /**
     * When loading a digital worker for WORKER_SAVED_DATA: keep only list items
     * tied to this human viewer (unless the viewer is an account owner).
     */
    scopeItemsToViewerId?: string;
  },
): Promise<EmployeeRecordSnapshot> {
  const { speaker: owner, guestMode, seeAll, listWhere, filingWhere } =
    await resolveRecordVisibility(employeeId, options);

  const viewerScope = options?.scopeItemsToViewerId
    ? await resolveRecordVisibility(options.scopeItemsToViewerId)
    : null;
  if (viewerScope?.guestMode) {
    return { lists: [], filing: [], reminders: [] };
  }

  // Live data only: soft-deleted list/filing rows stay in DB but are never loaded.
  // Done/cancelled reminder clocks stay in DB but are never injected into context.
  const [ownListsRaw, sharedItems, partnerLists, ownFilings, partnerFilings, reminderRows, people] =
    await Promise.all([
    prisma.employeeList.findMany({
      where: { ...listWhere, deletedAt: null },
      include: {
        employee: { select: { id: true, name: true, nickname: true } },
        items: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
      },
      orderBy: [{ listType: "asc" }, { name: "asc" }],
    }),
    seeAll
      ? Promise.resolve([])
      : prisma.employeeListItem.findMany({
          // Digital-worker tasks reach a person only through WORKER_SAVED_DATA.
          where: {
            scope: "shared",
            deletedAt: null,
            list: { employeeId: { not: employeeId }, employee: { kind: "human" } },
          },
          include: {
            list: {
              include: { employee: { select: { id: true, name: true, nickname: true } } },
            },
          },
          orderBy: { createdAt: "asc" },
        }),
    seeAll
      ? Promise.resolve([])
      : prisma.employeeList.findMany({
          where: {
            scope: "shared",
            deletedAt: null,
            employeeId: { not: employeeId },
            employee: { kind: "human" },
          },
          include: {
            employee: { select: { id: true, name: true, nickname: true } },
            items: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
          },
          orderBy: [{ listType: "asc" }, { name: "asc" }],
        }),
    prisma.employeeFiling.findMany({
      where: { ...filingWhere, deletedAt: null },
      include: { employee: { select: { name: true, nickname: true } } },
      orderBy: { itemName: "asc" },
    }),
    seeAll
      ? Promise.resolve([])
      : prisma.employeeFiling.findMany({
          where: {
            scope: "shared",
            deletedAt: null,
            employeeId: { not: employeeId },
          },
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

  const workerViewerId = viewerScope ? options?.scopeItemsToViewerId : undefined;
  const workerReminderLinks = workerViewerId
    ? await loadWorkerReminderLinks(ownListsRaw.flatMap((list) => list.items))
    : new Map<string, WorkerReminderLink>();
  const ownListsScoped =
    viewerScope && !viewerScope.seeAll && workerViewerId
      ? filterListItemsTiedToSpeaker(
          ownListsRaw,
          workerViewerId,
          workerReminderLinks,
        )
      : ownListsRaw;
  // After viewer scoping, drop empty list shells so day/self answers cannot latch onto stale list types.
  const ownLists =
    viewerScope && !viewerScope.seeAll && options?.scopeItemsToViewerId
      ? ownListsScoped.filter((list) => list.items.length > 0)
      : ownListsScoped;
  const names = new Map(
    people.map((person) => [person.id, person.nickname?.trim() || person.name]),
  );
  const activeReminders = new Map<string, LinkedReminderRow>(
    reminderRows
      .filter((row) => row.status === "active")
      .map((row) => [row.id, row] as const),
  );

  const sharedByOwner = new Map<string, Map<string, Record<string, unknown>[]>>();
  /** owner name → bucket → ids that can see those items (owner first). */
  const sharedAudience = new Map<string, Map<string, string[]>>();
  const seenPartnerListIds = new Set<string>();
  for (const item of sharedItems) {
    if (!visibleToIncludes(item.visibleTo, employeeId)) {
      continue;
    }
    const owner = item.list.employee.nickname?.trim() || item.list.employee.name;
    const byType = sharedByOwner.get(owner) ?? new Map<string, Record<string, unknown>[]>();
    const audience = sharedAudience.get(owner) ?? new Map<string, string[]>();
    audience.set(
      item.list.listType,
      uniqueIds([
        item.list.employee.id,
        ...(audience.get(item.list.listType) ?? []),
        ...idList(item.visibleTo),
      ]),
    );
    sharedAudience.set(owner, audience);
    const items = byType.get(item.list.listType) ?? [];
    items.push(
      withVisibility(
        item.data,
        "shared",
        owner,
        item.id,
        {
          ...linkedReminderField(item, activeReminders),
          ...urgencySnapshotField(item.urgency),
        },
      ),
    );
    byType.set(item.list.listType, items);
    sharedByOwner.set(owner, byType);
  }

  for (const list of partnerLists) {
    if (!visibleToIncludes(list.visibleTo, employeeId)) {
      continue;
    }
    if (seenPartnerListIds.has(list.id)) {
      continue;
    }
    seenPartnerListIds.add(list.id);
    const owner = list.employee.nickname?.trim() || list.employee.name;
    const byType = sharedByOwner.get(owner) ?? new Map<string, Record<string, unknown>[]>();
    const bucketKey =
      list.listType === "custom" && list.name.trim()
        ? `custom\0${list.name.trim()}`
        : list.listType === "custom"
          ? `custom\0${deriveCustomListName(list.items.map((item) => asRecord(item.data))) || list.id}`
          : list.listType;
    const items = byType.get(bucketKey) ?? [];
    for (const item of list.items) {
      items.push(
        withVisibility(
          item.data,
          "shared",
          owner,
          item.id,
          {
            ...linkedReminderField(item, activeReminders),
            ...urgencySnapshotField(item.urgency),
          },
        ),
      );
    }
    byType.set(bucketKey, items);
    sharedByOwner.set(owner, byType);
  }

  const lists: EmployeeRecordSnapshot["lists"] = [];
  const seenListKeys = new Set<string>();
  const pushSnapshotList = (
    entry: EmployeeRecordSnapshot["lists"][number] | null,
  ) => {
    if (!entry) {
      return;
    }
    const key = `${entry.owner}\0${entry.list_type}\0${entry.list_name ?? ""}`;
    if (seenListKeys.has(key)) {
      return;
    }
    seenListKeys.add(key);
    lists.push(entry);
  };

  for (const list of ownLists) {
    // Guests only see lists shared with them — never personal shopping/tasks.
    if (guestMode && list.scope !== "shared") {
      continue;
    }
    pushSnapshotList(
      toListSnapshotEntry({
        listId: list.id,
        listType: list.listType,
        listName: list.name,
        titleField: list.titleField,
        columns: list.columns,
        hiddenColumns: list.hiddenColumns,
        ownerId: list.employee.id,
        ownerName: list.employee.nickname?.trim() || list.employee.name,
        scope: list.scope === "shared" ? "shared" : "personal",
        visibleTo: list.visibleTo,
        items: list.items,
        names,
        activeReminders,
        ...(workerViewerId
          ? {
              itemExtras: (item: WorkerTaskRow) =>
                workerTaskViewerFields(
                  item,
                  workerViewerId,
                  workerReminderLinks,
                  names,
                ),
            }
          : {}),
      }),
    );
  }

  for (const list of partnerLists) {
    if (!visibleToIncludes(list.visibleTo, employeeId)) {
      continue;
    }
    pushSnapshotList(
      toListSnapshotEntry({
        listId: list.id,
        listType: list.listType,
        listName: list.name,
        titleField: list.titleField,
        columns: list.columns,
        hiddenColumns: list.hiddenColumns,
        ownerId: list.employee.id,
        ownerName: list.employee.nickname?.trim() || list.employee.name,
        scope: "shared",
        visibleTo: list.visibleTo,
        items: list.items,
        names,
        activeReminders,
      }),
    );
  }

  // Item-level shared shopping/tasks on someone else's personal list (legacy path).
  for (const [owner, byType] of sharedByOwner) {
    for (const [bucketKey, items] of byType) {
      if (items.length === 0) {
        continue;
      }
      const customSep = bucketKey.indexOf("\0");
      const listType = customSep >= 0 ? "custom" : bucketKey;
      const listName =
        customSep >= 0 ? bucketKey.slice(customSep + 1) : undefined;
      // Skip if we already emitted this named custom/shared list from partnerLists/ownLists.
      const already = lists.some(
        (row) =>
          row.owner === owner &&
          row.list_type === listType &&
          (row.list_name ?? "") === (listName ?? ""),
      );
      if (already) {
        continue;
      }
      const audience = sharedAudience.get(owner)?.get(bucketKey) ?? [];
      const sharedWith = audience
        .map((id) => names.get(id) ?? "")
        .filter(Boolean);
      lists.push({
        list_type: listType,
        ...(listName ? { list_name: listName } : {}),
        owner,
        scope: "shared",
        shared_with: sharedWith.length > 0 ? sharedWith : [owner],
        items,
      });
    }
  }

  const filingRows = [
    ...ownFilings
      .filter((filing) => !guestMode || filing.scope === "shared")
      .map((filing) => ({
        filing_id: filing.id,
        item_name: filing.itemName,
        item_info: filing.itemInfo,
        item_description: filing.itemDescription ?? "",
        owner: filing.employee.nickname?.trim() || filing.employee.name,
        scope: (filing.scope === "shared" ? "shared" : "personal") as
          | "shared"
          | "personal",
      })),
    ...partnerFilings
      .filter((filing) => visibleToIncludes(filing.visibleTo, employeeId))
      .map((filing) => ({
        filing_id: filing.id,
        item_name: filing.itemName,
        item_info: filing.itemInfo,
        item_description: filing.itemDescription ?? "",
        owner: filing.employee.nickname?.trim() || filing.employee.name,
        scope: "shared" as const,
      })),
  ];

  return {
    lists,
    filing: filingRows,
    // Guests do not get reminder clocks — shared-list Q&A only.
    reminders: guestMode
      ? []
      : reminderRows
          .filter((row) => {
            if (seeAll) {
              return true;
            }
            const pings = Array.isArray(row.pingIds)
              ? row.pingIds.map(String)
              : [];
            return row.ownerId === employeeId || pings.includes(employeeId);
          })
          .filter((row) => row.status === "active")
          .map((row) => toReminderSnapshotRow(row, names)),
  };
}

export interface SharedItemEvent {
  notifyEmployeeIds: string[];
  metadata: LlmMetadata;
  listOwnerId: string;
  purchased?: boolean;
  partnerNames?: string[];
}

export interface ListItemMutation {
  action: "add" | "update" | "remove";
  itemId: string;
  employeeId: string;
  listType: string;
  itemKey: string;
  /** Hebrew product label for the item (not schema jargon). */
  itemLabel: string;
  listName?: string;
  /** Named custom list opened/updated with no real rows (columns only). */
  listShell?: boolean;
  /** Set on a remove/update of a digital-worker task: everyone it involved before the change. */
  workerTaskInvolvedIds?: string[];
}

type WorkerAccessCache = {
  ownerDigital?: boolean;
  actor?: { kind: string; isOwner: boolean } | null;
};

/**
 * Remove/update of a digital-worker task: anyone the task involves may act on it
 * (plus account owners and server-side worker turns). Null = not a worker task.
 */
async function workerTaskAccess(
  employeeId: string,
  actorId: string,
  item: WorkerTaskRow,
  cache: WorkerAccessCache,
): Promise<{ allowed: boolean; involvedIds: string[] } | null> {
  if (cache.ownerDigital === undefined) {
    const owner = prisma.employee?.findUnique
      ? await prisma.employee.findUnique({
          where: { id: employeeId },
          select: { kind: true },
        })
      : null;
    cache.ownerDigital = owner?.kind === "digital";
  }
  if (!cache.ownerDigital) {
    return null;
  }
  const links = await loadWorkerReminderLinks([item]);
  const involvedIds = workerTaskInvolvedIds(item, links).all;
  if (actorId === employeeId || involvedIds.includes(actorId)) {
    return { allowed: true, involvedIds };
  }
  if (cache.actor === undefined) {
    cache.actor = prisma.employee?.findUnique
      ? await prisma.employee.findUnique({
          where: { id: actorId },
          select: { kind: true, isOwner: true },
        })
      : null;
  }
  const allowed =
    cache.actor?.kind === "digital" || cache.actor?.isOwner === true;
  return { allowed, involvedIds };
}

export interface FilingMutation {
  action: "add" | "update" | "remove";
  itemName: string;
  itemInfo: string;
  itemDescription: string;
}

export async function applyEmployeeRecords(
  employeeId: string,
  metadata: LlmMetadata,
  visibility?: ItemVisibility,
  actorId?: string,
): Promise<{
  events: SharedItemEvent[];
  mutations: ListItemMutation[];
  filingMutations: FilingMutation[];
  cancelledReminders: string[];
}> {
  if (metadata.lists.length === 0 && metadata.filing.length === 0) {
    return {
      events: [],
      mutations: [],
      filingMutations: [],
      cancelledReminders: [],
    };
  }

  const resolved: ItemVisibility = visibility ?? {
    scope: "personal",
    addedById: employeeId,
    visibleTo: [employeeId],
  };
  const actor = actorId ?? employeeId;
  const events: SharedItemEvent[] = [];
  const mutations: ListItemMutation[] = [];
  const filingMutations: FilingMutation[] = [];
  const cancelledReminders: string[] = [];

  for (const action of metadata.lists) {
    const result = await applyListAction(employeeId, action, resolved, actor);
    events.push(...result.events);
    mutations.push(...result.mutations);
    cancelledReminders.push(...result.cancelledReminders);
  }

  const filingOwner = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { userId: true },
  });
  for (const action of metadata.filing) {
    if (action.action === "remove_filing") {
      const filingId = action.filingId.trim();
      if (!filingId) {
        continue;
      }
      const existing = await prisma.employeeFiling.findFirst({
        where: { id: filingId, employeeId, deletedAt: null },
      });
      if (!existing) {
        continue;
      }
      await prisma.employeeFiling.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
      });
      filingMutations.push({
        action: "remove",
        itemName: existing.itemName,
        itemInfo: existing.itemInfo,
        itemDescription: existing.itemDescription ?? "",
      });
      if (filingOwner) {
        await recordAuditEvent({
          userId: filingOwner.userId,
          actorEmployeeId: actor,
          action: "filing_remove",
          entityType: "EmployeeFiling",
          entityId: existing.id,
          summary: `remove filing: ${existing.itemName}`,
        });
      }
    } else if (action.action === "update_filing") {
      const filingId = action.filingId.trim();
      if (!filingId) {
        continue;
      }
      const existingFiling = await prisma.employeeFiling.findFirst({
        where: { id: filingId, employeeId, deletedAt: null },
      });
      if (!existingFiling) {
        continue;
      }
      const itemDescription = action.itemDescription.trim().slice(0, 4000);
      const nextDescription =
        itemDescription || existingFiling.itemDescription || "";
      const shareFiling =
        resolved.scope === "shared" || resolved.visibleTo.length > 1;
      await prisma.employeeFiling.update({
        where: { id: existingFiling.id },
        data: {
          ...(action.itemName.trim()
            ? { itemName: action.itemName.trim().slice(0, 200) }
            : {}),
          itemInfo: action.itemInfo,
          itemDescription: nextDescription,
          ...(shareFiling
            ? {
                scope: "shared",
                visibleTo: uniqueIds([
                  employeeId,
                  ...resolved.visibleTo,
                  ...idList(existingFiling.visibleTo),
                ]),
              }
            : {}),
        },
      });
      const nextName = action.itemName.trim()
        ? action.itemName.trim().slice(0, 200)
        : existingFiling.itemName;
      filingMutations.push({
        action: "update",
        itemName: nextName,
        itemInfo: action.itemInfo,
        itemDescription: nextDescription,
      });
      if (filingOwner) {
        await recordAuditEvent({
          userId: filingOwner.userId,
          actorEmployeeId: actor,
          action: "filing_update",
          entityType: "EmployeeFiling",
          entityId: existingFiling.id,
          summary: `update filing: ${nextName}`,
        });
      }
    } else {
      const itemName = action.itemName.slice(0, 200);
      const itemDescription = action.itemDescription.trim().slice(0, 4000);
      const existingFiling = await prisma.employeeFiling.findFirst({
        where: { employeeId, itemName, deletedAt: null },
      });
      if (existingFiling) {
        const shareFiling =
          resolved.scope === "shared" || resolved.visibleTo.length > 1;
        const nextDescription =
          itemDescription || existingFiling.itemDescription || "";
        await prisma.employeeFiling.update({
          where: { id: existingFiling.id },
          data: {
            itemInfo: action.itemInfo,
            itemDescription: nextDescription,
            ...(shareFiling
              ? {
                  scope: "shared",
                  visibleTo: uniqueIds([
                    employeeId,
                    ...resolved.visibleTo,
                    ...idList(existingFiling.visibleTo),
                  ]),
                }
              : {}),
          },
        });
        filingMutations.push({
          action: "update",
          itemName,
          itemInfo: action.itemInfo,
          itemDescription: nextDescription,
        });
        if (filingOwner) {
          await recordAuditEvent({
            userId: filingOwner.userId,
            actorEmployeeId: actor,
            action: "filing_update",
            entityType: "EmployeeFiling",
            entityId: existingFiling.id,
            summary: `update filing: ${itemName}`,
          });
        }
      } else {
        if (!itemDescription) {
          // Incomplete add — model should ask for תיאור first.
          continue;
        }
        const shareFiling =
          resolved.scope === "shared" || resolved.visibleTo.length > 1;
        const created = await prisma.employeeFiling.create({
          data: {
            employeeId,
            itemName,
            itemInfo: action.itemInfo,
            itemDescription,
            addedById: resolved.addedById,
            ...(shareFiling
              ? { scope: "shared", visibleTo: resolved.visibleTo }
              : {}),
          },
        });
        filingMutations.push({
          action: "add",
          itemName,
          itemInfo: action.itemInfo,
          itemDescription,
        });
        if (filingOwner) {
          await recordAuditEvent({
            userId: filingOwner.userId,
            actorEmployeeId: actor,
            action: "filing_add",
            entityType: "EmployeeFiling",
            entityId: created.id,
            summary: `add filing: ${itemName}`,
          });
        }
      }
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

  return { events, mutations, filingMutations, cancelledReminders };
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
    list: {
      id: string;
      employeeId: string;
      listType: string;
      name: string;
      titleField?: string;
    };
  },
  fields: EmployeeRecordField[],
  actorId: string,
): Promise<SharedItemEvent[]> {
  const listType = existing.list.listType as LlmListType;
  const nextData = mergeListItemData(asRecord(existing.data), fieldsToData(fields));
  const nextKey =
    itemIdentity(listType, nextData, existing.list.titleField ?? "") ||
    existing.itemKey;
  if (!ownedItemTitle(listType, nextData, nextKey)) {
    throw new ValidationError("Item name is required", { name: "Item name is required" });
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
    list: { employeeId: string; listType: string; name: string; titleField?: string };
  },
  actorId: string,
): Promise<SharedItemEvent[]> {
  const listType = existing.list.listType as LlmListType;
  await prisma.employeeListItem.update({
    where: { id: existing.id },
    data: { deletedAt: new Date(), reminderId: null },
  });
  await cancelReminderLinkedToWorkerItem(existing.id);
  const owner = await prisma.employee.findUnique({
    where: { id: existing.list.employeeId },
    select: { userId: true },
  });
  if (owner) {
    const label =
      ownedItemTitle(
        listType,
        asRecord(existing.data),
        existing.itemKey,
        existing.list?.titleField,
      ) || existing.itemKey;
    await cancelActiveRemindersMatchingWork({
      userId: owner.userId,
      itemKey: existing.itemKey,
      itemLabel: label,
      actorEmployeeId: actorId,
    });
    await recordAuditEvent({
      userId: owner.userId,
      actorEmployeeId: actorId,
      action: "list_remove",
      entityType: "EmployeeListItem",
      entityId: existing.id,
      summary: `remove ${listType}: ${existing.itemKey}`,
    });
  }
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
          itemDescription: "",
          targets: [],
          filingId: existing.id,
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
  await prisma.employeeFiling.update({
    where: { id: existing.id },
    data: { deletedAt: new Date() },
  });
  const owner = await prisma.employee.findUnique({
    where: { id: existing.employeeId },
    select: { userId: true },
  });
  if (owner) {
    await recordAuditEvent({
      userId: owner.userId,
      actorEmployeeId: actorId,
      action: "filing_remove",
      entityType: "EmployeeFiling",
      entityId: existing.id,
      summary: `remove filing: ${existing.itemName}`,
    });
  }
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
          itemDescription: "",
          targets: [],
          filingId: existing.id,
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
  item: { scope?: string; addedById?: string | null; visibleTo?: unknown },
): string[] {
  // Same rule as chat plan: only real share partners, never everyone in a personal row.
  return sharedAudience(item, ownerId, actorId);
}

async function applyListAction(
  employeeId: string,
  action: LlmListAction,
  visibility: ItemVisibility,
  actorId: string,
): Promise<{
  events: SharedItemEvent[];
  mutations: ListItemMutation[];
  cancelledReminders: string[];
}> {
  const events: SharedItemEvent[] = [];
  const mutations: ListItemMutation[] = [];
  const cancelledReminders: string[] = [];
  const seenCascadeTaskIds = new Set<string>();
  const accessCache: WorkerAccessCache = {};
  const resolvedAction = await resolveListActionAgainstSaved(employeeId, action);
  let listName = resolvedAction.listName.slice(0, 100);
  if (!listName && resolvedAction.listType === "custom") {
    for (const raw of resolvedAction.items) {
      const record = asRecord(raw);
      const fromItem =
        typeof record.list_name === "string"
          ? record.list_name.trim()
          : typeof record.listName === "string"
            ? record.listName.trim()
            : "";
      if (fromItem) {
        listName = fromItem.slice(0, 100);
        break;
      }
    }
  }
  // Model sometimes puts the new list title only as the sole title-like item.
  let itemsForApply = resolvedAction.items;
  if (
    !listName &&
    resolvedAction.listType === "custom" &&
    resolvedAction.items.length === 1 &&
    looksLikeListTitleOnlyRecord(asRecord(resolvedAction.items[0]))
  ) {
    const label =
      ownedItemTitle("custom", asRecord(resolvedAction.items[0]), "") ||
      itemIdentity("custom", asRecord(resolvedAction.items[0]));
    if (label.trim()) {
      listName = label.trim().slice(0, 100);
      itemsForApply = [];
    }
  } else if (
    listName &&
    resolvedAction.listType === "custom" &&
    resolvedAction.items.length === 1 &&
    isPhantomCustomListItem(listName, asRecord(resolvedAction.items[0]))
  ) {
    itemsForApply = [];
  }
  const listShare =
    visibility.scope === "shared" &&
    resolvedAction.listType === "custom" &&
    Boolean(listName.trim());

  const existingList = await prisma.employeeList.findFirst({
    where: {
      employeeId,
      listType: resolvedAction.listType,
      name: listName,
      deletedAt: null,
    },
  });
  const createdList = !existingList;
  const list =
    existingList ??
    (await prisma.employeeList.create({
      data: {
        employeeId,
        listType: resolvedAction.listType,
        name: listName,
        ...(resolvedAction.listType === "custom" && resolvedAction.titleField
          ? { titleField: resolvedAction.titleField }
          : {}),
        ...(resolvedAction.listType === "custom" &&
        (resolvedAction.columns?.length ?? 0) > 0
          ? { columns: resolvedAction.columns }
          : {}),
        ...(listShare
          ? { scope: "shared", visibleTo: visibility.visibleTo }
          : {}),
      },
    }));

  if (listShare) {
    await prisma.employeeList.update({
      where: { id: list.id },
      data: {
        scope: "shared",
        visibleTo: uniqueIds([
          employeeId,
          ...visibility.visibleTo,
          ...idList(list.visibleTo),
        ]),
      },
    });
  }

  // Repair legacy custom rows that were created with an empty name while
  // list_name lived only on the item JSON.
  if (
    listName &&
    list.name.trim() === "" &&
    resolvedAction.listType === "custom"
  ) {
    const clash = await prisma.employeeList.findFirst({
      where: {
        employeeId,
        listType: "custom",
        name: listName,
        deletedAt: null,
      },
    });
    if (!clash || clash.id === list.id) {
      await prisma.employeeList.update({
        where: { id: list.id },
        data: { name: listName },
      });
      list.name = listName;
    }
  }

  const itemMutationsBefore = mutations.length;
  for (const rawItem of itemsForApply) {
    const item = normalizeRelativeDatesInRecord(asRecord(rawItem));
    if (
      resolvedAction.listType === "custom" &&
      isPhantomCustomListItem(listName, item)
    ) {
      continue;
    }
    const mutateId = readItemId(item);
    if (
      (resolvedAction.action === "remove" ||
        resolvedAction.action === "update") &&
      !mutateId
    ) {
      // Id-only mutate (jobs-style): never match remove/update by title/key.
      continue;
    }

    if (resolvedAction.action === "remove") {
      const existing = await findLiveListItemById(mutateId, employeeId);
      if (!existing?.id) {
        continue;
      }
      const access = await workerTaskAccess(employeeId, actorId, existing, accessCache);
      if (access && !access.allowed) {
        continue;
      }
      const targetListId = existing.listId;
      const targetListName = list.name || listName;
      const removedKey = existing.itemKey;
      const removedTitleField = existing.list?.titleField ?? "";
      await cancelReminderLinkedToWorkerItem(existing.id);
      mutations.push({
        action: "remove",
        itemId: existing.id,
        employeeId,
        listType: resolvedAction.listType,
        itemKey: removedKey,
        itemLabel:
          ownedItemTitle(
            resolvedAction.listType,
            asRecord(existing.data),
            removedKey,
            removedTitleField,
          ) || removedKey,
        listName: targetListName || resolvedAction.listName || undefined,
        ...(access && existing.reminderId
          ? { workerTaskInvolvedIds: access.involvedIds }
          : {}),
      });
      await prisma.employeeListItem.update({
        where: { id: existing.id },
        data: { deletedAt: new Date(), reminderId: null },
      });
      const owner = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { userId: true },
      });
      if (owner) {
        const label =
          ownedItemTitle(
            resolvedAction.listType,
            asRecord(existing.data),
            removedKey,
            removedTitleField,
          ) || removedKey;
        const cascade = await cancelActiveRemindersMatchingWork({
          userId: owner.userId,
          itemKey: removedKey,
          itemLabel: label,
          actorEmployeeId: actorId,
        });
        cancelledReminders.push(...cascade.cancelledReminders);
        for (const task of cascade.removedWorkerTasks) {
          if (seenCascadeTaskIds.has(task.id)) {
            continue;
          }
          seenCascadeTaskIds.add(task.id);
          mutations.push({
            action: "remove",
            itemId: task.id,
            employeeId: task.employeeId,
            listType: "tasks",
            itemKey: task.itemKey,
            itemLabel: task.itemLabel,
          });
        }
      }
      if (owner) {
        await recordAuditEvent({
          userId: owner.userId,
          actorEmployeeId: actorId,
          action: "list_remove",
          entityType: "EmployeeListItem",
          entityId: existing.id,
          summary: `remove ${resolvedAction.listType}: ${removedKey}`,
        });
      }
      const watchers = await resolveWatchers({
        existing,
        visibility,
        ownerId: employeeId,
        actorId,
        itemKey: removedKey,
      });
      const related = await deleteRelatedAssignmentTasks(
        [...new Set([actorId, employeeId, ...watchers])],
        removedKey,
      );
      for (const task of related) {
        if (seenCascadeTaskIds.has(task.itemId)) {
          continue;
        }
        seenCascadeTaskIds.add(task.itemId);
        mutations.push(task);
      }
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
      continue;
    }

    const done = extractOccurrenceDone(item);
    const shaped = shapeItemRecurrence(done.item);
    const fieldsItem = shaped.item;
    const rowTitleField = list.titleField ?? "";
    const itemKey =
      itemIdentity(resolvedAction.listType, fieldsItem, rowTitleField) || "";
    // add = always insert; update/remove = only by item_id (no key/fuzzy match).
    if (resolvedAction.action === "add" && !itemKey) {
      continue;
    }

    const existing =
      resolvedAction.action === "update"
        ? await findLiveListItemById(mutateId, employeeId)
        : null;
    if (resolvedAction.action === "update" && !existing?.id) {
      continue;
    }
    const access = existing
      ? await workerTaskAccess(employeeId, actorId, existing, accessCache)
      : null;
    if (access && !access.allowed) {
      continue;
    }
    // Editing a worker task never re-shares it; who it involves comes from the task itself.
    const resolvedVisibility =
      access && existing
        ? {
            scope: (existing.scope === "shared" ? "shared" : "personal") as ItemScope,
            addedById: existing.addedById ?? actorId,
            visibleTo: idList(existing.visibleTo),
          }
        : mergeItemVisibility(existing, visibility, employeeId);
    const mergedRecord =
      resolvedAction.action === "update" && existing
        ? mergeListItemData(asRecord(existing.data), fieldsItem)
        : normalizeListItemData(fieldsItem);
    const ruledRecord = shaped.clear ? clearItemRecurrence(mergedRecord) : mergedRecord;
    const nextDataRecord =
      done.doneDate && resolvedAction.action === "update"
        ? markOccurrenceDone(ruledRecord, done.doneDate)
        : ruledRecord;
    const nextData = toJsonValue(nextDataRecord);
    const existingList = existing && "list" in existing
      ? (existing.list as { titleField?: string } | null)
      : null;
    const effectiveTitleField = existingList?.titleField ?? rowTitleField;
    const nextItemKey =
      itemIdentity(resolvedAction.listType, nextDataRecord, effectiveTitleField) ||
      itemKey ||
      existing?.itemKey ||
      "";
    const itemUrgency = readItemUrgency(fieldsItem);
    const fields = {
      data: nextData,
      scope: resolvedVisibility.scope,
      addedById: resolvedVisibility.addedById,
      visibleTo: resolvedVisibility.visibleTo,
      ...(itemUrgency !== undefined
        ? { urgency: itemUrgency }
        : resolvedAction.action === "add"
          ? { urgency: "normal" as const }
          : {}),
    };

    const listOwner = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { userId: true },
    });
    if (existing) {
      await prisma.employeeListItem.update({
        where: { id: existing.id },
        data: {
          ...fields,
          ...(resolvedAction.action === "update" &&
          nextItemKey &&
          nextItemKey !== existing.itemKey
            ? { itemKey: nextItemKey }
            : {}),
        },
      });
      mutations.push({
        action: "update",
        itemId: existing.id,
        employeeId,
        listType: resolvedAction.listType,
        itemKey: existing.itemKey,
        itemLabel:
          ownedItemTitle(
            resolvedAction.listType,
            nextDataRecord,
            nextItemKey || existing.itemKey,
            effectiveTitleField,
          ) ||
          nextItemKey ||
          existing.itemKey,
        listName: list.name || resolvedAction.listName || undefined,
        ...(access && existing.reminderId
          ? { workerTaskInvolvedIds: access.involvedIds }
          : {}),
      });
      if (listOwner) {
        const occurrenceDone = done.doneDate && itemDoneThrough(nextDataRecord);
        await recordAuditEvent({
          userId: listOwner.userId,
          actorEmployeeId: actorId,
          action: occurrenceDone ? "list_occurrence_done" : "list_update",
          entityType: "EmployeeListItem",
          entityId: existing.id,
          summary: occurrenceDone
            ? `occurrence done ${done.doneDate} ${resolvedAction.listType}: ${existing.itemKey}`
            : `update ${resolvedAction.listType}: ${existing.itemKey}`,
        });
      }
    } else {
      if (!nextItemKey) {
        continue;
      }
      const created = await prisma.employeeListItem.create({
        data: {
          listId: list.id,
          itemKey: nextItemKey,
          ...fields,
        },
      });
      mutations.push({
        action: "add",
        itemId: created.id,
        employeeId,
        listType: resolvedAction.listType,
        itemKey: nextItemKey,
        itemLabel:
          ownedItemTitle(
            resolvedAction.listType,
            nextDataRecord,
            nextItemKey,
            effectiveTitleField,
          ) || nextItemKey,
        listName: list.name || resolvedAction.listName || undefined,
      });
      if (listOwner) {
        await recordAuditEvent({
          userId: listOwner.userId,
          actorEmployeeId: actorId,
          action: "list_add",
          entityType: "EmployeeListItem",
          entityId: created.id,
          summary: `add ${resolvedAction.listType}: ${nextItemKey}`,
        });
      }
    }
    const onlyOccurrenceDone =
      Boolean(done.doneDate) &&
      Object.keys(fieldsItem).every((key) => key === "item_id" || key === "itemId" || key === "id");
    if (onlyOccurrenceDone) {
      continue;
    }
    // Shared watchers for add/update — keep existing notify path below.
    const watchers = await resolveWatchers({
      existing,
      visibility: resolvedVisibility,
      ownerId: employeeId,
      actorId,
      itemKey: nextItemKey || existing?.itemKey || "",
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

  if (
    resolvedAction.listType === "custom" &&
    listName.trim() &&
    resolvedAction.action !== "remove" &&
    mutations.length === itemMutationsBefore
  ) {
    mutations.push({
      action: createdList ? "add" : "update",
      itemId: list.id,
      employeeId,
      listType: "custom",
      itemKey: listName,
      itemLabel: listName,
      listName,
      listShell: true,
    });
    // Notify partners only when opening a *new* empty shared list — not when
    // re-touching an existing one (that would look like "added a shared list"
    // instead of an item mutation that may arrive in the same turn).
    if (listShare && createdList && visibility.visibleTo.length > 1) {
      events.push({
        notifyEmployeeIds: uniqueIds(visibility.visibleTo).filter(
          (id) => id !== actorId,
        ),
        metadata: {
          lists: [
            {
              ...resolvedAction,
              listName,
              items: [],
            },
          ],
          filing: [],
        },
        listOwnerId: employeeId,
      });
    }
  }

  return { events, mutations, cancelledReminders };
}

/**
 * For update/remove: copy list_type + list_name from the row addressed by
 * item_id. Never guess by title / fuzzy field match.
 */
async function resolveListActionAgainstSaved(
  employeeId: string,
  action: LlmListAction,
): Promise<LlmListAction> {
  if (action.action !== "remove" && action.action !== "update") {
    return action;
  }

  let itemId = "";
  for (const raw of action.items) {
    itemId = readItemId(asRecord(raw));
    if (itemId) {
      break;
    }
  }
  if (!itemId) {
    return action;
  }

  const existing = await findLiveListItemById(itemId, employeeId);
  const list = existing && "list" in existing ? existing.list : null;
  if (!list?.listType) {
    return action;
  }

  return {
    ...action,
    listType: list.listType as LlmListType,
    listName: list.name ?? action.listName,
  };
}

async function findLiveListItemById(itemId: string, employeeId: string) {
  const id = itemId.trim();
  if (!id) {
    return null;
  }
  return prisma.employeeListItem.findFirst({
    where: {
      id,
      deletedAt: null,
      list: { employeeId },
    },
    include: {
      list: { select: { id: true, listType: true, name: true, titleField: true } },
    },
  });
}

/**
 * Last-resort custom remove: find the row on any custom list the actor can see
 * on the account (owned or shared-visible), then soft-delete every matching copy.
 */
export async function removeVisibleCustomItems(input: {
  userId: string;
  actorId: string;
  lists: LlmListAction[];
}): Promise<{
  events: SharedItemEvent[];
  mutations: ListItemMutation[];
  cancelledReminders: string[];
}> {
  const events: SharedItemEvent[] = [];
  const mutations: ListItemMutation[] = [];
  const cancelledReminders: string[] = [];
  const removes = input.lists.filter(
    (row) => row.action === "remove" && row.listType === "custom",
  );
  if (removes.length === 0) {
    return { events, mutations, cancelledReminders };
  }

  const lists = await prisma.employeeList.findMany({
    where: {
      listType: "custom",
      deletedAt: null,
      employee: { userId: input.userId, kind: "human" },
    },
    include: {
      items: { where: { deletedAt: null } },
      employee: { select: { id: true, userId: true } },
    },
  });

  for (const action of removes) {
    for (const rawItem of action.items) {
      const item = asRecord(rawItem);
      const itemId = readItemId(item);
      if (!itemId) {
        continue;
      }
      for (const list of lists) {
        const visibleTo = idList(list.visibleTo);
        const canSee =
          list.employeeId === input.actorId ||
          (list.scope === "shared" && visibleTo.includes(input.actorId));
        if (!canSee) {
          continue;
        }
        const existing = list.items.find((row) => row.id === itemId);
        if (!existing) {
          continue;
        }
        if (mutations.some((row) => row.itemId === existing.id)) {
          continue;
        }
        await cancelReminderLinkedToWorkerItem(existing.id);
        await prisma.employeeListItem.update({
          where: { id: existing.id },
          data: { deletedAt: new Date(), reminderId: null },
        });
        const label =
          ownedItemTitle(
            "custom",
            asRecord(existing.data),
            existing.itemKey,
            list.titleField,
          ) || existing.itemKey;
        mutations.push({
          action: "remove",
          itemId: existing.id,
          employeeId: list.employeeId,
          listType: "custom",
          itemKey: existing.itemKey,
          itemLabel: label,
          listName: list.name || action.listName || undefined,
        });
        if (list.employee.userId) {
          const cascade = await cancelActiveRemindersMatchingWork({
            userId: list.employee.userId,
            itemKey: existing.itemKey,
            itemLabel: label,
            actorEmployeeId: input.actorId,
          });
          cancelledReminders.push(...cascade.cancelledReminders);
        }
        const watchers = uniqueIds([
          ...idList(list.visibleTo),
          list.employeeId,
        ]).filter((id) => id !== input.actorId);
        if (watchers.length > 0) {
          events.push({
            notifyEmployeeIds: watchers,
            metadata: {
              lists: [{ ...action, items: [item] }],
              filing: [],
            },
            listOwnerId: list.employeeId,
          });
        }
      }
    }
  }

  return { events, mutations, cancelledReminders };
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
      deletedAt: null,
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
): Promise<ListItemMutation[]> {
  if (employeeIds.length === 0 || !itemKey) {
    return [];
  }

  const where = {
    itemKey: { contains: itemKey },
    deletedAt: null,
    list: {
      listType: "tasks" as const,
      employeeId: { in: employeeIds },
    },
  };

  const doomed = await prisma.employeeListItem.findMany({
    where,
    include: { list: { select: { employeeId: true, listType: true } } },
  });
  const labeled = doomed.filter(
    (row) => row.list?.listType === "tasks" && Boolean(row.list.employeeId),
  );

  if (labeled.length > 0) {
    await prisma.employeeListItem.updateMany({
      where: { id: { in: labeled.map((row) => row.id) } },
      data: { deletedAt: new Date(), reminderId: null },
    });
    return labeled.map((row) => {
      const data = asRecord(row.data);
      return {
        action: "remove" as const,
        itemId: row.id,
        employeeId: row.list.employeeId,
        listType: "tasks",
        itemKey: row.itemKey,
        itemLabel:
          ownedItemTitle("tasks", data, row.itemKey) || row.itemKey,
      };
    });
  }

  // Fallback when findMany is stubbed / empty: still soft-delete by key.
  await prisma.employeeListItem.updateMany({
    where,
    data: { deletedAt: new Date(), reminderId: null },
  });
  return [];
}

function sharedWithNames(
  ownerId: string,
  visibleTo: unknown,
  names: Map<string, string>,
): string[] {
  const ordered = uniqueIds([ownerId, ...idList(visibleTo)]);
  return ordered
    .map((id) => names.get(id) ?? "")
    .filter((name) => Boolean(name));
}

function toListSnapshotEntry(input: {
  listId?: string;
  listType: string;
  listName: string;
  titleField?: string;
  columns?: unknown;
  hiddenColumns?: unknown;
  ownerId: string;
  ownerName: string;
  scope: ItemScope;
  visibleTo: unknown;
  items: Array<{
    id?: string;
    data: unknown;
    scope?: string;
    itemKey?: string;
    urgency?: string | null;
    reminderId?: string | null;
    linkedReminderId?: string | null;
    addedById?: string | null;
    visibleTo?: unknown;
  }>;
  names: Map<string, string>;
  activeReminders?: Map<string, LinkedReminderRow>;
  itemExtras?: (item: WorkerTaskRow) => Record<string, unknown>;
}): EmployeeRecordSnapshot["lists"][number] | null {
  const derivedName =
    input.listName.trim() ||
    (input.listType === "custom"
      ? deriveCustomListName(input.items.map((item) => asRecord(item.data)))
      : "");
  const items = input.items
    .map((item) =>
      withVisibility(
        withoutHiddenColumns(asRecord(item.data), input.hiddenColumns),
        item.scope === "shared" || input.scope === "shared"
          ? "shared"
          : "personal",
        input.ownerName,
        item.id,
        {
          ...linkedReminderField(item, input.activeReminders ?? new Map()),
          ...urgencySnapshotField(item.urgency),
          ...(input.itemExtras?.(item) ?? {}),
        },
      ),
    );
  // Keep named custom lists and any shared list even when empty so Lucy can
  // answer "do we have X?" / "show shared lists" without inventing.
  if (items.length === 0) {
    const keepEmpty =
      Boolean(derivedName) &&
      (input.scope === "shared" || input.listType === "custom");
    if (!keepEmpty) {
      return null;
    }
  }
  const columns =
    input.listType === "custom"
      ? visibleListColumns(
          { columns: input.columns, hiddenColumns: input.hiddenColumns },
          input.items,
        )
      : [];
  const titleField =
    input.listType === "custom" ? (input.titleField ?? "").trim() : "";
  return {
    ...(input.listId ? { list_id: input.listId } : {}),
    list_type: input.listType,
    ...(derivedName ? { list_name: derivedName } : {}),
    ...(columns.length > 0 ? { columns } : {}),
    ...(titleField ? { title_field: titleField } : {}),
    owner: input.ownerName,
    scope: input.scope,
    ...(input.scope === "shared"
      ? {
          shared_with: sharedWithNames(
            input.ownerId,
            input.visibleTo,
            input.names,
          ),
        }
      : {}),
    items,
  };
}

export type LinkedReminderRow = {
  id: string;
  fireAt: Date;
  repeat: string;
  recurrence?: unknown;
  occurrencesFired?: number;
};

/**
 * The active clock FK-linked to this item: reminder_id (worker task) or
 * linked_reminder_id (speaker/shared item from the same turn).
 */
export function linkedReminderField(
  item: { reminderId?: string | null; linkedReminderId?: string | null },
  activeReminders: Map<string, LinkedReminderRow>,
): Record<string, unknown> {
  const reminder = [item.reminderId, item.linkedReminderId]
    .map((id) => (id ? activeReminders.get(id) : undefined))
    .find(Boolean);
  if (!reminder) {
    return {};
  }
  return {
    reminder: {
      reminder_id: reminder.id,
      fire_at: formatJerusalemDateTime(reminder.fireAt),
      repeat: reminder.repeat,
      ...reminderRuleSnapshot(reminder),
    },
  };
}

function withVisibility(
  data: unknown,
  scope: string,
  owner: string,
  itemId?: string,
  linked: Record<string, unknown> = {},
): Record<string, unknown> {
  const raw = normalizeListItemData(asRecord(data));
  const normalized = stripRecurrenceMeta(stripJobMeta(raw));
  const dateRaw = normalized["תאריך לביצוע"];
  const weekday =
    typeof dateRaw === "string" ? hebrewWeekdayFromYmd(dateRaw) : null;
  const nextOccurrences = itemNextOccurrences(raw);
  const doneThrough = nextOccurrences ? itemDoneThrough(raw) : "";
  return {
    ...normalized,
    ...(itemId ? { item_id: itemId } : {}),
    ...(weekday ? { "יום בשבוע": weekday } : {}),
    ...(nextOccurrences ? { next_occurrences: nextOccurrences } : {}),
    ...(doneThrough ? { done_through: doneThrough } : {}),
    ...linked,
    scope,
    owner,
  };
}

function visibleToIncludes(visibleTo: unknown, employeeId: string): boolean {
  return Array.isArray(visibleTo) && visibleTo.includes(employeeId);
}

function listTitle(listType: string, listName: string): string {
  if (listType === "custom" && listName.trim()) {
    return listName.trim();
  }
  return LIST_TYPE_TITLES[listType] ?? (listName.trim() || "List");
}

export function deriveCustomListName(
  items: Array<Record<string, unknown>>,
): string {
  for (const item of items) {
    const name =
      typeof item.list_name === "string"
        ? item.list_name.trim()
        : typeof item.listName === "string"
          ? item.listName.trim()
          : typeof item["שם הרשימה"] === "string"
            ? item["שם הרשימה"].trim()
            : "";
    if (name) {
      return name.slice(0, 100);
    }
  }
  return "";
}

/** Drop fake rows where the model stuffed the list title instead of a real entry. */
export function isPhantomCustomListItem(
  listName: string,
  item: Record<string, unknown>,
): boolean {
  const name = listName.trim();
  const metaKeys = new Set(["list_name", "listName", "name", "רשימה"]);
  const filledEntries = Object.entries(item).filter(([, value]) => {
    if (value == null) {
      return false;
    }
    if (typeof value === "string") {
      return value.trim() !== "";
    }
    return true;
  });
  if (filledEntries.length === 0) {
    return true;
  }
  if (filledEntries.every(([key]) => metaKeys.has(key))) {
    return true;
  }
  if (!name) {
    return false;
  }
  const identity = itemIdentity("custom", item);
  if (!identity || !keysLooselyMatch(identity, name)) {
    return false;
  }
  // Title equals list name and there is no other distinct filled column.
  const otherValues = filledEntries.filter(([key, value]) => {
    if (metaKeys.has(key)) {
      return false;
    }
    const text =
      typeof value === "string"
        ? value.trim()
        : typeof value === "number"
          ? String(value)
          : "";
    return text !== "" && !keysLooselyMatch(text, name);
  });
  return otherValues.length === 0;
}

function looksLikeListTitleOnlyRecord(item: Record<string, unknown>): boolean {
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
  const filled = Object.entries(item).filter(([key, value]) => {
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

function toOwnedListItem(
  listType: string,
  item: { id: string; itemKey?: string; data: unknown; addedById?: string | null; createdAt: Date },
  names: Map<string, string>,
  ownerName: string,
  titleField = "",
): EmployeeRecordsResponse["groups"][number]["items"][number] {
  const data = stripRecurrenceMeta(stripJobMeta(normalizeListItemData(asRecord(item.data))));
  return {
    id: item.id,
    kind: "list",
    title: ownedItemTitle(listType, data, item.itemKey ?? "", titleField),
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
  titleField = "",
): string {
  if (listType === "contacts") {
    const first = readItemText(data, ITEM_NAME_KEYS.contacts);
    const last = readItemText(data, ["שם משפחה", "last_name", "surname"]);
    return [first, last].filter(Boolean).join(" ") || fallback;
  }

  const keys = ITEM_NAME_KEYS[listType as LlmListType] ?? [];
  const titled = keys.length > 0 ? readItemText(data, keys) : "";
  if (titled) {
    return titled;
  }
  if (listType === "custom") {
    const named = titleField.trim() ? readItemText(data, [titleField.trim()]) : "";
    return named || firstCustomDataValue(data) || fallback;
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
  const skip = new Set((TITLE_KEYS[listType] ?? []).map((key) => key));
  for (const key of CUSTOM_ITEM_META_KEYS) {
    skip.add(key);
  }
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
