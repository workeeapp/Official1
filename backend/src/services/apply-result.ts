/**
 * Result-A: internal ApplyResult contract (no reply renderer).
 * requested is captured before resolve/H; applied is DB-confirmed only.
 * Absence of misses never implies success (completeness may be unknown).
 */
import type {
  LlmDirectoryAction,
  LlmFilingAction,
  LlmListAction,
  LlmListOp,
  LlmReminderAction,
} from "@workee/shared";
import type {
  FilingMutation,
  ListItemMutation,
  ShareApplyMiss,
} from "./employee-records.service.js";
import type { IntentMiss } from "./list-intent-refs.js";
import type { ListOpResult } from "./list-ops.service.js";

export type ApplyCompleteness = "complete" | "partial" | "unknown";

export type ApplyResultDomain =
  | "lists"
  | "filing"
  | "reminders"
  | "directory"
  | "list_ops";

export type RequestedOp = {
  domain: ApplyResultDomain;
  op: string;
  id?: string;
  listType?: string;
  listName?: string;
  listId?: string;
  mutateSource?: string;
  /** Numbered-dump line when the request used mutate_source=dump_line. */
  dumpLine?: number;
};

export type AppliedOp = {
  domain: ApplyResultDomain;
  op: string;
  id?: string;
  label?: string;
  listType?: string;
  listName?: string;
  listId?: string;
  employeeId?: string;
  /** lists: YYYY-MM-DD of the saved row (post-save / pre-delete), when dated. */
  calendarYmd?: string;
  /** lists: named custom list opened with no real rows (no item to open). */
  listShell?: boolean;
  /** lists: row added to a list created in this same turn. */
  inNewList?: boolean;
};

export type ApplyMiss = {
  domain: ApplyResultDomain;
  reason: string;
  id?: string;
  op?: string;
  listType?: string;
  listName?: string;
  detail?: string;
  /** Numbered-dump line when the miss came from a dump-mapped row. */
  dumpLine?: number;
};

/** Intent / H / show-turn-strip drops. */
export type ResultIntentMiss = {
  reason: string;
  mutateSource?: string;
  dumpLine?: number;
  itemId?: string;
  listId?: string;
  listType?: string;
  listName?: string;
  op?: string;
  domain?: ApplyResultDomain;
  source?: "intent" | "dump_guard" | "show_turn_strip";
  /** Product title of the row this miss did not change. */
  label?: string;
};

export type DomainApplyResult = {
  requested: RequestedOp[];
  applied: AppliedOp[];
  intent_misses: ResultIntentMiss[];
  apply_misses: ApplyMiss[];
  /**
   * Requested ops removed before apply without a definite miss reason.
   * Forces completeness=unknown; never treated as applied.
   */
  unclassified_drops?: RequestedOp[];
  completeness: ApplyCompleteness;
};

/** Result-C: post-apply engine display from a fresh DB snapshot (not model draft). */
export type ApplyResultDisplay = {
  kind: string;
  snapshot_text: string;
  lines?: Array<{
    n: number;
    id: string;
    kind: string;
    title_stem: string;
    list_name?: string;
  }>;
};

export type ApplyResult = {
  domains: {
    lists?: DomainApplyResult;
    filing?: DomainApplyResult;
    reminders?: DomainApplyResult;
    directory?: DomainApplyResult;
    list_ops?: DomainApplyResult;
  };
  completeness: ApplyCompleteness;
  /** Set only when engine dump ran from a post-apply snapshot. */
  display?: ApplyResultDisplay;
};

export type CapturedRequested = {
  lists: LlmListAction[];
  filing: LlmFilingAction[];
  reminders: LlmReminderAction[];
  directory: LlmDirectoryAction[];
  listOps: LlmListOp[];
};

export type DumpGuardDrop = {
  itemId?: string;
  listType?: string;
  listName?: string;
  op?: string;
  reason: "outside_dump" | "outside_dump_scope";
  /** Numbered-dump line and title, when the dropped id was on the map. */
  dumpLine?: number;
  label?: string;
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readItemId(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "";
  }
  const record = raw as Record<string, unknown>;
  for (const key of [
    "item_id",
    "itemId",
    "id",
    "filing_id",
    "filingId",
    "reminder_id",
    "reminderId",
    "contact_id",
    "contactId",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function readMutateSource(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const value = record.mutate_source ?? record.mutateSource;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readDumpLine(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const value = record.dump_line ?? record.dumpLine;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    if (Number.isInteger(n) && n >= 1) {
      return n;
    }
  }
  return undefined;
}

/**
 * ApplyResult list accounting: prefer post-resolve/H identity (dump_line →
 * stamped item_id) and keep pre-resolve items that were dropped so intent /
 * dump-guard misses can still pair.
 */
export function accountingListsForApplyResult(
  preResolveLists: LlmListAction[],
  postResolveLists: LlmListAction[],
): LlmListAction[] {
  const post = cloneJson(postResolveLists);
  const coveredDump = new Set<string>();
  const coveredIds = new Set<string>();
  for (const action of post) {
    const items = Array.isArray(action.items) ? action.items : [];
    for (const item of items) {
      const id = readItemId(item);
      if (id) {
        coveredIds.add(id);
      }
      const dumpLine = readDumpLine(item);
      if (dumpLine != null) {
        coveredDump.add(`${action.action}\0${action.listType}\0${dumpLine}`);
      }
    }
  }

  for (const action of preResolveLists) {
    if (action.action !== "remove" && action.action !== "update") {
      continue;
    }
    const items = Array.isArray(action.items) ? action.items : [];
    const ghosts: Record<string, unknown>[] = [];
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        continue;
      }
      const item = rawItem as Record<string, unknown>;
      const id = readItemId(item);
      const dumpLine = readDumpLine(item);
      if (id && coveredIds.has(id)) {
        continue;
      }
      if (
        dumpLine != null &&
        coveredDump.has(`${action.action}\0${action.listType}\0${dumpLine}`)
      ) {
        continue;
      }
      if (!id && dumpLine == null && !readMutateSource(item)) {
        continue;
      }
      ghosts.push(cloneJson(item));
      if (id) {
        coveredIds.add(id);
      }
      if (dumpLine != null) {
        coveredDump.add(`${action.action}\0${action.listType}\0${dumpLine}`);
      }
    }
    if (ghosts.length === 0) {
      continue;
    }
    const existing = post.find(
      (row) =>
        row.action === action.action &&
        row.listType === action.listType &&
        (row.listName || "") === (action.listName || "") &&
        (row.listId || "") === (action.listId || ""),
    );
    if (existing) {
      existing.items = [
        ...(Array.isArray(existing.items) ? existing.items : []),
        ...ghosts,
      ];
    } else {
      post.push({
        ...cloneJson(action),
        items: ghosts,
      });
    }
  }
  return post;
}

/** Immutable snapshot of model-requested mutates (call before resolve/H). */
export function captureRequestedFromMetadata(metadata: {
  lists?: LlmListAction[];
  filing?: LlmFilingAction[];
  reminders?: LlmReminderAction[];
  directory?: LlmDirectoryAction[];
  listOps?: LlmListOp[];
}): CapturedRequested {
  return {
    lists: cloneJson(metadata.lists ?? []),
    filing: cloneJson(metadata.filing ?? []),
    reminders: cloneJson(metadata.reminders ?? []),
    directory: cloneJson(metadata.directory ?? []),
    listOps: cloneJson(metadata.listOps ?? []),
  };
}

export function requestedOpsFromLists(lists: LlmListAction[]): RequestedOp[] {
  const out: RequestedOp[] = [];
  for (const action of lists) {
    const items = Array.isArray(action.items) ? action.items : [];
    if (
      (action.action === "remove" ||
        action.action === "update" ||
        action.action === "add") &&
      items.length > 0
    ) {
      for (const item of items) {
        const dumpLine = readDumpLine(item);
        out.push({
          domain: "lists",
          op: action.action,
          id: readItemId(item) || undefined,
          listType: action.listType,
          listName: action.listName || undefined,
          listId: action.listId,
          mutateSource: readMutateSource(item),
          ...(dumpLine != null ? { dumpLine } : {}),
        });
      }
      continue;
    }
    out.push({
      domain: "lists",
      op: action.action,
      listType: action.listType,
      listName: action.listName || undefined,
      listId: action.listId,
    });
  }
  return out;
}

export function requestedOpsFromFiling(
  filing: LlmFilingAction[],
): RequestedOp[] {
  return filing.map((row) => ({
    domain: "filing" as const,
    op: row.action,
    id: row.filingId || undefined,
    listType: "filing",
  }));
}

export function requestedOpsFromReminders(
  reminders: LlmReminderAction[],
): RequestedOp[] {
  return reminders.map((row) => ({
    domain: "reminders" as const,
    op: row.action,
    id: row.reminderId || undefined,
    // Reminder.listType is a soft-link wrapper (shopping|tasks|…), not the
    // clock domain. Applied reminder rows omit listType — never pair on it.
  }));
}

export function requestedOpsFromDirectory(
  directory: LlmDirectoryAction[],
): RequestedOp[] {
  return directory.map((row) => ({
    domain: "directory" as const,
    op: row.action,
    id: row.contactId || undefined,
  }));
}

export function requestedOpsFromListOps(ops: LlmListOp[]): RequestedOp[] {
  return ops.map((row) => ({
    domain: "list_ops" as const,
    op: row.action,
    id: row.listId || undefined,
    listId: row.listId || undefined,
  }));
}

function missMatchesRequested(
  miss: ResultIntentMiss,
  req: RequestedOp,
): boolean {
  const missId = miss.itemId?.trim() ?? "";
  const reqId = req.id?.trim() ?? "";
  if (missId && reqId && missId === reqId) {
    return true;
  }
  // dump_line miss ↔ dump_line request (ids may disagree pre/post resolve).
  if (
    miss.dumpLine != null &&
    req.dumpLine != null &&
    miss.dumpLine === req.dumpLine
  ) {
    if (miss.op && miss.op !== req.op) {
      return false;
    }
    if (miss.listType && req.listType && miss.listType !== req.listType) {
      return false;
    }
    if (miss.domain && miss.domain !== req.domain) {
      return false;
    }
    return true;
  }
  if (reqId) {
    return false;
  }
  // Id-less requested: match structured miss on op + shell fields.
  if (!miss.op || miss.op !== req.op) {
    return false;
  }
  if ((miss.listType ?? "") !== (req.listType ?? "")) {
    return false;
  }
  if ((miss.listName ?? "") !== (req.listName ?? "")) {
    return false;
  }
  if ((miss.listId ?? "") !== (req.listId ?? "")) {
    return false;
  }
  if (miss.domain && miss.domain !== req.domain) {
    return false;
  }
  return true;
}

/**
 * Match an unused applied row to a requested op by shell fields.
 * Prefer same listName when the request carries one; otherwise op+listType.
 * Each applied index may be claimed at most once (caller tracks usedApplied).
 */
function claimAppliedByShell(
  req: RequestedOp,
  applied: AppliedOp[],
  usedApplied: Set<number>,
): boolean {
  const reqName = req.listName?.trim() ?? "";
  const tryClaim = (requireName: boolean): boolean => {
    for (let i = 0; i < applied.length; i += 1) {
      if (usedApplied.has(i)) {
        continue;
      }
      const row = applied[i]!;
      if (row.op !== req.op) {
        continue;
      }
      if ((row.listType ?? "") !== (req.listType ?? "")) {
        continue;
      }
      if (requireName) {
        if ((row.listName?.trim() ?? "") !== reqName) {
          continue;
        }
      }
      usedApplied.add(i);
      return true;
    }
    return false;
  };
  if (reqName) {
    if (tryClaim(true)) {
      return true;
    }
    // Name present but no exact row — fall back to op+listType only.
  }
  return tryClaim(false);
}

/**
 * complete = every requested op has applied or miss (known fate).
 * partial = known fate for all, with both applied and misses.
 * unknown = unaccounted requested, unclassified drops, or reportingIncomplete.
 *
 * Id-less adds (typical lists.add before mint): pair 1:1 to unused applied
 * rows with the same op+listType (+listName when possible). Never reuse one
 * applied for two requested ops.
 */
export function computeDomainCompleteness(input: {
  requested: RequestedOp[];
  applied: AppliedOp[];
  intent_misses: ResultIntentMiss[];
  apply_misses: ApplyMiss[];
  unclassified_drops?: RequestedOp[];
  reportingIncomplete?: boolean;
}): ApplyCompleteness {
  const {
    requested,
    applied,
    intent_misses,
    apply_misses,
    unclassified_drops,
    reportingIncomplete,
  } = input;
  // Nested NEW-task+remind txn misses can surface with empty reminderRequested
  // (clocks lived only under items[].remind) — still must not report complete.
  if (reportingIncomplete || (unclassified_drops?.length ?? 0) > 0) {
    return "unknown";
  }
  if (requested.length === 0) {
    // Nested-only success: applied clocks, no requested.reminders → complete.
    // Any miss/unclassified with empty requested must not report complete.
    if ((apply_misses?.length ?? 0) > 0 || (intent_misses?.length ?? 0) > 0) {
      return applied.length > 0 ? "partial" : "unknown";
    }
    return "complete";
  }

  const missIds = new Set<string>();
  for (const miss of intent_misses) {
    if (miss.itemId?.trim()) {
      missIds.add(miss.itemId.trim());
    }
  }
  for (const miss of apply_misses) {
    if (miss.id?.trim()) {
      missIds.add(miss.id.trim());
    }
  }

  const usedApplied = new Set<number>();
  const usedIntentMiss = new Set<number>();
  const usedApplyMiss = new Set<number>();

  let matchedApplied = 0;
  let matchedMiss = 0;
  let unaccounted = 0;

  for (const req of requested) {
    const id = req.id?.trim() ?? "";
    if (id) {
      const appliedIdx = applied.findIndex(
        (row, i) => !usedApplied.has(i) && row.id === id,
      );
      if (appliedIdx >= 0) {
        usedApplied.add(appliedIdx);
        matchedApplied += 1;
        continue;
      }
      if (missIds.has(id)) {
        const applyIdx = apply_misses.findIndex(
          (miss, i) => !usedApplyMiss.has(i) && miss.id?.trim() === id,
        );
        if (applyIdx >= 0) {
          usedApplyMiss.add(applyIdx);
        }
        matchedMiss += 1;
        continue;
      }
      // Id requested but not applied/missed — still try shell pairing below
      // only for id-less path; known id with no fate stays unaccounted.
      unaccounted += 1;
      continue;
    }

    // Id-less (e.g. lists.add before item_id mint): claim applied first so a
    // successful add is not left unknown while a sibling miss exists.
    if (claimAppliedByShell(req, applied, usedApplied)) {
      matchedApplied += 1;
      continue;
    }

    const intentIdx = intent_misses.findIndex(
      (miss, i) =>
        !usedIntentMiss.has(i) && missMatchesRequested(miss, req),
    );
    if (intentIdx >= 0) {
      usedIntentMiss.add(intentIdx);
      matchedMiss += 1;
      continue;
    }

    const applyMissIdx = apply_misses.findIndex((miss, i) => {
      if (usedApplyMiss.has(i)) {
        return false;
      }
      if (miss.op !== req.op) {
        return false;
      }
      // A dump-line remove is id-less at request capture and gains an id only
      // after the dump map is applied. That miss still accounts for one request.
      if (req.listType && miss.listType && miss.listType !== req.listType) {
        return false;
      }
      if (req.listName?.trim() && miss.listName?.trim()) {
        return miss.listName.trim() === req.listName.trim();
      }
      return true;
    });
    if (applyMissIdx >= 0) {
      usedApplyMiss.add(applyMissIdx);
      matchedMiss += 1;
      continue;
    }

    unaccounted += 1;
  }

  if (unaccounted > 0) {
    return "unknown";
  }
  if (matchedApplied > 0 && matchedMiss > 0) {
    return "partial";
  }
  return "complete";
}

function survivingListKeys(lists: LlmListAction[]): Set<string> {
  const keys = new Set<string>();
  for (const action of lists) {
    const items = Array.isArray(action.items) ? action.items : [];
    if (items.length === 0) {
      keys.add(
        ["lists", action.action, action.listType, action.listName, action.listId ?? "", ""].join(
          "\0",
        ),
      );
      continue;
    }
    for (const item of items) {
      keys.add(
        [
          "lists",
          action.action,
          action.listType,
          action.listName,
          action.listId ?? "",
          readItemId(item),
        ].join("\0"),
      );
    }
  }
  return keys;
}

function requestedKey(op: RequestedOp): string {
  return [
    op.domain,
    op.op,
    op.listType ?? "",
    op.listName ?? "",
    op.listId ?? "",
    op.id ?? "",
  ].join("\0");
}

function metadataHasMutates(meta: {
  lists?: unknown[];
  listOps?: unknown[];
  filing?: unknown[];
  reminders?: unknown[];
  directory?: unknown[];
}): boolean {
  return (
    (meta.lists?.length ?? 0) > 0 ||
    (meta.listOps?.length ?? 0) > 0 ||
    (meta.filing?.length ?? 0) > 0 ||
    (meta.reminders?.length ?? 0) > 0 ||
    (meta.directory?.length ?? 0) > 0
  );
}

/**
 * Diff requested vs post-strip metadata. Does not change strip policy.
 * Known path: show_dump alone clears mutates → reason show_dump_cleared_mutates.
 * Any other disappearance → unclassified_drops (forces unknown; no invented reason).
 */
export function collectShowTurnStripDrops(input: {
  requested: CapturedRequested;
  showDumpBefore: string | null | undefined;
  afterStrip: {
    lists?: LlmListAction[];
    listOps?: LlmListOp[];
    filing?: LlmFilingAction[];
    reminders?: LlmReminderAction[];
    directory?: LlmDirectoryAction[];
  };
}): {
  misses: ResultIntentMiss[];
  unclassified: RequestedOp[];
} {
  const showDump = input.showDumpBefore?.trim() ?? "";
  const allRequested = [
    ...requestedOpsFromLists(input.requested.lists),
    ...requestedOpsFromFiling(input.requested.filing),
    ...requestedOpsFromReminders(input.requested.reminders),
    ...requestedOpsFromDirectory(input.requested.directory),
    ...requestedOpsFromListOps(input.requested.listOps),
  ];
  if (allRequested.length === 0 || !showDump) {
    return { misses: [], unclassified: [] };
  }

  const surviving = new Set<string>();
  for (const key of survivingListKeys(input.afterStrip.lists ?? [])) {
    surviving.add(key);
  }
  for (const op of requestedOpsFromFiling(input.afterStrip.filing ?? [])) {
    surviving.add(requestedKey(op));
  }
  for (const op of requestedOpsFromReminders(input.afterStrip.reminders ?? [])) {
    surviving.add(requestedKey(op));
  }
  for (const op of requestedOpsFromDirectory(input.afterStrip.directory ?? [])) {
    surviving.add(requestedKey(op));
  }
  for (const op of requestedOpsFromListOps(input.afterStrip.listOps ?? [])) {
    surviving.add(requestedKey(op));
  }

  const dropped = allRequested.filter((op) => !surviving.has(requestedKey(op)));
  if (dropped.length === 0) {
    return { misses: [], unclassified: [] };
  }

  // Definite policy branch: show_dump with no remaining mutates cleared them.
  const clearedForDisplayOnly = !metadataHasMutates(input.afterStrip);
  if (clearedForDisplayOnly) {
    return {
      misses: dropped.map((op) => ({
        reason: "show_dump_cleared_mutates",
        itemId: op.id,
        listId: op.listId,
        listType: op.listType,
        listName: op.listName,
        op: op.op,
        domain: op.domain,
        source: "show_turn_strip" as const,
      })),
      unclassified: [],
    };
  }

  // Should not happen with current strip policy when show+mutates keeps mutates.
  return { misses: [], unclassified: dropped };
}

function rollupCompleteness(
  domains: ApplyResult["domains"],
): ApplyCompleteness {
  const values = Object.values(domains).filter(
    Boolean,
  ) as DomainApplyResult[];
  if (values.length === 0) {
    return "complete";
  }
  if (values.some((row) => row.completeness === "unknown")) {
    return "unknown";
  }
  if (values.some((row) => row.completeness === "partial")) {
    return "partial";
  }
  return "complete";
}

type ReminderApplySlice = {
  saved?: Array<{ id: string; itemLabel?: string; item?: string }>;
  /** Cancelled-clock labels for the delete fallback. Not clock ids. */
  removed?: string[];
  changes?: Array<{ action: string; label?: string; id?: string }>;
};

/**
 * One applied row per saved clock or per change.
 * `removed` repeats the same cancel as a label (the delete fallback reads it).
 * A label with no matching change is a same-turn cascade that already
 * cancelled the clock; it pairs to the requested remove id that no change claimed.
 */
function reminderAppliedOps(
  rr: ReminderApplySlice | undefined,
  requested: RequestedOp[],
): AppliedOp[] {
  const saved: AppliedOp[] = (rr?.saved ?? []).map((row) => ({
    domain: "reminders",
    op: "add",
    id: row.id,
    label: row.itemLabel || row.item,
  }));
  const fromChanges: AppliedOp[] = (rr?.changes ?? []).map((row) => ({
    domain: "reminders",
    op: row.action === "remove" ? "remove" : "update",
    ...(row.id ? { id: row.id } : {}),
    ...(row.label ? { label: row.label } : {}),
  }));
  const unmatchedChanges = fromChanges.filter((row) => row.op === "remove");
  const leftoverLabels: string[] = [];
  for (const raw of rr?.removed ?? []) {
    const label = raw.trim();
    if (!label) {
      continue;
    }
    const idx = unmatchedChanges.findIndex(
      (row) => (row.label ?? "").trim() === label,
    );
    if (idx >= 0) {
      unmatchedChanges.splice(idx, 1);
      continue;
    }
    leftoverLabels.push(label);
  }
  const claimedIds = new Set(
    fromChanges.flatMap((row) =>
      row.op === "remove" && row.id ? [row.id] : [],
    ),
  );
  const unclaimedIds = requested
    .filter(
      (row) =>
        row.domain === "reminders" &&
        row.op === "remove" &&
        Boolean(row.id) &&
        !claimedIds.has(row.id!),
    )
    .map((row) => row.id!);
  const cascade: AppliedOp[] =
    leftoverLabels.length > 0 && leftoverLabels.length === unclaimedIds.length
      ? leftoverLabels.map((label, index) => ({
          domain: "reminders",
          op: "remove",
          id: unclaimedIds[index],
          label,
        }))
      : [];
  return [...saved, ...fromChanges, ...cascade];
}

/**
 * `missed` stores a display label when the request had an item name, so the
 * string is not the clock id. Pair those known misses onto the requested
 * remove ids that did not apply, in request order.
 */
function reminderMissesAsApplyMisses(
  missed: string[],
  requested: RequestedOp[],
  applied: AppliedOp[],
): ApplyMiss[] {
  const appliedIds = new Set(
    applied.flatMap((row) => (row.id ? [row.id] : [])),
  );
  const unclaimed = requested.filter(
    (row) =>
      row.domain === "reminders" &&
      row.op === "remove" &&
      Boolean(row.id) &&
      !appliedIds.has(row.id!),
  );
  if (missed.length > 0 && unclaimed.length === missed.length) {
    return missed.map((token, index) => {
      const id = unclaimed[index]!.id!;
      const label = token.trim();
      return {
        domain: "reminders" as const,
        reason: "missed",
        id,
        op: "remove",
        ...(label && label !== id ? { detail: label } : {}),
      };
    });
  }
  return missed.map((id) => ({
    domain: "reminders" as const,
    reason: "missed",
    id,
  }));
}

export function buildApplyResult(input: {
  requested: CapturedRequested;
  intentMisses?: IntentMiss[];
  dumpGuardDrops?: DumpGuardDrop[];
  /** Classified stripShowTurnMutates drops (known reason). */
  stripMisses?: ResultIntentMiss[];
  /** Strip removals without a definite reason — force unknown. */
  unclassifiedStripDrops?: RequestedOp[];
  listMutations?: ListItemMutation[];
  filingMutations?: FilingMutation[];
  shareMisses?: ShareApplyMiss[];
  /** NEW task+nested-remind transaction failures (lists apply_miss). */
  nestedRemindMisses?: Array<{
    reason: string;
    op: string;
    listType: string;
    listName?: string;
    itemLabel: string;
    detail?: string;
    /** Per-clock labels in the failed package. */
    remindLabels?: string[];
  }>;
  listOpResults?: ListOpResult[];
  reminderResult?: {
    saved: Array<{ id: string; itemLabel?: string; item?: string }>;
    /** Cancelled reminder labels (the delete fallback). Not clock ids. */
    removed?: string[];
    /** Missed reminder ids, or the item label when the request named one. */
    missed?: string[];
    skipped?: Array<{ reason?: string; item?: string }>;
    changes?: Array<{ action: string; label?: string; id?: string }>;
  };
  directoryResult?: {
    saved: Array<{ id: string; name?: string }>;
    /** Removed contact ids. */
    removed: string[];
  };
}): ApplyResult {
  const domains: ApplyResult["domains"] = {};
  const stripMisses = input.stripMisses ?? [];
  const unclassifiedStrip = input.unclassifiedStripDrops ?? [];

  const listRequested = requestedOpsFromLists(input.requested.lists);
  if (listRequested.length > 0) {
    const intent_misses: ResultIntentMiss[] = [
      ...(input.intentMisses ?? []).map((miss) => ({
        reason: miss.reason,
        mutateSource: miss.mutateSource,
        dumpLine: miss.dumpLine,
        itemId: miss.itemId,
        listId: miss.listId,
        listType: miss.listType,
        listName: miss.listName,
        ...(miss.op ? { op: miss.op } : {}),
        ...(miss.label ? { label: miss.label } : {}),
        source: "intent" as const,
      })),
      ...(input.dumpGuardDrops ?? []).map((drop) => ({
        reason: drop.reason,
        itemId: drop.itemId,
        listType: drop.listType,
        listName: drop.listName,
        op: drop.op,
        domain: "lists" as const,
        source: "dump_guard" as const,
        ...(drop.dumpLine ? { dumpLine: drop.dumpLine } : {}),
        ...(drop.label ? { label: drop.label } : {}),
      })),
      ...stripMisses.filter((miss) => miss.domain === "lists"),
    ];
    const applied: AppliedOp[] = (input.listMutations ?? []).map((row) => ({
      domain: "lists" as const,
      op: row.action,
      id: row.itemId,
      label: row.itemLabel,
      listType: row.listType,
      listName: row.listName,
      employeeId: row.employeeId,
      ...(row.calendarYmd ? { calendarYmd: row.calendarYmd } : {}),
      ...(row.listShell ? { listShell: true } : {}),
      ...(row.inNewList ? { inNewList: true } : {}),
    }));
    const apply_misses: ApplyMiss[] = [
      ...(input.shareMisses ?? []).map((miss) => ({
        domain: "lists" as const,
        reason: miss.reason,
        id: miss.itemId,
        ...(miss.op ? { op: miss.op } : {}),
        ...(miss.listType ? { listType: miss.listType } : {}),
        ...(miss.label ? { detail: miss.label } : {}),
        ...(miss.dumpLine ? { dumpLine: miss.dumpLine } : {}),
      })),
      ...(input.nestedRemindMisses ?? []).map((miss) => ({
        domain: "lists" as const,
        reason: miss.reason,
        op: miss.op,
        listType: miss.listType,
        listName: miss.listName,
        detail: miss.detail ?? miss.itemLabel,
      })),
    ];
    const unclassified_drops = unclassifiedStrip.filter(
      (op) => op.domain === "lists",
    );
    domains.lists = {
      requested: listRequested,
      applied,
      intent_misses,
      apply_misses,
      ...(unclassified_drops.length > 0 ? { unclassified_drops } : {}),
      completeness: computeDomainCompleteness({
        requested: listRequested,
        applied,
        intent_misses,
        apply_misses,
        unclassified_drops,
        // Nested NEW-task+remind txn failure is an explicit package miss —
        // never report domain completeness=complete for that fate.
        reportingIncomplete: (input.nestedRemindMisses?.length ?? 0) > 0,
      }),
    };
  }

  const filingRequested = requestedOpsFromFiling(input.requested.filing);
  if (filingRequested.length > 0) {
    // FilingMutation uses short add|update|remove; requested/ApplyResult ops
    // are add_filing|update_filing|remove_filing — map so shell pairing works.
    const applied: AppliedOp[] = (input.filingMutations ?? []).map((row) => ({
      domain: "filing" as const,
      op:
        row.action === "add"
          ? "add_filing"
          : row.action === "update"
            ? "update_filing"
            : "remove_filing",
      id: row.filingId?.trim() || undefined,
      label: row.itemName,
      listType: "filing",
      listName: "תיוקים",
    }));
    const intent_misses = stripMisses.filter((miss) => miss.domain === "filing");
    const unclassified_drops = unclassifiedStrip.filter(
      (op) => op.domain === "filing",
    );
    // No apply_miss channel for silent filing failures → unaccounted request
    // stays unknown. Successful applied rows pair via computeDomainCompleteness
    // (id-less add_filing ↔ applied add_filing) and must NOT force unknown.
    domains.filing = {
      requested: filingRequested,
      applied,
      intent_misses,
      apply_misses: [],
      ...(unclassified_drops.length > 0 ? { unclassified_drops } : {}),
      completeness: computeDomainCompleteness({
        requested: filingRequested,
        applied,
        intent_misses,
        apply_misses: [],
        unclassified_drops,
      }),
    };
  }

  const reminderRequested = requestedOpsFromReminders(input.requested.reminders);
  const nestedReminderMisses: ApplyMiss[] = (input.nestedRemindMisses ?? []).flatMap(
    (miss) => {
      const labels =
        Array.isArray(miss.remindLabels) && miss.remindLabels.length > 0
          ? miss.remindLabels
          : [miss.itemLabel];
      return labels.map((label) => ({
        domain: "reminders" as const,
        reason: "nested_remind_txn_failed",
        op: "add",
        detail: label,
      }));
    },
  );
  const rr = input.reminderResult;
  // Nested-only success: clocks from items[].remind land in reminderResult.saved
  // even when metadata.reminders was empty — still open the reminders domain.
  const hasReminderOutcome =
    (rr?.saved?.length ?? 0) > 0 ||
    (rr?.removed?.length ?? 0) > 0 ||
    (rr?.changes?.length ?? 0) > 0 ||
    (rr?.missed?.length ?? 0) > 0 ||
    (rr?.skipped?.length ?? 0) > 0;
  if (
    reminderRequested.length > 0 ||
    nestedReminderMisses.length > 0 ||
    hasReminderOutcome
  ) {
    const applied = reminderAppliedOps(rr, reminderRequested);
    const intent_misses = stripMisses.filter(
      (miss) => miss.domain === "reminders",
    );
    const unclassified_drops = unclassifiedStrip.filter(
      (op) => op.domain === "reminders",
    );
    const apply_misses: ApplyMiss[] = [
      ...reminderMissesAsApplyMisses(
        rr?.missed ?? [],
        reminderRequested,
        applied,
      ),
      ...(rr?.skipped ?? []).map((row) => ({
        domain: "reminders" as const,
        reason: String(row.reason ?? "skipped"),
        detail: row.item,
      })),
      ...nestedReminderMisses,
    ];
    domains.reminders = {
      requested: reminderRequested,
      applied,
      intent_misses,
      apply_misses,
      ...(unclassified_drops.length > 0 ? { unclassified_drops } : {}),
      completeness: computeDomainCompleteness({
        requested: reminderRequested,
        applied,
        intent_misses,
        apply_misses,
        unclassified_drops,
        reportingIncomplete: nestedReminderMisses.length > 0,
      }),
    };
  }

  const directoryRequested = requestedOpsFromDirectory(
    input.requested.directory,
  );
  if (directoryRequested.length > 0) {
    const dr = input.directoryResult;
    const applied: AppliedOp[] = [
      ...(dr?.saved ?? []).map((row) => ({
        domain: "directory" as const,
        op: "add",
        id: row.id,
        label: row.name,
      })),
      ...(dr?.removed ?? []).map((id) => ({
        domain: "directory" as const,
        op: "remove",
        id,
      })),
    ];
    const intent_misses = stripMisses.filter(
      (miss) => miss.domain === "directory",
    );
    const unclassified_drops = unclassifiedStrip.filter(
      (op) => op.domain === "directory",
    );
    const allStripClassified =
      unclassified_drops.length === 0 &&
      directoryRequested.every((req) =>
        intent_misses.some((miss) => missMatchesRequested(miss, req)),
      );
    domains.directory = {
      requested: directoryRequested,
      applied,
      intent_misses,
      apply_misses: [],
      ...(unclassified_drops.length > 0 ? { unclassified_drops } : {}),
      completeness: allStripClassified
        ? computeDomainCompleteness({
            requested: directoryRequested,
            applied,
            intent_misses,
            apply_misses: [],
            unclassified_drops,
          })
        : "unknown",
    };
  }

  const listOpsRequested = requestedOpsFromListOps(input.requested.listOps);
  if (listOpsRequested.length > 0) {
    const applied: AppliedOp[] = [];
    const apply_misses: ApplyMiss[] = [];
    for (const row of input.listOpResults ?? []) {
      if (row.applied) {
        applied.push({
          domain: "list_ops",
          op: row.action,
          id: row.listId,
          label: row.listLabel,
          listType: row.listType,
          listName: row.listName,
          listId: row.listId,
        });
      } else if (row.refusal) {
        apply_misses.push({
          domain: "list_ops",
          reason: row.refusal.reason,
          id: row.listId,
          op: row.action,
          detail: row.refusal.detail,
        });
      }
    }
    const intent_misses = stripMisses.filter(
      (miss) => miss.domain === "list_ops",
    );
    const unclassified_drops = unclassifiedStrip.filter(
      (op) => op.domain === "list_ops",
    );
    const accounted =
      applied.length + apply_misses.length + intent_misses.length;
    domains.list_ops = {
      requested: listOpsRequested,
      applied,
      intent_misses,
      apply_misses,
      ...(unclassified_drops.length > 0 ? { unclassified_drops } : {}),
      completeness: computeDomainCompleteness({
        requested: listOpsRequested,
        applied,
        intent_misses,
        apply_misses,
        unclassified_drops,
        reportingIncomplete:
          unclassified_drops.length === 0 &&
          accounted < listOpsRequested.length &&
          intent_misses.length === 0,
      }),
    };
  }

  return {
    domains,
    completeness: rollupCompleteness(domains),
  };
}
