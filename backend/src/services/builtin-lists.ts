/**
 * Single source for builtin shopping/tasks/contacts Hebrew labels and
 * opaque «הצג» button command strings (emit + allowlist invert).
 */

export type BuiltinListType = "shopping" | "tasks" | "contacts";

export const BUILTIN_LIST_TYPES = [
  "shopping",
  "tasks",
  "contacts",
] as const satisfies readonly BuiltinListType[];

const BUILTIN_LIST_HEBREW: Record<BuiltinListType, string> = {
  shopping: "קניות",
  tasks: "מטלות",
  contacts: "אנשי קשר",
};

/** Noun used in «כל ה…» labels (with definite article where natural). */
const BUILTIN_ALL_NOUN: Record<BuiltinListType, string> = {
  shopping: "הקניות",
  tasks: "המטלות",
  contacts: "אנשי הקשר",
};

export const SHOW_REMINDERS_COMMAND = "הצג תזכורות";
export const SHOW_FILINGS_COMMAND = "הצג תיוקים";
export const SHOW_LIST_PREFIX = "הצג רשימת ";
export const SHOW_FILINGS_ALL_COMMAND = "כל התיוקים";
/** Full overview («מה יש לי» / SHOW MY LISTS) — list-shell post-mutate nav. */
export const SHOW_LISTS_COMMAND = "הצג רשימות";

export function isBuiltinListType(value: string): value is BuiltinListType {
  return (BUILTIN_LIST_TYPES as readonly string[]).includes(value);
}

export function builtinListHebrew(listType: BuiltinListType): string {
  return BUILTIN_LIST_HEBREW[listType];
}

/** Hebrew label → list_type, or null if not a builtin product name. */
export function builtinListTypeFromHebrew(
  hebrew: string,
): BuiltinListType | null {
  const trimmed = hebrew.trim();
  for (const listType of BUILTIN_LIST_TYPES) {
    if (BUILTIN_LIST_HEBREW[listType] === trimmed) {
      return listType;
    }
  }
  return null;
}

/**
 * Opaque UI button command for a builtin list or a custom list title.
 * Reminders use SHOW_REMINDERS_COMMAND separately.
 */
export function showListButtonCommand(
  listTypeOrCustomName: BuiltinListType | string,
): string {
  if (isBuiltinListType(listTypeOrCustomName)) {
    return `${SHOW_LIST_PREFIX}${builtinListHebrew(listTypeOrCustomName)}`;
  }
  const name = listTypeOrCustomName.trim();
  return name ? `${SHOW_LIST_PREFIX}${name}` : SHOW_LIST_PREFIX.trimEnd();
}

/** Opaque UI button → digital-worker tasks inventory (show_dump_about). */
export function showWorkerTasksButtonCommand(workerDisplayName: string): string {
  const name = workerDisplayName.trim();
  return name ? `הצג מטלות של ${name}` : "";
}

/** «כל ה…» alias for unfiltered dump (same kind as הצג רשימת …). */
export function showAllListButtonCommand(
  listTypeOrFilings: BuiltinListType | "filings",
): string {
  if (listTypeOrFilings === "filings") {
    return SHOW_FILINGS_ALL_COMMAND;
  }
  return `כל ${BUILTIN_ALL_NOUN[listTypeOrFilings]}`;
}

/** Short WhatsApp label for «all» (§8.1). */
export function showAllListButtonLabel(
  listTypeOrFilings: BuiltinListType | "filings",
): string {
  return showAllListButtonCommand(listTypeOrFilings);
}

/** Opaque command: shared-with person dump (co_share only). */
export function showSharedWithButtonCommand(
  listTypeOrFilings: BuiltinListType | "filings" | string,
  person: string,
): string {
  const who = person.trim();
  if (!who) {
    return "";
  }
  if (listTypeOrFilings === "filings") {
    return `הצג תיוקים משותפים עם ${who}`;
  }
  if (isBuiltinListType(listTypeOrFilings)) {
    return `הצג ${builtinListHebrew(listTypeOrFilings)} משותפות עם ${who}`;
  }
  const name = listTypeOrFilings.trim();
  return name ? `הצג רשימת ${name} משותפות עם ${who}` : "";
}

/** Opaque command: assignee/באחריות dump. */
export function showAssigneeButtonCommand(
  listTypeOrFilings: BuiltinListType | "filings" | string,
  person: string,
): string {
  const who = person.trim();
  if (!who) {
    return "";
  }
  if (listTypeOrFilings === "filings") {
    return `הצג תיוקים באחריות ${who}`;
  }
  if (isBuiltinListType(listTypeOrFilings)) {
    return `הצג ${builtinListHebrew(listTypeOrFilings)} באחריות ${who}`;
  }
  const name = listTypeOrFilings.trim();
  return name ? `הצג רשימת ${name} באחריות ${who}` : "";
}

/** Short labels (§8.1) — max ~20 with typical names. */
export function showSharedWithButtonLabel(person: string): string {
  return `משותף עם ${person.trim()}`.trim();
}

export function showAssigneeButtonLabel(person: string): string {
  return `באחריות ${person.trim()}`.trim();
}

/** Exact builtin/reminder button command → show_dump kind. */
export function staticShowButtonDumpMap(): Readonly<Record<string, string>> {
  return {
    [SHOW_REMINDERS_COMMAND]: "reminders",
    [SHOW_FILINGS_COMMAND]: "filings",
    [SHOW_FILINGS_ALL_COMMAND]: "filings",
    [SHOW_LISTS_COMMAND]: "full",
    [showListButtonCommand("shopping")]: "shopping",
    [showListButtonCommand("tasks")]: "tasks",
    // Contacts v2: button dumps canonical SPEAKER_CONTACTS (phone_book), not lists.contacts.
    [showListButtonCommand("contacts")]: "phone_book",
    [showAllListButtonCommand("shopping")]: "shopping",
    [showAllListButtonCommand("tasks")]: "tasks",
    [showAllListButtonCommand("contacts")]: "phone_book",
  };
}
