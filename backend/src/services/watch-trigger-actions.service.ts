/**
 * P0 Watch→Action: capture-time validation + headless execution of deferred
 * owner-only lists.add|update when a Watch condition matches.
 *
 * Does NOT call sendChatMessage or an Action-planning LLM.
 * Chat-level Gates that require utterance/conversation run at CAPTURE only;
 * execution re-checks owner-only allowlist + apply-layer permissions.
 */
import { createHash } from "node:crypto";
import type {
  LlmListAction,
  LlmMetadata,
  LlmOnTriggerActions,
  LlmOnTriggerListAction,
} from "@workee/shared";
import { emptyLlmMetadata } from "@workee/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import type { ComposeEvalFacts } from "./compose-condition.js";
import {
  applyEmployeeRecords,
  itemIdentity,
} from "./employee-records.service.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import type { LlmListType } from "@workee/shared";

export const WATCH_TRIGGER_PACKAGE_VERSION = 1 as const;
export const WATCH_TRIGGER_EXEC_VERSION = 1 as const;
/** Soft cap — prune only terminal event entries beyond this. */
export const WATCH_TRIGGER_EXEC_MAX_EVENTS = 32;

export type WatchTriggerActionMode = "static" | "event_bound";
export type WatchTriggerActionStatus = "pending" | "done" | "failed";

export type WatchTriggerPackageAction = {
  key: string;
  kind: "lists.add" | "lists.update";
  mode: WatchTriggerActionMode;
  list: LlmListAction;
  binds?: Record<string, string>;
};

export type WatchTriggerPackage = {
  version: typeof WATCH_TRIGGER_PACKAGE_VERSION;
  authorizedAt: string;
  actorEmployeeId: string;
  ownerEmployeeId: string;
  actions: WatchTriggerPackageAction[];
};

export type WatchTriggerActionExecState = {
  status: WatchTriggerActionStatus;
  attempts: number;
  lastError?: string;
  doneAt?: string;
  resultHint?: string;
};

export type WatchTriggerEventExec = {
  firstSeenAt: string;
  /** Independent of Action success. null = not attempted yet. */
  notified: boolean | null;
  notifiedAt?: string;
  actions: Record<string, WatchTriggerActionExecState>;
};

export type WatchTriggerExecLedger = {
  version: typeof WATCH_TRIGGER_EXEC_VERSION;
  events: Record<string, WatchTriggerEventExec>;
};

export type NormalizeWatchTriggerResult =
  | { ok: true; package: WatchTriggerPackage }
  | { ok: false; reason: string };

const ALLOWED_FACT_BINDS = new Set([
  "market.price",
  "market.fingerprint",
  "sports.matchId",
  "sports.kickoffIso",
  "sports.opponent",
  "flight.fingerprint",
  "bus.fingerprint",
]);

const BUILTIN_LIST_TYPES = new Set(["shopping", "tasks"]);

function stableActionKey(list: LlmListAction, index: number): string {
  const itemIds = list.items
    .map((item) =>
      String(
        (item as { item_id?: unknown; itemId?: unknown }).item_id ??
          (item as { itemId?: unknown }).itemId ??
          "",
      ).trim(),
    )
    .filter(Boolean)
    .join(",");
  const title = list.items
    .map((item) =>
      String(
        item["שם פריט"] ??
          item.title ??
          item.name ??
          item.item ??
          "",
      ).trim(),
    )
    .filter(Boolean)
    .join("|");
  const basis = [
    list.action,
    list.listType,
    list.listId ?? "",
    list.listName,
    itemIds || title || String(index),
  ].join("::");
  return `${list.action}:${createHash("sha256").update(basis).digest("hex").slice(0, 16)}`;
}

function stripShareTargets(list: LlmListAction): LlmListAction {
  return {
    ...list,
    targets: [],
    listAttachmentIds: undefined,
  };
}

function isOwnerOnlyListAction(list: LlmListAction): string | null {
  if (list.action !== "add" && list.action !== "update") {
    return `unsupported_action:${list.action}`;
  }
  if (list.listType === "contacts") {
    return "contacts_forbidden";
  }
  if (list.targets.length > 0) {
    return "targets_not_owner_only";
  }
  if (list.listAttachmentIds && list.listAttachmentIds.length > 0) {
    return "attachments_not_supported_p0";
  }
  if (list.action === "update") {
    const hasId = list.items.some((item) => {
      const id = String(
        (item as { item_id?: unknown; itemId?: unknown }).item_id ??
          (item as { itemId?: unknown }).itemId ??
          "",
      ).trim();
      return Boolean(id);
    });
    if (!hasId) {
      return "update_requires_item_id";
    }
  }
  if (list.action === "add") {
    const hasIdentity = list.items.some((item) => {
      const label = String(
        item["שם פריט"] ?? item.title ?? item.name ?? item.item ?? "",
      ).trim();
      return Boolean(label);
    });
    if (!hasIdentity) {
      return "add_requires_item_identity";
    }
    if (
      list.listType === "custom" &&
      !String(list.listId ?? "").trim() &&
      !String(list.listName ?? "").trim()
    ) {
      return "custom_list_requires_id_or_name";
    }
  }
  return null;
}

function validateBinds(
  mode: WatchTriggerActionMode,
  binds: Record<string, string> | undefined,
): string | null {
  if (mode === "static") {
    if (binds && Object.keys(binds).length > 0) {
      return "static_must_not_declare_binds";
    }
    return null;
  }
  if (!binds || Object.keys(binds).length === 0) {
    return "event_bound_requires_binds";
  }
  for (const [fieldPath, factPath] of Object.entries(binds)) {
    if (!fieldPath.trim() || !factPath.trim()) {
      return "empty_bind";
    }
    if (!ALLOWED_FACT_BINDS.has(factPath)) {
      return `unsupported_fact_bind:${factPath}`;
    }
  }
  return null;
}

/**
 * Capture-time normalization. Rejects anything outside the P0 allowlist.
 * Resolves builtin/custom listId when possible under ownerEmployeeId.
 */
export async function normalizeWatchTriggerPackage(input: {
  raw: LlmOnTriggerActions | null | undefined;
  actorEmployeeId: string;
  ownerEmployeeId: string;
  authorizedAt?: Date;
}): Promise<NormalizeWatchTriggerResult> {
  if (input.raw == null) {
    return { ok: false, reason: "empty" };
  }
  if (input.actorEmployeeId !== input.ownerEmployeeId) {
    return { ok: false, reason: "actor_must_equal_owner_p0" };
  }
  if (!Array.isArray(input.raw.lists) || input.raw.lists.length === 0) {
    return { ok: false, reason: "empty_lists" };
  }
  if (input.raw.lists.length > 12) {
    return { ok: false, reason: "too_many_actions" };
  }

  const actions: WatchTriggerPackageAction[] = [];
  for (let i = 0; i < input.raw.lists.length; i += 1) {
    const entry = input.raw.lists[i] as LlmOnTriggerListAction;
    const mode: WatchTriggerActionMode =
      entry.mode === "event_bound" ? "event_bound" : "static";
    // Refuse share/assign targets before stripping — never silently drop them.
    if (Array.isArray(entry.targets) && entry.targets.length > 0) {
      return { ok: false, reason: "targets_not_owner_only" };
    }
    const cleaned = stripShareTargets(entry);
    const allowErr = isOwnerOnlyListAction(cleaned);
    if (allowErr) {
      return { ok: false, reason: allowErr };
    }
    const bindErr = validateBinds(mode, entry.binds);
    if (bindErr) {
      return { ok: false, reason: bindErr };
    }

    let listId = String(cleaned.listId ?? "").trim();
    if (!listId) {
      listId = await resolveOwnerListId({
        ownerEmployeeId: input.ownerEmployeeId,
        listType: cleaned.listType,
        listName: cleaned.listName,
      });
    } else {
      const owned = await prisma.employeeList.findFirst({
        where: {
          id: listId,
          employeeId: input.ownerEmployeeId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!owned) {
        return { ok: false, reason: `list_id_not_owned:${listId}` };
      }
    }

    // updates must target items on the owner's account (checked again at exec).
    if (cleaned.action === "update") {
      for (const item of cleaned.items) {
        const itemId = String(
          (item as { item_id?: unknown; itemId?: unknown }).item_id ??
            (item as { itemId?: unknown }).itemId ??
            "",
        ).trim();
        if (!itemId) {
          continue;
        }
        const row = await prisma.employeeListItem.findFirst({
          where: {
            id: itemId,
            deletedAt: null,
            list: { employeeId: input.ownerEmployeeId, deletedAt: null },
          },
          select: { id: true },
        });
        if (!row) {
          return { ok: false, reason: `update_item_not_owned:${itemId}` };
        }
      }
    }

    const list: LlmListAction = {
      ...cleaned,
      ...(listId ? { listId } : {}),
      targets: [],
    };
    // Builtin shopping/tasks may omit listId when shell does not exist yet —
    // applyEmployeeRecords will create under owner. Custom without id refused above.
    if (
      !listId &&
      cleaned.listType === "custom" &&
      !String(cleaned.listName ?? "").trim()
    ) {
      return { ok: false, reason: "unresolved_list" };
    }
    if (!listId && !BUILTIN_LIST_TYPES.has(cleaned.listType) && cleaned.listType !== "custom") {
      return { ok: false, reason: `unsupported_list_type:${cleaned.listType}` };
    }

    actions.push({
      key: stableActionKey(list, i),
      kind: cleaned.action === "update" ? "lists.update" : "lists.add",
      mode,
      list,
      ...(mode === "event_bound" && entry.binds ? { binds: entry.binds } : {}),
    });
  }

  return {
    ok: true,
    package: {
      version: WATCH_TRIGGER_PACKAGE_VERSION,
      authorizedAt: (input.authorizedAt ?? new Date()).toISOString(),
      actorEmployeeId: input.actorEmployeeId,
      ownerEmployeeId: input.ownerEmployeeId,
      actions,
    },
  };
}

async function resolveOwnerListId(input: {
  ownerEmployeeId: string;
  listType: string;
  listName: string;
}): Promise<string> {
  if (BUILTIN_LIST_TYPES.has(input.listType)) {
    const row = await prisma.employeeList.findFirst({
      where: {
        employeeId: input.ownerEmployeeId,
        listType: input.listType,
        deletedAt: null,
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    return row?.id ?? "";
  }
  const name = input.listName.trim();
  if (!name) {
    return "";
  }
  const row = await prisma.employeeList.findFirst({
    where: {
      employeeId: input.ownerEmployeeId,
      listType: "custom",
      name,
      deletedAt: null,
    },
    select: { id: true },
  });
  return row?.id ?? "";
}

export function parseWatchTriggerPackage(
  raw: unknown,
): WatchTriggerPackage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== WATCH_TRIGGER_PACKAGE_VERSION) {
    return null;
  }
  const actorEmployeeId = String(record.actorEmployeeId ?? "").trim();
  const ownerEmployeeId = String(record.ownerEmployeeId ?? "").trim();
  const authorizedAt = String(record.authorizedAt ?? "").trim();
  if (!actorEmployeeId || !ownerEmployeeId || !authorizedAt) {
    return null;
  }
  if (!Array.isArray(record.actions) || record.actions.length === 0) {
    return null;
  }
  const actions: WatchTriggerPackageAction[] = [];
  for (const entry of record.actions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const row = entry as Record<string, unknown>;
    const key = String(row.key ?? "").trim();
    const kind = String(row.kind ?? "").trim();
    const mode = row.mode === "event_bound" ? "event_bound" : "static";
    if (!key || (kind !== "lists.add" && kind !== "lists.update")) {
      return null;
    }
    if (!row.list || typeof row.list !== "object" || Array.isArray(row.list)) {
      return null;
    }
    const list = row.list as LlmListAction;
    if (list.action !== "add" && list.action !== "update") {
      return null;
    }
    const binds =
      row.binds && typeof row.binds === "object" && !Array.isArray(row.binds)
        ? (row.binds as Record<string, string>)
        : undefined;
    actions.push({
      key,
      kind: kind as "lists.add" | "lists.update",
      mode,
      list: { ...list, targets: [] },
      ...(binds ? { binds } : {}),
    });
  }
  return {
    version: WATCH_TRIGGER_PACKAGE_VERSION,
    authorizedAt,
    actorEmployeeId,
    ownerEmployeeId,
    actions,
  };
}

export function parseWatchTriggerExecLedger(
  raw: unknown,
): WatchTriggerExecLedger {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { version: WATCH_TRIGGER_EXEC_VERSION, events: {} };
  }
  const record = raw as Record<string, unknown>;
  const eventsRaw =
    record.events && typeof record.events === "object" && !Array.isArray(record.events)
      ? (record.events as Record<string, unknown>)
      : {};
  const events: Record<string, WatchTriggerEventExec> = {};
  for (const [fp, value] of Object.entries(eventsRaw)) {
    const fingerprint = String(fp ?? "").trim().slice(0, 64);
    if (!fingerprint || !value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const row = value as Record<string, unknown>;
    const actionsRaw =
      row.actions && typeof row.actions === "object" && !Array.isArray(row.actions)
        ? (row.actions as Record<string, unknown>)
        : {};
    const actions: Record<string, WatchTriggerActionExecState> = {};
    for (const [key, state] of Object.entries(actionsRaw)) {
      if (!state || typeof state !== "object" || Array.isArray(state)) {
        continue;
      }
      const s = state as Record<string, unknown>;
      const status =
        s.status === "done" || s.status === "failed" || s.status === "pending"
          ? s.status
          : "pending";
      actions[key] = {
        status,
        attempts: Number.isFinite(Number(s.attempts)) ? Number(s.attempts) : 0,
        ...(typeof s.lastError === "string" ? { lastError: s.lastError.slice(0, 240) } : {}),
        ...(typeof s.doneAt === "string" ? { doneAt: s.doneAt } : {}),
        ...(typeof s.resultHint === "string"
          ? { resultHint: s.resultHint.slice(0, 120) }
          : {}),
      };
    }
    const notified =
      row.notified === true ? true : row.notified === false ? false : null;
    events[fingerprint] = {
      firstSeenAt:
        typeof row.firstSeenAt === "string"
          ? row.firstSeenAt
          : new Date(0).toISOString(),
      notified,
      ...(typeof row.notifiedAt === "string" ? { notifiedAt: row.notifiedAt } : {}),
      actions,
    };
  }
  return { version: WATCH_TRIGGER_EXEC_VERSION, events };
}

function eventIsTerminal(
  event: WatchTriggerEventExec,
  actionKeys: string[],
): boolean {
  const actionsDone = actionKeys.every(
    (key) => event.actions[key]?.status === "done" || event.actions[key]?.status === "failed",
  );
  // Terminal for prune only when notified settled (true/false) and actions settled.
  return event.notified !== null && actionsDone;
}

function pruneLedger(
  ledger: WatchTriggerExecLedger,
  actionKeys: string[],
): WatchTriggerExecLedger {
  const entries = Object.entries(ledger.events);
  if (entries.length <= WATCH_TRIGGER_EXEC_MAX_EVENTS) {
    return ledger;
  }
  const terminal = entries
    .filter(([, event]) => eventIsTerminal(event, actionKeys))
    .sort((a, b) => a[1].firstSeenAt.localeCompare(b[1].firstSeenAt));
  const incomplete = entries.filter(
    ([, event]) => !eventIsTerminal(event, actionKeys),
  );
  const keepTerminal = terminal.slice(
    Math.max(0, terminal.length - Math.max(4, WATCH_TRIGGER_EXEC_MAX_EVENTS - incomplete.length)),
  );
  const next: Record<string, WatchTriggerEventExec> = {};
  for (const [fp, event] of [...incomplete, ...keepTerminal]) {
    next[fp] = event;
  }
  return { version: WATCH_TRIGGER_EXEC_VERSION, events: next };
}

function ensureEventEntry(
  ledger: WatchTriggerExecLedger,
  fingerprint: string,
  actionKeys: string[],
  now: Date,
): WatchTriggerEventExec {
  const existing = ledger.events[fingerprint];
  if (existing) {
    for (const key of actionKeys) {
      if (!existing.actions[key]) {
        existing.actions[key] = { status: "pending", attempts: 0 };
      }
    }
    return existing;
  }
  const actions: Record<string, WatchTriggerActionExecState> = {};
  for (const key of actionKeys) {
    actions[key] = { status: "pending", attempts: 0 };
  }
  const created: WatchTriggerEventExec = {
    firstSeenAt: now.toISOString(),
    notified: null,
    actions,
  };
  ledger.events[fingerprint] = created;
  return created;
}

function readFactValue(
  facts: ComposeEvalFacts,
  factPath: string,
): string | number | null {
  switch (factPath) {
    case "market.price":
      return facts.marketPrice != null && Number.isFinite(facts.marketPrice)
        ? facts.marketPrice
        : null;
    case "market.fingerprint":
      return facts.marketPrice != null ? "market" : null;
    case "sports.matchId": {
      const fp = facts.sportsMatchFingerprint ?? "";
      const m = /^sports:([^:]+):/.exec(fp);
      return m?.[1] ?? null;
    }
    case "sports.kickoffIso": {
      const fp = facts.sportsMatchFingerprint ?? "";
      const m = /^sports:[^:]+:(.+)$/.exec(fp);
      return m?.[1] ?? null;
    }
    case "sports.opponent":
      return null; // not on ComposeEvalFacts — fail closed unless extended
    case "flight.fingerprint":
      return facts.flightChangedFingerprint || facts.flightEtaFingerprint || null;
    case "bus.fingerprint":
      return facts.busEtaFingerprint ?? null;
    default:
      return null;
  }
}

function setPathValue(
  target: Record<string, unknown>,
  path: string,
  value: string | number,
): boolean {
  const parts = path.split(".").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) {
    return false;
  }
  let cursor: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!;
    const next = parts[i + 1]!;
    const index = /^\d+$/.test(part) ? Number(part) : null;
    if (index != null) {
      if (!Array.isArray(cursor)) {
        return false;
      }
      if (cursor[index] == null || typeof cursor[index] !== "object") {
        cursor[index] = /^\d+$/.test(next) ? [] : {};
      }
      cursor = cursor[index] as Record<string, unknown> | unknown[];
      continue;
    }
    const obj = cursor as Record<string, unknown>;
    if (obj[part] == null || typeof obj[part] !== "object") {
      obj[part] = /^\d+$/.test(next) ? [] : {};
    }
    cursor = obj[part] as Record<string, unknown> | unknown[];
  }
  const leaf = parts[parts.length - 1]!;
  if (/^\d+$/.test(leaf)) {
    if (!Array.isArray(cursor)) {
      return false;
    }
    cursor[Number(leaf)] = value;
    return true;
  }
  (cursor as Record<string, unknown>)[leaf] = value;
  return true;
}

function materializeAction(
  action: WatchTriggerPackageAction,
  facts: ComposeEvalFacts,
): { ok: true; list: LlmListAction } | { ok: false; reason: string } {
  if (action.mode === "static") {
    return { ok: true, list: { ...action.list, targets: [] } };
  }
  const list: LlmListAction = {
    ...action.list,
    items: action.list.items.map((item) => ({ ...item })),
    targets: [],
  };
  const binds = action.binds ?? {};
  for (const [fieldPath, factPath] of Object.entries(binds)) {
    const value = readFactValue(facts, factPath);
    if (value == null || value === "") {
      return { ok: false, reason: `missing_fact:${factPath}` };
    }
    const root: Record<string, unknown> = {
      items: list.items,
      listName: list.listName,
      listId: list.listId,
    };
    if (!setPathValue(root, fieldPath, value)) {
      return { ok: false, reason: `bad_field_path:${fieldPath}` };
    }
    if (Array.isArray(root.items)) {
      list.items = root.items as Record<string, unknown>[];
    }
  }
  return { ok: true, list };
}

async function persistLedger(
  reminderId: string,
  ledger: WatchTriggerExecLedger,
  actionKeys: string[],
): Promise<WatchTriggerExecLedger> {
  const pruned = pruneLedger(ledger, actionKeys);
  await prisma.reminder.update({
    where: { id: reminderId },
    data: { onTriggerExec: pruned as unknown as Prisma.InputJsonValue },
  });
  return pruned;
}

export type WatchTriggerRunResult = {
  fingerprint: string;
  /** True when every package action is done or failed for this fingerprint. */
  actionsTerminal: boolean;
  /** True when at least one action is still pending/failed-retryable. */
  hasIncompleteActions: boolean;
  actionResults: Array<{
    key: string;
    status: WatchTriggerActionStatus;
    error?: string;
  }>;
  ledger: WatchTriggerExecLedger;
};

/**
 * Execute incomplete Actions for one event fingerprint. Never touches notify state.
 * Idempotent: actions with status=done are skipped.
 */
export async function executeWatchTriggerActions(input: {
  reminderId: string;
  userId: string;
  package: WatchTriggerPackage;
  ledger: WatchTriggerExecLedger;
  fingerprint: string;
  facts: ComposeEvalFacts;
  now?: Date;
}): Promise<WatchTriggerRunResult> {
  const now = input.now ?? new Date();
  const fingerprint = input.fingerprint.trim().slice(0, 64);
  const actionKeys = input.package.actions.map((a) => a.key);
  const ledger: WatchTriggerExecLedger = {
    version: WATCH_TRIGGER_EXEC_VERSION,
    events: { ...input.ledger.events },
  };
  // Deep-copy event maps so we do not mutate caller state unexpectedly.
  for (const [fp, event] of Object.entries(ledger.events)) {
    ledger.events[fp] = {
      ...event,
      actions: { ...event.actions },
    };
  }

  if (input.package.ownerEmployeeId !== input.package.actorEmployeeId) {
    recordWhatsAppEvent(
      "watch_trigger_refuse",
      `reason=owner_actor_mismatch reminder=${input.reminderId.slice(0, 8)}`,
    );
    return {
      fingerprint,
      actionsTerminal: true,
      hasIncompleteActions: false,
      actionResults: actionKeys.map((key) => ({
        key,
        status: "failed" as const,
        error: "owner_actor_mismatch",
      })),
      ledger,
    };
  }

  const owner = await prisma.employee.findFirst({
    where: {
      id: input.package.ownerEmployeeId,
      userId: input.userId,
    },
    select: {
      id: true,
      isGuest: true,
      user: { select: { consentPending: true } },
    },
  });
  if (!owner || owner.isGuest) {
    return {
      fingerprint,
      actionsTerminal: true,
      hasIncompleteActions: false,
      actionResults: actionKeys.map((key) => ({
        key,
        status: "failed" as const,
        error: "owner_unavailable",
      })),
      ledger,
    };
  }
  // Prospect / consent-pending: fail closed at execution (chat Join not available).
  if (owner.user?.consentPending === true) {
    return {
      fingerprint,
      actionsTerminal: true,
      hasIncompleteActions: false,
      actionResults: actionKeys.map((key) => ({
        key,
        status: "failed" as const,
        error: "consent_pending",
      })),
      ledger,
    };
  }

  const event = ensureEventEntry(ledger, fingerprint, actionKeys, now);
  const actionResults: WatchTriggerRunResult["actionResults"] = [];

  for (const action of input.package.actions) {
    const state = event.actions[action.key] ?? {
      status: "pending" as const,
      attempts: 0,
    };
    if (state.status === "done") {
      actionResults.push({ key: action.key, status: "done" });
      continue;
    }

    // Re-validate allowlist at execution (do not trust stale package alone).
    const allowErr = isOwnerOnlyListAction(action.list);
    if (allowErr) {
      event.actions[action.key] = {
        status: "failed",
        attempts: state.attempts + 1,
        lastError: allowErr,
      };
      actionResults.push({ key: action.key, status: "failed", error: allowErr });
      continue;
    }

    const materialized = materializeAction(action, input.facts);
    if (!materialized.ok) {
      event.actions[action.key] = {
        status: "failed",
        attempts: state.attempts + 1,
        lastError: materialized.reason,
      };
      actionResults.push({
        key: action.key,
        status: "failed",
        error: materialized.reason,
      });
      continue;
    }

    // Watch-scoped only: skip lists.add when the same normalized title already
    // exists on the target owner list. Does not change global list.add semantics.
    if (action.kind === "lists.add") {
      const skipDup = await findWatchDuplicateAdd({
        ownerEmployeeId: input.package.ownerEmployeeId,
        list: materialized.list,
      });
      if (skipDup) {
        event.actions[action.key] = {
          status: "done",
          attempts: state.attempts + 1,
          doneAt: now.toISOString(),
          resultHint: "skipped_duplicate_title",
        };
        actionResults.push({ key: action.key, status: "done" });
        continue;
      }
    }

    if (action.kind === "lists.update") {
      let updateOwnedOk = true;
      for (const item of materialized.list.items) {
        const itemId = String(
          (item as { item_id?: unknown; itemId?: unknown }).item_id ??
            (item as { itemId?: unknown }).itemId ??
            "",
        ).trim();
        if (!itemId) {
          continue;
        }
        const owned = await prisma.employeeListItem.findFirst({
          where: {
            id: itemId,
            deletedAt: null,
            list: {
              employeeId: input.package.ownerEmployeeId,
              deletedAt: null,
            },
          },
          select: { id: true },
        });
        if (!owned) {
          updateOwnedOk = false;
          event.actions[action.key] = {
            status: "failed",
            attempts: state.attempts + 1,
            lastError: `update_item_not_owned:${itemId}`,
          };
          actionResults.push({
            key: action.key,
            status: "failed",
            error: `update_item_not_owned:${itemId}`,
          });
          break;
        }
      }
      if (!updateOwnedOk) {
        continue;
      }
    }

    const metadata: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [materialized.list],
    };

    try {
      const applied = await applyEmployeeRecords(
        input.package.ownerEmployeeId,
        metadata,
        {
          scope: "personal",
          addedById: input.package.actorEmployeeId,
          visibleTo: [input.package.ownerEmployeeId],
        },
        input.package.actorEmployeeId,
      );
      const mutated = applied.mutations.some(
        (m) =>
          (m.action === "add" || m.action === "update") &&
          m.listType === materialized.list.listType,
      );
      // Treat "already present / no-op update" as done when apply did not throw
      // and shareMisses are empty — avoids infinite retries on idempotent adds.
      const failedShare = applied.shareMisses.length > 0;
      if (failedShare) {
        event.actions[action.key] = {
          status: "failed",
          attempts: state.attempts + 1,
          lastError: "share_miss",
        };
        actionResults.push({
          key: action.key,
          status: "failed",
          error: "share_miss",
        });
      } else {
        event.actions[action.key] = {
          status: "done",
          attempts: state.attempts + 1,
          doneAt: now.toISOString(),
          resultHint: mutated ? "mutated" : "noop",
        };
        actionResults.push({ key: action.key, status: "done" });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 240) : "apply_failed";
      event.actions[action.key] = {
        status: "failed",
        attempts: state.attempts + 1,
        lastError: message,
      };
      actionResults.push({
        key: action.key,
        status: "failed",
        error: message,
      });
    }
  }

  const saved = await persistLedger(input.reminderId, ledger, actionKeys);
  const eventAfter = saved.events[fingerprint]!;
  const hasIncompleteActions = actionKeys.some(
    (key) => eventAfter.actions[key]?.status !== "done",
  );
  // failed counts as terminal for this attempt cycle; recovery may retry failed.
  const actionsTerminal = actionKeys.every(
    (key) =>
      eventAfter.actions[key]?.status === "done" ||
      eventAfter.actions[key]?.status === "failed",
  );

  return {
    fingerprint,
    actionsTerminal,
    hasIncompleteActions: actionKeys.some(
      (key) => eventAfter.actions[key]?.status === "pending",
    ) || actionKeys.some((key) => eventAfter.actions[key]?.status === "failed"),
    actionResults,
    ledger: saved,
  };
}

/**
 * Mark notification attempt for a fingerprint without changing Action statuses.
 * Incomplete event entries for other fingerprints are preserved.
 */
export async function markWatchTriggerNotified(input: {
  reminderId: string;
  ledger: WatchTriggerExecLedger;
  package: WatchTriggerPackage;
  fingerprint: string;
  notified: boolean;
  now?: Date;
}): Promise<WatchTriggerExecLedger> {
  const now = input.now ?? new Date();
  const fingerprint = input.fingerprint.trim().slice(0, 64);
  const actionKeys = input.package.actions.map((a) => a.key);
  const ledger: WatchTriggerExecLedger = {
    version: WATCH_TRIGGER_EXEC_VERSION,
    events: { ...input.ledger.events },
  };
  for (const [fp, event] of Object.entries(ledger.events)) {
    ledger.events[fp] = { ...event, actions: { ...event.actions } };
  }
  const event = ensureEventEntry(ledger, fingerprint, actionKeys, now);
  event.notified = input.notified;
  event.notifiedAt = now.toISOString();
  return persistLedger(input.reminderId, ledger, actionKeys);
}

export function watchTriggerNeedsActionRecovery(
  ledger: WatchTriggerExecLedger,
  pkg: WatchTriggerPackage,
  fingerprint: string,
): boolean {
  const event = ledger.events[fingerprint];
  if (!event) {
    return false;
  }
  return pkg.actions.some((action) => {
    const status = event.actions[action.key]?.status;
    return status !== "done";
  });
}

export function watchTriggerNeedsNotifyRecovery(
  ledger: WatchTriggerExecLedger,
  fingerprint: string,
): boolean {
  const event = ledger.events[fingerprint];
  // No ledger row ⇒ nothing to recover (condition never opened this event).
  if (!event) {
    return false;
  }
  return event.notified !== true;
}

export function listIncompleteWatchFingerprints(
  ledger: WatchTriggerExecLedger,
  pkg: WatchTriggerPackage,
): string[] {
  const keys = pkg.actions.map((a) => a.key);
  return Object.entries(ledger.events)
    .filter(([, event]) => {
      const actionsIncomplete = keys.some(
        (key) => event.actions[key]?.status !== "done",
      );
      const notifyIncomplete = event.notified !== true;
      return actionsIncomplete || notifyIncomplete;
    })
    .map(([fp]) => fp);
}

export function packageToPrismaJson(
  pkg: WatchTriggerPackage | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!pkg) {
    return Prisma.DbNull;
  }
  return pkg as unknown as Prisma.InputJsonValue;
}

/**
 * Watch-execution only: true when an open item with the same normalized
 * identity already exists on the owner's target list.
 */
export async function findWatchDuplicateAdd(input: {
  ownerEmployeeId: string;
  list: LlmListAction;
}): Promise<boolean> {
  const listType = input.list.listType as LlmListType;
  const identities = input.list.items
    .map((item) => itemIdentity(listType, item as Record<string, unknown>))
    .map((key) => key.trim())
    .filter(Boolean);
  if (identities.length === 0) {
    return false;
  }
  const listId = String(input.list.listId ?? "").trim();
  const listWhere = listId
    ? { id: listId, employeeId: input.ownerEmployeeId, deletedAt: null }
    : {
        employeeId: input.ownerEmployeeId,
        listType,
        deletedAt: null,
        ...(listType === "custom" && input.list.listName.trim()
          ? { name: input.list.listName.trim() }
          : {}),
      };
  const list = await prisma.employeeList.findFirst({
    where: listWhere,
    select: { id: true, titleField: true },
  });
  if (!list) {
    return false;
  }
  const live = await prisma.employeeListItem.findMany({
    where: { listId: list.id, deletedAt: null },
    select: { itemKey: true, data: true },
    take: 500,
  });
  const existingKeys = new Set(
    live.map((row) => {
      const fromData = itemIdentity(
        listType,
        (row.data as Record<string, unknown>) ?? {},
        list.titleField ?? "",
      );
      return (fromData || row.itemKey || "").trim();
    }),
  );
  return identities.some((id) => existingKeys.has(id));
}
