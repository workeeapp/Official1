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
  tasks: "משימות",
  contacts: "אנשי קשר",
};

/** Legacy list noun (מטלות) — still accepted on resolve; never emit. */
export const TASKS_HEBREW_LEGACY = "\u05de\u05d8\u05dc\u05d5\u05ea";

/** Noun used in «כל ה…» labels (with definite article where natural). */
const BUILTIN_ALL_NOUN: Record<BuiltinListType, string> = {
  shopping: "הקניות",
  tasks: "המשימות",
  contacts: "אנשי הקשר",
};

/** Legacy «כל המטלות» still accepted. */
const BUILTIN_ALL_NOUN_LEGACY: Partial<Record<BuiltinListType, string>> = {
  tasks: "ה\u05de\u05d8\u05dc\u05d5\u05ea",
};

export const SHOW_REMINDERS_COMMAND = "הצג תזכורות";
export const SHOW_FILINGS_COMMAND = "הצג תיוקים";
export const SHOW_LIST_PREFIX = "הצג רשימת ";
export const SHOW_FILINGS_ALL_COMMAND = "כל התיוקים";
/** Full overview («הצג רשימות» / SHOW MY LISTS) — list-shell post-mutate nav. */
export const SHOW_LISTS_COMMAND = "הצג רשימות";
/** Dated agenda offer → undated general tasks dump (show_dump_date_scope=undated). */
export const SHOW_UNDATED_TASKS_COMMAND = "הצג משימות כלליות";
/** Legacy typed alias for {@link SHOW_UNDATED_TASKS_COMMAND}. */
export const SHOW_UNDATED_TASKS_COMMAND_LEGACY =
  "הצג \u05de\u05d8\u05dc\u05d5\u05ea כלליות";

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
  if (trimmed === TASKS_HEBREW_LEGACY) {
    return "tasks";
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
  return name ? `הצג משימות של ${name}` : "";
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
    // Legacy tasks label — keep old WhatsApp buttons working.
    [`${SHOW_LIST_PREFIX}${TASKS_HEBREW_LEGACY}`]: "tasks",
    // Contacts v2: button dumps canonical SPEAKER_CONTACTS (phone_book), not lists.contacts.
    [showListButtonCommand("contacts")]: "phone_book",
    [showAllListButtonCommand("shopping")]: "shopping",
    [showAllListButtonCommand("tasks")]: "tasks",
    [`כל ${BUILTIN_ALL_NOUN_LEGACY.tasks}`]: "tasks",
    [showAllListButtonCommand("contacts")]: "phone_book",
  };
}

/**
 * N1 result navigation: opaque item reference appended to an item-open tap
 * command («הציגי את המשימה X ·#t:…»). The readable prefix is cosmetic; the
 * engine resolves the reference to an ITEM DUMP of exactly those rows, which
 * re-checks every id against the tapper's own live snapshot.
 * kind: t=tasks s=shopping c=custom-list item f=filing r=reminder p=phone book.
 */
export type ItemNavKind = "t" | "s" | "c" | "f" | "r" | "p";
export type ItemNavRef = { kind: ItemNavKind; id: string };

const ITEM_NAV_REF_MARK = " ·#";
const ITEM_NAV_REF_RE = /\s·#([tscfrp]:[A-Za-z0-9_-]{6,40}(?:,[tscfrp]:[A-Za-z0-9_-]{6,40})*)\s*$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** UUID → 22-char base64url (keeps tap commands well under WhatsApp's 256). */
function packId(id: string): string {
  const trimmed = id.trim();
  if (!UUID_RE.test(trimmed)) {
    return trimmed;
  }
  return Buffer.from(trimmed.replace(/-/g, ""), "hex").toString("base64url");
}

function unpackId(token: string): string {
  if (token.length !== 22) {
    return token;
  }
  const hex = Buffer.from(token, "base64url").toString("hex");
  if (hex.length !== 32) {
    return token;
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function formatItemNavRef(refs: ReadonlyArray<ItemNavRef>): string {
  if (refs.length === 0) {
    return "";
  }
  return `${ITEM_NAV_REF_MARK}${refs.map((ref) => `${ref.kind}:${packId(ref.id)}`).join(",")}`;
}

export function parseItemNavRef(text: string): ItemNavRef[] | null {
  const match = text.trim().match(ITEM_NAV_REF_RE);
  if (!match?.[1]) {
    return null;
  }
  const refs: ItemNavRef[] = [];
  for (const part of match[1].split(",")) {
    const kind = part.slice(0, 1) as ItemNavKind;
    const id = unpackId(part.slice(2));
    if (id) {
      refs.push({ kind, id });
    }
  }
  return refs.length > 0 ? refs : null;
}

/** Command text without the reference (readable part only). */
export function stripItemNavRef(text: string): string {
  return text.replace(ITEM_NAV_REF_RE, "").trim();
}

/** Readable prefix of an engine item-open tap, per item kind. */
const ITEM_OPEN_PREFIX: Record<ItemNavKind, string> = {
  t: "הציגי את המשימה",
  s: "הציגי את הפריט",
  c: "הציגי את הפריט",
  f: "הציגי את התיוק",
  r: "הציגי את התזכורת",
  p: "הציגי את איש הקשר",
};

/** Label when the title does not fit a WhatsApp button (≤20). */
export const ITEM_OPEN_FALLBACK_LABEL: Record<ItemNavKind, string> = {
  t: "להצגת המשימה",
  s: "להצגת הפריט",
  c: "להצגת הפריט",
  f: "להצגת התיוק",
  r: "להצגת התזכורת",
  p: "להצגת איש הקשר",
};

/** Readable part of the «open everything saved this turn» tap. */
export const ITEM_OPEN_ALL_COMMAND = "הציגי את מה ששמרתי";

const TAP_COMMAND_MAX = 256;

/** «הציגי את המשימה ‹title› ·#t:…» — title shortened so the ref always fits. */
export function itemOpenTapCommand(ref: ItemNavRef, title: string): string {
  const suffix = formatItemNavRef([ref]);
  const prefix = ITEM_OPEN_PREFIX[ref.kind];
  const room = TAP_COMMAND_MAX - suffix.length - prefix.length - 1;
  const cleanTitle = title.trim().replace(/\s+/gu, " ").slice(0, Math.max(0, room)).trim();
  return `${prefix}${cleanTitle ? ` ${cleanTitle}` : ""}${suffix}`;
}

/** One tap that opens exactly these rows; null when the refs do not fit. */
export function itemOpenAllTapCommand(refs: ReadonlyArray<ItemNavRef>): string | null {
  const command = `${ITEM_OPEN_ALL_COMMAND}${formatItemNavRef(refs)}`;
  return command.length <= TAP_COMMAND_MAX ? command : null;
}

/** Kind + readable title of an item-open tap (engine form, or the model's task/filing form). */
export function parseItemOpenTap(
  command: string,
): { kind: ItemNavKind; title: string } | null {
  const readable = stripItemNavRef(command)
    .replace(/\s+/gu, " ")
    .replace(/^הציג את /u, "הציגי את ");
  for (const kind of ["t", "f", "s", "r", "p"] as const) {
    const prefix = ITEM_OPEN_PREFIX[kind];
    if (readable === prefix || readable.startsWith(`${prefix} `)) {
      const title = readable.slice(prefix.length).trim();
      const ref = parseItemNavRef(command);
      const refKind = ref?.length === 1 ? ref[0]!.kind : null;
      return { kind: refKind ?? kind, title };
    }
  }
  // Legacy task noun (מטלה).
  const legacy = readable.match(/^הציגי את המטלה(?:\s+(.*))?$/u);
  if (legacy) {
    return { kind: "t", title: (legacy[1] ?? "").trim() };
  }
  return null;
}
