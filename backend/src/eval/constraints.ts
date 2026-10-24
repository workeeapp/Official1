import type { LlmMetadata } from "@workee/shared";
import {
  parseFlightsAction,
  parseJewishAction,
  parseMarketAction,
  parsePlacesAction,
  parseRoutesAction,
  parseWeatherAction,
} from "@workee/shared";
import { resolveRelativeDateLabel } from "../utils/relative-date.js";

export type ModelEvalTag =
  | "happy"
  | "action-confusion"
  | "hallucination-boundaries"
  | "safety-rails"
  | "continuity";

/** Live board domains scored by LIVE_MODEL ACTION constraints (not mutations). */
export type LiveDomainKey =
  | "weather"
  | "market"
  | "jewish"
  | "places"
  | "routes"
  | "flights";

const LIVE_DOMAIN_KEYS: LiveDomainKey[] = [
  "weather",
  "market",
  "jewish",
  "places",
  "routes",
  "flights",
];

export type ModelEvalConstraint =
  | {
      type: "filing_has_action";
      action: string;
      infoIncludes?: string;
      /** When set, at least one matching filing action must use this exact filing_id. */
      filingId?: string;
    }
  | { type: "filing_empty" }
  | { type: "lists_empty" }
  /** Reject any list_ops row (delete_list, alter_list, …). Prefer for item-level deletes. */
  | { type: "list_ops_empty" }
  | {
      type: "lists_has_action";
      action: string;
      listType?: string;
      minCount?: number;
      maxCount?: number;
      /** At least one item JSON must contain this substring (e.g. phone digits). */
      itemTextIncludes?: string;
    }
  | {
      type: "lists_remove_item_ids";
      /** Exact set of item_id values that must be removed (no missing, extra, or duplicates). */
      itemIds: string[];
      listType?: string;
      /**
       * When true (default), every lists action must be remove (of listType if set).
       * Set false when the turn also legitimately emits lists.add/update.
       */
      exclusive?: boolean;
    }
  | {
      type: "list_ops_has_action";
      action: "delete_list" | "alter_list";
      minCount?: number;
      maxCount?: number;
    }
  | {
      type: "list_ops_delete_list_ids";
      /** Exact set of list_id values on delete_list ops (no missing, extra, or duplicates). */
      listIds: string[];
    }
  | { type: "no_list_ops_delete" }
  | { type: "no_lists_remove"; listType?: string }
  /** Reject lists.add (optionally scoped to listType). Used by COMPLEX EVENTS host-only turns. */
  | { type: "no_lists_add"; listType?: string }
  | { type: "not_lists_remove_shopping" }
  | {
      type: "directory_has_action";
      action: string;
      nameIncludes?: string;
      phoneIncludes?: string;
    }
  | {
      type: "directory_remove_contact_ids";
      /** Exact set of contact_id values on directory.remove (no missing/extra/duplicates). */
      contactIds: string[];
    }
  | { type: "directory_empty" }
  | {
      type: "reminders_has_action";
      action: string;
      /**
       * When true, at least one matching add must be recurring via everyCount+everyUnit
       * or recurrence {freq:"interval", unit:"hours", …}.
       */
      recurring?: boolean;
    }
  | {
      type: "reminders_remove_ids";
      /** Exact set of reminder_id values on reminders.remove. */
      reminderIds: string[];
    }
  /** No reminders.* actions (forbid offer/create clocks on this turn). */
  | { type: "reminders_empty" }
  | {
      type: "jobs_has_action";
      action: string;
      /** When true, answerText on at least one matching open must be non-empty. */
      requireAsk?: boolean;
    }
  | { type: "no_invented_reminder_add" }
  | { type: "hold_present" }
  | { type: "hold_or_confirm" }
  | { type: "hold_or_confirm_or_ask" }
  /** Clarification phrasing only — never substitutes for empty-mutation checks. */
  | { type: "response_looks_like_ask" }
  | { type: "no_query_report" }
  | { type: "mutations_empty_or_read_only" }
  | { type: "no_silent_multi_domain_wipe" }
  /** metadata.show_dump must equal this value (e.g. "full"). */
  | { type: "show_dump"; value: string }
  | { type: "response_mentions_any"; needles: string[] }
  /** Every needle must appear in the response (AND). */
  | { type: "response_mentions_all"; needles: string[] }
  | { type: "response_forbids_any"; needles: string[] }
  /**
   * At least one metadata.messages row. Prefer over response text for
   * coordination / outbound checks (e.g. meeting book with Amit).
   */
  | {
      type: "messages_has";
      minCount?: number;
      /** At least one message target must include this substring (fold). */
      targetIncludes?: string;
      /** At least one matching message text must include this substring. */
      textIncludes?: string;
      /** When true, at least one matching message must carry a book slot. */
      requireBook?: boolean;
    }
  /**
   * Exactly one live board domain may be non-null (parse*Action).
   * Used to keep NL→ACTION cases domain-isolated without provider HTTP.
   */
  | { type: "live_domain_only"; domain: LiveDomainKey }
  /** No live board domain ACTION (clarify / ASK turn before emitting). */
  | { type: "live_domains_empty" }
  | {
      type: "weather_action";
      placeIncludes?: string;
      /** Every listed aspect must appear on the parsed weather ACTION. */
      aspectsIncludes?: string[];
      /** None of these aspects may appear. */
      aspectsExcludes?: string[];
      /** When true, parsed date must be non-empty YYYY-MM-DD. */
      requireDate?: boolean;
      /**
       * Parsed weather.date must equal SESSION_CLOCK resolution of this label
       * (היום / מחר / אתמול) via resolveRelativeDateLabel — no hardcoded YMD.
       */
      dateEqualsRelative?: string;
    }
  | {
      type: "market_action";
      /** At least one query must include any of these substrings (fold). */
      queryIncludesAny?: string[];
      aspectsIncludes?: string[];
      aspectsExcludes?: string[];
    }
  | {
      type: "jewish_action";
      placeIncludes?: string;
      /** When true, place may be empty (parasha / holidays alone). */
      allowEmptyPlace?: boolean;
      aspectsIncludes?: string[];
      aspectsExcludes?: string[];
    }
  | {
      type: "places_action";
      queryIncludes?: string;
      placeIncludes?: string;
      intent?: "business" | "parking";
      openNow?: boolean;
      minRatingAtLeast?: number;
      aspectsIncludes?: string[];
      aspectsExcludes?: string[];
    }
  | {
      type: "routes_action";
      originIncludes?: string;
      destinationIncludes?: string;
      /** When true, parsed destination must be empty (e.g. stop-board lines). */
      destinationEmpty?: boolean;
      lineIncludes?: string;
      /** When true, parsed stopCode must be non-empty. */
      requireStopCode?: boolean;
      aspectsIncludes?: string[];
      aspectsExcludes?: string[];
    }
  | {
      type: "flights_action";
      airportIncludes?: string;
      direction?: "arrivals" | "departures" | "both";
      cityIncludes?: string;
      flightIncludes?: string;
      aspectsIncludes?: string[];
      aspectsExcludes?: string[];
    }
  /**
   * lists.update/add items must cover exactly these item_ids and each must
   * include every listed attachment_id (attachment intent scoring).
   */
  | {
      type: "lists_attach_item_ids";
      action: "update" | "add";
      itemIds: string[];
      attachmentIds: string[];
      listType?: string;
    }
  /** At least one filing action carries every listed attachment_id. */
  | {
      type: "filing_attach_ids";
      action: string;
      attachmentIds: string[];
    }
  | { type: "any"; constraints: ModelEvalConstraint[] };

export interface ModelEvalCaseResult {
  ok: boolean;
  failures: string[];
}

function includesFold(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function readItemId(item: Record<string, unknown>): string {
  for (const key of ["item_id", "itemId", "id"]) {
    const raw = item[key];
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }
  }
  return "";
}

function readAttachmentIds(row: Record<string, unknown>): string[] {
  const raw = row.attachment_ids ?? row.attachmentIds;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
    .map((id) => id.trim());
}

function sortedCopy(ids: string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function sameIdMultiset(actual: string[], expected: string[]): string | null {
  if (actual.some((id) => !id)) {
    return "empty id in mutation set";
  }
  const uniq = new Set(actual);
  if (uniq.size !== actual.length) {
    return `duplicate ids in mutation set: ${actual.join(",")}`;
  }
  const a = sortedCopy(actual);
  const e = sortedCopy(expected);
  if (a.length !== e.length) {
    return `id set size ${a.length} != expected ${e.length} (got [${a.join(",")}] want [${e.join(",")}])`;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== e[i]) {
      return `id set mismatch (got [${a.join(",")}] want [${e.join(",")}])`;
    }
  }
  return null;
}

function readFilingId(row: { filingId?: string }): string {
  return typeof row.filingId === "string" ? row.filingId.trim() : "";
}

function readReminderId(row: { reminderId?: string }): string {
  return typeof row.reminderId === "string" ? row.reminderId.trim() : "";
}

function readContactId(row: { contactId?: string }): string {
  return typeof row.contactId === "string" ? row.contactId.trim() : "";
}

function isRecurringReminderAdd(row: {
  everyCount?: number | null;
  everyUnit?: string | null;
  recurrence?: { freq?: string; interval?: number; unit?: string } | null;
}): boolean {
  if (
    typeof row.everyCount === "number" &&
    row.everyCount > 0 &&
    Boolean(row.everyUnit)
  ) {
    return true;
  }
  const rec = row.recurrence;
  if (!rec || typeof rec !== "object") {
    return false;
  }
  if (rec.freq === "interval") {
    return (
      typeof rec.interval === "number" &&
      rec.interval > 0 &&
      (rec.unit === "hours" || rec.unit === "days")
    );
  }
  return (
    (rec.freq === "daily" ||
      rec.freq === "weekly" ||
      rec.freq === "monthly" ||
      rec.freq === "yearly") &&
    typeof rec.interval === "number" &&
    rec.interval > 0
  );
}

function domainMutationCount(meta: LlmMetadata): {
  lists: number;
  listOps: number;
  filing: number;
  reminders: number;
  directory: number;
} {
  return {
    lists: meta.lists?.length ?? 0,
    listOps: meta.listOps?.length ?? 0,
    filing: meta.filing?.length ?? 0,
    reminders: meta.reminders?.length ?? 0,
    directory: meta.directory?.length ?? 0,
  };
}

function mutatedDomains(meta: LlmMetadata): number {
  const counts = domainMutationCount(meta);
  return (
    (counts.lists > 0 ? 1 : 0) +
    (counts.listOps > 0 ? 1 : 0) +
    (counts.filing > 0 ? 1 : 0) +
    (counts.reminders > 0 ? 1 : 0) +
    (counts.directory > 0 ? 1 : 0)
  );
}

function hasHold(meta: LlmMetadata): boolean {
  return Boolean(
    (meta as { hold?: unknown }).hold &&
      typeof (meta as { hold?: unknown }).hold === "object",
  );
}

/** Re-parse live domains from typed metadata (same parse*Action path as production). */
function liveMetaBag(meta: LlmMetadata): Record<string, unknown> {
  return meta as unknown as Record<string, unknown>;
}

function aspectsIncludeAll(
  actual: string[] | undefined,
  want: string[] | undefined,
  label: string,
): string | null {
  if (!want?.length) return null;
  const have = actual ?? [];
  const missing = want.filter(
    (a) => !have.some((h) => h.toLowerCase() === a.toLowerCase()),
  );
  return missing.length === 0
    ? null
    : `${label} missing aspects: ${missing.join(",")} (got [${have.join(",")}])`;
}

function aspectsExcludeAny(
  actual: string[] | undefined,
  forbid: string[] | undefined,
  label: string,
): string | null {
  if (!forbid?.length) return null;
  const have = actual ?? [];
  const hit = forbid.find((a) =>
    have.some((h) => h.toLowerCase() === a.toLowerCase()),
  );
  return hit ? `${label} must not include aspect ${hit}` : null;
}

function parseLiveDomain(
  domain: LiveDomainKey,
  bag: Record<string, unknown>,
): unknown {
  switch (domain) {
    case "weather":
      return parseWeatherAction(bag);
    case "market":
      return parseMarketAction(bag);
    case "jewish":
      return parseJewishAction(bag);
    case "places":
      return parsePlacesAction(bag);
    case "routes":
      return parseRoutesAction(bag);
    case "flights":
      return parseFlightsAction(bag);
  }
}

function activeLiveDomains(meta: LlmMetadata): LiveDomainKey[] {
  const bag = liveMetaBag(meta);
  return LIVE_DOMAIN_KEYS.filter((domain) => Boolean(parseLiveDomain(domain, bag)));
}

export function looksLikeAsk(response: string): boolean {
  const text = response.trim();
  if (!text) {
    return false;
  }
  return (
    /[?？]/.test(text) ||
    /(?:מתי|מה |איזה|איזו|האם|לאשר|בטוח|רוצה ש|אוכל|תרצה|תאשרי|לא מצא)/.test(
      text,
    )
  );
}

export function checkConstraint(
  constraint: ModelEvalConstraint,
  meta: LlmMetadata,
  response: string,
): string | null {
  switch (constraint.type) {
    case "any": {
      const failures = constraint.constraints.map((row) =>
        checkConstraint(row, meta, response),
      );
      if (failures.some((row) => row === null)) {
        return null;
      }
      return `any: none matched (${failures.filter(Boolean).join("; ")})`;
    }
    case "filing_has_action": {
      const rows = (meta.filing ?? []).filter(
        (row) => row.action === constraint.action,
      );
      if (rows.length === 0) {
        return `expected filing.${constraint.action}`;
      }
      if (constraint.filingId) {
        const hit = rows.some((row) => readFilingId(row) === constraint.filingId);
        if (!hit) {
          return `filing.${constraint.action} missing filing_id ${constraint.filingId}`;
        }
      }
      if (
        constraint.infoIncludes &&
        !rows.some((row) => includesFold(row.itemInfo ?? "", constraint.infoIncludes!))
      ) {
        return `filing.${constraint.action} missing info ${constraint.infoIncludes}`;
      }
      return null;
    }
    case "filing_empty":
      return (meta.filing?.length ?? 0) === 0
        ? null
        : `expected empty filing, got ${meta.filing?.length}`;
    case "lists_empty":
      return (meta.lists?.length ?? 0) === 0
        ? null
        : `expected empty lists, got ${meta.lists?.length}`;
    case "list_ops_empty":
      return (meta.listOps?.length ?? 0) === 0
        ? null
        : `expected empty list_ops, got ${meta.listOps?.length}`;
    case "lists_has_action": {
      const rows = (meta.lists ?? []).filter((row) => {
        if (row.action !== constraint.action) {
          return false;
        }
        if (constraint.listType && row.listType !== constraint.listType) {
          return false;
        }
        return true;
      });
      const itemCount = rows.reduce((sum, row) => sum + (row.items?.length ?? 0), 0);
      const count = Math.max(rows.length, itemCount);
      if (constraint.minCount !== undefined && count < constraint.minCount) {
        return `lists.${constraint.action}${constraint.listType ? `/${constraint.listType}` : ""} count ${count} < ${constraint.minCount}`;
      }
      if (constraint.maxCount !== undefined && count > constraint.maxCount) {
        return `lists.${constraint.action}${constraint.listType ? `/${constraint.listType}` : ""} count ${count} > ${constraint.maxCount}`;
      }
      if (rows.length === 0) {
        return `expected lists.${constraint.action}${constraint.listType ? `/${constraint.listType}` : ""}`;
      }
      if (constraint.itemTextIncludes) {
        const needle = constraint.itemTextIncludes;
        const hit = rows.some((row) =>
          (row.items ?? []).some((item) =>
            includesFold(JSON.stringify(item), needle),
          ),
        );
        if (!hit) {
          return `lists.${constraint.action} missing item text ${needle}`;
        }
      }
      return null;
    }
    case "lists_attach_item_ids": {
      const rows = (meta.lists ?? []).filter((row) => {
        if (row.action !== constraint.action) {
          return false;
        }
        if (constraint.listType && row.listType !== constraint.listType) {
          return false;
        }
        return true;
      });
      const byItem = new Map<string, string[]>();
      for (const row of rows) {
        for (const item of row.items ?? []) {
          const rec = item as Record<string, unknown>;
          const id = readItemId(rec);
          if (!id) {
            continue;
          }
          byItem.set(id, readAttachmentIds(rec));
        }
      }
      const actualIds = [...byItem.keys()];
      const mismatch = sameIdMultiset(actualIds, constraint.itemIds);
      if (mismatch) {
        return `lists_attach_item_ids: ${mismatch}`;
      }
      for (const itemId of constraint.itemIds) {
        const got = new Set(byItem.get(itemId) ?? []);
        for (const att of constraint.attachmentIds) {
          if (!got.has(att)) {
            return `lists_attach_item_ids: item ${itemId} missing attachment ${att}`;
          }
        }
      }
      return null;
    }
    case "filing_attach_ids": {
      const rows = (meta.filing ?? []).filter(
        (row) => row.action === constraint.action,
      );
      if (rows.length === 0) {
        return `expected filing.${constraint.action}`;
      }
      const hit = rows.some((row) => {
        const got = new Set(
          readAttachmentIds(row as unknown as Record<string, unknown>),
        );
        return constraint.attachmentIds.every((id) => got.has(id));
      });
      return hit
        ? null
        : `filing.${constraint.action} missing attachment_ids ${constraint.attachmentIds.join(",")}`;
    }
    case "lists_remove_item_ids": {
      const lists = meta.lists ?? [];
      const exclusive = constraint.exclusive !== false;
      const removes = lists.filter((row) => row.action === "remove");
      if (exclusive) {
        if (lists.some((row) => row.action !== "remove")) {
          return `lists_remove_item_ids: unexpected non-remove lists action`;
        }
        if (
          constraint.listType &&
          removes.some((row) => row.listType !== constraint.listType)
        ) {
          return `lists_remove_item_ids: remove on unexpected list_type`;
        }
      } else if (
        constraint.listType &&
        removes.some((row) => row.listType !== constraint.listType)
      ) {
        return `lists_remove_item_ids: remove on unexpected list_type`;
      }
      const scoped = constraint.listType
        ? removes.filter((row) => row.listType === constraint.listType)
        : removes;
      const actual: string[] = [];
      for (const row of scoped) {
        for (const item of row.items ?? []) {
          actual.push(readItemId(item as Record<string, unknown>));
        }
      }
      const mismatch = sameIdMultiset(actual, constraint.itemIds);
      return mismatch ? `lists_remove_item_ids: ${mismatch}` : null;
    }
    case "list_ops_has_action": {
      const rows = (meta.listOps ?? []).filter(
        (row) => row.action === constraint.action,
      );
      if (rows.length === 0) {
        return `expected list_ops.${constraint.action}`;
      }
      if (constraint.minCount !== undefined && rows.length < constraint.minCount) {
        return `list_ops.${constraint.action} count ${rows.length} < ${constraint.minCount}`;
      }
      if (constraint.maxCount !== undefined && rows.length > constraint.maxCount) {
        return `list_ops.${constraint.action} count ${rows.length} > ${constraint.maxCount}`;
      }
      return null;
    }
    case "list_ops_delete_list_ids": {
      const ops = meta.listOps ?? [];
      const nonDelete = ops.filter((row) => row.action !== "delete_list");
      if (nonDelete.length > 0) {
        return `list_ops_delete_list_ids: unexpected list_ops action ${nonDelete.map((r) => r.action).join(",")}`;
      }
      const actual = ops.map((row) => row.listId.trim());
      const mismatch = sameIdMultiset(actual, constraint.listIds);
      return mismatch ? `list_ops_delete_list_ids: ${mismatch}` : null;
    }
    case "no_list_ops_delete": {
      const bad = (meta.listOps ?? []).some((row) => row.action === "delete_list");
      return bad ? "must not emit list_ops.delete_list" : null;
    }
    case "no_lists_remove": {
      const bad = (meta.lists ?? []).some((row) => {
        if (row.action !== "remove") {
          return false;
        }
        if (constraint.listType && row.listType !== constraint.listType) {
          return false;
        }
        return true;
      });
      return bad
        ? `must not lists.remove${constraint.listType ? `/${constraint.listType}` : ""}`
        : null;
    }
    case "no_lists_add": {
      const bad = (meta.lists ?? []).some((row) => {
        if (row.action !== "add") {
          return false;
        }
        if (constraint.listType && row.listType !== constraint.listType) {
          return false;
        }
        return true;
      });
      return bad
        ? `must not lists.add${constraint.listType ? `/${constraint.listType}` : ""}`
        : null;
    }
    case "not_lists_remove_shopping": {
      const bad = (meta.lists ?? []).some(
        (row) => row.action === "remove" && row.listType === "shopping",
      );
      return bad ? "must not lists.remove shopping for this ask" : null;
    }
    case "directory_has_action": {
      const rows = (meta.directory ?? []).filter(
        (row) => row.action === constraint.action,
      );
      if (rows.length === 0) {
        return `expected directory.${constraint.action}`;
      }
      if (
        constraint.nameIncludes &&
        !rows.some((row) => includesFold(row.name ?? "", constraint.nameIncludes!))
      ) {
        return `directory.${constraint.action} missing name ${constraint.nameIncludes}`;
      }
      if (
        constraint.phoneIncludes &&
        !rows.some((row) =>
          includesFold(
            String(row.phone ?? "").replace(/\D/g, ""),
            constraint.phoneIncludes!.replace(/\D/g, ""),
          ),
        )
      ) {
        return `directory.${constraint.action} missing phone ${constraint.phoneIncludes}`;
      }
      return null;
    }
    case "directory_remove_contact_ids": {
      const rows = (meta.directory ?? []).filter((row) => row.action === "remove");
      const other = (meta.directory ?? []).filter((row) => row.action !== "remove");
      if (other.length > 0) {
        return `directory_remove_contact_ids: unexpected directory action ${other.map((r) => r.action).join(",")}`;
      }
      const actual = rows.map((row) => readContactId(row));
      const mismatch = sameIdMultiset(actual, constraint.contactIds);
      return mismatch ? `directory_remove_contact_ids: ${mismatch}` : null;
    }
    case "directory_empty":
      return (meta.directory?.length ?? 0) === 0
        ? null
        : `expected empty directory, got ${meta.directory?.length}`;
    case "reminders_has_action": {
      const rows = (meta.reminders ?? []).filter(
        (row) => row.action === constraint.action,
      );
      if (rows.length === 0) {
        return `expected reminders.${constraint.action}`;
      }
      if (constraint.recurring && !rows.some((row) => isRecurringReminderAdd(row))) {
        return `expected reminders.${constraint.action} with recurrence or every_count+every_unit`;
      }
      return null;
    }
    case "reminders_remove_ids": {
      const rows = (meta.reminders ?? []).filter((row) => row.action === "remove");
      const other = (meta.reminders ?? []).filter((row) => row.action !== "remove");
      if (other.length > 0) {
        return `reminders_remove_ids: unexpected reminders action ${other.map((r) => r.action).join(",")}`;
      }
      const actual = rows.map((row) => readReminderId(row));
      const mismatch = sameIdMultiset(actual, constraint.reminderIds);
      return mismatch ? `reminders_remove_ids: ${mismatch}` : null;
    }
    case "reminders_empty":
      return (meta.reminders?.length ?? 0) === 0
        ? null
        : `expected empty reminders, got ${meta.reminders?.length}`;
    case "jobs_has_action": {
      const rows = (meta.jobs ?? []).filter(
        (row) => row.action === constraint.action,
      );
      if (rows.length === 0) {
        return `expected jobs.${constraint.action}`;
      }
      if (constraint.requireAsk && !rows.some((row) => row.answerText.trim())) {
        return `expected jobs.${constraint.action} with answer_text`;
      }
      return null;
    }
    case "no_invented_reminder_add": {
      const invented = (meta.reminders ?? []).some((row) => {
        if (row.action !== "add") {
          return false;
        }
        return Boolean(row.inSeconds || row.time || row.date);
      });
      return invented
        ? "invented reminders.add with a clock before asking"
        : null;
    }
    case "hold_present":
      return hasHold(meta) ? null : "expected metadata.hold";
    case "hold_or_confirm":
      return hasHold(meta) || meta.confirm === true
        ? null
        : "expected hold or confirm=true";
    case "hold_or_confirm_or_ask":
      return hasHold(meta) || meta.confirm === true || looksLikeAsk(response)
        ? null
        : "expected hold, confirm=true, or a clarifying ask in response";
    case "response_looks_like_ask":
      return looksLikeAsk(response) ? null : "expected clarifying ask in response";
    case "no_query_report":
      return (meta as { query?: string | null }).query === "report"
        ? "must not emit query report"
        : null;
    case "show_dump": {
      const actual = (meta.showDump ?? "").trim();
      return actual === constraint.value
        ? null
        : `expected show_dump=${constraint.value}, got ${actual || "(empty)"}`;
    }
    case "mutations_empty_or_read_only": {
      const counts = domainMutationCount(meta);
      const total =
        counts.lists +
        counts.listOps +
        counts.filing +
        counts.reminders +
        counts.directory;
      return total === 0
        ? null
        : `expected read-only turn, got mutations lists=${counts.lists} listOps=${counts.listOps} filing=${counts.filing} reminders=${counts.reminders} directory=${counts.directory}`;
    }
    case "no_silent_multi_domain_wipe": {
      if (hasHold(meta) || meta.confirm === true || looksLikeAsk(response)) {
        return null;
      }
      if (mutatedDomains(meta) >= 2) {
        return "silent wipe across ≥2 domains without hold/confirm/ask";
      }
      return null;
    }
    case "response_mentions_any": {
      if (constraint.needles.some((needle) => includesFold(response, needle))) {
        return null;
      }
      return `response missing any of: ${constraint.needles.join(", ")}`;
    }
    case "response_mentions_all": {
      const missing = constraint.needles.filter(
        (needle) => !includesFold(response, needle),
      );
      return missing.length === 0
        ? null
        : `response missing all-required: ${missing.join(", ")}`;
    }
    case "response_forbids_any": {
      const hit = constraint.needles.find((needle) =>
        includesFold(response, needle),
      );
      return hit ? `response must not mention: ${hit}` : null;
    }
    case "messages_has": {
      const rows = meta.messages ?? [];
      const minCount = constraint.minCount ?? 1;
      if (rows.length < minCount) {
        return `expected messages count >= ${minCount}, got ${rows.length}`;
      }
      let matched = rows;
      if (constraint.targetIncludes) {
        matched = matched.filter((row) =>
          (row.targets ?? []).some((t) =>
            includesFold(String(t), constraint.targetIncludes!),
          ),
        );
        if (matched.length === 0) {
          return `expected messages target~${constraint.targetIncludes}`;
        }
      }
      if (constraint.textIncludes) {
        matched = matched.filter((row) =>
          includesFold(row.text ?? "", constraint.textIncludes!),
        );
        if (matched.length === 0) {
          return `expected messages text~${constraint.textIncludes}`;
        }
      }
      if (constraint.requireBook) {
        const withBook = matched.filter(
          (row) => row.book && typeof row.book === "object",
        );
        if (withBook.length === 0) {
          return "expected messages entry with book";
        }
      }
      return null;
    }
    case "live_domain_only": {
      const active = activeLiveDomains(meta);
      if (active.length === 0) {
        return `expected live domain ${constraint.domain}, got none`;
      }
      if (active.length !== 1 || active[0] !== constraint.domain) {
        return `expected only live domain ${constraint.domain}, got [${active.join(",")}]`;
      }
      return null;
    }
    case "live_domains_empty": {
      const active = activeLiveDomains(meta);
      return active.length === 0
        ? null
        : `expected no live domain ACTION, got [${active.join(",")}]`;
    }
    case "weather_action": {
      const action = parseWeatherAction(liveMetaBag(meta));
      if (!action) return "expected metadata.weather ACTION";
      if (
        constraint.placeIncludes &&
        !includesFold(action.place, constraint.placeIncludes)
      ) {
        return `weather.place missing ~${constraint.placeIncludes} (got ${action.place})`;
      }
      if (constraint.requireDate && !/^\d{4}-\d{2}-\d{2}$/.test(action.date)) {
        return `weather.date required YYYY-MM-DD (got ${action.date || "(empty)"})`;
      }
      if (constraint.dateEqualsRelative?.trim()) {
        const want = resolveRelativeDateLabel(
          constraint.dateEqualsRelative.trim(),
        );
        if (!/^\d{4}-\d{2}-\d{2}$/.test(want)) {
          return `weather.dateEqualsRelative not a resolvable day label: ${constraint.dateEqualsRelative}`;
        }
        if (action.date !== want) {
          return `weather.date want ${want} (=${constraint.dateEqualsRelative.trim()} via SESSION_CLOCK), got ${action.date || "(empty)"}`;
        }
      }
      return (
        aspectsIncludeAll(action.aspects, constraint.aspectsIncludes, "weather") ??
        aspectsExcludeAny(action.aspects, constraint.aspectsExcludes, "weather")
      );
    }
    case "market_action": {
      const action = parseMarketAction(liveMetaBag(meta));
      if (!action) return "expected metadata.market ACTION";
      if (constraint.queryIncludesAny?.length) {
        const hit = action.queries.some((q) =>
          constraint.queryIncludesAny!.some((n) => includesFold(q, n)),
        );
        if (!hit) {
          return `market.queries missing any of [${constraint.queryIncludesAny.join(",")}] (got [${action.queries.join(",")}])`;
        }
      }
      return (
        aspectsIncludeAll(action.aspects, constraint.aspectsIncludes, "market") ??
        aspectsExcludeAny(action.aspects, constraint.aspectsExcludes, "market")
      );
    }
    case "jewish_action": {
      const action = parseJewishAction(liveMetaBag(meta));
      if (!action) return "expected metadata.jewish ACTION";
      if (!constraint.allowEmptyPlace && !action.place.trim()) {
        return "jewish.place required";
      }
      if (
        constraint.placeIncludes &&
        !includesFold(action.place, constraint.placeIncludes)
      ) {
        return `jewish.place missing ~${constraint.placeIncludes} (got ${action.place || "(empty)"})`;
      }
      return (
        aspectsIncludeAll(action.aspects, constraint.aspectsIncludes, "jewish") ??
        aspectsExcludeAny(action.aspects, constraint.aspectsExcludes, "jewish")
      );
    }
    case "places_action": {
      const action = parsePlacesAction(liveMetaBag(meta));
      if (!action) return "expected metadata.places ACTION";
      if (
        constraint.queryIncludes &&
        !includesFold(action.query, constraint.queryIncludes)
      ) {
        return `places.query missing ~${constraint.queryIncludes} (got ${action.query})`;
      }
      if (
        constraint.placeIncludes &&
        !includesFold(action.place, constraint.placeIncludes)
      ) {
        return `places.place missing ~${constraint.placeIncludes} (got ${action.place})`;
      }
      if (constraint.intent && action.intent !== constraint.intent) {
        return `places.intent want ${constraint.intent}, got ${action.intent}`;
      }
      if (
        constraint.openNow !== undefined &&
        action.openNow !== constraint.openNow
      ) {
        return `places.open_now want ${constraint.openNow}, got ${action.openNow}`;
      }
      if (
        constraint.minRatingAtLeast !== undefined &&
        (action.minRating == null ||
          action.minRating + 1e-9 < constraint.minRatingAtLeast)
      ) {
        return `places.min_rating >= ${constraint.minRatingAtLeast} (got ${action.minRating ?? "null"})`;
      }
      return (
        aspectsIncludeAll(action.aspects, constraint.aspectsIncludes, "places") ??
        aspectsExcludeAny(action.aspects, constraint.aspectsExcludes, "places")
      );
    }
    case "routes_action": {
      const action = parseRoutesAction(liveMetaBag(meta));
      if (!action) return "expected metadata.routes ACTION";
      if (
        constraint.originIncludes &&
        !includesFold(action.origin, constraint.originIncludes)
      ) {
        return `routes.origin missing ~${constraint.originIncludes} (got ${action.origin || "(empty)"})`;
      }
      if (
        constraint.destinationIncludes &&
        !includesFold(action.destination, constraint.destinationIncludes)
      ) {
        return `routes.destination missing ~${constraint.destinationIncludes} (got ${action.destination || "(empty)"})`;
      }
      if (constraint.destinationEmpty && action.destination.trim()) {
        return `routes.destination must be empty (got ${action.destination})`;
      }
      if (
        constraint.lineIncludes &&
        !includesFold(action.line, constraint.lineIncludes)
      ) {
        return `routes.line missing ~${constraint.lineIncludes} (got ${action.line || "(empty)"})`;
      }
      if (constraint.requireStopCode && !action.stopCode.trim()) {
        return "routes.stop_code required";
      }
      return (
        aspectsIncludeAll(action.aspects, constraint.aspectsIncludes, "routes") ??
        aspectsExcludeAny(action.aspects, constraint.aspectsExcludes, "routes")
      );
    }
    case "flights_action": {
      const action = parseFlightsAction(liveMetaBag(meta));
      if (!action) return "expected metadata.flights ACTION";
      if (
        constraint.airportIncludes &&
        !includesFold(action.airport, constraint.airportIncludes)
      ) {
        return `flights.airport missing ~${constraint.airportIncludes} (got ${action.airport || "(empty)"})`;
      }
      if (constraint.direction && action.direction !== constraint.direction) {
        return `flights.direction want ${constraint.direction}, got ${action.direction || "(empty)"}`;
      }
      if (
        constraint.cityIncludes &&
        !includesFold(action.city, constraint.cityIncludes)
      ) {
        return `flights.city missing ~${constraint.cityIncludes} (got ${action.city || "(empty)"})`;
      }
      if (
        constraint.flightIncludes &&
        !includesFold(action.flight, constraint.flightIncludes)
      ) {
        return `flights.flight missing ~${constraint.flightIncludes} (got ${action.flight || "(empty)"})`;
      }
      return (
        aspectsIncludeAll(
          action.aspects,
          constraint.aspectsIncludes,
          "flights",
        ) ??
        aspectsExcludeAny(action.aspects, constraint.aspectsExcludes, "flights")
      );
    }
    default: {
      const unknown = constraint as { type: string };
      return `unknown constraint ${unknown.type}`;
    }
  }
}

export function evaluateConstraints(
  constraints: ModelEvalConstraint[],
  meta: LlmMetadata,
  response: string,
): ModelEvalCaseResult {
  const failures = constraints
    .map((row) => checkConstraint(row, meta, response))
    .filter((row): row is string => Boolean(row));
  return { ok: failures.length === 0, failures };
}
