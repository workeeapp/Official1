/**
 * Engine dump from model `show_dump` (+ section/partner). Builds the spoken
 * reply from the same live snapshot as EMPLOYEE_SAVED_DATA.
 * Dump intent never comes from free-form user text — only ACTION fields, or a
 * closed equality allowlist of known UI button command strings.
 */
import {
  addJerusalemDays,
  isValidCalendarYmd,
  normalizeShowDumpListName,
  resolveEffectiveOccurrenceReminder,
  type LlmListAction,
  type LlmShowDumpSection,
  type RecurrenceException,
} from "@workee/shared";
import {
  hebrewWeekdayFromYmd,
  jerusalemYmd,
} from "../utils/relative-date.js";
import {
  builtinListHebrew,
  builtinListTypeFromHebrew,
  isBuiltinListType,
  SHOW_FILINGS_COMMAND,
  SHOW_REMINDERS_COMMAND,
  SHOW_UNDATED_TASKS_COMMAND,
  SHOW_UNDATED_TASKS_COMMAND_LEGACY,
  parseItemNavRef,
  showListButtonCommand,
  staticShowButtonDumpMap,
  type ItemNavRef,
} from "./builtin-lists.js";
import type { EmployeeRecordSnapshot } from "./employee-records.service.js";
import {
  effectiveListEmoji,
  FILINGS_LIST_EMOJI,
  REMINDERS_LIST_EMOJI,
} from "./list-emoji.js";
import type { ReminderSnapshotRow } from "./reminder.service.js";
import { isWorkerTrackingTitle } from "./worker-tracking-title.js";

export {
  SHOW_REMINDERS_COMMAND,
  SHOW_FILINGS_COMMAND,
  SHOW_LIST_PREFIX,
  SHOW_UNDATED_TASKS_COMMAND,
  SHOW_UNDATED_TASKS_COMMAND_LEGACY,
  showAllListButtonCommand,
  showSharedWithButtonCommand,
  showAssigneeButtonCommand,
  showSharedWithButtonLabel,
  showAssigneeButtonLabel,
  showAllListButtonLabel,
} from "./builtin-lists.js";

/** Opaque button payloads the engine emits — equality only, no prefix/regex. */
const STATIC_SHOW_BUTTON_DUMP = staticShowButtonDumpMap();

/** Structured allowlist hit: kind + optional collaboration filters. */
export type ShowButtonDumpTarget = {
  kind: string;
  section?: LlmShowDumpSection | null;
  partner?: string | null;
  assignee?: string | null;
  /**
   * Digital-worker inventory («הצג משימות של לוסי») → show_dump_about.
   * Not a human co-share / assign filter.
   */
  about?: string | null;
  /** Pure co-share vs assign — never conflate the two. */
  collaboration?: "co_share" | "assign" | null;
  /** Tasks: undated = משימות כלליות (clears from/to on the engine). */
  dateScope?: "undated" | null;
  /** Inclusive YYYY-MM-DD — absolute day-agenda button taps. */
  dateFrom?: string | null;
  /** Inclusive YYYY-MM-DD — absolute day-agenda button taps. */
  dateTo?: string | null;
  /** N1 item-open tap: ITEM DUMP of exactly these row ids (show_dump_ids). */
  ids?: string[];
};

const ITEM_NAV_DUMP_KIND: Record<ItemNavRef["kind"], string | null> = {
  t: "tasks",
  s: "shopping",
  c: null,
  f: "filings",
  r: "reminders",
  p: "phone_book",
};

/**
 * N1 item-open tap («… ·#t:…») → ITEM DUMP target. One kind → that dump
 * (custom items resolve their list from the snapshot); mixed kinds or an
 * unresolved custom list → cross-kind full dump of only those ids. Visibility
 * is enforced later: unknown / foreign ids are dropped against the tapper's
 * live snapshot (never an unfiltered dump).
 */
function itemNavRefDumpTarget(
  text: string,
  snapshot?: Pick<EmployeeRecordSnapshot, "lists"> | null,
): ShowButtonDumpTarget | null {
  const refs = parseItemNavRef(text);
  if (!refs) {
    return null;
  }
  const ids = [...new Set(refs.map((ref) => ref.id))];
  const kinds = new Set(refs.map((ref) => ref.kind));
  if (kinds.size === 1) {
    const only = refs[0]!.kind;
    const builtin = ITEM_NAV_DUMP_KIND[only];
    if (builtin) {
      return { kind: builtin, ids };
    }
    const owning = (snapshot?.lists ?? []).filter(
      (list) =>
        list.list_type === "custom" &&
        list.items.some((item) => ids.includes(String(item.item_id ?? ""))),
    );
    const name = owning.length === 1 ? (owning[0]!.list_name ?? "").trim() : "";
    if (name) {
      return { kind: name, ids };
    }
  }
  return { kind: "full", ids };
}

const TITLE_KEYS: Record<string, string[]> = {
  shopping: ["שם פריט", "name", "item_name"],
  tasks: ["שם משימה", "name", "task", "item_name"],
  contacts: ["שם פרטי", "first_name", "name"],
};

export type ShowDumpOptions = {
  /**
   * Subject of the dump (speaker, or about-person when show_dump_about).
   * Omitted from co-share / partner filter keys.
   */
  viewerName?: string;
  /** Extra viewer labels (nickname + legal name) so partner keys never keep the viewer. */
  viewerAliases?: string[];
  now?: Date;
  /** shopping/tasks: personal | shared | omit for full dump (filters rows). */
  section?: LlmShowDumpSection | null;
  /**
   * With section=shared: keep rows whose partnerFilterKey matches.
   * string | string[] — multiple = OR.
   */
  partner?: string | string[] | null;
  /**
   * Responsibility filter: `self` | display name(s).
   * string | string[] — multiple = OR.
   * `self` matches assigneeSelfNames (speaker), even when dumping about someone else.
   */
  assignee?: string | string[] | null;
  /** When assignee=self — speaker display names / nicknames. */
  assigneeSelfNames?: string[];
  /** Inclusive YYYY-MM-DD — tasks/reminders only. */
  dateFrom?: string | null;
  /** Inclusive YYYY-MM-DD — tasks/reminders only. */
  dateTo?: string | null;
  /**
   * Tasks date-scope filter. `undated` = משימות כלליות (no calendar date and
   * no recurrence). Wins over dateFrom/dateTo (range cleared when set).
   */
  dateScope?: "undated" | null;
  /**
   * Urgency filter: urgent = urgent|very_urgent; very_urgent = only that.
   * null = no filter.
   */
  urgency?: "urgent" | "very_urgent" | null;
  /**
   * shopping/tasks: one header with counts only (no item lines).
   * Used by show_dump=full for קניות.
   */
  countsOnly?: boolean;
  /**
   * Digital-worker book: one numbered list without assign/co-share marks
   * (`assigned_by` means asker, not human co-share).
   */
  flatLayout?: boolean;
  /** SPEAKER_CONTACTS rows for show_dump=full / phone_book ספר הטלפונים. */
  phoneBook?: PhoneBookDumpRow[];
  /**
   * When true, empty dumps stay "" (no Hebrew empty sentence).
   * Used before composeTasksDumpWithWaiting so emptiness is structural.
   */
  omitEmptySentence?: boolean;
  /**
   * ITEM DUMP: keep only rows whose opaque id is in this set
   * (item_id / filing_id / reminder_id / contact_id).
   * null/undefined = no id filter (full category dump).
   * Empty Set = ITEM DUMP with no ids → keep nothing (caller shows no-match).
   */
  itemIds?: ReadonlySet<string> | null;
  /**
   * Pure collaboration filter:
   * - co_share: shared-with rows only (exclude באחריות / assignee)
   * - assign: sole-assignee rows only (exclude multi-party co-share)
   * null/omit: legacy section/partner/assignee only (partner+shared still
   * excludes assign when partner is set — see filterDumpRows).
   */
  collaboration?: "co_share" | "assign" | null;
  /**
   * Custom list_name stamped onto LAST_NUMBERED_DUMP lines (kind=custom) so the
   * server can refuse add/update/remove against a different list.
   */
  dumpListName?: string | null;
  /**
   * Mutable dump-wide line counter. Shared across stitched sections/days so `n`
   * is continuous for one dump. Reset only when a new dump starts (fresh
   * `{ next: 1 }`). Standalone formatters allocate a local counter when omitted.
   */
  numbering?: DumpNumbering;
};

/** Shared mutable counter for continuous dump line numbers. */
export type DumpNumbering = { next: number };

function ensureDumpNumbering(opts?: ShowDumpOptions): DumpNumbering {
  if (opts?.numbering) {
    return opts.numbering;
  }
  return { next: 1 };
}

function takeDumpLineNumber(numbering: DumpNumbering): number {
  const n = numbering.next;
  numbering.next += 1;
  return n;
}

/** Phone-book dump row (directory / SPEAKER_CONTACTS). */
export type PhoneBookDumpRow = {
  /** Opaque Contacts.id for LAST_NUMBERED_DUMP / directory mutates. */
  contact_id?: string;
  name: string;
  phone?: string;
  /** Optional free-text note (תיאור). */
  description?: string;
  scope?: "personal" | "shared";
  /** Partner display names when shared (may include owner). */
  shared_with?: string[];
  /** Assigner display name (ESD assigned_by) — not the responsible owner. */
  assigned_by?: string;
  /** Book owner when viewing an assigned/shared row on someone else's book. */
  owner?: string;
  /** Same `attachments` refs as other saved rows (paperclip / send). */
  attachments?: unknown;
};

/** Normalize dump filter name(s) to a trimmed list. */
export function dumpFilterNames(
  value: string | string[] | null | undefined,
): string[] {
  if (value == null) {
    return [];
  }
  const parts = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = typeof part === "string" ? part.trim() : "";
    if (trimmed && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  }
  return out;
}

function partnerFilterLabel(partners: string[]): string {
  if (partners.length === 0) {
    return "";
  }
  if (partners.length === 1) {
    return partners[0]!;
  }
  return partners.join(" או ");
}

/**
 * Closed allowlist: exact UI button command → dump target (kind + filters).
 * Custom lists: «הצג רשימת <list_name>» (+ optional משותפות עם / באחריות).
 */
/**
 * Absolute day-agenda show commands («מה יש לי ב־2026-11-12 ברשימת משימות»
 * or D.M.YYYY). Relative weekday-only commands stay on the model path.
 */
export function mapAbsoluteDayAgendaCommandToDumpTarget(
  text: string,
): ShowButtonDumpTarget | null {
  const trimmed = text.trim().replace(/\s+/gu, " ");
  if (!trimmed) {
    return null;
  }
  const iso = trimmed.match(
    /^מה יש לי ב[־\-](\d{4}-\d{2}-\d{2})(?:\s+ברשימת משימות)?$/u,
  );
  if (iso?.[1] && isValidCalendarYmd(iso[1])) {
    return { kind: "tasks", dateFrom: iso[1], dateTo: iso[1] };
  }
  const dmy = trimmed.match(
    /^מה יש לי ב[־\-](\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+ברשימת משימות)?$/u,
  );
  if (dmy) {
    const dd = Number(dmy[1]);
    const mm = Number(dmy[2]);
    const yyyy = Number(dmy[3]);
    const ymd = `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    if (isValidCalendarYmd(ymd)) {
      return { kind: "tasks", dateFrom: ymd, dateTo: ymd };
    }
  }
  return null;
}

/**
 * Click-path aliases only — expand bare «הצג משימות» / strip doubled «רשימת»
 * for allowlist match. Never used to rewrite a stored model button after Apply.
 */
function expandShowNavClickAliases(command: string): string[] {
  const trimmed = command.trim().replace(/\s+/gu, " ");
  if (!trimmed) {
    return [];
  }
  const out = [trimmed];
  if (trimmed === "הצג משימות") {
    out.push(showListButtonCommand("tasks"));
  } else if (trimmed === "הצג קניות") {
    out.push(showListButtonCommand("shopping"));
  } else if (trimmed === "הצג אנשי קשר") {
    out.push(showListButtonCommand("contacts"));
  }
  const listMatch = trimmed.match(
    /^(הצג רשימת) (.+?)( משותפות עם .+| באחריות .+)?$/u,
  );
  if (listMatch) {
    const name = (listMatch[2] ?? "").replace(/^(?:רשימת\s+)+/u, "").trim();
    const suffix = listMatch[3] ?? "";
    if (name) {
      const canonical = `${listMatch[1]} ${name}${suffix}`;
      if (canonical !== trimmed) {
        out.push(canonical);
      }
    }
  }
  return out;
}

export function mapShowButtonCommandToDumpTarget(
  text: string,
  snapshot?: Pick<EmployeeRecordSnapshot, "lists"> | null,
): ShowButtonDumpTarget | null {
  const itemNav = itemNavRefDumpTarget(text, snapshot);
  if (itemNav) {
    return itemNav;
  }
  const candidates = expandShowNavClickAliases(text);
  if (candidates.length === 0) {
    return null;
  }
  for (const trimmed of candidates) {
    const hit = mapShowButtonCommandToDumpTargetExact(trimmed, snapshot);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function mapShowButtonCommandToDumpTargetExact(
  trimmed: string,
  snapshot?: Pick<EmployeeRecordSnapshot, "lists"> | null,
): ShowButtonDumpTarget | null {
  if (!trimmed) {
    return null;
  }
  if (
    trimmed === SHOW_UNDATED_TASKS_COMMAND ||
    trimmed === SHOW_UNDATED_TASKS_COMMAND_LEGACY
  ) {
    return { kind: "tasks", dateScope: "undated" };
  }
  const absoluteDay = mapAbsoluteDayAgendaCommandToDumpTarget(trimmed);
  if (absoluteDay) {
    return absoluteDay;
  }
  const staticKind = STATIC_SHOW_BUTTON_DUMP[trimmed];
  if (staticKind) {
    return { kind: staticKind };
  }

  // Worker inventory (WATCH / להזכיר / לשלוח הודעה) — not collab משותפות/באחריות.
  const workerTasksAbout = trimmed.match(
    /^הצג (?:משימות|משימות) של (.+)$/u,
  );
  if (workerTasksAbout) {
    const person = (workerTasksAbout[1] ?? "").trim();
    if (person) {
      return { kind: "tasks", about: person };
    }
  }

  const builtinShared = trimmed.match(
    /^הצג (קניות|משימות|משימות|אנשי קשר) משותפות עם (.+)$/u,
  );
  if (builtinShared) {
    const hebrew = builtinShared[1] ?? "";
    const person = (builtinShared[2] ?? "").trim();
    const listType = builtinListTypeFromHebrew(hebrew);
    if (listType && person) {
      return {
        // Contacts v2: אנשי קשר collab dumps canonical phone_book.
        kind: listType === "contacts" ? "phone_book" : listType,
        section: "shared",
        partner: person,
        collaboration: "co_share",
      };
    }
  }
  const filingsShared = trimmed.match(/^הצג תיוקים משותפים עם (.+)$/u);
  if (filingsShared) {
    const person = (filingsShared[1] ?? "").trim();
    if (person) {
      return {
        kind: "filings",
        section: "shared",
        partner: person,
        collaboration: "co_share",
      };
    }
  }
  const builtinAssign = trimmed.match(
    /^הצג (קניות|משימות|משימות|אנשי קשר) באחריות (.+)$/u,
  );
  if (builtinAssign) {
    const hebrew = builtinAssign[1] ?? "";
    const person = (builtinAssign[2] ?? "").trim();
    const listType = builtinListTypeFromHebrew(hebrew);
    if (listType && person) {
      return {
        kind: listType === "contacts" ? "phone_book" : listType,
        section: "shared",
        assignee: person,
        collaboration: "assign",
      };
    }
  }
  const filingsAssign = trimmed.match(/^הצג תיוקים באחריות (.+)$/u);
  if (filingsAssign) {
    const person = (filingsAssign[1] ?? "").trim();
    if (person) {
      return {
        kind: "filings",
        section: "shared",
        assignee: person,
        collaboration: "assign",
      };
    }
  }

  if (!snapshot) {
    return null;
  }
  // Longest custom list_name wins when one name prefixes another.
  let bestCustom: ShowButtonDumpTarget | null = null;
  let bestCustomLen = -1;
  for (const list of snapshot.lists) {
    if (list.list_type !== "custom") {
      continue;
    }
    const listName = (list.list_name ?? "").trim();
    if (!listName) {
      continue;
    }
    const prefix = showListButtonCommand(listName);
    const sharedSuffix = ` משותפות עם `;
    const assignSuffix = ` באחריות `;
    if (trimmed.startsWith(prefix + sharedSuffix)) {
      const person = trimmed.slice((prefix + sharedSuffix).length).trim();
      if (person && listName.length > bestCustomLen) {
        bestCustom = {
          kind: listName,
          section: "shared",
          partner: person,
          collaboration: "co_share",
        };
        bestCustomLen = listName.length;
      }
      continue;
    }
    if (trimmed.startsWith(prefix + assignSuffix)) {
      const person = trimmed.slice((prefix + assignSuffix).length).trim();
      if (person && listName.length > bestCustomLen) {
        bestCustom = {
          kind: listName,
          section: "shared",
          assignee: person,
          collaboration: "assign",
        };
        bestCustomLen = listName.length;
      }
      continue;
    }
    // Exact button command OR free-typed aliases («הצג משימות לטל»).
    // Aliases keep LAST_NUMBERED_DUMP in sync — model-written inventory does not.
    if (
      matchesCustomListShowCommand(trimmed, listName) &&
      listName.length > bestCustomLen
    ) {
      bestCustom = { kind: listName };
      bestCustomLen = listName.length;
    }
  }
  return bestCustom;
}

/**
 * Opaque button «הצג רשימת X» plus free-typed show aliases for the same custom
 * list (exact equality only — never fuzzy / partial).
 */
export function matchesCustomListShowCommand(
  text: string,
  listName: string,
): boolean {
  const trimmed = text.trim();
  const name = listName.trim();
  if (!trimmed || !name) {
    return false;
  }
  return (
    trimmed === showListButtonCommand(name) ||
    trimmed === `הצג ${name}` ||
    trimmed === `הציגי ${name}` ||
    trimmed === `הצג את רשימת ${name}` ||
    trimmed === `הציגי את רשימת ${name}` ||
    trimmed === `הציגי רשימת ${name}`
  );
}

function actionItemIdFromRaw(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "";
  }
  const record = raw as Record<string, unknown>;
  for (const key of ["item_id", "itemId", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function normalizeDumpListName(value: string | null | undefined): string {
  return normalizeShowDumpListName(value ?? "").trim();
}

/**
 * Whether this lists.* ACTION targets a domain present in the active dump
 * (add to shopping while custom dump is open → false).
 */
export function listActionMatchesLastNumberedDumpScope(
  action: Pick<LlmListAction, "listType" | "listName">,
  dump: ReadonlyArray<LastNumberedDumpLine>,
): boolean {
  if (dump.length === 0) {
    return true;
  }
  const kinds = new Set(dump.map((row) => row.kind.trim()).filter(Boolean));
  const customNames = new Set(
    dump
      .map((row) =>
        row.kind === "custom" ? normalizeDumpListName(row.list_name) : "",
      )
      .filter(Boolean),
  );
  const legacyCustomWithoutName = dump.some(
    (row) => row.kind === "custom" && !normalizeDumpListName(row.list_name),
  );
  const listType = action.listType;
  if (listType === "shopping") {
    return kinds.has("shopping");
  }
  if (listType === "tasks") {
    return kinds.has("tasks");
  }
  if (listType === "reminders") {
    return kinds.has("reminders");
  }
  if (listType === "contacts") {
    return kinds.has("contacts") || kinds.has("phone_book");
  }
  if (listType === "filing") {
    return kinds.has("filings") || kinds.has("filing");
  }
  if (listType === "custom") {
    // Other-domain dumps do not match custom scope. Explicit named custom
    // adds bypass H via isExplicitListAddTarget; this helper is for
    // non-explicit mutates (no list_name / no item_id).
    if (!kinds.has("custom")) {
      return false;
    }
    const name = normalizeDumpListName(action.listName);
    if (name && customNames.has(name)) {
      return true;
    }
    // Pre-list_name dump maps: allow any custom rather than lock the session.
    return legacyCustomWithoutName;
  }
  return false;
}

/**
 * Hard server guard while LAST_NUMBERED_DUMP is active.
 *
 * Model owns intent + explicit target; H only:
 * - resolves dump-bound line refs (ids on the dump / dump_line pass-through)
 * - drops ungrounded / stale ids and non-explicit mutates outside dump scope
 *
 * Explicit `lists.add` (shopping|tasks|contacts|filing, or custom with
 * non-empty list_name) is never dump-scoped — apply still validates existence
 * and permissions.
 *
 * `lists.update`/`remove` with item_id: keep when id is on the dump, Stage-2
 * passThrough (dump_line|saved_data), or grounded in this turn's visible ESD
 * ids. Format-only ids that are not grounded are dropped.
 *
 * Without item_id and without an explicit add target → dump scope match
 * (strict). Empty dump → no filter.
 */
export type DumpGuardDroppedItem = {
  itemId?: string;
  listType?: string;
  listName?: string;
  op?: string;
  reason: "outside_dump" | "outside_dump_scope";
  /** Dump line and title, when the dropped id was on the numbered map. */
  dumpLine?: number;
  label?: string;
};

/** Model-supplied add destination — not a dump line reference. */
function isExplicitListAddTarget(action: LlmListAction): boolean {
  if (
    action.listType === "shopping" ||
    action.listType === "tasks" ||
    action.listType === "contacts" ||
    action.listType === "filing"
  ) {
    return true;
  }
  if (
    action.listType === "custom" &&
    Boolean(normalizeDumpListName(action.listName))
  ) {
    return true;
  }
  return false;
}

export function restrictListMutatesToLastNumberedDump(
  lists: LlmListAction[],
  dump: ReadonlyArray<LastNumberedDumpLine>,
  options?: {
    passThroughIds?: ReadonlySet<string>;
    /** Opaque ids present in this turn's injected ESD/WORKER facts. */
    groundedIds?: ReadonlySet<string>;
  },
): {
  lists: LlmListAction[];
  droppedOutsideDump: boolean;
  /** Ids/actions dropped by H — for ApplyResult only; policy unchanged. */
  droppedItems: DumpGuardDroppedItem[];
} {
  if (dump.length === 0 || lists.length === 0) {
    return { lists, droppedOutsideDump: false, droppedItems: [] };
  }
  const allowedIds = new Set(
    dump.map((row) => row.id.trim()).filter(Boolean),
  );
  const passThroughIds = options?.passThroughIds;
  const groundedIds = options?.groundedIds;
  let droppedOutsideDump = false;
  const droppedItems: DumpGuardDroppedItem[] = [];
  const next: LlmListAction[] = [];
  for (const action of lists) {
    if (action.action === "add") {
      if (isExplicitListAddTarget(action)) {
        next.push(action);
        continue;
      }
      if (!listActionMatchesLastNumberedDumpScope(action, dump)) {
        droppedOutsideDump = true;
        droppedItems.push({
          listType: action.listType,
          listName: action.listName,
          op: action.action,
          reason: "outside_dump_scope",
        });
        continue;
      }
      next.push(action);
      continue;
    }
    if (action.action !== "remove" && action.action !== "update") {
      next.push(action);
      continue;
    }
    const items = Array.isArray(action.items) ? action.items : [];
    const addressedIds = items
      .map((raw) => actionItemIdFromRaw(raw))
      .filter(Boolean);
    if (addressedIds.length === 0) {
      // No ids — not an explicit item target; keep dump scope (strict).
      if (!listActionMatchesLastNumberedDumpScope(action, dump)) {
        droppedOutsideDump = true;
        droppedItems.push({
          listType: action.listType,
          listName: action.listName,
          op: action.action,
          reason: "outside_dump_scope",
        });
        continue;
      }
      next.push(action);
      continue;
    }
    const kept: typeof items = [];
    for (const raw of items) {
      const id = actionItemIdFromRaw(raw);
      if (!id) {
        kept.push(raw);
        continue;
      }
      // Dump line id, Stage-2 validated id, or this-turn ESD/WORKER grounded id.
      // Never keep on format alone.
      if (
        allowedIds.has(id) ||
        passThroughIds?.has(id) ||
        groundedIds?.has(id)
      ) {
        kept.push(raw);
        continue;
      }
      droppedOutsideDump = true;
      const line = dump.find((row) => row.id.trim() === id);
      droppedItems.push({
        itemId: id,
        listType: action.listType,
        listName: action.listName,
        op: action.action,
        reason: "outside_dump",
        ...(line?.n ? { dumpLine: line.n } : {}),
        ...(line?.title_stem.trim() ? { label: line.title_stem.trim() } : {}),
      });
    }
    if (kept.every((raw) => !actionItemIdFromRaw(raw))) {
      continue;
    }
    if (kept.length !== items.length) {
      next.push({ ...action, items: kept });
    } else {
      next.push(action);
    }
  }
  return { lists: next, droppedOutsideDump, droppedItems };
}

/**
 * Closed allowlist: exact UI button command → show_dump kind string.
 * Prefer mapShowButtonCommandToDumpTarget when filters are needed.
 */
export function mapShowButtonCommandToDump(
  text: string,
  snapshot?: Pick<EmployeeRecordSnapshot, "lists"> | null,
): string | null {
  return mapShowButtonCommandToDumpTarget(text, snapshot)?.kind ?? null;
}

/** True when the message is an exact known show-button command string. */
export function isKnownShowButtonCommand(
  text: string,
  snapshot?: Pick<EmployeeRecordSnapshot, "lists"> | null,
): boolean {
  return mapShowButtonCommandToDumpTarget(text, snapshot) !== null;
}

/** Map metadata.show_dump labels to a dump target (no section/polite stripping). */
export function resolveShowDumpKind(
  raw: string,
):
  | { kind: "full" }
  | { kind: "reminders" }
  | { kind: "filings" }
  | { kind: "phone_book" }
  | { kind: "list"; name: string }
  | null {
  const trimmed = normalizeShowDumpListName(raw);
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (
    lower === "full" ||
    trimmed === "הכל" ||
    trimmed === "סיכום" ||
    trimmed === "סיכום מלא"
  ) {
    return { kind: "full" };
  }
  if (
    lower === "reminders" ||
    trimmed === "תזכורות" ||
    trimmed === SHOW_REMINDERS_COMMAND
  ) {
    return { kind: "reminders" };
  }
  if (
    lower === "filings" ||
    trimmed === "תיוקים" ||
    trimmed === SHOW_FILINGS_COMMAND
  ) {
    return { kind: "filings" };
  }
  if (
    lower === "phone_book" ||
    lower === "phonebook" ||
    lower === "contacts" ||
    trimmed === "ספר הטלפונים" ||
    trimmed === "אנשי קשר"
  ) {
    // Contacts v2: one surface — SPEAKER_CONTACTS / directory (not lists.contacts).
    return { kind: "phone_book" };
  }
  if (isBuiltinListType(lower)) {
    return {
      kind: "list",
      name: builtinListHebrew(lower),
    };
  }
  const fromHebrew = builtinListTypeFromHebrew(trimmed);
  if (fromHebrew === "contacts") {
    return { kind: "phone_book" };
  }
  if (fromHebrew) {
    return { kind: "list", name: builtinListHebrew(fromHebrew) };
  }
  return { kind: "list", name: trimmed };
}

/** One numbered dump line for LAST_NUMBERED_DUMP (model copies id on line-index turns). */
export type LastNumberedDumpLine = {
  n: number;
  id: string;
  kind: string;
  title_stem: string;
  /**
   * Display context (day YMD, full-dump category, multi-about subject).
   * Line `n` is dump-global continuous — section does not restart numbering.
   */
  section?: string;
  /**
   * Exact custom list_name when kind=custom — scopes add/update/remove to that
   * list while this dump is active (not another custom list).
   */
  list_name?: string;
};

type DumpTextResult = {
  text: string;
  lines: LastNumberedDumpLine[];
  /**
   * Dated tasks dump excluded 2+ משימות כלליות — engine offers the undated button
   * (do not list them inline).
   */
  offerUndatedTasksButton?: boolean;
};

function emptyDumpResult(text = ""): DumpTextResult {
  return { text, lines: [] };
}

export function undatedTasksOfferButton(): { label: string; command: string } {
  return {
    label: "משימות כלליות",
    command: SHOW_UNDATED_TASKS_COMMAND,
  };
}

/**
 * Exact dump-line → opaque id. Returns null when n is missing/out of range or
 * section is required and does not match. Never picks another row.
 */
export function resolveDumpLineId(
  lines: LastNumberedDumpLine[],
  n: number,
  section?: string | null,
): string | null {
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  const sectionKey = section?.trim() || "";
  const matches = lines.filter((row) => {
    if (row.n !== n) {
      return false;
    }
    if (!sectionKey) {
      return true;
    }
    return (row.section ?? "") === sectionKey;
  });
  if (matches.length !== 1) {
    return null;
  }
  const id = matches[0]?.id?.trim() ?? "";
  return id || null;
}

export function formatLastNumberedDumpContext(
  lines: LastNumberedDumpLine[],
): string {
  if (lines.length === 0) {
    return "";
  }
  return [
    "LAST_NUMBERED_DUMP:",
    "Spoken dump indices («3» / «ל3» / «תמחק את 3» / «שתף 4 עם עמית») map to these rows from the last numbered dump. Copy the exact id (+ kind) for that n into the ACTION — never substitute another dump row or a live JSON neighbor. Share-by-index: shopping/tasks/custom/filings → lists.update with that item_id + targets:[speaker, partner] on the lists[] entry (list-level canonical; item-nested targets also accepted). phone_book / אנשי קשר (kind phone_book, id=contact_id) → directory.update with that contact_id + targets:[speaker, partner] (never lists.update). If n is present in this JSON → FORBIDDEN claiming «לא מופיע פריט N» / ASK which item. Missing/out of range / ambiguous n → ASK with empty mutates; never invent or guess ids. Never treat n as EMPLOYEE_SAVED_DATA array index.",
    JSON.stringify(lines),
  ].join("\n");
}

/** Dump from model `show_dump` (+ optional section/partner on opts). */
export function formatShowDumpFromKind(
  kind: string,
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): string | null {
  return formatShowDumpWithLineMap(kind, snapshot, opts).text;
}

/** Same dump text as formatShowDumpFromKind, plus LAST_NUMBERED_DUMP lines. */
export function formatShowDumpWithLineMap(
  kind: string,
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): {
  text: string | null;
  lines: LastNumberedDumpLine[];
  offerUndatedTasksButton?: boolean;
} {
  const resolved = resolveShowDumpKind(kind);
  if (!resolved) {
    return { text: null, lines: [] };
  }
  return formatResolvedShowDump(resolved, snapshot, opts);
}

function formatResolvedShowDump(
  parsed:
    | { kind: "full" }
    | { kind: "reminders" }
    | { kind: "filings" }
    | { kind: "phone_book" }
    | { kind: "list"; name: string },
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): {
  text: string | null;
  lines: LastNumberedDumpLine[];
  offerUndatedTasksButton?: boolean;
} {
  if (parsed.kind === "full") {
    const full = formatFullDump(snapshot, opts);
    return {
      text: full.text || null,
      lines: full.lines,
      ...(full.offerUndatedTasksButton
        ? { offerUndatedTasksButton: true }
        : {}),
    };
  }
  if (parsed.kind === "reminders") {
    const body = formatRemindersDump(snapshot.reminders ?? [], opts);
    if (body.text) {
      return {
        text: `${remindersActiveDumpHeader()}\n${body.text}`,
        lines: body.lines,
      };
    }
    return {
      text: opts?.omitEmptySentence ? "" : "אין לך תזכורות פעילות כרגע.",
      lines: [],
    };
  }
  if (parsed.kind === "filings") {
    const body = formatFilingsDump(snapshot.filing ?? [], opts);
    if (body.text) {
      return body;
    }
    return {
      text: opts?.omitEmptySentence ? "" : emptyFilingsSentence(opts),
      lines: [],
    };
  }
  if (parsed.kind === "phone_book") {
    const body = formatPhoneBookDump(opts?.phoneBook, opts);
    if (body.text) {
      return body;
    }
    return {
      text: opts?.omitEmptySentence ? "" : emptyPhoneBookSentence(opts),
      lines: [],
    };
  }
  return formatListDump(parsed.name, snapshot, opts);
}

/** One-line empty when a focused shopping/tasks dump has nothing. */
export function emptyListDumpSentence(
  label: string,
  opts?: ShowDumpOptions,
): string {
  const section = opts?.section ?? null;
  const partnerFilters = dumpFilterNames(opts?.partner);
  if (section === "personal") {
    return `אין ${label} אישיות.`;
  }
  if (section === "shared" && partnerFilters.length > 0) {
    return `אין ${label} משותפות עם ${partnerFilterLabel(partnerFilters)}.`;
  }
  if (section === "shared") {
    return `אין ${label} משותפות.`;
  }
  return `אין ${label} שמורות.`;
}

/** Assign mark shown to both parties — no arrows, no bare name. */
export function formatAssignResponsibilityMark(
  assignee: string,
  assigner: string,
): string {
  const who = assignee.trim();
  const from = assigner.trim();
  if (who && from) {
    return `באחריות ${who} · מאת ${from}`;
  }
  if (who) {
    return `באחריות ${who}`;
  }
  if (from) {
    return `מאת ${from}`;
  }
  return "";
}

/** Parse assignee from «באחריות X · מאת Y». */
export function extractAssigneeFromMark(mark: string): string | undefined {
  const trimmed = mark.trim();
  const full = trimmed.match(/^באחריות\s+(.+?)\s+·\s+מאת\s+/);
  if (full?.[1]?.trim()) {
    return full[1].trim();
  }
  const only = trimmed.match(/^באחריות\s+(.+)$/);
  if (only?.[1]?.trim() && !only[1].includes("·")) {
    return only[1].trim();
  }
  return undefined;
}

function emptyFilingsSentence(opts?: ShowDumpOptions): string {
  const section = opts?.section ?? null;
  const partners = dumpFilterNames(opts?.partner);
  if (section === "shared" && partners.length > 0) {
    return `אין תיוקים משותפים עם ${partnerFilterLabel(partners)}.`;
  }
  if (section === "shared") {
    return "אין תיוקים משותפים.";
  }
  if (section === "personal") {
    return "אין תיוקים אישיים.";
  }
  return "אין תיוקים שמורים.";
}

function emptyPhoneBookSentence(opts?: ShowDumpOptions): string {
  const section = opts?.section ?? null;
  const partners = dumpFilterNames(opts?.partner);
  if (section === "shared" && partners.length > 0) {
    return `אין אנשי קשר משותפים עם ${partnerFilterLabel(partners)}.`;
  }
  if (section === "shared" || partners.length > 0) {
    return "אין אנשי קשר משותפים.";
  }
  if (section === "personal") {
    return "אין אנשי קשר אישיים.";
  }
  return "אין אנשי קשר שמורים.";
}

function emptyContactsSentence(opts?: ShowDumpOptions): string {
  const section = opts?.section ?? null;
  const partners = dumpFilterNames(opts?.partner);
  if (section === "shared" && partners.length > 0) {
    return `אין אנשי קשר משותפים עם ${partnerFilterLabel(partners)}.`;
  }
  if (section === "shared") {
    return "אין אנשי קשר משותפים.";
  }
  if (section === "personal") {
    return "אין אנשי קשר אישיים.";
  }
  return "אין אנשי קשר שמורים.";
}

function emptyFullDumpSentence(opts?: ShowDumpOptions): string {
  const partners = dumpFilterNames(opts?.partner);
  if (partners.length > 0) {
    return `אין לך מידע משותף עם ${partnerFilterLabel(partners)} כרגע.`;
  }
  if (opts?.section === "shared") {
    return "אין לך מידע משותף כרגע.";
  }
  if (opts?.section === "personal") {
    return "אין לך מידע אישי שמור כרגע.";
  }
  return "אין לך מידע שמור כרגע.";
}

/**
 * Bare overview («הצג רשימות» / הציגי הכל): stitch Stage-2 category dumps.
 * Item detail only for tasks + reminders. All other shells = counts only
 * (shopping, custom, filings, phone book / אנשי קשר).
 *
 * Topic / ITEM multi-section (`opts.itemIds` set): only matching row ids;
 * shopping/filings/phone_book/custom as filtered item lines (not counts);
 * omit empty sections and the inventory hint.
 */
export function formatFullDump(
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): DumpTextResult {
  const sections: string[] = [];
  const lines: LastNumberedDumpLine[] = [];
  const itemDump = opts?.itemIds != null;
  // One counter for the whole stitched dump — never reset between blocks.
  const numbering = ensureDumpNumbering(opts);
  const sharedOpts: ShowDumpOptions = { ...opts, numbering };
  let offerUndatedTasksButton = false;

  const pushBlock = (block: DumpTextResult | string, section?: string) => {
    if (typeof block === "string") {
      const trimmed = block.trim();
      if (trimmed) {
        sections.push(trimmed);
      }
      return;
    }
    if (block.offerUndatedTasksButton) {
      offerUndatedTasksButton = true;
    }
    const trimmed = block.text.trim();
    if (trimmed) {
      sections.push(trimmed);
    }
    for (const line of block.lines) {
      lines.push(
        section && !line.section ? { ...line, section } : line,
      );
    }
  };

  pushBlock(
    formatThreeWayDump("shopping", "קניות", snapshot, {
      ...sharedOpts,
      // Topic dump: filtered item lines. Bare full inventory: counts only.
      countsOnly: itemDump ? false : true,
    }),
  );
  pushBlock(
    formatThreeWayDump(
      "tasks",
      tasksDumpBareLabel(sharedOpts),
      snapshot,
      sharedOpts,
    ),
    "tasks",
  );
  if (itemDump) {
    for (const list of snapshot.lists) {
      if (list.list_type !== "custom") {
        continue;
      }
      const name = (list.list_name ?? "").trim();
      if (!name) {
        continue;
      }
      const customBody = formatContactsOrCustomDump(
        "custom",
        name,
        snapshot,
        name,
        sharedOpts,
      );
      if (customBody?.text.trim()) {
        pushBlock(customBody, "custom");
      }
    }
  } else {
    pushBlock(formatCustomListsCountsDump(snapshot, sharedOpts));
  }

  const partnerNeedles = dumpFilterNames(sharedOpts?.partner);
  const partnerOnly =
    Boolean(sharedOpts?.section === "shared") || partnerNeedles.length > 0;

  const linkedIds = linkedReminderIdsFromTasks(snapshot);
  const partnerLinkedIds = partnerOnly
    ? linkedReminderIdsFromPartnerTasks(snapshot, sharedOpts)
    : new Set<string>();
  const reminderRows = (snapshot.reminders ?? []).filter((row) => {
    // Never re-list a clock already folded into a task line.
    if (linkedIds.has(row.reminder_id)) {
      return false;
    }
    if (partnerOnly) {
      return reminderInvolvesPartner(row, partnerNeedles, partnerLinkedIds);
    }
    return true;
  });
  const remBody = formatRemindersDump(reminderRows, sharedOpts, "reminders");
  if (remBody.text) {
    sections.push(`${remindersActiveDumpHeader()}\n${remBody.text}`);
    lines.push(...remBody.lines);
  }

  // Bare full inventory: counts only (like shopping/custom). ITEM/topic dump keeps lines.
  const otherCountsOnly = !itemDump;
  pushBlock(
    formatFilingsDump(snapshot.filing ?? [], {
      ...sharedOpts,
      countsOnly: otherCountsOnly,
    }),
    "filings",
  );

  // Contacts v2: single «אנשי קשר» from SPEAKER_CONTACTS (never lists.contacts).
  pushBlock(
    formatPhoneBookDump(sharedOpts?.phoneBook, {
      ...sharedOpts,
      countsOnly: otherCountsOnly,
    }),
    "phone_book",
  );

  if (sections.length === 0) {
    if (opts?.omitEmptySentence === true) {
      return emptyDumpResult("");
    }
    return emptyDumpResult(emptyFullDumpSentence(opts));
  }

  if (!itemDump) {
    sections.push("לפירוט רשימה: הצג רשימת …");
  }
  return {
    text: sections.join("\n\n"),
    lines,
    ...(offerUndatedTasksButton ? { offerUndatedTasksButton: true } : {}),
  };
}

/**
 * Opaque dump row ids present in this live snapshot (item_id / filing_id /
 * contact_id / reminder_id). Used to validate show_dump_ids before format.
 * Pass phoneBook so Contacts.id values count for phone_book ITEM DUMP.
 */
export function liveDumpRowIdsFromSnapshot(
  snapshot: EmployeeRecordSnapshot,
  phoneBook?: PhoneBookDumpRow[] | null,
): Set<string> {
  const ids = new Set<string>();
  for (const list of snapshot.lists ?? []) {
    if (list.list_type === "contacts") {
      // Contacts v2: legacy list rows are not dump ids.
      continue;
    }
    const listType = list.list_type as ListDumpType;
    for (const item of list.items ?? []) {
      const id = dumpItemId(listType, item as Record<string, unknown>);
      if (id) {
        ids.add(id);
      }
    }
  }
  for (const row of snapshot.filing ?? []) {
    const id = String(row.filing_id ?? "").trim();
    if (id) {
      ids.add(id);
    }
  }
  for (const row of snapshot.reminders ?? []) {
    const id = String(row.reminder_id ?? "").trim();
    if (id) {
      ids.add(id);
    }
  }
  for (const row of phoneBook ?? []) {
    const id = String(row.contact_id ?? "").trim();
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

function hebrewItemCount(n: number): string {
  return n === 1 ? "1 פריט" : `${n} פריטים`;
}

/**
 * Raw share names for custom full-dump count marks / partner filter.
 * Whole-list shared → list.shared_with; shared_items → item shared_with or owner;
 * else item co-share partners.
 */
function customListCountShareNames(
  list: EmployeeRecordSnapshot["lists"][number],
): string[] {
  if (list.scope === "shared") {
    return (list.shared_with ?? [])
      .map((name) => name.trim())
      .filter(Boolean);
  }
  if (list.scope === "shared_items") {
    const fromItems = list.items.flatMap((item) => stringArray(item.shared_with));
    if (fromItems.length > 0) {
      return fromItems;
    }
    const owner = (list.owner ?? "").trim();
    return owner ? [owner] : [];
  }
  return list.items.flatMap((item) => stringArray(item.shared_with));
}

function customListHasShareSignal(
  list: EmployeeRecordSnapshot["lists"][number],
): boolean {
  if (list.scope === "shared" || list.scope === "shared_items") {
    return true;
  }
  return list.items.some((item) => stringArray(item.shared_with).length > 0);
}

/** Custom lists: one count line each (FULL DUMP רשימות אחרות). */
function formatCustomListsCountsDump(
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): string {
  const customs = snapshot.lists.filter((list) => list.list_type === "custom");
  const viewer = opts?.viewerName?.trim() ?? "";
  const aliases = opts?.viewerAliases ?? [];
  const section = opts?.section ?? null;
  const partnerNeedles = dumpFilterNames(opts?.partner);
  const lines: string[] = [];
  for (const list of customs) {
    const hasShare = customListHasShareSignal(list);
    if (section === "personal" && (list.scope === "shared" || list.scope === "shared_items")) {
      continue;
    }
    if (section === "shared" && !hasShare) {
      continue;
    }
    const shareNames = customListCountShareNames(list);
    const partners =
      shareNames.length > 0
        ? partnersKey(shareNames, viewer, aliases)
        : "";
    if (
      partnerNeedles.length > 0 &&
      !partnerNeedles.some((needle) =>
        partnerBucketMatches(partners || "משותף", needle),
      )
    ) {
      continue;
    }
    const name = (list.list_name ?? "").trim() || "ללא שם";
    const n = list.items.length;
    if (n === 0) {
      continue;
    }
    // Display = all involved (מיכל, טל); filter key above stays partners-only.
    const mark =
      partners && partners !== "משותף"
        ? allInvolvedNames(shareNames, viewer, aliases)
        : "";
    const withMark = mark ? ` (${mark})` : "";
    const emoji = listDumpEmoji(list);
    lines.push(`${emoji} *${name}*${withMark} — ${hebrewItemCount(n)}`);
  }
  if (lines.length === 0) {
    return "";
  }
  return ["רשימות אחרות:", ...lines].join("\n");
}

/**
 * Phone book dump — one header + co-share marks (same rules as contacts).
 */
export function formatPhoneBookDump(
  phoneBook: PhoneBookDumpRow[] | undefined,
  opts?: ShowDumpOptions,
): DumpTextResult {
  const rows = phoneBook ?? [];
  const viewer = (opts?.viewerName ?? "").trim();
  const aliases = (opts?.viewerAliases ?? []).map((name) => name.trim());
  const viewerNames = new Set(
    [viewer, ...aliases].map((name) => name.trim()).filter(Boolean),
  );
  const collected: DumpItem[] = rows.map((row) => {
    const name = row.name.trim() || "איש קשר";
    const phone = (row.phone ?? "").trim();
    const description = (row.description ?? "").trim();
    const contactId = (row.contact_id ?? "").trim();
    const base = phone ? `${name} — ${phone}` : name;
    const title = description ? `${base} · ${description}` : base;
    const attachments = Array.isArray(row.attachments) ? row.attachments : [];
    const item: Record<string, unknown> = {
      ...(contactId ? { contact_id: contactId } : {}),
      name,
      ...(phone ? { phone } : {}),
      ...(description ? { description } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    const sharedWith = (row.shared_with ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
    const partners = sharedWith.filter((value) => !viewerNames.has(value));
    const assignedBy = (row.assigned_by ?? "").trim();
    const owner = (row.owner ?? "").trim();
    if (assignedBy && sharedWith.length === 0) {
      const assignee = owner || viewer;
      const mark = formatAssignResponsibilityMark(assignee, assignedBy);
      return {
        title,
        item,
        isShared: true,
        partnerFilterKey: assignedBy,
        assigneeName: assignee || undefined,
        ...(mark ? { responsibilityMark: mark } : {}),
      };
    }
    const isShared = row.scope === "shared" && partners.length > 0;
    const allInvolved = isShared
      ? allInvolvedNames(sharedWith, viewer, aliases)
      : "";
    const partnerFilterKey = isShared
      ? partnersKey(sharedWith, viewer, aliases)
      : "";
    return {
      title,
      item,
      isShared,
      ...(partnerFilterKey ? { partnerFilterKey } : {}),
      ...(allInvolved ? { responsibilityMark: allInvolved } : {}),
    };
  });
  const kept = filterDumpRows(collected, "phone_book", opts);
  // Unified UX label «אנשי קשר» + 👤; lines carry contact_id for directory mutates.
  return formatSingleHeaderDump("👤 אנשי קשר", "phone_book", kept, opts);
}

/**
 * Digital-worker follow-up clocks (owned by a digital employee or linked via
 * worker_item_id). Used to keep them out of the speaker's personal day agenda.
 */
export function isDigitalWorkerReminderAgendaSlot(
  rem: Pick<
    ReminderSnapshotRow,
    "owner_is_digital" | "worker_item_id" | "owner_id"
  >,
): boolean {
  if (rem.owner_is_digital === true) {
    return true;
  }
  const workerItemId =
    typeof rem.worker_item_id === "string" ? rem.worker_item_id.trim() : "";
  return Boolean(workerItemId);
}

/** Conditional watch clock («תעדכני אותי אם…») — gate is structured compose_condition. */
function isConditionalWatchReminder(
  rem: Pick<ReminderSnapshotRow, "compose_condition">,
): boolean {
  const gate = rem.compose_condition;
  return gate != null && typeof gate === "object" && !Array.isArray(gate);
}

/** reminder_ids of conditional watches — their worker tasks must not flood day agenda. */
function conditionalWatchReminderIds(
  reminders: ReminderSnapshotRow[],
): Set<string> {
  const ids = new Set<string>();
  for (const rem of reminders) {
    if (!isConditionalWatchReminder(rem)) {
      continue;
    }
    const id = rem.reminder_id?.trim();
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

/** reminder_id values already shown via LINKED REMINDER on a task line. */
function linkedReminderIdsFromTasks(
  snapshot: EmployeeRecordSnapshot,
): Set<string> {
  const ids = new Set<string>();
  for (const list of snapshot.lists) {
    if (list.list_type !== "tasks") {
      continue;
    }
    for (const item of list.items) {
      for (const id of reminderIdsFromTaskItem(item)) {
        ids.add(id);
      }
    }
  }
  return ids;
}

function reminderIdFromTaskItem(
  item: Record<string, unknown>,
): string | null {
  const ids = reminderIdsFromTaskItem(item);
  return ids[0] ?? null;
}

/** All linked reminder_ids on a task (reminders[] ∪ singular reminder). */
function reminderIdsFromTaskItem(item: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return;
    }
    const id = (raw as { reminder_id?: unknown }).reminder_id;
    if (typeof id === "string" && id.trim() && !seen.has(id.trim())) {
      seen.add(id.trim());
      out.push(id.trim());
    }
  };
  const many = item.reminders;
  if (Array.isArray(many)) {
    for (const entry of many) {
      push(entry);
    }
  }
  push(item.reminder);
  return out;
}

/**
 * Partner bucket key for a tasks item (same rules as formatThreeWayDump),
 * or null when the row is personal / unshared.
 */
export function taskItemPartnerBucketKey(
  list: EmployeeRecordSnapshot["lists"][number],
  item: Record<string, unknown>,
  viewer: string,
  aliases: string[],
): string | null {
  if (list.scope === "shared_items") {
    return (list.owner ?? "").trim() || "משותף";
  }
  if (list.scope === "shared") {
    return partnersKey(list.shared_with ?? [], viewer, aliases);
  }
  const assignedBy =
    typeof item.assigned_by === "string" ? item.assigned_by.trim() : "";
  if (assignedBy) {
    return assignedBy;
  }
  const sharedWith = stringArray(item.shared_with);
  if (sharedWith.length > 0) {
    return partnersKey(sharedWith, viewer, aliases);
  }
  return null;
}

/** Linked reminder ids on tasks that partner-bucket with the dump partner(s). */
export function linkedReminderIdsFromPartnerTasks(
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): Set<string> {
  const needles = dumpFilterNames(opts?.partner);
  const viewer = (opts?.viewerName ?? "").trim();
  const aliases = (opts?.viewerAliases ?? []).map((name) => name.trim());
  const ids = new Set<string>();
  if (needles.length === 0 && opts?.section !== "shared") {
    return ids;
  }
  for (const list of snapshot.lists) {
    if (list.list_type !== "tasks") {
      continue;
    }
    for (const item of list.items) {
      const bucket = taskItemPartnerBucketKey(list, item, viewer, aliases);
      if (!bucket) {
        continue;
      }
      if (
        needles.length > 0 &&
        !needles.some((needle) => partnerBucketMatches(bucket, needle))
      ) {
        continue;
      }
      for (const id of reminderIdsFromTaskItem(item)) {
        ids.add(id);
      }
    }
  }
  return ids;
}

/** Partner dump: clock involves partner via ping, about_ids, or linked shared task. */
export function reminderInvolvesPartner(
  row: ReminderSnapshotRow,
  partnerNeedles: string[],
  partnerLinkedIds: Set<string>,
): boolean {
  if (partnerLinkedIds.has(row.reminder_id)) {
    return true;
  }
  if (partnerNeedles.length === 0) {
    // section=shared with no named partner — keep clocks linked to any shared task.
    return false;
  }
  const pings = (row.ping ?? []).map((name) => name.trim()).filter(Boolean);
  if (
    partnerNeedles.some((needle) =>
      pings.some(
        (ping) => ping === needle || partnerBucketMatches(ping, needle),
      ),
    )
  ) {
    return true;
  }
  const about = (row.about ?? []).map((name) => name.trim()).filter(Boolean);
  return partnerNeedles.some((needle) =>
    about.some(
      (name) => name === needle || partnerBucketMatches(name, needle),
    ),
  );
}

/** Linked reminder on a task item is about one of the partner needles. */
export function itemReminderAboutMatchesPartner(
  item: Record<string, unknown>,
  partnerNeedles: string[],
): boolean {
  if (partnerNeedles.length === 0) {
    return false;
  }
  const raw = item.reminder;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  const rem = raw as Record<string, unknown>;
  const aboutNames = Array.isArray(rem.about)
    ? rem.about.map((value) => String(value).trim()).filter(Boolean)
    : [];
  return partnerNeedles.some((needle) =>
    aboutNames.some(
      (name) => name === needle || partnerBucketMatches(name, needle),
    ),
  );
}

/**
 * Soft cap for list-row detail preview when no sentence/line end is available.
 * Short prose under this limit stays complete; longer unpunctuated text cuts at
 * a word boundary. Prefer sentence/paragraph via {@link firstFilingPreviewChunk}.
 */
export const LIST_ROW_PREVIEW_MAX_CHARS = 160;
/** @deprecated Use {@link LIST_ROW_PREVIEW_MAX_CHARS}. */
export const FILING_LIST_PREVIEW_MAX_CHARS = LIST_ROW_PREVIEW_MAX_CHARS;

/** Soft-preferred custom detail column names (any user columns still work). */
const CUSTOM_DETAIL_PREFERRED_KEYS = [
  "תיאור",
  "הערות",
  "פירוט",
  "notes",
  "description",
] as const;

/**
 * Filing dump body.
 * - `list` (inventory): short title only — preview line is appended separately
 *   via {@link formatFilingListPreview} (never full תיאור / מידע לחיפוש).
 * - `full` (ITEM DUMP when opts.itemIds is set): labeled «שם · תיאור · מידע לחיפוש».
 */
export function formatFilingDumpBody(
  row: EmployeeRecordSnapshot["filing"][number],
  mode: "list" | "full" = "list",
): string {
  const name = row.item_name?.trim() ?? "";
  if (mode === "list") {
    return name || "תיוק";
  }
  const parts: string[] = [];
  const info = row.item_info?.trim() ?? "";
  const findHelper = row.item_description?.trim() ?? "";
  if (name) {
    parts.push(`שם: ${name}`);
  }
  if (info) {
    parts.push(`תיאור: ${info}`);
  }
  if (findHelper) {
    parts.push(`מידע לחיפוש: ${findHelper}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "תיוק";
}

/** Skip ids / flags / bare tokens when walking JSON for list preview. */
function filingJsonStringLooksHuman(text: string): boolean {
  const t = text.trim();
  if (!t) {
    return false;
  }
  if (/[\u0590-\u05FF]/.test(t)) {
    return true;
  }
  if (/\s/.test(t) && /[a-zA-Z\u0590-\u05FF]{3,}/.test(t)) {
    return true;
  }
  return t.length >= 16 && /[a-zA-Z]{4,}/.test(t);
}

/**
 * Prefer human string fields; otherwise join nested prose values — never keys.
 */
function readableStringsFromJson(
  value: unknown,
  depth = 0,
  allowAnyString = false,
): string[] {
  if (depth > 4 || value == null) {
    return [];
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) {
      return [];
    }
    if (allowAnyString || depth === 0 || filingJsonStringLooksHuman(t)) {
      return [t];
    }
    return [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      readableStringsFromJson(entry, depth + 1, allowAnyString),
    );
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const preferred = [
      "text",
      "summary",
      "title",
      "description",
      "value",
      "label",
      "name",
      "body",
      "content",
      "תיאור",
      "שם",
      "מידע",
    ];
    for (const key of preferred) {
      const hit = obj[key];
      if (typeof hit === "string" && hit.trim()) {
        return [hit.trim()];
      }
    }
    return Object.values(obj).flatMap((entry) =>
      readableStringsFromJson(entry, depth + 1, false),
    );
  }
  return [];
}

/**
 * Readable prose from a stored filing field. Rejects bare coordinates and
 * surfaces JSON as human strings (no raw braces / field names).
 */
export function extractFilingReadableText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (parseLatLngCoordinates(trimmed)) {
    return "";
  }
  if (/^[\[{]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const parts = readableStringsFromJson(parsed)
        .map((part) =>
          part
            .replace(/\r\n/g, "\n")
            .split("\n")
            .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
            .filter(Boolean)
            .join("\n"),
        )
        .filter(Boolean);
      const joined = parts.join(" · ").trim();
      if (!joined || /^[\[{]/.test(joined)) {
        return "";
      }
      return joined;
    } catch {
      // Not valid JSON — fall through and treat as prose when possible.
    }
    // Broken / technical JSON-looking blob with no extractable prose.
    if (/[{}\[\]"]/.test(trimmed) && !/[\u0590-\u05FFa-zA-Z]{3,}/.test(trimmed)) {
      return "";
    }
  }
  // Keep newlines so list preview can stop at the first line.
  return trimmed
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * First sentence (through `.`/`!`/`?`) or first line — whichever comes first.
 */
export function firstFilingPreviewChunk(text: string): {
  head: string;
  rest: string;
} {
  const source = text.replace(/\r\n/g, "\n");
  let sentenceEnd = -1;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch !== "." && ch !== "!" && ch !== "?") {
      continue;
    }
    const next = source[i + 1];
    if (next === undefined || /\s/.test(next)) {
      sentenceEnd = i;
      break;
    }
  }
  const nl = source.indexOf("\n");
  let endExclusive = source.length;
  if (sentenceEnd >= 0 && nl >= 0) {
    endExclusive = Math.min(sentenceEnd + 1, nl);
  } else if (sentenceEnd >= 0) {
    endExclusive = sentenceEnd + 1;
  } else if (nl >= 0) {
    endExclusive = nl;
  }
  // Preserve newlines in the kept head (multi-line previews); collapse only
  // horizontal runs. Rest is normalized for overflow detection.
  const head = source
    .slice(0, endExclusive)
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const rest = source.slice(endExclusive).replace(/\s+/g, " ").trim();
  return { head, rest };
}

/** Soft-cap cut preferring a word boundary near `max`. */
export function truncateListProse(
  text: string,
  max = LIST_ROW_PREVIEW_MAX_CHARS,
): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { text: "", truncated: false };
  }
  if (trimmed.length <= max) {
    return { text: trimmed, truncated: false };
  }
  const slice = trimmed.slice(0, max);
  const sp = slice.lastIndexOf(" ");
  const minKeep = Math.max(24, Math.floor(max * 0.5));
  const cut = sp >= minKeep ? slice.slice(0, sp) : slice;
  return { text: cut.trimEnd(), truncated: true };
}

/** @deprecated Use {@link truncateListProse}. */
export function truncateFilingPreviewAtWord(
  text: string,
  max = LIST_ROW_PREVIEW_MAX_CHARS,
): { text: string; truncated: boolean } {
  return truncateListProse(text, max);
}

/**
 * Deterministic list-detail preview from already-built original prose.
 * Shows a contiguous prefix of that text (sentence/line end preferred, else
 * word boundary near {@link LIST_ROW_PREVIEW_MAX_CHARS}). Appends `…` only when
 * that prefix is shorter than the source. `truncated` (for 📝) is true whenever
 * any remainder was omitted — never rewrites, paraphrases, or calls a model.
 */
export function formatTruncatedListDetail(
  detailText: string,
): { text: string; truncated: boolean } | null {
  const raw = detailText.trim();
  if (!raw) {
    return null;
  }
  const { head, rest } = firstFilingPreviewChunk(raw);
  if (!head) {
    return null;
  }
  const capped = truncateListProse(head);
  if (!capped.text) {
    return null;
  }
  const truncated = capped.truncated || rest.length > 0;
  return {
    text: truncated ? `${capped.text}…` : capped.text,
    truncated,
  };
}

/**
 * `📝` — the row has additional text that the list view does not show
 * (custom / filing detail overflow, shopping description). Not for title
 * truncation; files keep 📎.
 */
export function listDetailOverflowMark(truncated: boolean): string {
  return truncated ? " 📝" : "";
}

/** «body · description» for an opened item; body unchanged when there is none. */
function withItemDescription(body: string, description: string): string {
  return description ? `${body} · ${description}` : body;
}

/**
 * General item description on a custom row (`description`), separate from the
 * list's own columns. Only when the list declares its columns and none of
 * them is «description» — a user column of that name keeps its meaning, and
 * lists without declared columns treat every key as a column (as today).
 */
export function customItemGeneralDescription(
  item: Record<string, unknown>,
  columns?: unknown,
): string {
  const declared = Array.isArray(columns)
    ? columns
        .filter((col): col is string => typeof col === "string")
        .map((col) => col.trim().toLowerCase())
        .filter(Boolean)
    : [];
  if (declared.length === 0 || declared.includes("description")) {
    return "";
  }
  return readText(item, ["description"]);
}

/**
 * Shopping rows that carry something the list view does not show — a
 * description or a file. Only these earn a direct item tap (N1).
 */
export function shoppingRowsWithDetail(
  snapshot: Pick<EmployeeRecordSnapshot, "lists">,
): Set<string> {
  const ids = new Set<string>();
  for (const list of snapshot.lists ?? []) {
    if (list.list_type !== "shopping") {
      continue;
    }
    for (const item of list.items ?? []) {
      const row = item as Record<string, unknown>;
      const id = String(row.item_id ?? "").trim();
      if (id && (shoppingItemDescription(row) || hasAttachments(row))) {
        ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * Optional shopping item description (empty / whitespace → ""). Canonical key
 * `description`; older rows stored under «תיאור» are still read.
 */
export function shoppingItemDescription(item: Record<string, unknown>): string {
  return readText(item, ["description", "תיאור"]);
}

/**
 * List-only preview under the filing title from the original readable
 * `item_info` / find-helper (`item_description`) strings — truncated in code,
 * not summarized. Address filings skip coordinate `item_info` (📍 covers it).
 */
export function formatFilingListPreviewParts(
  item: Record<string, unknown>,
): { text: string; truncated: boolean } | null {
  const name = readText(item, ["item_name", "itemName"]);
  const info = readText(item, ["item_info", "itemInfo"]);
  const findHelper = readText(item, ["item_description", "itemDescription"]);
  const chunks: string[] = [];
  if (filingNameLooksLikeAddress(name)) {
    const helper = extractFilingReadableText(findHelper);
    if (helper) {
      chunks.push(helper);
    }
  } else {
    const readableInfo = extractFilingReadableText(info);
    const readableHelper = extractFilingReadableText(findHelper);
    if (readableInfo) {
      chunks.push(readableInfo);
    }
    if (readableHelper) {
      chunks.push(readableHelper);
    }
  }
  if (chunks.length === 0) {
    return null;
  }
  return formatTruncatedListDetail(chunks.join("\n"));
}

export function formatFilingListPreview(
  item: Record<string, unknown>,
): string | null {
  return formatFilingListPreviewParts(item)?.text ?? null;
}

/**
 * Inventory mark when filing detail preview overflowed (more text than shown).
 */
export function filingHiddenDetailMark(
  item: Record<string, unknown>,
  mode: "list" | "full",
): string {
  if (mode !== "list") {
    return "";
  }
  const parts = formatFilingListPreviewParts(item);
  return listDetailOverflowMark(Boolean(parts?.truncated));
}

/** True when the filing name encodes a place/address/location. */
export function filingNameLooksLikeAddress(name: string): boolean {
  return /כתובת|מגורים|address|מיקום|רחוב/i.test(name.trim());
}

/**
 * Address text from a filing row: prefer item_info, else item_name
 * when the name encodes a place (כתובת / מגורים / …).
 * Raw stored value — never written into list rows; Waze uses coordinates only
 * via {@link filingNavigateCoordinates}.
 */
export function filingDumpAddressText(
  row: EmployeeRecordSnapshot["filing"][number],
): string | null {
  const name = row.item_name?.trim() ?? "";
  const info = row.item_info?.trim() ?? "";
  if (!filingNameLooksLikeAddress(name)) {
    return null;
  }
  return info || name || null;
}

/**
 * Parse a bare `lat, lng` pair for Waze `navigate_address`.
 */
export function parseLatLngCoordinates(
  raw: string,
): { lat: number; lng: number } | null {
  const trimmed = raw.trim();
  const coord = trimmed.match(
    /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/,
  );
  if (!coord) {
    return null;
  }
  const lat = Number(coord[1]);
  const lng = Number(coord[2]);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return null;
  }
  return { lat, lng };
}

/** Waze target from finite WGS84 coords, or null. */
export function navigateTargetFromCoords(
  lat: number | null | undefined,
  lng: number | null | undefined,
): string | null {
  if (
    lat == null ||
    lng == null ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return null;
  }
  return `${lat},${lng}`;
}

/**
 * Allowlisted list-item address fields only (`כתובת` / `address`).
 * Prefer parseable lat,lng in those fields or numeric lat+lng on the row;
 * else non-empty street text from those fields. Never title/notes/other columns.
 */
export function navigateTargetFromListItem(
  item: Record<string, unknown>,
): string | null {
  const latRaw = item.lat ?? item.latitude;
  const lngRaw = item.lng ?? item.longitude;
  const latNum =
    typeof latRaw === "number"
      ? latRaw
      : typeof latRaw === "string"
        ? Number(latRaw)
        : NaN;
  const lngNum =
    typeof lngRaw === "number"
      ? lngRaw
      : typeof lngRaw === "string"
        ? Number(lngRaw)
        : NaN;
  const fromNumeric = navigateTargetFromCoords(latNum, lngNum);
  if (fromNumeric) {
    return fromNumeric;
  }
  for (const key of ["כתובת", "address"] as const) {
    const raw = item[key];
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const asCoords = parseLatLngCoordinates(trimmed);
    if (asCoords) {
      return `${asCoords.lat},${asCoords.lng}`;
    }
    return trimmed;
  }
  return null;
}

/**
 * Stored place value → Waze target: coords if parseable, else street text (`q=`).
 * No geocoding.
 */
export function navigateTargetFromStoredPlace(
  raw: string | null,
): string | null {
  if (!raw?.trim()) {
    return null;
  }
  const trimmed = raw.trim();
  const coords = parseLatLngCoordinates(trimmed);
  if (coords) {
    return `${coords.lat},${coords.lng}`;
  }
  return trimmed;
}

/**
 * Navigate target for a filing row: coords preferred, else street from
 * place-encoded filing address fields.
 */
export function filingNavigateCoordinates(
  row: EmployeeRecordSnapshot["filing"][number],
): string | null {
  return navigateTargetFromStoredPlace(filingDumpAddressText(row));
}

/**
 * Filing place mark (option A): always `📍` only — never coords / Maps URL
 * in list or ITEM DUMP text. Navigation is the separate Waze button.
 */
export function filingPlaceMark(
  item: Record<string, unknown>,
  _mode: "icons" | "full" = "icons",
): string {
  const name = readText(item, ["item_name", "itemName"]);
  if (!filingNameLooksLikeAddress(name)) {
    return "";
  }
  const info = readText(item, ["item_info", "itemInfo"]);
  const address = info || name;
  if (!address) {
    return "";
  }
  return " 📍";
}

/** Filings visible under section/partner (same set as the dump lines). */
export function visibleFilingsForDump(
  rows: EmployeeRecordSnapshot["filing"],
  opts?: ShowDumpOptions,
): EmployeeRecordSnapshot["filing"] {
  const viewer = (opts?.viewerName ?? "").trim();
  const aliases = (opts?.viewerAliases ?? []).map((name) => name.trim());
  const section = opts?.section ?? null;
  const partnerNeedles = dumpFilterNames(opts?.partner);
  const viewerNames = new Set(
    [viewer, ...aliases].map((name) => name.trim()).filter(Boolean),
  );
  const out: EmployeeRecordSnapshot["filing"] = [];
  for (const row of rows) {
    const partners = (row.shared_with ?? [])
      .map((name) => name.trim())
      .filter(Boolean)
      .filter((name) => !viewerNames.has(name));
    // Same as contacts: shared section only when a non-viewer partner remains.
    const isShared = row.scope === "shared" && partners.length > 0;
    if (isShared) {
      if (section === "personal") {
        continue;
      }
      if (
        partnerNeedles.length > 0 &&
        !partnerNeedles.some(
          (needle) =>
            partners.some((name) => name.includes(needle)) ||
            partners.join(", ").includes(needle),
        )
      ) {
        continue;
      }
      out.push(row);
    } else if (section !== "shared") {
      out.push(row);
    }
  }
  return out;
}

/**
 * Waze `navigate_address` for a filings dump.
 * - Inventory / filtered multi-row dumps → null (no Waze under the list).
 * - ITEM DUMP only, when exactly one focused row has coords or street address.
 */
export function navigateAddressFromFilingsDump(
  rows: EmployeeRecordSnapshot["filing"],
  opts?: ShowDumpOptions,
): string | null {
  const itemIds = opts?.itemIds ?? null;
  if (itemIds == null || itemIds.size === 0) {
    return null;
  }
  const visible = visibleFilingsForDump(rows, opts).filter((row) => {
    const id = String(row.filing_id ?? "").trim();
    return Boolean(id) && itemIds.has(id);
  });
  // Single-item detail only — never Waze under a multi-id dump.
  if (visible.length !== 1) {
    return null;
  }
  return filingNavigateCoordinates(visible[0]!);
}

/**
 * Waze for shopping/tasks/custom ITEM dump: exactly one row kept after the
 * same dump filters as the spoken body; target from allowlisted address
 * fields / coords only.
 */
export function navigateAddressFromListDump(
  kind: string,
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): string | null {
  const itemIds = opts?.itemIds ?? null;
  if (itemIds == null || itemIds.size === 0) {
    return null;
  }
  const resolved = resolveShowDumpKind(kind);
  if (!resolved || resolved.kind !== "list") {
    return null;
  }
  const name = normalizeShowDumpListName(resolved.name);
  const builtin = builtinListTypeFromHebrew(name);
  if (builtin === "shopping" || builtin === "tasks") {
    const lists = snapshot.lists.filter((list) => list.list_type === builtin);
    const collected = collectListDumpRows(builtin, lists, opts);
    const kept = filterDumpRows(collected, builtin, opts);
    if (kept.length !== 1) {
      return null;
    }
    return navigateTargetFromListItem(kept[0]!.item);
  }
  if (builtin === "contacts") {
    return null;
  }
  // Named custom list.
  const lists = snapshot.lists.filter(
    (list) =>
      list.list_type === "custom" &&
      normalizeShowDumpListName(list.list_name ?? "") === name,
  );
  if (lists.length === 0) {
    return null;
  }
  const collected = collectListDumpRows("custom", lists, opts);
  const kept = filterDumpRows(collected, "custom", opts);
  if (kept.length !== 1) {
    return null;
  }
  return navigateTargetFromListItem(kept[0]!.item);
}

/**
 * Filings dump — one header; co-share `(A, B)` and assign `(באחריות X · מאת Y)`
 * same as shopping/tasks.
 */
export function formatFilingsDump(
  rows: EmployeeRecordSnapshot["filing"],
  opts?: ShowDumpOptions,
): DumpTextResult {
  const viewer = (opts?.viewerName ?? "").trim();
  const aliases = (opts?.viewerAliases ?? []).map((name) => name.trim());
  const viewerNames = new Set(
    [viewer, ...aliases].map((name) => name.trim()).filter(Boolean),
  );
  const dumpMode: "list" | "full" =
    opts?.itemIds != null ? "full" : "list";
  const collected: DumpItem[] = rows.map((row) => {
    // Address filings: inventory = name only (📍 via formatNumberedItem).
    // ITEM DUMP (full): show readable street text from item_info; never raw lat,lng
    // (Waze still uses filingNavigateCoordinates / navigateAddressFromFilingsDump).
    const address = filingDumpAddressText(row);
    let title: string;
    if (address) {
      title = row.item_name?.trim() || "תיוק";
      if (dumpMode === "full") {
        const info = row.item_info?.trim() ?? "";
        if (info && !parseLatLngCoordinates(info)) {
          title += ` · ${info}`;
        }
        const findHelper = row.item_description?.trim() ?? "";
        if (findHelper) {
          title += ` · מידע לחיפוש: ${findHelper}`;
        }
      }
    } else {
      title = formatFilingDumpBody(row, dumpMode);
    }
    const assignedBy = (row.assigned_by ?? "").trim();
    const sharedWith = (row.shared_with ?? [])
      .map((name) => name.trim())
      .filter(Boolean);
    const partners = sharedWith.filter((name) => !viewerNames.has(name));
    if (assignedBy && partners.length === 0) {
      const owner = (row.owner ?? "").trim();
      const assignee = owner || viewer;
      const mark = formatAssignResponsibilityMark(assignee, assignedBy);
      return {
        title,
        item: row as unknown as Record<string, unknown>,
        isShared: true,
        partnerFilterKey: assignedBy,
        assigneeName: assignee || undefined,
        ...(mark ? { responsibilityMark: mark } : {}),
      };
    }
    const isShared = row.scope === "shared" && partners.length > 0;
    const allInvolved = isShared
      ? allInvolvedNames(sharedWith, viewer, aliases)
      : "";
    const partnerFilterKey = isShared
      ? partnersKey(sharedWith, viewer, aliases)
      : "";
    return {
      title,
      item: row as unknown as Record<string, unknown>,
      isShared,
      ...(partnerFilterKey ? { partnerFilterKey } : {}),
      ...(allInvolved ? { responsibilityMark: allInvolved } : {}),
    };
  });
  const kept = filterDumpRows(collected, "filings", opts);
  return formatSingleHeaderDump(
    withListEmoji(FILINGS_LIST_EMOJI, "תיוקים"),
    "filings",
    kept,
    opts,
  );
}

/** Full / standalone reminders section header (emoji + name). */
function remindersActiveDumpHeader(): string {
  return `${withListEmoji(REMINDERS_LIST_EMOJI, "תזכורות פעילות")}:`;
}

function formatRemindersDump(
  rows: ReminderSnapshotRow[],
  opts?: ShowDumpOptions,
  section?: string,
): DumpTextResult {
  const now = opts?.now ?? new Date();
  const itemIds = opts?.itemIds ?? null;
  const active = rows.filter((row) => {
    if (row.status !== "active") {
      return false;
    }
    if (itemIds) {
      const id = row.reminder_id?.trim() ?? "";
      if (!id || !itemIds.has(id)) {
        return false;
      }
    }
    return reminderMatchesDateRange(row, opts?.dateFrom, opts?.dateTo);
  });
  if (active.length === 0) {
    return emptyDumpResult();
  }
  const lines: LastNumberedDumpLine[] = [];
  const numbering = ensureDumpNumbering(opts);
  const text = active
    .map((row) => {
      const n = takeDumpLineNumber(numbering);
      const stem = row.item.trim() || "תזכורת";
      let title = stem;
      if (hasAttachments(row)) {
        title += " 📎";
      }
      const when = formatReminderWhen(row, now);
      const id = row.reminder_id?.trim() ?? "";
      if (id) {
        lines.push({
          n,
          id,
          kind: "reminders",
          title_stem: stem,
          ...(section ? { section } : {}),
        });
      }
      return when ? `${n}. ${title} — ${when}` : `${n}. ${title}`;
    })
    .join("\n");
  return { text, lines };
}

/**
 * YYYY-MM-DD from a date / datetime string.
 * Rejects impossible calendar days (e.g. 2025-02-29) via isValidCalendarYmd.
 */
export function ymdFromDumpValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    return null;
  }
  const ymd = match[1]!;
  return isValidCalendarYmd(ymd) ? ymd : null;
}

function ymdInInclusiveRange(
  ymd: string,
  from: string | null | undefined,
  to: string | null | undefined,
): boolean {
  if (from && ymd < from) {
    return false;
  }
  if (to && ymd > to) {
    return false;
  }
  return true;
}

/**
 * True when the task has at least one usable calendar day (span or
 * next_occurrences). Untimed rows have none — they drop out of dated dumps.
 */
export function itemHasDumpCalendarDate(item: Record<string, unknown>): boolean {
  const start = ymdFromDumpValue(item["תאריך לביצוע"] ?? item.date);
  if (start) {
    return true;
  }
  if (ymdFromDumpValue(item["תאריך סיום"])) {
    return true;
  }
  const next = item.next_occurrences;
  if (Array.isArray(next)) {
    for (const occ of next) {
      if (ymdFromDumpValue(occ)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Snapshot standing/recurring signal: withVisibility injects `next_occurrences`
 * whenever a recurrence rule exists (possibly `[]` when the dump window has no
 * hit). Empty array ≠ undated.
 */
export function itemHasDumpRecurrenceRule(
  item: Record<string, unknown>,
): boolean {
  return Array.isArray(item.next_occurrences);
}

/** True when a task has no calendar date and no recurrence (משימה כללית). */
export function isUndatedGeneralTask(item: Record<string, unknown>): boolean {
  return !itemHasDumpCalendarDate(item) && !itemHasDumpRecurrenceRule(item);
}

/** Concise Hebrew note when a dated dump excluded undated (general) tasks. */
export function formatUndatedTasksExcludedNote(count: number): string {
  if (count <= 0) {
    return "";
  }
  if (count === 1) {
    return "(שים לב: משימה כללית אחת לא נכללה בטווח.)";
  }
  return `(שים לב: ${count} משימות כלליות לא נכללו בטווח.)`;
}

function hasUndatedDateScope(opts?: ShowDumpOptions): boolean {
  return opts?.dateScope === "undated";
}

/** Undated scope clears from/to so day-agenda layout does not run. */
function withEffectiveDumpDateOpts(
  opts?: ShowDumpOptions,
): ShowDumpOptions | undefined {
  if (!opts || !hasUndatedDateScope(opts)) {
    return opts;
  }
  return { ...opts, dateFrom: null, dateTo: null };
}

function tasksDumpBareLabel(opts?: ShowDumpOptions): string {
  if (opts?.flatLayout) {
    return "מעקבים של לוסי";
  }
  if (hasUndatedDateScope(opts)) {
    return "משימות כלליות";
  }
  return "משימות";
}

/**
 * Tasks: keep when date span [תאריך לביצוע, תאריך סיום] or any
 * next_occurrences day intersects [from, to]. No date filter → keep all.
 * Untimed / undated rows drop out when a range is set.
 */
export function itemMatchesDateRange(
  item: Record<string, unknown>,
  dateFrom?: string | null,
  dateTo?: string | null,
): boolean {
  const from = dateFrom?.trim().slice(0, 10) || null;
  const to = dateTo?.trim().slice(0, 10) || null;
  if (!from && !to) {
    return true;
  }
  const start = ymdFromDumpValue(item["תאריך לביצוע"] ?? item.date);
  const end = ymdFromDumpValue(item["תאריך סיום"]) ?? start;
  if (start && end) {
    // [start, end] intersects [from, to] (inclusive; null bound = open).
    if ((!from || end >= from) && (!to || start <= to)) {
      return true;
    }
  }
  const next = item.next_occurrences;
  if (Array.isArray(next)) {
    for (const occ of next) {
      const ymd = ymdFromDumpValue(occ);
      if (ymd && ymdInInclusiveRange(ymd, from, to)) {
        return true;
      }
    }
  }
  return false;
}

/** Reminders: filter by fire_at calendar day when a dump date range is set. */
export function reminderMatchesDateRange(
  row: Pick<ReminderSnapshotRow, "fire_at" | "next_occurrences">,
  dateFrom?: string | null,
  dateTo?: string | null,
): boolean {
  const from = dateFrom?.trim().slice(0, 10) || null;
  const to = dateTo?.trim().slice(0, 10) || null;
  if (!from && !to) {
    return true;
  }
  const ymd = ymdFromDumpValue(row.fire_at);
  if (ymd && ymdInInclusiveRange(ymd, from, to)) {
    return true;
  }
  const next = row.next_occurrences;
  if (Array.isArray(next)) {
    for (const occ of next) {
      const occYmd = ymdFromDumpValue(occ);
      if (occYmd && ymdInInclusiveRange(occYmd, from, to)) {
        return true;
      }
    }
  }
  return false;
}

function hasDumpDateRange(opts?: ShowDumpOptions): boolean {
  return Boolean(opts?.dateFrom?.trim() || opts?.dateTo?.trim());
}

type AgendaSlot = {
  ymd: string;
  /** Sort key HH:mm or empty for all-day. */
  sortHm: string;
  id: string;
  kind: "tasks" | "reminders";
  title_stem: string;
  /** Fully formatted numbered line (number filled when emitting). */
  formatLine: (n: number) => string;
};

/**
 * Day-agenda layout for tasks dumps with show_dump_from/to.
 * Expands next_occurrences into day buckets; each row uses the shared standing/ping mark.
 * Unlinked clocks in range appear as their own lines; linked clocks stay folded into the task.
 */
export function formatTasksDayAgendaDump(
  rows: Array<{
    title: string;
    item: Record<string, unknown>;
    responsibilityMark?: string;
  }>,
  reminders: ReminderSnapshotRow[],
  opts?: ShowDumpOptions,
  /** reminder_ids already folded into a task line — never list again. */
  linkedReminderIds: Set<string> = new Set(),
  /**
   * List name + emoji (e.g. «✅ משימות») above day headers — required for every
   * date / semantic cut so the dump still names its source list.
   */
  listHeader?: string,
): DumpTextResult {
  const from = opts?.dateFrom?.trim().slice(0, 10) || null;
  const to = opts?.dateTo?.trim().slice(0, 10) || null;
  const now = opts?.now ?? new Date();
  const slots: AgendaSlot[] = [];
  // Same rule as clocks: mashov/market/… watches are the digital worker's job.
  // Their standing worker task still carries interval next_occurrences (every
  // 5–60m) — without this skip, one Friday button prints the same line ~24–288×.
  const watchReminderIds = conditionalWatchReminderIds(reminders);

  for (const row of rows) {
    const linkedId = reminderIdFromTaskItem(row.item);
    if (linkedId && watchReminderIds.has(linkedId)) {
      continue;
    }
    slots.push(...expandTaskAgendaSlots(row, from, to, now, opts?.itemIds));
  }

  const partnerNeedles = dumpFilterNames(opts?.partner);
  const partnerOnly =
    Boolean(opts?.section === "shared") || partnerNeedles.length > 0;

  for (const rem of reminders) {
    if (rem.status !== "active") {
      continue;
    }
    if (linkedReminderIds.has(rem.reminder_id)) {
      continue;
    }
    // Conditional watches (compose_condition) are the digital worker's job —
    // ping=speaker makes them visible in the snapshot, but they must not flood
    // the speaker's day agenda (hourly expansion etc.). Inventory / about=worker.
    if (isConditionalWatchReminder(rem)) {
      continue;
    }
    // Speaker personal agenda: hide digital-worker-owned or worker-linked clocks.
    // Worker inventory (flatLayout) keeps them. Speaker tasks stay untouched.
    if (
      opts?.flatLayout !== true &&
      isDigitalWorkerReminderAgendaSlot(rem)
    ) {
      continue;
    }
    if (partnerOnly) {
      // Partner day-agenda: only clocks that ping the partner.
      if (!reminderInvolvesPartner(rem, partnerNeedles, new Set())) {
        continue;
      }
    }
    slots.push(...expandReminderAgendaSlots(rem, from, to, now));
  }

  const undatedRows = rows.filter((row) => isUndatedGeneralTask(row.item));
  if (slots.length === 0 && undatedRows.length === 0) {
    return emptyDumpResult();
  }

  slots.sort((a, b) => {
    if (a.ymd !== b.ymd) {
      return a.ymd.localeCompare(b.ymd);
    }
    if (a.sortHm !== b.sortHm) {
      if (!a.sortHm) {
        return 1;
      }
      if (!b.sortHm) {
        return -1;
      }
      return a.sortHm.localeCompare(b.sortHm);
    }
    return 0;
  });

  const byDay = new Map<string, AgendaSlot[]>();
  for (const slot of slots) {
    const bucket = byDay.get(slot.ymd) ?? [];
    bucket.push(slot);
    byDay.set(slot.ymd, bucket);
  }

  const textLines: string[] = [];
  const mapLines: LastNumberedDumpLine[] = [];
  const numbering = ensureDumpNumbering(opts);
  const dayKeys = [...byDay.keys()].sort();
  const headerLine = formatDumpListHeaderLine(listHeader);
  if (headerLine) {
    textLines.push(headerLine);
  }
  if (from && to && from !== to && dayKeys.length > 0) {
    textLines.push(formatAgendaWindowHeader(from, to));
    textLines.push("");
  }
  for (const ymd of dayKeys) {
    const daySlots = byDay.get(ymd) ?? [];
    textLines.push(formatDayAgendaHeader(ymd));
    for (const slot of daySlots) {
      const n = takeDumpLineNumber(numbering);
      textLines.push(slot.formatLine(n));
      if (slot.id) {
        mapLines.push({
          n,
          id: slot.id,
          kind: slot.kind,
          title_stem: slot.title_stem,
          section: ymd,
        });
      }
    }
    textLines.push("");
  }
  if (undatedRows.length > 0) {
    textLines.push("משימות כלליות:");
    for (const row of undatedRows) {
      const n = takeDumpLineNumber(numbering);
      const id = String(row.item.item_id ?? "").trim();
      const stem = row.title.trim() || "משימה";
      textLines.push(
        formatNumberedItem(n, row.title, row.item, "tasks", {
          responsibilityMark: row.responsibilityMark,
          now,
          itemIds: opts?.itemIds,
        }),
      );
      if (id) {
        mapLines.push({
          n,
          id,
          kind: "tasks",
          title_stem: stem,
          section: "undated",
        });
      }
    }
  }
  return { text: textLines.join("\n").trim(), lines: mapLines };
}

/** Ensure dump list headers end with «:» (emoji + name already applied). */
function formatDumpListHeaderLine(listHeader?: string): string {
  const trimmed = listHeader?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith(":") ? trimmed : `${trimmed}:`;
}

function expandTaskAgendaSlots(
  row: {
    title: string;
    item: Record<string, unknown>;
    responsibilityMark?: string;
  },
  from: string | null,
  to: string | null,
  now: Date,
  itemIds?: ReadonlySet<string> | null,
): AgendaSlot[] {
  const item = row.item;
  const recurring = readText(item, ["חוזר", "recurrence_text"]);
  const next = item.next_occurrences;
  if (recurring && Array.isArray(next) && next.length > 0) {
    const slots: AgendaSlot[] = [];
    // One slot per calendar day — interval polls (כל 5 דקות / כל שעה) must not
    // mint a numbered line for every fire time on that day.
    const seenDays = new Set<string>();
    for (const occ of next) {
      const ymd = ymdFromDumpValue(occ);
      if (!ymd || !ymdInInclusiveRange(ymd, from, to)) {
        continue;
      }
      if (seenDays.has(ymd)) {
        continue;
      }
      seenDays.add(ymd);
      // Prefer this day's slot HM (already exception-applied in next_occurrences)
      // over the series חוזר clock so moved occurrences display correctly.
      const hm =
        hmFromDumpValue(occ) || extractHmFromText(recurring) || "";
      const stem = row.title.trim() || "משימה";
      const id = String(item.item_id ?? "").trim();
      slots.push({
        ymd,
        sortHm: hm,
        id,
        kind: "tasks",
        title_stem: stem,
        formatLine: (n) =>
          formatAgendaStandingLine(n, row.title, item, hm, {
            responsibilityMark: row.responsibilityMark,
            now,
            occurrenceYmd: ymd,
            itemIds,
          }),
      });
    }
    return slots;
  }

  const start = ymdFromDumpValue(item["תאריך לביצוע"] ?? item.date);
  const end = ymdFromDumpValue(item["תאריך סיום"]) ?? start;
  if (!start) {
    return [];
  }
  const time = readText(item, ["שעה לביצוע", "time", "שעה"]);
  const hm = time ? normalizeHm(time) : "";
  // Multi-day span: one slot on the first day that intersects the window.
  const ymd =
    from && start < from && end && end >= from
      ? from
      : start;
  if (!ymdInInclusiveRange(ymd, from, to)) {
    return [];
  }
  const oneOffStem = row.title.trim() || "משימה";
  const oneOffId = String(item.item_id ?? "").trim();
  return [
    {
      ymd,
      sortHm: hm,
      id: oneOffId,
      kind: "tasks",
      title_stem: oneOffStem,
      formatLine: (n) =>
        formatAgendaOneOffLine(n, row.title, item, hm, {
          responsibilityMark: row.responsibilityMark,
          now,
          itemIds,
        }),
    },
  ];
}

function expandReminderAgendaSlots(
  row: ReminderSnapshotRow,
  from: string | null,
  to: string | null,
  now: Date,
): AgendaSlot[] {
  const next = row.next_occurrences;
  if (Array.isArray(next) && next.length > 0) {
    const slots: AgendaSlot[] = [];
    // One clock line per day (interval series otherwise floods the agenda).
    const seenDays = new Set<string>();
    const seriesHm =
      extractHmFromText(row.recurrence_text ?? "") ??
      hmFromDumpValue(row.fire_at) ??
      "";
    for (const occ of next) {
      const ymd = ymdFromDumpValue(occ);
      if (!ymd || !ymdInInclusiveRange(ymd, from, to)) {
        continue;
      }
      if (seenDays.has(ymd)) {
        continue;
      }
      seenDays.add(ymd);
      const hm = seriesHm || hmFromDumpValue(occ) || "";
      const stem = row.item.trim() || "תזכורת";
      slots.push({
        ymd,
        sortHm: hm,
        id: row.reminder_id?.trim() ?? "",
        kind: "reminders",
        title_stem: stem,
        formatLine: (n) => formatAgendaReminderLine(n, row, hm, now),
      });
    }
    if (slots.length > 0) {
      return slots;
    }
  }
  const ymd = ymdFromDumpValue(row.fire_at);
  if (!ymd || !ymdInInclusiveRange(ymd, from, to)) {
    return [];
  }
  const hm = hmFromDumpValue(row.fire_at) ?? "";
  const stem = row.item.trim() || "תזכורת";
  return [
    {
      ymd,
      sortHm: hm,
      id: row.reminder_id?.trim() ?? "",
      kind: "reminders",
      title_stem: stem,
      formatLine: (n) => formatAgendaReminderLine(n, row, hm, now),
    },
  ];
}

/** HH:mm from «YYYY-MM-DD HH:mm» / ISO-ish dump values. */
function hmFromDumpValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(/(?:^|\s)(\d{1,2}:\d{2})(?:\s|$)/);
  return match ? normalizeHm(match[1]) : null;
}

/** «ראשון 18.10:» */
export function formatDayAgendaHeader(ymd: string): string {
  const weekday = hebrewWeekdayFromYmd(ymd.trim().slice(0, 10));
  const short = formatShortDayMonth(ymd);
  return weekday ? `${weekday} ${short}:` : `${short}:`;
}

/** «מה־18 עד 24.10:» / «מה־28.9 עד 4.10:» */
export function formatAgendaWindowHeader(from: string, to: string): string {
  const fromParts = parseYmdParts(from);
  const toParts = parseYmdParts(to);
  if (!fromParts || !toParts) {
    return `מה־${from} עד ${to}:`;
  }
  if (fromParts.month === toParts.month && fromParts.year === toParts.year) {
    return `מה־${fromParts.day} עד ${toParts.day}.${toParts.month}:`;
  }
  return `מה־${fromParts.day}.${fromParts.month} עד ${toParts.day}.${toParts.month}:`;
}

function parseYmdParts(
  ymd: string,
): { year: number; month: number; day: number } | null {
  const match = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function formatShortDayMonth(ymd: string): string {
  const parts = parseYmdParts(ymd);
  if (!parts) {
    return ymd.trim();
  }
  return `${parts.day}.${parts.month}`;
}

/**
 * list = inventory/agenda rows; detail = ITEM DUMP.
 * Both modes show `🔔 תזכורת: <when>` when a when-string is known; bare `🔔`
 * only when a linked reminder exists but no displayable when.
 */
export type ReminderDisplayMode = "list" | "detail";

export function reminderDisplayMode(
  itemIds?: ReadonlySet<string> | null,
): ReminderDisplayMode {
  return itemIds != null ? "detail" : "list";
}

/**
 * Standing occurrence under a day header.
 * When `occurrenceYmd` is set: occurrence-effective chore time + reminder for
 * that exact day (reminder exceptions only — never task exceptions).
 * Without it: series overview suffix (`formatScheduleSuffix`) for flat dumps.
 * Reminder mark uses linked reminder when-text in both list and detail modes.
 */
export function formatAgendaStandingLine(
  n: number,
  title: string,
  item: Record<string, unknown>,
  occurrenceHm: string,
  opts?: {
    responsibilityMark?: string;
    now?: Date;
    /** When set, render this day's effective schedule — not the series overview. */
    occurrenceYmd?: string;
    /** ITEM DUMP filter — when set, reminder mark includes the effective time. */
    itemIds?: ReadonlySet<string> | null;
  },
): string {
  let body = title.trim() || "פריט";
  if (hasAttachments(item)) {
    body += " 📎";
  }
  if (hasLinkedLists(item)) {
    body += " 🗂️";
  }
  body += taskPlacePhoneMarks(item, "icons");
  if (opts?.responsibilityMark?.trim()) {
    const mark = opts.responsibilityMark.trim();
    if (!titleAlreadyListsPartners(body, mark)) {
      body += ` (${mark})`;
    }
  }
  const mode = reminderDisplayMode(opts?.itemIds);
  const occurrenceYmd = opts?.occurrenceYmd?.trim().slice(0, 10) ?? "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(occurrenceYmd)) {
    const hm = occurrenceHm.trim();
    if (hm) {
      body += ` — ${normalizeHm(hm)}`;
    }
    const reminder = formatOccurrenceEffectiveReminderParen(
      item,
      occurrenceYmd,
      mode,
    );
    if (reminder) {
      body += ` ${reminder}`;
    }
    return wrapUrgencyLine(`${n}. ${body}`, item.urgency);
  }
  const suffix = formatScheduleSuffix(
    item,
    "tasks",
    opts?.now ?? new Date(),
  );
  if (suffix) {
    body += ` ${suffix}`;
  }
  const reminder = formatReminderIndicator(item, mode, {
    now: opts?.now,
  });
  if (reminder) {
    body += ` ${reminder}`;
  }
  return wrapUrgencyLine(`${n}. ${body}`, item.urgency);
}

/**
 * Linked reminder mark for one occurrence day.
 * - Recurring series clock: series HM + that clock's `exception_entries` only
 *   (never task exceptions). Cancelled → empty (no series fallback / no bell).
 * - One-shot linked clock (no series-level reminder): only the fire_at day.
 * - Both modes → `🔔 תזכורת: HH:mm` when effective HM is known; else `🔔`.
 */
export function formatOccurrenceEffectiveReminderParen(
  item: Record<string, unknown>,
  occurrenceYmd: string,
  mode: ReminderDisplayMode = "list",
): string {
  if (!itemHasLinkedReminder(item)) {
    return "";
  }
  const ymd = occurrenceYmd.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    return "";
  }
  // Soft-linked one-shot: reminder exists only for that fire day — not every occurrence.
  if (!linkedReminderIsRecurring(item)) {
    const fireYmd = linkedReminderYmd(item);
    if (!fireYmd || fireYmd !== ymd) {
      return "";
    }
    const hm = linkedReminderSeriesHm(item);
    return formatReminderMarkText(mode, hm);
  }
  const raw = item.reminder as Record<string, unknown>;
  // Snapshot contract: Hebrew exception labels without structured entries mean
  // we cannot resolve per-day overrides safely — omit rather than false inherit.
  if (!reminderExceptionEntriesContractOk(raw)) {
    return "";
  }
  const seriesHm = linkedReminderSeriesHm(item);
  const entries = readExceptionEntries(raw.exception_entries);
  const effective = resolveEffectiveOccurrenceReminder({
    occurrenceYmd: ymd,
    seriesHm,
    exceptionEntries: entries,
  });
  if (effective.status === "cancelled" || effective.status === "none") {
    return "";
  }
  return formatReminderMarkText(mode, effective.hm);
}

/** `🔔 תזכורת: <when>` when when is known; bare `🔔` otherwise (list + detail). */
function formatReminderMarkText(
  _mode: ReminderDisplayMode,
  when: string | null | undefined,
): string {
  const text = typeof when === "string" ? when.trim() : "";
  return text ? `🔔 תזכורת: ${text}` : "🔔";
}

/**
 * Live snapshots emit Hebrew `exceptions` together with `exception_entries`.
 * Labels alone (stale / hand-built) must not drive inherit-as-series display.
 */
function reminderExceptionEntriesContractOk(
  reminder: Record<string, unknown>,
): boolean {
  const hebrew = Array.isArray(reminder.exceptions)
    ? reminder.exceptions.filter(
        (row): row is string => typeof row === "string" && row.trim().length > 0,
      )
    : [];
  if (hebrew.length === 0) {
    return true;
  }
  return readExceptionEntries(reminder.exception_entries).length > 0;
}

function readExceptionEntries(value: unknown): RecurrenceException[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: RecurrenceException[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const rec = row as Record<string, unknown>;
    const date =
      typeof rec.date === "string" ? rec.date.trim().slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      continue;
    }
    if (rec.cancel === true) {
      out.push({ date, cancel: true });
      continue;
    }
    const time = typeof rec.time === "string" ? rec.time.trim() : "";
    if (/^\d{1,2}:\d{2}$/.test(time)) {
      const [h, m] = time.split(":");
      out.push({
        date,
        time: `${String(Number(h)).padStart(2, "0")}:${m}`,
      });
    }
  }
  return out;
}

/** One-off under a day header: chore HM + optional reminder mark (list 🔔 / detail timed). */
export function formatAgendaOneOffLine(
  n: number,
  title: string,
  item: Record<string, unknown>,
  occurrenceHm: string,
  opts?: {
    responsibilityMark?: string;
    now?: Date;
    itemIds?: ReadonlySet<string> | null;
  },
): string {
  let body = title.trim() || "פריט";
  if (hasAttachments(item)) {
    body += " 📎";
  }
  if (hasLinkedLists(item)) {
    body += " 🗂️";
  }
  body += taskPlacePhoneMarks(item, "icons");
  if (opts?.responsibilityMark?.trim()) {
    const mark = opts.responsibilityMark.trim();
    if (!titleAlreadyListsPartners(body, mark)) {
      body += ` (${mark})`;
    }
  }
  const hm = occurrenceHm.trim();
  if (hm) {
    body += ` — ${hm}`;
  }
  const reminder = formatReminderIndicator(
    item,
    reminderDisplayMode(opts?.itemIds),
    { now: opts?.now },
  );
  if (reminder) {
    body += ` ${reminder}`;
  }
  return wrapUrgencyLine(`${n}. ${body}`, item.urgency);
}

/** Clock-only agenda line: «1. title — 09:00 (קבוע כל יום)». */
export function formatAgendaReminderLine(
  n: number,
  row: ReminderSnapshotRow,
  occurrenceHm: string,
  now = new Date(),
): string {
  let title = row.item.trim() || "תזכורת";
  if (hasAttachments(row)) {
    title += " 📎";
  }
  const hm = occurrenceHm.trim() || hmFromDumpValue(row.fire_at) || "";
  const hasExceptions = exceptionLabels(row.exceptions).length > 0;
  const cadence = standingCadenceParen(
    shortCadenceParen(row.recurrence_text, row.repeat, {
      keepSeriesClock: hasExceptions,
    }),
  );
  let body = title;
  if (hm) {
    body += ` — ${hm}`;
  } else {
    const relative = formatRelativeFireAt(row.fire_at, now);
    if (relative) {
      body += ` — ${relative}`;
    }
  }
  if (cadence) {
    body += ` ${cadence}`;
  }
  const extras = formatExceptionsSuffix(row.exceptions);
  return `${n}. ${body}${extras}`;
}

function wrapUrgencyLine(line: string, urgency: unknown): string {
  if (urgency === "urgent" || urgency === "very_urgent") {
    let out = `«${line}»`;
    if (urgency === "very_urgent") {
      out += " ‼️";
    }
    return out;
  }
  return line;
}

/**
 * Next fire + optional short cadence: «היום ב־19:00 (קבוע כל יום)» / «8.5.2027 ב־13:00 (קבוע כל שנה)».
 * One-off moves/cancels always append ` · 18.10 ב־21:30` from snapshot `exceptions`
 * (even when that day is already the primary `fire_at`) so standing + exception stay visible.
 * Cadence paren is labeled «קבוע …» so the series rule is not read as the next-fire time.
 * `flatCadence`: linked-task `(תזכורת: …)` uses « · קבוע כל יום» (no nested paren).
 */
export function formatReminderWhen(
  row: Pick<
    ReminderSnapshotRow,
    "fire_at" | "repeat" | "recurrence_text" | "exceptions"
  >,
  now = new Date(),
  opts?: { flatCadence?: boolean },
): string {
  const fireAt = row.fire_at?.trim() || "";
  const hasExceptions = exceptionLabels(row.exceptions).length > 0;
  const cadence = standingCadenceParen(
    shortCadenceParen(row.recurrence_text, row.repeat, {
      keepSeriesClock: hasExceptions,
    }),
  );
  const extras = formatExceptionsSuffix(row.exceptions);
  if (!fireAt) {
    const base = cadence.replace(/^\(|\)$/g, "");
    return base ? `${base}${extras}` : extras.replace(/^\s*·\s*/, "");
  }
  const relative = formatRelativeFireAt(fireAt, now);
  let when = relative;
  if (cadence) {
    if (opts?.flatCadence) {
      const flat = cadence.replace(/^\(|\)$/g, "").trim();
      when = flat ? `${relative} · ${flat}` : relative;
    } else {
      when = `${relative} ${cadence}`;
    }
  }
  return `${when}${extras}`;
}

/** «(כל יום)» → «(קבוע כל יום)» so reminder dumps name the standing rule. */
export function standingCadenceParen(cadence: string): string {
  const trimmed = cadence.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    return trimmed;
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner || inner.startsWith("קבוע")) {
    return trimmed;
  }
  return `(קבוע ${inner})`;
}

/** « · 18.10 ב־21:30» / « · 23.10 בוטל» from snapshot exception labels. */
export function formatExceptionsSuffix(exceptions: unknown): string {
  const labels = exceptionLabels(exceptions);
  return labels.length ? ` · ${labels.join(" · ")}` : "";
}

function exceptionLabels(exceptions: unknown): string[] {
  if (!Array.isArray(exceptions) || exceptions.length === 0) {
    return [];
  }
  return exceptions
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * «(כל יום)» / «(כל שנה)» from recurrence_text — strips time, calendar clause, until, count.
 * With keepSeriesClock (when exceptions exist): keep « ב־HH:mm» so the series time
 * stays visible next to a moved fire_at.
 */
export function shortCadenceParen(
  recurrenceText?: string | null,
  repeat?: string | null,
  options?: { keepSeriesClock?: boolean },
): string {
  let base = (recurrenceText ?? "").trim();
  if (!base) {
    const r = (repeat ?? "").trim().toLowerCase();
    if (r === "daily") {
      return "(כל יום)";
    }
    if (r === "weekly") {
      return "(כל שבוע)";
    }
    if (r === "monthly") {
      return "(כל חודש)";
    }
    if (r === "hourly") {
      return "(כל שעה)";
    }
    return "";
  }
  if (!options?.keepSeriesClock) {
    // Drop trailing clock « ב־19:00» / range « ב־19:00–20:00».
    base = base.replace(/\s+ב־\d{1,2}:\d{2}(?:–\d{1,2}:\d{2})?/g, "");
  }
  // Drop yearly calendar « ב־8 במאי» / « ב־12 באוקטובר».
  base = base.replace(/\s+ב־\d{1,2}\s+ב[\u0590-\u05FF]+/g, "");
  // Drop until / count tail.
  base = base.replace(/\s+עד\s+\S+/g, "");
  base = base.replace(/\s+\(\d+\s+פעמים\)/g, "");
  base = base.trim();
  return base ? `(${base})` : "";
}

function formatListDump(
  rawName: string,
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): { text: string | null; lines: LastNumberedDumpLine[] } {
  const name = normalizeShowDumpListName(rawName);
  const builtin = builtinListTypeFromHebrew(name);
  const omitEmpty = opts?.omitEmptySentence === true;
  if (builtin === "shopping" || builtin === "tasks") {
    const bareLabel =
      builtin === "tasks"
        ? tasksDumpBareLabel(opts)
        : builtinListHebrew(builtin);
    const effective = withEffectiveDumpDateOpts(opts);
    const body = formatThreeWayDump(builtin, bareLabel, snapshot, effective);
    if (body.text) {
      return body;
    }
    if (omitEmpty) {
      return emptyDumpResult("");
    }
    if (builtin === "tasks" && hasDumpDateRange(effective)) {
      return emptyDumpResult("אין משימות בטווח התאריכים.");
    }
    return emptyDumpResult(emptyListDumpSentence(bareLabel, effective));
  }
  if (builtin === "contacts") {
    // Contacts v2: list-name path redirects to canonical phone_book dump.
    const body = formatPhoneBookDump(opts?.phoneBook, opts);
    if (body.text) {
      return body;
    }
    return emptyDumpResult(omitEmpty ? "" : emptyContactsSentence(opts));
  }
  const customBody = formatContactsOrCustomDump(
    "custom",
    name,
    snapshot,
    name,
    opts,
  );
  if (customBody === null) {
    return { text: null, lines: [] };
  }
  if (customBody.text) {
    return customBody;
  }
  if (omitEmpty) {
    return emptyDumpResult("");
  }
  return emptyDumpResult(emptyCustomListSentence(name, snapshot, opts));
}

type DumpItem = {
  title: string;
  item: Record<string, unknown>;
  /**
   * Mark body (no parens): co-share «מיכל, טל»; assign «באחריות מיכל · מאת טל».
   */
  responsibilityMark?: string;
  /** List-level 📎 for this row's source list. */
  listFiles?: boolean;
  /** Effective emoji of the source EmployeeList (for header reuse on filters). */
  listEmoji?: string;
  /** True when row is assign / co-share / shared list / shared_items. */
  isShared?: boolean;
  /**
   * Whole-list share of this row's source shell (scope=shared): all involved
   * «עמית, טל». Rendering only — header mark when every row shares it, else
   * the row's mark. Never used by section/partner/assignee filters.
   */
  shellShareMark?: string;
  /** Partner filter key (assigner, co-share partners, list owner, …). */
  partnerFilterKey?: string;
  /** Sole assignee when this is an assign row (for באחריות filter). */
  assigneeName?: string;
  /**
   * Custom lists: short title_field value for LAST_NUMBERED_DUMP stem when
   * ITEM DUMP title is the full multi-column body.
   */
  titleStem?: string;
  /**
   * Inventory-only raw detail prose (custom non-title columns). Truncated in
   * {@link formatNumberedItem}; ITEM DUMP leaves this unset.
   */
  listDetailText?: string;
  /** Custom row has a general `description` (list view shows 📝 only). */
  hasDescription?: boolean;
};

type ListDumpType =
  | "shopping"
  | "tasks"
  | "contacts"
  | "custom"
  | "filings"
  | "phone_book";

/** Assign / באחריות row (sole responsibility) — not multi-party co-share. */
export function isAssignDumpRow(row: DumpItem): boolean {
  const mark = row.responsibilityMark?.trim() ?? "";
  return Boolean(row.assigneeName?.trim()) || mark.startsWith("באחריות");
}

/** Co-share / whole-list shared row (not assign). */
export function isCoShareDumpRow(row: DumpItem): boolean {
  return row.isShared === true && !isAssignDumpRow(row);
}

/** 0 = personal, 1 = co-share / whole shared list, 2 = assign. */
function dumpItemKindRank(row: DumpItem): number {
  if (isAssignDumpRow(row)) {
    return 2;
  }
  if (row.isShared === true) {
    return 1;
  }
  return 0;
}

/** Stable cluster: personal → co-share → assign (one header, no sub-blocks). */
export function clusterDumpRowsByKind<T extends DumpItem>(rows: T[]): T[] {
  return [...rows]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const delta = dumpItemKindRank(a.row) - dumpItemKindRank(b.row);
      return delta !== 0 ? delta : a.index - b.index;
    })
    .map(({ row }) => row);
}

/**
 * Row mark for shopping/tasks (assign vs co-share). Worker flatLayout skips marks.
 */
function resolveShoppingTasksRowMeta(
  list: EmployeeRecordSnapshot["lists"][number],
  item: Record<string, unknown>,
  title: string,
  viewer: string,
  aliases: string[],
  skipMarks: boolean,
): Pick<
  DumpItem,
  "responsibilityMark" | "isShared" | "partnerFilterKey" | "assigneeName"
> {
  if (skipMarks) {
    return { isShared: false };
  }
  if (list.scope === "shared") {
    return {
      isShared: true,
      partnerFilterKey: partnersKey(list.shared_with ?? [], viewer, aliases),
    };
  }
  if (list.scope === "shared_items") {
    const owner = (list.owner ?? "").trim() || "משותף";
    const sharedWith = stringArray(item.shared_with);
    if (sharedWith.length > 0) {
      const allInvolved = allInvolvedNames(sharedWith, viewer, aliases);
      const showMark =
        Boolean(allInvolved) && !titleAlreadyListsPartners(title, allInvolved);
      return {
        isShared: true,
        partnerFilterKey: partnersKey(sharedWith, viewer, aliases),
        ...(showMark ? { responsibilityMark: allInvolved } : {}),
      };
    }
    const assignedBy =
      typeof item.assigned_by === "string" ? item.assigned_by.trim() : "";
    const assigner = assignedBy || viewer;
    const mark = formatAssignResponsibilityMark(owner, assigner);
    return {
      isShared: true,
      partnerFilterKey: owner,
      assigneeName: owner,
      ...(mark ? { responsibilityMark: mark } : {}),
    };
  }
  const assignedBy =
    typeof item.assigned_by === "string" ? item.assigned_by.trim() : "";
  if (assignedBy) {
    const assignee =
      (list.owner ?? "").trim() ||
      viewer ||
      (aliases.map((name) => name.trim()).find(Boolean) ?? "");
    const mark = formatAssignResponsibilityMark(assignee, assignedBy);
    return {
      isShared: true,
      partnerFilterKey: assignedBy,
      assigneeName: assignee || undefined,
      ...(mark ? { responsibilityMark: mark } : {}),
    };
  }
  const sharedWith = stringArray(item.shared_with);
  if (sharedWith.length > 0) {
    const allInvolved = allInvolvedNames(sharedWith, viewer, aliases);
    const showMark =
      Boolean(allInvolved) && !titleAlreadyListsPartners(title, allInvolved);
    return {
      isShared: true,
      partnerFilterKey: partnersKey(sharedWith, viewer, aliases),
      ...(showMark ? { responsibilityMark: allInvolved } : {}),
    };
  }
  return { isShared: false };
}

function collectListDumpRows(
  listType: ListDumpType,
  lists: EmployeeRecordSnapshot["lists"],
  opts?: ShowDumpOptions,
): DumpItem[] {
  const viewer = opts?.viewerName?.trim() ?? "";
  const aliases = (opts?.viewerAliases ?? []).map((name) => name.trim());
  const skipMarks = opts?.flatLayout === true && (listType === "shopping" || listType === "tasks");
  const rows: DumpItem[] = [];

  const itemDump = opts?.itemIds != null;
  for (const list of lists) {
    const listFiles = listHasListLevelFiles(list);
    const listEmoji = listDumpEmoji(list);
    const shellMark =
      !skipMarks && list.scope === "shared"
        ? shellShareNames(list.shared_with ?? [], viewer, aliases)
        : "";
    const shellShare = shellMark.trim() ? { shellShareMark: shellMark } : {};
    for (const item of list.items) {
      if (listType === "custom") {
        const titleField = resolveCustomTitleField(
          item,
          list.title_field,
          list.columns,
        );
        const nameTitle = itemTitle("custom", item, titleField);
        const description = customItemGeneralDescription(item, list.columns);
        const title = itemDump
          ? withItemDescription(
              formatCustomItemBody(item, list.title_field, list.columns),
              description,
            )
          : nameTitle;
        const mark = customItemCoShareMark(list, item, viewer, aliases);
        const isShared =
          list.scope === "shared" ||
          list.scope === "shared_items" ||
          Boolean(mark);
        const partnerFilterKey = mark
          ? partnersKey(
              stringArray(item.shared_with).length > 0
                ? stringArray(item.shared_with)
                : [(list.owner ?? "").trim()].filter(Boolean),
              viewer,
              aliases,
            )
          : list.scope === "shared"
            ? partnersKey(list.shared_with ?? [], viewer, aliases)
            : "";
        const listDetailText = itemDump
          ? undefined
          : formatCustomListDetailText(item, titleField, list.columns);
        rows.push({
          title,
          item,
          listFiles,
          listEmoji,
          isShared,
          ...shellShare,
          titleStem: nameTitle,
          ...(listDetailText ? { listDetailText } : {}),
          ...(description && !itemDump ? { hasDescription: true } : {}),
          ...(partnerFilterKey ? { partnerFilterKey } : {}),
          ...(mark ? { responsibilityMark: mark } : {}),
        });
        continue;
      }

      const title = itemTitle(listType, item, list.title_field);

      if (listType === "contacts") {
        // Same assign vs co-share marks as shopping/tasks (assigned_by = assigner).
        const meta = resolveShoppingTasksRowMeta(
          list,
          item,
          title,
          viewer,
          aliases,
          skipMarks,
        );
        rows.push({
          title,
          item,
          listFiles,
          listEmoji,
          ...shellShare,
          ...meta,
        });
        continue;
      }

      const meta = resolveShoppingTasksRowMeta(
        list,
        item,
        title,
        viewer,
        aliases,
        skipMarks,
      );
      rows.push({
        title,
        item,
        listFiles,
        listEmoji,
        ...shellShare,
        ...meta,
      });
    }
  }
  return rows;
}

/**
 * Partners of a shared shell other than the viewer («עמית» / «מיכל, עמית») —
 * empty when nobody else is on it (a viewer-only share says nothing).
 */
function shellShareNames(
  sharedWith: string[],
  viewer: string,
  aliases: string[],
): string {
  const partners = partnersKey(sharedWith, viewer, aliases);
  return !partners || partners === "משותף" ? "" : partners;
}

/** List-share header suffix — distinct from an item co-share «(A, B)» line mark. */
export function listShareHeaderSuffix(partners: string): string {
  const names = partners.trim();
  return names ? ` · משותפת עם ${names}` : "";
}

/**
 * Whole-list share indication (scope=shared shells), kept apart from item
 * co-share marks: a LIST share is said on its own header («🛒 קניות · משותפת
 * עם מיכל:»), an ITEM share stays the «(A, B)» line mark. Rows from shells
 * with different share audiences never mix under one header: personal first,
 * then each shared audience as its own header (numbering stays continuous).
 */
function shellShareGroups(
  rows: DumpItem[],
): Array<{ partners: string; rows: DumpItem[] }> {
  const groups = new Map<string, DumpItem[]>();
  groups.set("", []);
  for (const row of rows) {
    const key = row.shellShareMark?.trim() ?? "";
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .filter(([, bucket]) => bucket.length > 0)
    .map(([partners, bucket]) => ({ partners, rows: bucket }));
}

/** Non-date dump filters shared by keep + undated-exclusion counting. */
function dumpRowPassesNonDateFilters(
  row: DumpItem,
  listType: ListDumpType,
  opts: ShowDumpOptions | undefined,
  pureCoShare: boolean,
  pureAssign: boolean,
  partnerFilters: string[],
): boolean {
  const section = opts?.section ?? null;
  const itemIds = opts?.itemIds ?? null;
  if (dumpRowExcludedByItemIds(listType, row.item, itemIds)) {
    return false;
  }
  const shared = row.isShared === true;
  if (section === "personal" && shared) {
    return false;
  }
  if (section === "shared" && !shared) {
    return false;
  }
  if (pureCoShare && !isCoShareDumpRow(row)) {
    return false;
  }
  if (pureAssign && !isAssignDumpRow(row)) {
    return false;
  }
  if (partnerFilters.length > 0) {
    const key = row.partnerFilterKey ?? "";
    if (
      !partnerFilters.some((needle) =>
        partnerBucketMatches(key || "משותף", needle),
      )
    ) {
      return false;
    }
  }
  if (
    !itemMatchesAssigneeFilter(
      row.responsibilityMark,
      opts,
      row.assigneeName,
    )
  ) {
    return false;
  }
  if (!itemMatchesUrgencyFilter(row.item, opts?.urgency)) {
    return false;
  }
  return true;
}

/**
 * Undated general tasks in scope (after section/partner/assignee/urgency/ids)
 * that a date-range dump would otherwise drop. Empty when no date range.
 */
export function listUndatedTasksExcludedByDateRange(
  rows: DumpItem[],
  opts?: ShowDumpOptions,
): DumpItem[] {
  if (!hasDumpDateRange(opts)) {
    return [];
  }
  const section = opts?.section ?? null;
  const partnerFilters = dumpFilterNames(opts?.partner);
  const assigneeFilters = dumpFilterNames(opts?.assignee);
  const collaboration = opts?.collaboration ?? null;
  const pureCoShare =
    collaboration === "co_share" ||
    (partnerFilters.length > 0 &&
      section === "shared" &&
      collaboration !== "assign" &&
      assigneeFilters.length === 0);
  const pureAssign = collaboration === "assign";
  const out: DumpItem[] = [];
  for (const row of rows) {
    if (opts?.flatLayout !== true && isWorkerTrackingTitle(row.title)) {
      continue;
    }
    if (
      !dumpRowPassesNonDateFilters(
        row,
        "tasks",
        opts,
        pureCoShare,
        pureAssign,
        partnerFilters,
      )
    ) {
      continue;
    }
    if (itemMatchesDateRange(row.item, opts?.dateFrom, opts?.dateTo)) {
      continue;
    }
    // Undated = no concrete calendar day AND no standing rule. A recurring
    // task with next_occurrences: [] (no hit in this dump window) is not undated.
    if (isUndatedGeneralTask(row.item)) {
      out.push(row);
    }
  }
  return out;
}

/**
 * Count tasks in scope that are excluded solely because they have no usable
 * calendar date under a range. Does not invent counts when no date range is set.
 */
export function countUndatedTasksExcludedByDateRange(
  rows: DumpItem[],
  opts?: ShowDumpOptions,
): number {
  return listUndatedTasksExcludedByDateRange(rows, opts).length;
}

function filterDumpRows(
  rows: DumpItem[],
  listType: ListDumpType,
  opts?: ShowDumpOptions,
): DumpItem[] {
  const effective = withEffectiveDumpDateOpts(opts);
  const section = effective?.section ?? null;
  const partnerFilters = dumpFilterNames(effective?.partner);
  const assigneeFilters = dumpFilterNames(effective?.assignee);
  const collaboration = effective?.collaboration ?? null;
  const undatedOnly =
    listType === "tasks" && hasUndatedDateScope(effective);
  // «משותף עם X» (partner + shared, no assignee) — never include assign rows.
  // Combined partner+assignee keeps legacy intersection; collaboration=assign
  // forces assign-only.
  const pureCoShare =
    collaboration === "co_share" ||
    (partnerFilters.length > 0 &&
      section === "shared" &&
      collaboration !== "assign" &&
      assigneeFilters.length === 0);
  const pureAssign = collaboration === "assign";

  let kept = rows.filter((row) => {
    // Speaker «הצג משימות»: Lucy's tracking rows (להזכיר ל… / לשלוח הודעה…)
    // must not appear even when they wrongly landed on the speaker book.
    // Worker inventory keeps them (flatLayout).
    if (
      listType === "tasks" &&
      effective?.flatLayout !== true &&
      isWorkerTrackingTitle(row.title)
    ) {
      return false;
    }
    if (
      !dumpRowPassesNonDateFilters(
        row,
        listType,
        effective,
        pureCoShare,
        pureAssign,
        partnerFilters,
      )
    ) {
      return false;
    }
    if (listType === "tasks" && undatedOnly) {
      return isUndatedGeneralTask(row.item);
    }
    if (
      listType === "tasks" &&
      !itemMatchesDateRange(row.item, effective?.dateFrom, effective?.dateTo)
    ) {
      return false;
    }
    return true;
  });

  // Partner-filtered tasks: also keep personal about-X rows for spoken inventory.
  // Post-share nav (collaboration=co_share) skips about-expansion — pure shared-with.
  if (
    listType === "tasks" &&
    section === "shared" &&
    partnerFilters.length > 0 &&
    collaboration !== "co_share" &&
    !pureAssign
  ) {
    const seen = new Set(
      kept.map((row) => String(row.item.item_id ?? "")).filter(Boolean),
    );
    for (const row of rows) {
      if (row.isShared) {
        continue;
      }
      if (!itemReminderAboutMatchesPartner(row.item, partnerFilters)) {
        continue;
      }
      if (
        !itemMatchesAssigneeFilter(
          row.responsibilityMark,
          effective,
          row.assigneeName,
        ) ||
        !itemMatchesUrgencyFilter(row.item, effective?.urgency) ||
        (undatedOnly
          ? !isUndatedGeneralTask(row.item)
          : !itemMatchesDateRange(
              row.item,
              effective?.dateFrom,
              effective?.dateTo,
            ))
      ) {
        continue;
      }
      const id = String(row.item.item_id ?? "");
      if (id && seen.has(id)) {
        continue;
      }
      if (id) {
        seen.add(id);
      }
      kept = [...kept, row];
    }
  }

  return clusterDumpRowsByKind(kept);
}

/**
 * FULL DUMP shopping count line label for one bucket (no leading spaces).
 * Personal → «אישיות»; co-share/assign → «(mark)» all-involved / באחריות.
 */
function shoppingCountBucketLabel(
  row: DumpItem,
  viewer: string,
  aliases: string[],
): { kind: number; label: string } {
  const kind = dumpItemKindRank(row);
  const mark = row.responsibilityMark?.trim() ?? "";
  if (kind === 2) {
    if (mark) {
      return { kind, label: `(${mark})` };
    }
    const who = row.assigneeName?.trim();
    return {
      kind,
      label: who ? `(באחריות ${who})` : "(באחריות)",
    };
  }
  if (kind === 1) {
    if (mark) {
      return { kind, label: `(${mark})` };
    }
    const key = (row.partnerFilterKey ?? "").trim();
    if (!key || key === "משותף") {
      return { kind, label: "(משותף)" };
    }
    const names = key
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const involved = allInvolvedNames(names, viewer, aliases);
    return {
      kind,
      label: involved ? `(${involved})` : "(משותף)",
    };
  }
  return { kind: 0, label: "אישיות" };
}

/** FULL DUMP קניות: breakdown by personal / co-share / assign (counts only). */
function formatShoppingCountsBreakdown(
  label: string,
  rows: DumpItem[],
  opts?: ShowDumpOptions,
): string {
  if (rows.length === 0) {
    return "";
  }
  const viewer = opts?.viewerName?.trim() ?? "";
  const aliases = (opts?.viewerAliases ?? []).map((name) => name.trim());
  const headerFiles = rows.some((row) => row.listFiles);
  const groups = new Map<
    string,
    { kind: number; label: string; count: number; order: number }
  >();
  let order = 0;
  for (const row of rows) {
    const bucket = shoppingCountBucketLabel(row, viewer, aliases);
    const existing = groups.get(bucket.label);
    if (existing) {
      existing.count += 1;
      continue;
    }
    groups.set(bucket.label, {
      kind: bucket.kind,
      label: bucket.label,
      count: 1,
      order: order++,
    });
  }
  const sorted = [...groups.values()].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind - b.kind;
    }
    return a.order - b.order;
  });
  return [
    `${label}${paperclipSuffix(headerFiles)}:`,
    ...sorted.map(
      (group) => `${group.label} — ${hebrewItemCount(group.count)}`,
    ),
  ].join("\n");
}

function dumpItemId(listType: ListDumpType, item: Record<string, unknown>): string {
  if (listType === "filings") {
    return String(item.filing_id ?? "").trim();
  }
  if (listType === "phone_book") {
    return String(item.contact_id ?? item.item_id ?? "").trim();
  }
  return String(item.item_id ?? "").trim();
}

/** True when opts.itemIds is set and this row's id is not in the set. */
export function dumpRowExcludedByItemIds(
  listType: ListDumpType,
  item: Record<string, unknown>,
  itemIds: ReadonlySet<string> | null | undefined,
): boolean {
  if (!itemIds) {
    return false;
  }
  if (itemIds.size === 0) {
    return true;
  }
  const id = dumpItemId(listType, item);
  return !id || !itemIds.has(id);
}

function dumpItemTitleStem(
  listType: ListDumpType,
  row: DumpItem,
): string {
  const item = row.item;
  if (listType === "shopping") {
    return (
      readText(item, TITLE_KEYS.shopping) ||
      row.title.replace(/\s*-\s*\d+\s*$/, "").trim() ||
      "פריט"
    );
  }
  if (listType === "tasks") {
    return readText(item, TITLE_KEYS.tasks) || row.title.trim() || "משימה";
  }
  if (listType === "contacts") {
    return readText(item, TITLE_KEYS.contacts) || row.title.trim() || "איש קשר";
  }
  if (listType === "phone_book") {
    return (
      String(item.name ?? "").trim() ||
      row.title.trim().split(" — ")[0]?.trim() ||
      "איש קשר"
    );
  }
  if (listType === "filings") {
    return String(item.item_name ?? "").trim() || row.title.trim() || "תיוק";
  }
  if (listType === "custom") {
    return (
      row.titleStem?.trim() ||
      itemTitle("custom", item, undefined) ||
      row.title.trim() ||
      "פריט"
    );
  }
  return row.title.trim() || "פריט";
}

function formatSingleHeaderDump(
  label: string,
  listType: ListDumpType,
  rows: DumpItem[],
  opts?: ShowDumpOptions,
  reminders: ReminderSnapshotRow[] = [],
  linkedReminderIds: Set<string> = new Set(),
): DumpTextResult {
  const headerFiles = rows.some((row) => row.listFiles);
  if (opts?.countsOnly === true) {
    if (listType === "shopping") {
      return emptyDumpResult(formatShoppingCountsBreakdown(label, rows, opts));
    }
    const n = rows.length;
    return emptyDumpResult(
      n === 0
        ? ""
        : `${label}${paperclipSuffix(headerFiles)}: ${hebrewItemCount(n)}`,
    );
  }
  const groups = shellShareGroups(rows);
  if (listType === "tasks" && hasDumpDateRange(opts)) {
    // Day agenda is grouped by date: mark the list header only when every row
    // shares one audience (mixed shells keep the plain header).
    const soleShare = groups.length === 1 ? groups[0]!.partners : "";
    return formatTasksDayAgendaDump(
      rows,
      reminders,
      opts,
      linkedReminderIds,
      `${label}${listShareHeaderSuffix(soleShare)}${paperclipSuffix(headerFiles)}`,
    );
  }
  if (rows.length === 0) {
    return emptyDumpResult();
  }
  const lines: LastNumberedDumpLine[] = [];
  const numbering = ensureDumpNumbering(opts);
  const dumpListName =
    listType === "custom"
      ? normalizeDumpListName(opts?.dumpListName) || undefined
      : undefined;
  const blocks = groups.map((group) => [
    `${label}${listShareHeaderSuffix(group.partners)}${paperclipSuffix(
      group.rows.some((row) => row.listFiles),
    )}:`,
    ...group.rows.map((row) => {
      const n = takeDumpLineNumber(numbering);
      const id = dumpItemId(listType, row.item);
      if (id) {
        lines.push({
          n,
          id,
          kind: listType,
          title_stem: dumpItemTitleStem(listType, row),
          ...(dumpListName ? { list_name: dumpListName } : {}),
        });
      }
      return formatNumberedItem(n, row.title, row.item, listType, {
        responsibilityMark: row.responsibilityMark,
        now: opts?.now,
        itemIds: opts?.itemIds,
        listDetailText: row.listDetailText,
        hasDescription: row.hasDescription,
      });
    }),
  ].join("\n"));
  return { text: blocks.join("\n\n"), lines };
}

function formatThreeWayDump(
  listType: "shopping" | "tasks",
  /** Product Hebrew label without emoji (🛒/✅ applied from source list). */
  bareLabel: string,
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): DumpTextResult {
  const effective = withEffectiveDumpDateOpts(opts);
  const lists = snapshot.lists.filter((list) => list.list_type === listType);
  const collected = collectListDumpRows(listType, lists, effective);
  const undatedExcludedRows =
    listType === "tasks" && !hasUndatedDateScope(effective)
      ? listUndatedTasksExcludedByDateRange(collected, effective)
      : [];
  const undatedExcluded = undatedExcludedRows.length;
  // Dated dump: exactly one משימה כללית → show it inline; 2+ → button (no list).
  let kept = filterDumpRows(collected, listType, effective);
  let offerUndatedTasksButton = false;
  if (listType === "tasks" && hasDumpDateRange(effective)) {
    if (undatedExcluded === 1) {
      const sole = undatedExcludedRows[0]!;
      const soleId = String(sole.item.item_id ?? "").trim();
      if (
        !kept.some((row) => String(row.item.item_id ?? "").trim() === soleId)
      ) {
        kept = [...kept, sole];
      }
    } else if (undatedExcluded > 1) {
      offerUndatedTasksButton = true;
    }
  }
  const label = withListEmoji(dumpHeaderEmoji(kept, listType, lists), bareLabel);
  const body = formatSingleHeaderDump(
    label,
    listType,
    kept,
    effective,
    snapshot.reminders ?? [],
    linkedReminderIdsFromTasks(snapshot),
  );
  if (
    !body.text.trim() &&
    offerUndatedTasksButton &&
    listType === "tasks" &&
    hasDumpDateRange(effective)
  ) {
    return {
      text: `${formatDumpListHeaderLine(label)}\nאין משימות בטווח התאריכים.`,
      lines: [],
      offerUndatedTasksButton: true,
    };
  }
  return {
    ...body,
    ...(offerUndatedTasksButton ? { offerUndatedTasksButton: true } : {}),
  };
}

/** Co-share mark: partners then viewer — e.g. «מיכל, טל». */
export function allInvolvedNames(
  names: string[],
  viewerName: string,
  viewerAliases: string[] = [],
): string {
  const viewer = viewerName.trim();
  const partners = partnersKey(names, viewerName, viewerAliases);
  if (!viewer) {
    return partners === "משותף" ? "" : partners;
  }
  if (!partners || partners === "משותף") {
    return viewer;
  }
  return `${partners}, ${viewer}`;
}

/** Urgency dump filter: urgent = urgent|very_urgent; very_urgent = exact. */
export function itemMatchesUrgencyFilter(
  item: Record<string, unknown>,
  urgency?: "urgent" | "very_urgent" | null,
): boolean {
  if (!urgency) {
    return true;
  }
  const value = item.urgency;
  if (urgency === "very_urgent") {
    return value === "very_urgent";
  }
  return value === "urgent" || value === "very_urgent";
}

/** Assignee filter against assign row / mark (sole assignee only when filter set). */
export function itemMatchesAssigneeFilter(
  responsibilityMark: string | undefined,
  opts?: Pick<ShowDumpOptions, "assignee" | "assigneeSelfNames" | "viewerName" | "viewerAliases">,
  assigneeName?: string,
): boolean {
  const assignees = dumpFilterNames(opts?.assignee);
  if (assignees.length === 0) {
    return true;
  }
  const mark = (responsibilityMark ?? "").trim();
  const sole =
    (assigneeName ?? "").trim() ||
    extractAssigneeFromMark(mark) ||
    "";
  // Multi-party co-share has no single owner — drop when filtering by assignee.
  if (!sole && (mark.includes(",") || mark.includes("·"))) {
    return false;
  }
  const matchAgainst = sole || mark;
  if (!matchAgainst) {
    return false;
  }
  // Each assignee is OR'd; `self` = speaking human only (assigneeSelfNames).
  const selfNames = (opts?.assigneeSelfNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  return assignees.some((raw) => {
    const needles =
      raw.toLowerCase() === "self" ? selfNames : [raw];
    return needles.some((name) => name === matchAgainst);
  });
}

/** Drop list items whose item_id is in `itemIds` (OPEN_JOBS shadows before dump). */
export function excludeItemIdsFromSnapshot(
  snapshot: EmployeeRecordSnapshot,
  itemIds: ReadonlySet<string>,
): EmployeeRecordSnapshot {
  if (itemIds.size === 0) {
    return snapshot;
  }
  return {
    ...snapshot,
    lists: snapshot.lists
      .map((list) => ({
        ...list,
        items: list.items.filter((raw) => {
          const item = raw as Record<string, unknown>;
          const id =
            typeof item.item_id === "string"
              ? item.item_id.trim()
              : typeof item.itemId === "string"
                ? item.itemId.trim()
                : typeof item.id === "string"
                  ? item.id.trim()
                  : "";
          return !id || !itemIds.has(id);
        }),
      }))
      .filter((list) => list.items.length > 0),
  };
}

/**
 * Stitch a tasks dump with an optional ממתינים (OPEN_JOBS) block.
 * Empty tasks ("" / null) + waiting → waiting only. No Hebrew parsing.
 */
export function composeTasksDumpWithWaiting(
  tasksDump: string | null,
  waitingDump: string,
): string | null {
  const waiting = waitingDump.trim();
  const tasks = (tasksDump ?? "").trim();
  if (!waiting) {
    return tasks || null;
  }
  if (!tasks) {
    return waiting;
  }
  return `${tasks}\n\n${waiting}`;
}

/** True when show_dump resolves to the built-in tasks list. */
export function isTasksShowDumpKind(kind: string): boolean {
  const resolved = resolveShowDumpKind(kind);
  return (
    resolved?.kind === "list" &&
    (resolved.name === "משימות" || resolved.name === "משימות")
  );
}

/**
 * Non-owner ABOUT X: keep only rows involving that person from the speaker's
 * already-visible snapshot (no private rows of X).
 */
export function filterSnapshotForAboutPerson(
  snapshot: EmployeeRecordSnapshot,
  aboutName: string,
  aboutAliases: string[] = [],
): EmployeeRecordSnapshot {
  const needles = new Set(
    [aboutName, ...aboutAliases]
      .map((name) => name.trim())
      .filter(Boolean),
  );
  if (needles.size === 0) {
    return { lists: [], filing: [], reminders: [] };
  }
  const nameHit = (value: string | undefined | null) =>
    Boolean(value && needles.has(value.trim()));
  const namesHit = (values: string[] | undefined) =>
    (values ?? []).some((name) => nameHit(name));

  const lists = snapshot.lists
    .map((list) => {
      if (list.list_type === "custom") {
        if (list.scope === "shared_items" && nameHit(list.owner)) {
          return list;
        }
        if (list.scope === "shared" && namesHit(list.shared_with)) {
          return list;
        }
        if (nameHit(list.owner) || namesHit(list.shared_with)) {
          return list;
        }
        const items = list.items.filter((item) =>
          namesHit(stringArray(item.shared_with)),
        );
        if (items.length === 0) {
          return null;
        }
        return { ...list, items };
      }
      if (list.list_type !== "shopping" && list.list_type !== "tasks" && list.list_type !== "contacts") {
        // Other non-builtin: keep if owner is about or shared_with includes them.
        if (nameHit(list.owner) || namesHit(list.shared_with)) {
          return list;
        }
        return null;
      }
      if (list.scope === "shared_items" && nameHit(list.owner)) {
        return list;
      }
      if (list.scope === "shared" && namesHit(list.shared_with)) {
        return list;
      }
      if (list.scope === "personal" || !list.scope) {
        if (nameHit(list.owner)) {
          return list;
        }
        const items = list.items.filter((item) => {
          const assignedBy =
            typeof item.assigned_by === "string" ? item.assigned_by.trim() : "";
          if (nameHit(assignedBy)) {
            return true;
          }
          return namesHit(stringArray(item.shared_with));
        });
        if (items.length === 0) {
          return null;
        }
        return { ...list, items };
      }
      return null;
    })
    .filter((row): row is EmployeeRecordSnapshot["lists"][number] => row !== null);

  const filing = (snapshot.filing ?? []).filter((row) => {
    if (nameHit(row.owner)) {
      return true;
    }
    return namesHit(row.shared_with);
  });

  return { lists, filing, reminders: [] };
}

/** Partner bucket key contains the requested partner name (exact segment). */
export function partnerBucketMatches(
  bucketKey: string,
  partner: string,
): boolean {
  const needle = partner.trim();
  if (!needle) {
    return true;
  }
  if (bucketKey === needle) {
    return true;
  }
  return bucketKey.split(",").some((part) => part.trim() === needle);
}

/**
 * Row mark for a custom-list item: assign `(באחריות X · מאת Y)` or co-share
 * `(A, B)`. Whole-list scope=shared → no per-line mark (its header says
 * «· משותפת עם X» via shellShareGroups).
 */
export function customItemCoShareMark(
  list: EmployeeRecordSnapshot["lists"][number],
  item: Record<string, unknown>,
  viewerName: string,
  viewerAliases: string[] = [],
): string | undefined {
  if (list.scope === "shared") {
    return undefined;
  }
  const assignedBy =
    typeof item.assigned_by === "string" ? item.assigned_by.trim() : "";
  const sharedWith = stringArray(item.shared_with);
  if (assignedBy && sharedWith.length === 0) {
    const owner = (list.owner ?? "").trim() || viewerName.trim();
    const mark = formatAssignResponsibilityMark(owner, assignedBy);
    return mark.trim() ? mark : undefined;
  }
  if (sharedWith.length > 0) {
    const mark = allInvolvedNames(sharedWith, viewerName, viewerAliases);
    return mark.trim() ? mark : undefined;
  }
  if (list.scope === "shared_items") {
    const owner = (list.owner ?? "").trim();
    if (!owner) {
      return undefined;
    }
    if (assignedBy) {
      const mark = formatAssignResponsibilityMark(owner, assignedBy);
      return mark.trim() ? mark : undefined;
    }
    const mark = allInvolvedNames([owner], viewerName, viewerAliases);
    return mark.trim() ? mark : undefined;
  }
  return undefined;
}

function formatContactsOrCustomDump(
  listType: "contacts" | "custom",
  listName: string,
  snapshot: EmployeeRecordSnapshot,
  emptyLabel: string,
  opts?: ShowDumpOptions,
): DumpTextResult | null {
  const normalizedListName = normalizeShowDumpListName(listName);
  const lists = snapshot.lists.filter((list) => {
    if (list.list_type !== listType) {
      return false;
    }
    if (listType === "contacts") {
      return true;
    }
    return (
      (list.list_name ?? "").trim() === normalizedListName
    );
  });
  if (lists.length === 0) {
    const label = normalizeShowDumpListName(emptyLabel) || emptyLabel;
    return emptyDumpResult(`לא מצאתי רשימה בשם «${label}».`);
  }
  const collected = collectListDumpRows(listType, lists, opts);
  const kept = filterDumpRows(collected, listType, opts);
  if (kept.length === 0) {
    return emptyDumpResult();
  }
  const bareHeader =
    listType === "contacts"
      ? stripLeadingListEmoji(emptyLabel) || emptyLabel
      : `רשימת «${stripLeadingListEmoji(emptyLabel) || emptyLabel}»`;
  const header = withListEmoji(
    dumpHeaderEmoji(kept, listType, lists),
    bareHeader,
  );
  return formatSingleHeaderDump(header, listType, kept, {
    ...opts,
    ...(listType === "custom"
      ? { dumpListName: normalizedListName }
      : {}),
  });
}

/** Focused custom-list empty sentence (not used in FULL DUMP sections). */
function emptyCustomListSentence(
  listName: string,
  snapshot: EmployeeRecordSnapshot,
  opts?: ShowDumpOptions,
): string {
  const name = listName.trim() || "ללא שם";
  const lists = snapshot.lists.filter(
    (list) =>
      list.list_type === "custom" && (list.list_name ?? "").trim() === name,
  );
  const listFiles = lists.some((list) => listHasListLevelFiles(list));
  const emoji = lists.length > 0
    ? listDumpEmoji(lists[0]!)
    : effectiveListEmoji({ listType: "custom", storedEmoji: null });
  // Shared shell → same «(עמית, טל)» header mark as a non-empty dump.
  const sharedShell = lists.find((list) => list.scope === "shared");
  const shellMark = sharedShell
    ? shellShareNames(
        sharedShell.shared_with ?? [],
        opts?.viewerName?.trim() ?? "",
        (opts?.viewerAliases ?? []).map((alias) => alias.trim()),
      )
    : "";
  const labeled = withListEmoji(
    emoji,
    `רשימת «${name}»${listShareHeaderSuffix(shellMark)}`,
  );
  const section = opts?.section ?? null;
  const partnerNeedles = dumpFilterNames(opts?.partner);
  if (section === "shared" || partnerNeedles.length > 0) {
    return `${labeled}${paperclipSuffix(listFiles)} — אין פריטים משותפים תואמים.`;
  }
  if (section === "personal") {
    return `${labeled}${paperclipSuffix(listFiles)} — אין פריטים אישיים.`;
  }
  return `${labeled}${paperclipSuffix(listFiles)} ריקה.`;
}

/** Effective emoji from a snapshot list row (fallback to canonical). */
function listDumpEmoji(
  list: Pick<EmployeeRecordSnapshot["lists"][number], "list_type" | "emoji">,
): string {
  return effectiveListEmoji({
    listType: list.list_type,
    storedEmoji: list.emoji ?? null,
  });
}

/**
 * Header emoji for a dump: first kept row's source list, else first matching
 * shell, else canonical. Filtered/item dumps reuse the source list glyph —
 * never infer from filter partner or item text.
 */
function dumpHeaderEmoji(
  rows: Array<Pick<DumpItem, "listEmoji">>,
  listType: string,
  lists: EmployeeRecordSnapshot["lists"],
): string {
  for (const row of rows) {
    const fromRow = row.listEmoji?.trim();
    if (fromRow) {
      return fromRow;
    }
  }
  for (const list of lists) {
    if (list.list_type === listType) {
      return listDumpEmoji(list);
    }
  }
  return effectiveListEmoji({ listType, storedEmoji: null });
}

function withListEmoji(emoji: string, label: string): string {
  const glyph = emoji.trim();
  const text = label.trim();
  if (!glyph || !text) {
    return text || glyph;
  }
  if (text.startsWith(glyph)) {
    return text;
  }
  return `${glyph} ${text}`;
}

/** Drop a leading emoji token so callers may pass either bare or prefixed labels. */
function stripLeadingListEmoji(label: string): string {
  const trimmed = label.trim();
  // One visible emoji grapheme (incl. ZWJ / variation selectors) + space.
  const match = trimmed.match(
    /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s+/u,
  );
  return match ? trimmed.slice(match[0].length).trim() : trimmed;
}

/**
 * Drop `ב־HH:mm` from a dump title when it matches chore `שעה לביצוע`
 * (synced into שם משימה by applyTimeToTaskLabel) so we do not print
 * «ב־09:00 — 09:00».
 */
export function stripMatchingTitleClock(title: string, hm: string): string {
  const want = normalizeHm(hm);
  if (!want) {
    return title.trim();
  }
  return title
    .replace(/\s*ב־(\d{1,2}:\d{2})\b/g, (full, clock: string) =>
      normalizeHm(clock) === want ? "" : full,
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Linked reminder is a series (not a one-shot). */
export function linkedReminderIsRecurring(item: Record<string, unknown>): boolean {
  const raw = item.reminder;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  const reminder = raw as Record<string, unknown>;
  const recurrenceText =
    typeof reminder.recurrence_text === "string"
      ? reminder.recurrence_text.trim()
      : "";
  if (recurrenceText) {
    return true;
  }
  const repeat =
    typeof reminder.repeat === "string" ? reminder.repeat.trim() : "";
  return Boolean(repeat) && repeat !== "none" && repeat !== "once";
}

/** Exported for unit tests. */
export function formatNumberedItem(
  n: number,
  title: string,
  item: Record<string, unknown>,
  listType: string,
  opts?: {
    /** Assign = assignee only; co-share = all involved — no «עם» prefix. */
    responsibilityMark?: string;
    /** @deprecated Stage-1 assign mark — prefer responsibilityMark. */
    assignedBy?: string;
    /** @deprecated Stage-1 co-share — prefer responsibilityMark (no עם). */
    sharedWithLabel?: string;
    now?: Date;
    /**
     * ITEM DUMP filter from ShowDumpOptions — when set, place/phone marks
     * include stored values; list dumps omit values (icons only).
     */
    itemIds?: ReadonlySet<string> | null;
    /**
     * Inventory-only custom (or similar) detail prose to preview under the
     * title — never truncates the title itself.
     */
    listDetailText?: string;
    /** Custom row has a general `description`: 📝 in the list view. */
    hasDescription?: boolean;
  },
): string {
  let body = title.trim() || "פריט";
  const listMode = opts?.itemIds == null;
  const choreTimeRaw =
    listType === "tasks" || listType === "shopping"
      ? readText(item, ["שעה לביצוע", "time", "שעה"])
      : "";
  const choreHm = choreTimeRaw ? normalizeHm(choreTimeRaw) : "";
  if (choreHm) {
    body = stripMatchingTitleClock(body, choreHm) || "פריט";
  }
  // Shopping description: the item view shows the text; the list view only 📝.
  const shoppingDescription =
    listType === "shopping" ? shoppingItemDescription(item) : "";
  if (!listMode) {
    body = withItemDescription(body, shoppingDescription);
  }
  if (hasAttachments(item)) {
    body += " 📎";
  }
  if (hasLinkedLists(item)) {
    body += " 🗂️";
  }
  if (listType === "tasks") {
    body += taskPlacePhoneMarks(
      item,
      opts?.itemIds != null ? "full" : "icons",
    );
  }
  if (listType === "filings") {
    body += filingPlaceMark(
      item,
      opts?.itemIds != null ? "full" : "icons",
    );
    body += filingHiddenDetailMark(
      item,
      opts?.itemIds != null ? "full" : "list",
    );
  }
  // responsibilityMark = co-share «(מיכל, טל)» or assign «(באחריות … · מאת …)».
  // sharedWithLabel is legacy; prefer responsibilityMark (no «עם»).
  if (opts?.responsibilityMark?.trim()) {
    const mark = opts.responsibilityMark.trim();
    if (!titleAlreadyListsPartners(body, mark)) {
      body += ` (${mark})`;
    }
  } else if (opts?.assignedBy?.trim()) {
    body += ` (${opts.assignedBy.trim()})`;
  } else if (
    opts?.sharedWithLabel?.trim() &&
    !titleAlreadyListsPartners(body, opts.sharedWithLabel.trim())
  ) {
    body += ` (${opts.sharedWithLabel.trim()})`;
  }
  if (listMode && shoppingDescription) {
    body += listDetailOverflowMark(true);
  }
  // Detail preview under the title (filings / custom). Titles stay full.
  if (listMode && listType === "filings") {
    const preview = formatFilingListPreview(item);
    if (preview) {
      body += `\n${preview}`;
    }
  } else if (listMode && listType === "custom") {
    const detail = formatTruncatedListDetail(opts?.listDetailText ?? "");
    // 📝 = more text than the preview shows: a truncated column preview or a
    // general description (never shown in the list view).
    body += listDetailOverflowMark(
      Boolean(detail?.truncated) || opts?.hasDescription === true,
    );
    if (detail) {
      body += `\n${detail.text}`;
    }
  }
  const standing =
    listType === "tasks" && Boolean(readText(item, ["חוזר", "recurrence_text"]));
  const reminderHm = linkedReminderSeriesHm(item);
  // Worker daily sends often have linked recurring clock + שעה לביצוע but no חוזר.
  const foldRecurringWithoutStanding =
    listType === "tasks" &&
    !standing &&
    linkedReminderIsRecurring(item) &&
    Boolean(choreHm) &&
    Boolean(reminderHm) &&
    choreHm === reminderHm;
  if (listType === "tasks" || listType === "shopping") {
    const schedule = formatScheduleSuffix(item, listType, opts?.now);
    if (schedule) {
      body += ` ${schedule}`;
    }
  }
  // Matching chore HM + recurring linked (no חוזר) → «(קבוע)» cadence fold.
  // Reminder presence is a separate 🔔 / detail mark (not embedded times).
  if (foldRecurringWithoutStanding) {
    body += ` ${standingLinkedReminderMark(item, `ב־${choreHm}`)}`;
  }
  if (listType === "tasks" || listType === "shopping") {
    const reminder = formatReminderIndicator(
      item,
      reminderDisplayMode(opts?.itemIds),
      { now: opts?.now },
    );
    if (reminder) {
      body += ` ${reminder}`;
    }
  }
  let line = `${n}. ${body}`;
  const urgency = item.urgency;
  if (urgency === "urgent" || urgency === "very_urgent") {
    line = `«${line}»`;
    if (urgency === "very_urgent") {
      line += " ‼️";
    }
  }
  return line;
}

/** True when the item carries a linked active-clock object (any non-array object). */
export function itemHasLinkedReminder(item: Record<string, unknown>): boolean {
  const raw = item.reminder;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return true;
  }
  const many = item.reminders;
  return Array.isArray(many) && many.length > 0;
}

/**
 * Standing cadence mark — always «(קבוע)».
 * Reminder presence is a separate list/detail mark (`🔔` / `🔔 תזכורת: …`),
 * not embedded as «+ תזכורת ב־…» on the standing paren.
 */
export function standingLinkedReminderMark(
  _item: Record<string, unknown>,
  _standingRuleText: string,
): string {
  return "(קבוע)";
}

/**
 * Formerly « · תזכורת ב־28.10 ב־09:30» for a one-shot clock soft-linked to a
 * standing series. Reminder times no longer live in the schedule suffix —
 * use {@link formatReminderIndicator} instead. Kept as an empty stub so
 * existing call sites stay safe.
 */
export function formatOneShotStandingReminderSuffix(
  _item: Record<string, unknown>,
): string {
  return "";
}

/** HH:mm from «ב־21:00» / «ב־21:00–22:00» in product-Hebrew rule text. */
function extractHmFromText(text: string): string | null {
  const match = text.match(/ב־(\d{1,2}:\d{2})/);
  return match ? normalizeHm(match[1]) : null;
}

/** Task event day YYYY-MM-DD from תאריך לביצוע or first next_occurrence. */
function taskEventYmd(item: Record<string, unknown>): string | null {
  const date = readText(item, ["תאריך לביצוע", "date"]).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return date;
  }
  const next = item.next_occurrences;
  if (Array.isArray(next) && typeof next[0] === "string") {
    const ymd = next[0].trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      return ymd;
    }
  }
  return null;
}

/** Linked reminder fire day YYYY-MM-DD (Jerusalem wall from fire_at). */
function linkedReminderYmd(item: Record<string, unknown>): string | null {
  const raw = item.reminder;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const fireAt = String((raw as Record<string, unknown>).fire_at ?? "").trim();
  if (!fireAt) {
    return null;
  }
  const space = fireAt.match(/^(\d{4}-\d{2}-\d{2})(?:\s|$)/);
  if (space) {
    return space[1]!;
  }
  const iso = Date.parse(fireAt);
  if (!Number.isNaN(iso)) {
    return jerusalemYmd(new Date(iso));
  }
  return null;
}

/** Series ping HH:mm from linked `reminder` (recurrence_text first, else fire_at). */
function linkedReminderSeriesHm(item: Record<string, unknown>): string | null {
  const raw = item.reminder;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const reminder = raw as Record<string, unknown>;
  const recurrenceText =
    typeof reminder.recurrence_text === "string"
      ? reminder.recurrence_text.trim()
      : "";
  const fromRule = extractHmFromText(recurrenceText);
  if (fromRule) {
    return fromRule;
  }
  const fireAt =
    typeof reminder.fire_at === "string" ? reminder.fire_at.trim() : "";
  const fromFire = fireAt.match(/(?:^|\s)(\d{1,2}:\d{2})(?:\s|$)/);
  return fromFire ? normalizeHm(fromFire[1]) : null;
}

/** Standing / dated suffix: «— שני ושלישי ב־19:00 (קבוע)» or «— מחר ב־19:30».
 * Reminder times are not part of this suffix — callers append
 * {@link formatReminderIndicator} (list 🔔 / detail timed).
 * Live task `exceptions` append « · 18.10 ב־21:30» / « · 23.10 בוטל». */
export function formatScheduleSuffix(
  item: Record<string, unknown>,
  listType: string,
  now = new Date(),
): string {
  if (listType !== "tasks") {
    return "";
  }
  const extras = formatExceptionsSuffix(item.exceptions);
  const recurring = readText(item, ["חוזר", "recurrence_text"]);
  if (recurring) {
    const mark = standingLinkedReminderMark(item, recurring);
    let base: string;
    if (/\(קבוע(?:\s*\+\s*תזכורת(?:\s+ב־[^)]+)?)?\)/.test(recurring)) {
      base = `— ${recurring.replace(/\(קבוע(?:\s*\+\s*תזכורת(?:\s+ב־[^)]+)?)?\)/g, mark)}`;
    } else if (/קבוע/.test(recurring)) {
      base = `— ${recurring}`;
    } else {
      base = `— ${recurring} ${mark}`;
    }
    return `${base}${extras}`;
  }
  const date = readText(item, ["תאריך לביצוע", "date"]);
  const time = readText(item, ["שעה לביצוע", "time", "שעה"]);
  if (date && time) {
    return `— ${formatRelativeDayLabel(date, now)} ב־${normalizeHm(time)}`;
  }
  if (date) {
    return `— ${formatRelativeDayLabel(date, now)}`;
  }
  if (time) {
    return `— ${normalizeHm(time)}`;
  }
  return "";
}

/**
 * Task-row reminder mark: `🔔 תזכורת: <when>` when when is known (list + detail).
 * Prefer occurrence-effective time when `occurrenceYmd` is set, or (flat
 * ITEM DUMP / list recurring) the nearest `next_occurrences` day that still has
 * an effective reminder — skip cancelled/absent; never use series HM when that
 * day was moved. No upcoming effective day → empty (no bell / no time).
 */
export function formatReminderIndicator(
  item: Record<string, unknown>,
  mode: ReminderDisplayMode = "list",
  opts?: { now?: Date; occurrenceYmd?: string },
): string {
  if (!itemHasLinkedReminder(item)) {
    return "";
  }
  const occurrenceYmd = opts?.occurrenceYmd?.trim().slice(0, 10) ?? "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(occurrenceYmd)) {
    return formatOccurrenceEffectiveReminderParen(item, occurrenceYmd, mode);
  }
  if (linkedReminderIsRecurring(item)) {
    const raw = item.reminder as Record<string, unknown>;
    if (reminderExceptionEntriesContractOk(raw)) {
      const ymds = nextOccurrenceYmds(item);
      if (ymds.length > 0) {
        for (const ymd of ymds) {
          const mark = formatOccurrenceEffectiveReminderParen(item, ymd, mode);
          if (mark) {
            return mark;
          }
        }
        // Snapshot listed upcoming days but every effective reminder is
        // cancelled/absent — no bell (do not fall back to series fire_at).
        return "";
      }
      // No occurrence slots in the snapshot — fall through to flat fire_at /
      // cadence mark (still show 🔔 when a linked clock exists).
    }
  }
  return formatLinkedReminderParen(item, opts?.now ?? new Date(), mode);
}

/** Chronological YYYY-MM-DD values from snapshot `next_occurrences`. */
function nextOccurrenceYmds(item: Record<string, unknown>): string[] {
  const next = item.next_occurrences;
  if (!Array.isArray(next)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const occ of next) {
    const ymd = ymdFromDumpValue(occ);
    if (!ymd || seen.has(ymd)) {
      continue;
    }
    seen.add(ymd);
    out.push(ymd);
  }
  return out;
}

/**
 * Linked-reminder mark for non-occurrence paths.
 * One clock → `🔔 תזכורת: <formatReminderWhen>` (unchanged).
 * Many → `🔔 תזכורת: a · b` with whens from sorted `reminders[]`.
 */
export function formatLinkedReminderParen(
  item: Record<string, unknown>,
  now = new Date(),
  mode: ReminderDisplayMode = "list",
): string {
  const many = Array.isArray(item.reminders)
    ? item.reminders.filter(
        (row): row is Record<string, unknown> =>
          Boolean(row) && typeof row === "object" && !Array.isArray(row),
      )
    : [];
  if (many.length > 1) {
    const whens: string[] = [];
    for (const reminder of many) {
      const when = whenTextFromLinkedReminder(reminder, now);
      if (when) {
        whens.push(when);
      }
    }
    if (whens.length === 0) {
      return itemHasLinkedReminder(item) ? "🔔" : "";
    }
    return formatReminderMarkText(mode, whens.join(" · "));
  }
  const raw =
    many.length === 1
      ? many[0]
      : item.reminder &&
          typeof item.reminder === "object" &&
          !Array.isArray(item.reminder)
        ? (item.reminder as Record<string, unknown>)
        : null;
  if (!raw) {
    return "";
  }
  const when = whenTextFromLinkedReminder(raw, now);
  return formatReminderMarkText(mode, when || null);
}

function whenTextFromLinkedReminder(
  reminder: Record<string, unknown>,
  now: Date,
): string {
  const fireAt =
    typeof reminder.fire_at === "string" ? reminder.fire_at.trim() : "";
  const recurrenceText =
    typeof reminder.recurrence_text === "string"
      ? reminder.recurrence_text.trim()
      : "";
  const repeat =
    typeof reminder.repeat === "string" ? reminder.repeat.trim() : "";
  if (
    !fireAt &&
    !recurrenceText &&
    (!repeat || repeat === "none" || repeat === "once")
  ) {
    return "";
  }
  const exceptions = Array.isArray(reminder.exceptions)
    ? reminder.exceptions.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : undefined;
  return formatReminderWhen(
    {
      fire_at: fireAt,
      repeat,
      recurrence_text: recurrenceText || undefined,
      ...(exceptions ? { exceptions } : {}),
    },
    now,
    { flatCadence: true },
  );
}

/**
 * Near-calendar labels vs Asia/Jerusalem today:
 * 0 היום · 1 מחר · 2 מחרתיים · 3–6 weekday · else D.M.YYYY.
 */
export function formatRelativeDayLabel(ymd: string, now = new Date()): string {
  const datePart = ymd.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return formatDisplayDate(ymd);
  }
  for (let offset = 0; offset <= 6; offset += 1) {
    const candidate = jerusalemYmd(addJerusalemDays(now, offset));
    if (candidate !== datePart) {
      continue;
    }
    if (offset === 0) {
      return "היום";
    }
    if (offset === 1) {
      return "מחר";
    }
    if (offset === 2) {
      return "מחרתיים";
    }
    return hebrewWeekdayFromYmd(datePart) ?? formatDisplayDate(datePart);
  }
  return formatDisplayDate(datePart);
}

/** «היום ב־19:00» / «מחרתיים ב־09:00» / «8.5.2027 ב־13:00». */
export function formatRelativeFireAt(fireAt: string, now: Date): string {
  const datePart = fireAt.slice(0, 10);
  const timePart = fireAt.length >= 16 ? fireAt.slice(11, 16) : "";
  const dayLabel = formatRelativeDayLabel(datePart, now);
  return timePart ? `${dayLabel} ב־${timePart}` : dayLabel;
}

/** Unpadded D.M.YYYY (e.g. 8.5.2027). */
export function formatDisplayDate(ymd: string): string {
  const match = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return ymd.trim();
  }
  return `${Number(match[3])}.${Number(match[2])}.${match[1]}`;
}

function normalizeHm(time: string): string {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) {
    return time.trim();
  }
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

/**
 * True when the item title already enumerates co-share partners inside `(…)`,
 * e.g. «פגישה (טל, עמית)» — so the dump must not also append «(עם עמית)».
 */
export function titleAlreadyListsPartners(
  title: string,
  partnerKey: string,
): boolean {
  const partners = partnerKey
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name !== "משותף");
  if (partners.length === 0) {
    return false;
  }
  const groups = [...title.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]);
  if (groups.length === 0) {
    return false;
  }
  const haystack = groups.join(" , ");
  return partners.every((name) => haystack.includes(name));
}

/**
 * Non-viewer partners joined as «A, B» — never includes the viewer (by name or aliases).
 */
export function partnersKey(
  names: string[],
  viewerName: string,
  viewerAliases: string[] = [],
): string {
  const excluded = new Set(
    [viewerName, ...viewerAliases]
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const partners = names
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name) => !excluded.has(name));
  return partners.length > 0 ? partners.join(", ") : "משותף";
}

/** List-level files only (`has_attachments` / list attachments) — not item roll-up. */
function listHasListLevelFiles(
  list: EmployeeRecordSnapshot["lists"][number],
): boolean {
  const row = list as Record<string, unknown>;
  if (row.has_attachments === true) {
    return true;
  }
  return hasAttachments(row);
}

function paperclipSuffix(show: boolean): string {
  return show ? " 📎" : "";
}

const CUSTOM_META_KEYS = new Set([
  "item_id",
  "scope",
  "owner",
  "urgency",
  "shared_with",
  "assigned_by",
  "attachments",
  "linked_lists",
  "linked_from_items",
  "reminder",
  "חוזר",
  "recurrence_text",
  "תאריך לביצוע",
  "שעה לביצוע",
  "תאריך סיום",
  "שעת סיום",
  "next_occurrences",
  "done_dates",
  "exceptions",
  "יום בשבוע",
  "יום בשבוע סיום",
]);

/** Title column for a custom row: list title_field, else first declared col, else first data key. */
export function resolveCustomTitleField(
  item: Record<string, unknown>,
  titleField?: string,
  columns?: string[],
): string {
  const fromList = (titleField ?? "").trim();
  if (fromList) {
    return fromList;
  }
  const declared = Array.isArray(columns)
    ? columns
        .filter((col): col is string => typeof col === "string")
        .map((col) => col.trim())
        .filter(Boolean)
    : [];
  if (declared[0]) {
    return declared[0];
  }
  for (const [key, value] of Object.entries(item)) {
    const col = key.trim();
    if (!col || CUSTOM_META_KEYS.has(col)) {
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      return col;
    }
  }
  return "";
}

/**
 * Inventory detail for a custom row: original non-title column values with
 * their labels («מפתח: ערך»). Prefers known detail column names when present,
 * then remaining columns in list order. No rewrite — truncation happens later
 * via {@link formatTruncatedListDetail}. Skips {@link CUSTOM_META_KEYS} and
 * empty/non-string values.
 */
export function formatCustomListDetailText(
  item: Record<string, unknown>,
  titleField?: string,
  columns?: string[],
): string {
  const titleKey = resolveCustomTitleField(item, titleField, columns);
  const declared = Array.isArray(columns)
    ? columns
        .filter((col): col is string => typeof col === "string")
        .map((col) => col.trim())
        .filter(Boolean)
    : [];
  const columnOrder =
    declared.length > 0
      ? declared
      : Object.keys(item)
          .map((key) => key.trim())
          .filter(Boolean);

  const valueFor = (key: string): string => {
    const raw = item[key];
    return typeof raw === "string" ? raw.trim() : "";
  };

  const usable = (key: string): boolean => {
    if (!key || key === titleKey || CUSTOM_META_KEYS.has(key)) {
      return false;
    }
    return Boolean(valueFor(key));
  };

  const orderedKeys: string[] = [];
  const seen = new Set<string>();
  const pushKey = (key: string) => {
    if (!usable(key) || seen.has(key)) {
      return;
    }
    seen.add(key);
    orderedKeys.push(key);
  };

  for (const preferred of CUSTOM_DETAIL_PREFERRED_KEYS) {
    if (columnOrder.includes(preferred)) {
      pushKey(preferred);
    }
  }
  for (const key of columnOrder) {
    pushKey(key);
  }

  return orderedKeys.map((key) => `${key}: ${valueFor(key)}`).join(" · ");
}

/**
 * Custom list line: every non-empty column as «מפתח: ערך», joined with ·.
 * Includes title_field. Example: «שם: טל · תיאור: נשוי למיכל».
 * Used for ITEM DUMP / full body — not inventory title.
 */
export function formatCustomItemBody(
  item: Record<string, unknown>,
  titleField?: string,
  columns?: string[],
): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  const pushField = (key: string, value: unknown) => {
    const col = key.trim();
    if (!col || CUSTOM_META_KEYS.has(col) || seen.has(col)) {
      return;
    }
    if (typeof value !== "string" || !value.trim()) {
      return;
    }
    seen.add(col);
    parts.push(`${col}: ${value.trim()}`);
  };

  if (Array.isArray(columns) && columns.length > 0) {
    for (const col of columns) {
      if (typeof col !== "string") {
        continue;
      }
      pushField(col, item[col.trim()]);
    }
  } else {
    const titleKey = (titleField ?? "").trim();
    if (titleKey) {
      pushField(titleKey, item[titleKey]);
    }
    for (const [key, value] of Object.entries(item)) {
      pushField(key, value);
    }
  }

  return parts.length > 0 ? parts.join(" · ") : "פריט";
}

/** Shopping line body: «אורז - 2» / «עגבניות - 1 ק"ג» (missing כמות → 1). */
export function formatShoppingTitle(item: Record<string, unknown>): string {
  const name =
    readText(item, TITLE_KEYS.shopping) ||
    readText(item, ["name", "item_name"]) ||
    "פריט";
  const qtyRaw = item["כמות"] ?? item.quantity ?? item.qty;
  const qty =
    typeof qtyRaw === "number" && Number.isFinite(qtyRaw)
      ? qtyRaw
      : typeof qtyRaw === "string" &&
          qtyRaw.trim() !== "" &&
          Number.isFinite(Number(qtyRaw))
        ? Number(qtyRaw)
        : 1;
  const unit = readText(item, ["יחידת מידה", "unit", "יחידה"]);
  return unit ? `${name} - ${qty} ${unit}` : `${name} - ${qty}`;
}

function itemTitle(
  listType: string,
  item: Record<string, unknown>,
  titleField?: string,
): string {
  if (listType === "shopping") {
    return formatShoppingTitle(item);
  }
  if (listType === "contacts") {
    const first = readText(item, TITLE_KEYS.contacts);
    const last = readText(item, ["שם משפחה", "last_name", "surname"]);
    return [first, last].filter(Boolean).join(" ") || "איש קשר";
  }
  const keys = TITLE_KEYS[listType] ?? [];
  const titled = keys.length > 0 ? readText(item, keys) : "";
  if (titled) {
    return titled;
  }
  if (listType === "custom") {
    const field = titleField?.trim();
    if (field) {
      const named = readText(item, [field]);
      if (named) {
        return named;
      }
    }
    for (const [key, value] of Object.entries(item)) {
      if (CUSTOM_META_KEYS.has(key)) {
        continue;
      }
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return "פריט";
}

function readText(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((row): row is string => typeof row === "string")
    .map((row) => row.trim())
    .filter(Boolean);
}

function hasAttachments(row: Record<string, unknown> | ReminderSnapshotRow): boolean {
  const attachments = (row as { attachments?: unknown }).attachments;
  return Array.isArray(attachments) && attachments.length > 0;
}

/** Tasks host with one or more linked shopping/custom lists. */
function hasLinkedLists(row: Record<string, unknown>): boolean {
  const linked = row.linked_lists;
  return Array.isArray(linked) && linked.length > 0;
}

/**
 * Task dump place/phone marks (after 📎/🗂️).
 * - `icons` (default): 📍/📞 only — list / agenda lines.
 * - `full`: icon + stored value — ITEM DUMP (`show_dump_ids` / itemIds set).
 */
export function taskPlacePhoneMarks(
  item: Record<string, unknown>,
  mode: "icons" | "full" = "icons",
): string {
  let marks = "";
  const address = readText(item, ["כתובת", "address"]);
  if (address) {
    marks += mode === "full" ? ` 📍 ${address}` : " 📍";
  }
  const phone = readText(item, ["טלפון", "phone", "telephone"]);
  if (phone) {
    marks += mode === "full" ? ` 📞 ${phone}` : " 📞";
  }
  return marks;
}
