/**
 * Stage-2 intent-source gate for lists remove|update:
 * - dump_line → server maps n from THIS turn's LAST_NUMBERED_DUMP
 * - saved_data → id must appear in THIS turn's injected ESD/WORKER snapshot map
 * - missing mutate_source → leave untouched (legacy → H fallback); never infer saved_data
 *
 * Apply remains the authority for live existence, ownership, and permissions.
 */
import type { LlmListAction } from "@workee/shared";
import type { EmployeeRecordSnapshot } from "./employee-records.service.js";
import {
  resolveDumpLineId,
  type LastNumberedDumpLine,
} from "./show-button-dump.js";

export type IntentRefDomain = "list" | "filing" | "reminders";

export type IntentRefMeta = {
  domain: IntentRefDomain;
  listType?: string;
  listId?: string;
  listName?: string;
};

export type IntentMissReason =
  | "invalid_source"
  | "dump_line_invalid"
  | "dump_empty"
  | "not_in_this_turn_facts"
  | "list_id_mismatch"
  | "missing_id";

export type IntentMiss = {
  reason: IntentMissReason;
  mutateSource?: string;
  dumpLine?: number;
  itemId?: string;
  listId?: string;
  listType?: string;
  listName?: string;
  /** Dump title when this miss can name the row that was not changed. */
  label?: string;
};

export type ResolveIntentRefsResult = {
  lists: LlmListAction[];
  misses: IntentMiss[];
  /** Ids stamped by a successful intent resolve — H must not drop these. */
  passThroughIds: Set<string>;
};

const MUTATE_SOURCES = new Set(["dump_line", "saved_data"]);

function readTrimmedString(raw: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function actionItemIdFromRaw(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "";
  }
  return readTrimmedString(raw as Record<string, unknown>, [
    "item_id",
    "itemId",
    "id",
    "filing_id",
    "filingId",
    "reminder_id",
    "reminderId",
  ]);
}

function readMutateSource(raw: Record<string, unknown>): string {
  const value = raw.mutate_source ?? raw.mutateSource;
  return typeof value === "string" ? value.trim() : "";
}

function readDumpLine(raw: Record<string, unknown>): number | null {
  const value = raw.dump_line ?? raw.dumpLine;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function readDumpSection(raw: Record<string, unknown>): string | null {
  const value = raw.dump_section ?? raw.dumpSection;
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

function indexSnapshot(
  snapshot: EmployeeRecordSnapshot | null | undefined,
  into: Map<string, IntentRefMeta>,
): void {
  if (!snapshot) {
    return;
  }
  for (const list of snapshot.lists ?? []) {
    const listType = String(list.list_type ?? "").trim();
    const listId =
      typeof list.list_id === "string" && list.list_id.trim()
        ? list.list_id.trim()
        : undefined;
    const listName =
      typeof list.list_name === "string" && list.list_name.trim()
        ? list.list_name.trim()
        : undefined;
    for (const item of list.items ?? []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const id = readTrimmedString(item as Record<string, unknown>, [
        "item_id",
        "itemId",
        "id",
      ]);
      if (!id || into.has(id)) {
        continue;
      }
      into.set(id, {
        domain: "list",
        ...(listType ? { listType } : {}),
        ...(listId ? { listId } : {}),
        ...(listName ? { listName } : {}),
      });
    }
  }
  for (const filing of snapshot.filing ?? []) {
    const id = String(filing.filing_id ?? "").trim();
    if (!id || into.has(id)) {
      continue;
    }
    into.set(id, { domain: "filing", listType: "filing" });
  }
  for (const reminder of snapshot.reminders ?? []) {
    const id = String(reminder.reminder_id ?? "").trim();
    if (!id || into.has(id)) {
      continue;
    }
    into.set(id, { domain: "reminders", listType: "reminders" });
  }
}

/** Build the this-turn visible id map from the same snapshots injected into facts. */
export function buildThisTurnVisibleRefs(
  speakerSnapshot: EmployeeRecordSnapshot | null | undefined,
  workerSnapshot?: EmployeeRecordSnapshot | null,
): Map<string, IntentRefMeta> {
  const map = new Map<string, IntentRefMeta>();
  indexSnapshot(speakerSnapshot, map);
  indexSnapshot(workerSnapshot, map);
  return map;
}

function dumpKindToListType(kind: string): string {
  const k = kind.trim().toLowerCase();
  if (k === "filings" || k === "filing") {
    return "filing";
  }
  if (k === "phone_book" || k === "contacts") {
    return "contacts";
  }
  return kind.trim();
}

function stampIdOnItem(
  raw: Record<string, unknown>,
  id: string,
  kind: string,
): Record<string, unknown> {
  const listType = dumpKindToListType(kind);
  const next: Record<string, unknown> = { ...raw };
  if (listType === "filing") {
    next.filing_id = id;
    delete next.item_id;
    delete next.itemId;
    delete next.id;
  } else if (listType === "reminders") {
    next.reminder_id = id;
    delete next.item_id;
    delete next.itemId;
    delete next.id;
  } else {
    next.item_id = id;
    delete next.itemId;
    delete next.id;
  }
  return next;
}

function resolveDumpLineItem(
  raw: Record<string, unknown>,
  action: LlmListAction,
  dump: ReadonlyArray<LastNumberedDumpLine>,
  misses: IntentMiss[],
  passThroughIds: Set<string>,
): Record<string, unknown> | null {
  if (dump.length === 0) {
    misses.push({
      reason: "dump_empty",
      mutateSource: "dump_line",
      listType: action.listType,
      listName: action.listName,
    });
    return null;
  }
  const n = readDumpLine(raw);
  if (n == null || n < 1) {
    misses.push({
      reason: "dump_line_invalid",
      mutateSource: "dump_line",
      listType: action.listType,
      listName: action.listName,
    });
    return null;
  }
  const section = readDumpSection(raw);
  const id = resolveDumpLineId(dump, n, section);
  if (!id) {
    misses.push({
      reason: "dump_line_invalid",
      mutateSource: "dump_line",
      dumpLine: n,
      listType: action.listType,
      listName: action.listName,
    });
    return null;
  }
  const line = dump.find((row) => row.id === id && row.n === n) ??
    dump.find((row) => row.id === id);
  const kind = line?.kind?.trim() || action.listType;
  passThroughIds.add(id);
  return stampDumpTitle(stampIdOnItem(raw, id, kind), kind, line?.title_stem ?? "");
}

/** So a later apply miss can name the dump row, not only its opaque id. */
function stampDumpTitle(
  item: Record<string, unknown>,
  kind: string,
  titleStem: string,
): Record<string, unknown> {
  const stem = titleStem.trim();
  if (!stem) {
    return item;
  }
  const key =
    kind === "shopping"
      ? "שם פריט"
      : kind === "contacts" || kind === "phone_book"
        ? "שם פרטי"
        : kind === "tasks"
          ? "שם משימה"
          : "תיאור";
  const existing = item[key];
  if (typeof existing === "string" && existing.trim()) {
    return item;
  }
  return { ...item, [key]: stem };
}

function resolveSavedDataItem(
  raw: Record<string, unknown>,
  action: LlmListAction,
  visibleRefs: ReadonlyMap<string, IntentRefMeta>,
  misses: IntentMiss[],
  passThroughIds: Set<string>,
): Record<string, unknown> | null {
  const id = actionItemIdFromRaw(raw);
  if (!id) {
    misses.push({
      reason: "missing_id",
      mutateSource: "saved_data",
      listType: action.listType,
      listName: action.listName,
      listId: action.listId,
    });
    return null;
  }
  const meta = visibleRefs.get(id);
  if (!meta) {
    misses.push({
      reason: "not_in_this_turn_facts",
      mutateSource: "saved_data",
      itemId: id,
      listType: action.listType,
      listName: action.listName,
      listId: action.listId,
    });
    return null;
  }
  const actionListId = action.listId?.trim() ?? "";
  if (actionListId) {
    const homeListId = meta.listId?.trim() ?? "";
    if (!homeListId || homeListId !== actionListId) {
      misses.push({
        reason: "list_id_mismatch",
        mutateSource: "saved_data",
        itemId: id,
        listId: actionListId,
        listType: action.listType,
        listName: action.listName,
      });
      return null;
    }
  }
  passThroughIds.add(id);
  return raw;
}

/**
 * Resolve explicit intent-source markers on lists remove|update items.
 * Items without mutate_source are left unchanged for the legacy H path.
 */
export function resolveIntentRefs(
  lists: LlmListAction[],
  input: {
    dump: ReadonlyArray<LastNumberedDumpLine>;
    visibleRefs: ReadonlyMap<string, IntentRefMeta>;
  },
): ResolveIntentRefsResult {
  const misses: IntentMiss[] = [];
  const passThroughIds = new Set<string>();
  if (lists.length === 0) {
    return { lists, misses, passThroughIds };
  }

  const next: LlmListAction[] = [];
  for (const action of lists) {
    if (action.action !== "remove" && action.action !== "update") {
      next.push(action);
      continue;
    }
    const items = Array.isArray(action.items) ? action.items : [];
    if (items.length === 0) {
      next.push(action);
      continue;
    }

    const kept: Record<string, unknown>[] = [];
    let listType = action.listType;
    let listName = action.listName;
    let touchedDumpLine = false;

    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        kept.push(rawItem as Record<string, unknown>);
        continue;
      }
      const raw = rawItem as Record<string, unknown>;
      const source = readMutateSource(raw);
      if (!source) {
        // Legacy: do not infer saved_data.
        kept.push(raw);
        continue;
      }
      if (!MUTATE_SOURCES.has(source)) {
        misses.push({
          reason: "invalid_source",
          mutateSource: source,
          listType: action.listType,
          listName: action.listName,
          listId: action.listId,
        });
        continue;
      }
      if (source === "dump_line") {
        const resolved = resolveDumpLineItem(
          raw,
          action,
          input.dump,
          misses,
          passThroughIds,
        );
        if (!resolved) {
          continue;
        }
        kept.push(resolved);
        touchedDumpLine = true;
        const lineId = actionItemIdFromRaw(resolved);
        const line = input.dump.find((row) => row.id === lineId) ?? null;
        if (line?.kind) {
          const mapped = dumpKindToListType(line.kind);
          if (
            mapped === "shopping" ||
            mapped === "tasks" ||
            mapped === "custom" ||
            mapped === "contacts"
          ) {
            listType = mapped as LlmListAction["listType"];
          }
          if (line.kind === "custom" && line.list_name?.trim()) {
            listName = line.list_name.trim();
          }
        }
        continue;
      }
      const saved = resolveSavedDataItem(
        raw,
        action,
        input.visibleRefs,
        misses,
        passThroughIds,
      );
      if (!saved) {
        continue;
      }
      kept.push(saved);
    }

    if (kept.length === 0) {
      continue;
    }
    next.push({
      ...action,
      ...(touchedDumpLine ? { listType, listName } : {}),
      items: kept,
    });
  }

  return { lists: next, misses, passThroughIds };
}
