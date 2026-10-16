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

export const SHOW_REMINDERS_COMMAND = "הצג תזכורות";
export const SHOW_FILINGS_COMMAND = "הצג תיוקים";
export const SHOW_LIST_PREFIX = "הצג רשימת ";

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

/** Exact builtin/reminder button command → show_dump kind. */
export function staticShowButtonDumpMap(): Readonly<Record<string, string>> {
  return {
    [SHOW_REMINDERS_COMMAND]: "reminders",
    [SHOW_FILINGS_COMMAND]: "filings",
    [showListButtonCommand("shopping")]: "shopping",
    [showListButtonCommand("tasks")]: "tasks",
    [showListButtonCommand("contacts")]: "contacts",
  };
}
