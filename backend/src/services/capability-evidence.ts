/**
 * Capability evidence + familiarity (P1).
 *
 * shown  = TipProgress only (tip key shown) — never proves tried/using
 * tried  = ≥1 Engine evidence event matching catalog matchers
 * using  = ≥2 matches in CAPABILITY_USING_WINDOW_DAYS, or active-state matcher
 */

import { prisma } from "../database/prisma.js";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_USING_MIN_MATCHES,
  CAPABILITY_USING_WINDOW_DAYS,
  capabilityIdsForTipKey,
  getCapability,
  isSoftTryTriggerKind,
  type CapabilityDef,
  type CapabilityEvidenceAttrs,
  type CapabilityEvidenceKind,
  type CapabilityEvidenceMatcher,
} from "./capability-catalog.js";
import { RECURRENCE_META_KEY } from "./list-recurrence.js";

export type CapabilityEvidenceEvent = {
  kind: CapabilityEvidenceKind;
  at: Date;
  entityId?: string;
  attrs: CapabilityEvidenceAttrs;
};

export type CapabilityFamiliarity = {
  capabilityId: string;
  shown: boolean;
  tried: boolean;
  using: boolean;
  matchCount: number;
  matchesInWindow: number;
};

export type TipOfferGate = {
  /** Suppress soft-try (general/model) tips for this key. */
  suppressSoftTry: boolean;
  /** Suppress action tips for this key. */
  suppressActionTip: boolean;
  reasons: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonArrayLen(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  return 0;
}

function attrEquals(
  actual: CapabilityEvidenceAttrs[keyof CapabilityEvidenceAttrs],
  expected: CapabilityEvidenceAttrs[keyof CapabilityEvidenceAttrs],
): boolean {
  return actual === expected;
}

/** Pure matcher — used by tests and familiarity. */
export function matchEvidenceMatcher(
  matcher: CapabilityEvidenceMatcher,
  event: CapabilityEvidenceEvent,
): boolean {
  if (event.kind !== matcher.kind) {
    return false;
  }
  if (matcher.require) {
    for (const [key, expected] of Object.entries(matcher.require)) {
      if (expected === undefined) {
        continue;
      }
      const actual = event.attrs[key as keyof CapabilityEvidenceAttrs];
      if (!attrEquals(actual, expected as typeof actual)) {
        return false;
      }
    }
  }
  if (matcher.rejectIf) {
    for (const [key, flag] of Object.entries(matcher.rejectIf)) {
      if (flag === true && event.attrs[key as keyof CapabilityEvidenceAttrs] === true) {
        return false;
      }
    }
  }
  return true;
}

export function eventsMatchingCapability(
  capability: CapabilityDef,
  events: readonly CapabilityEvidenceEvent[],
): CapabilityEvidenceEvent[] {
  return events.filter((event) =>
    capability.evidenceMatchers.some((matcher) =>
      matchEvidenceMatcher(matcher, event),
    ),
  );
}

function eventsMatchingMatcherIds(
  capability: CapabilityDef,
  events: readonly CapabilityEvidenceEvent[],
  matcherIds: readonly string[],
): CapabilityEvidenceEvent[] {
  const wanted = new Set(matcherIds);
  const matchers = capability.evidenceMatchers.filter((m) => wanted.has(m.id));
  return events.filter((event) =>
    matchers.some((matcher) => matchEvidenceMatcher(matcher, event)),
  );
}

export function evaluateCapabilityFamiliarity(
  capability: CapabilityDef,
  events: readonly CapabilityEvidenceEvent[],
  tipShownKeys: ReadonlySet<string>,
  now: Date = new Date(),
): CapabilityFamiliarity {
  const matched = eventsMatchingCapability(capability, events);
  const windowMs = CAPABILITY_USING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const windowStart = now.getTime() - windowMs;
  const inWindow = matched.filter((e) => e.at.getTime() >= windowStart);

  const shown = capability.tipKeys.some((key) => tipShownKeys.has(key));
  const tried = matched.length >= 1;

  let using = inWindow.length >= CAPABILITY_USING_MIN_MATCHES;
  if (!using && capability.activeUsingMatcherIds?.length) {
    const activeHits = eventsMatchingMatcherIds(
      capability,
      matched,
      capability.activeUsingMatcherIds,
    ).filter((e) => e.attrs.active === true);
    using = activeHits.length >= 1;
  }

  return {
    capabilityId: capability.id,
    shown,
    tried,
    using,
    matchCount: matched.length,
    matchesInWindow: inWindow.length,
  };
}

export function evaluateAllCapabilityFamiliarity(
  events: readonly CapabilityEvidenceEvent[],
  tipShownKeys: ReadonlySet<string>,
  now: Date = new Date(),
): Map<string, CapabilityFamiliarity> {
  const map = new Map<string, CapabilityFamiliarity>();
  for (const cap of CAPABILITY_CATALOG) {
    map.set(
      cap.id,
      evaluateCapabilityFamiliarity(cap, events, tipShownKeys, now),
    );
  }
  return map;
}

/**
 * Offer gate for a tip key given familiarity map.
 * Soft-try suppressed when any linked capability is tried|using.
 * Action tip suppressed when any linked capability is using.
 * Unmapped tip keys → never suppressed by catalog.
 */
export function tipOfferGateForKey(
  tipKey: string,
  triggerKind: string | null | undefined,
  familiarityById: ReadonlyMap<string, CapabilityFamiliarity>,
): TipOfferGate {
  const capIds = capabilityIdsForTipKey(tipKey);
  if (capIds.length === 0) {
    return { suppressSoftTry: false, suppressActionTip: false, reasons: [] };
  }
  const reasons: string[] = [];
  let anyTried = false;
  let anyUsing = false;
  for (const id of capIds) {
    const row =
      familiarityById.get(id) ??
      (getCapability(id)
        ? evaluateCapabilityFamiliarity(getCapability(id)!, [], new Set())
        : undefined);
    if (!row) {
      continue;
    }
    if (row.tried) {
      anyTried = true;
      reasons.push(`${id}:tried`);
    }
    if (row.using) {
      anyUsing = true;
      reasons.push(`${id}:using`);
    }
  }
  const soft = isSoftTryTriggerKind(triggerKind);
  return {
    suppressSoftTry: soft && (anyTried || anyUsing),
    suppressActionTip: !soft && anyUsing,
    reasons,
  };
}

export function shouldSuppressTipOffer(input: {
  tipKey: string;
  triggerKind: string | null | undefined;
  familiarityById: ReadonlyMap<string, CapabilityFamiliarity>;
}): boolean {
  const gate = tipOfferGateForKey(
    input.tipKey,
    input.triggerKind,
    input.familiarityById,
  );
  if (isSoftTryTriggerKind(input.triggerKind)) {
    return gate.suppressSoftTry;
  }
  return gate.suppressActionTip;
}

/** Classify a Reminder row into evidence attrs (pure). */
export function reminderClockAttrs(row: {
  recurrence?: unknown;
  repeat?: string | null;
  composeCondition?: unknown;
  composeAtFire?: boolean;
  composeSource?: string | null;
  status?: string | null;
}): CapabilityEvidenceAttrs {
  const watch = row.composeCondition != null;
  const digest =
    row.composeAtFire === true &&
    Boolean(String(row.composeSource ?? "").trim());
  const recurring =
    row.recurrence != null ||
    (String(row.repeat ?? "once").trim().toLowerCase() !== "once" &&
      String(row.repeat ?? "").trim() !== "");
  return {
    recurring: watch ? false : recurring,
    watch,
    digest: watch ? false : digest,
    active: String(row.status ?? "").toLowerCase() === "active",
  };
}

/** True when tasks item data indicates a timed meeting / duration slot. */
export function tasksItemIsMeeting(data: unknown): boolean {
  const row = asRecord(data);
  const end =
    row["שעת סיום"] ?? row.end_time ?? row.endTime ?? row["end_time"];
  if (end != null && String(end).trim() !== "") {
    return true;
  }
  const date =
    row["תאריך לביצוע"] ?? row.date ?? row["due_date"] ?? row.dueDate;
  const time =
    row["שעה לביצוע"] ?? row.time ?? row["due_time"] ?? row.dueTime;
  const allDay = row["יום שלם"] ?? row.all_day ?? row.allDay;
  if (allDay === true || allDay === "true") {
    return Boolean(date != null && String(date).trim() !== "");
  }
  return (
    date != null &&
    String(date).trim() !== "" &&
    time != null &&
    String(time).trim() !== ""
  );
}

export function tasksItemIsStanding(data: unknown): boolean {
  return RECURRENCE_META_KEY in asRecord(data);
}

function sharedFromScopeVisible(
  scope: string | null | undefined,
  visibleTo: unknown,
): boolean {
  if (String(scope ?? "personal").toLowerCase() !== "personal") {
    return true;
  }
  return jsonArrayLen(visibleTo) > 0;
}

/** Build evidence events from loaded DB-shaped rows (pure; testable). */
export function evidenceFromReminderRows(
  rows: Array<{
    id: string;
    createdAt: Date;
    recurrence?: unknown;
    repeat?: string | null;
    composeCondition?: unknown;
    composeAtFire?: boolean;
    composeSource?: string | null;
    status?: string | null;
  }>,
): CapabilityEvidenceEvent[] {
  return rows.map((row) => ({
    kind: "reminder.clock" as const,
    at: row.createdAt,
    entityId: row.id,
    attrs: reminderClockAttrs(row),
  }));
}

export function evidenceFromListItemRows(
  rows: Array<{
    id: string;
    createdAt: Date;
    listType: string;
    data: unknown;
    scope?: string | null;
    visibleTo?: unknown;
    listScope?: string | null;
    listVisibleTo?: unknown;
  }>,
): CapabilityEvidenceEvent[] {
  const out: CapabilityEvidenceEvent[] = [];
  for (const row of rows) {
    const standing = tasksItemIsStanding(row.data);
    const meeting =
      row.listType === "tasks" ? tasksItemIsMeeting(row.data) : false;
    out.push({
      kind: "list.item_mutated",
      at: row.createdAt,
      entityId: row.id,
      attrs: {
        listType: row.listType,
        op: "add",
        standing,
        meeting,
      },
    });
    const itemShared = sharedFromScopeVisible(row.scope, row.visibleTo);
    const listShared = sharedFromScopeVisible(
      row.listScope,
      row.listVisibleTo,
    );
    if (itemShared || listShared) {
      out.push({
        kind: "list.shared",
        at: row.createdAt,
        entityId: row.id,
        attrs: { shared: true, listType: row.listType },
      });
    }
  }
  return out;
}

export function evidenceFromFilingRows(
  rows: Array<{
    id: string;
    createdAt: Date;
    scope?: string | null;
    visibleTo?: unknown;
    hasMedia?: boolean;
  }>,
): CapabilityEvidenceEvent[] {
  return rows.map((row) => ({
    kind: "filing.mutated" as const,
    at: row.createdAt,
    entityId: row.id,
    attrs: {
      shared: sharedFromScopeVisible(row.scope, row.visibleTo),
      hasMedia: row.hasMedia === true,
      op: "add",
    },
  }));
}

export function evidenceFromFilingMediaRows(
  rows: Array<{ id: string; createdAt: Date; filingId: string }>,
): CapabilityEvidenceEvent[] {
  return rows.map((row) => ({
    kind: "filing.media_linked" as const,
    at: row.createdAt,
    entityId: row.filingId,
    attrs: { hasMedia: true },
  }));
}

export function evidenceFromContactRows(
  rows: Array<{
    id: string;
    createdAt: Date;
    scope?: string | null;
    visibleTo?: unknown;
  }>,
): CapabilityEvidenceEvent[] {
  return rows.map((row) => ({
    kind: "directory.contact" as const,
    at: row.createdAt,
    entityId: row.id,
    attrs: {
      shared: sharedFromScopeVisible(row.scope, row.visibleTo),
      op: "add",
    },
  }));
}

export function evidenceFromContactBookRows(
  rows: Array<{
    id: string;
    updatedAt: Date;
    scope?: string | null;
    visibleTo?: unknown;
  }>,
): CapabilityEvidenceEvent[] {
  return rows
    .filter((row) => sharedFromScopeVisible(row.scope, row.visibleTo))
    .map((row) => ({
      kind: "directory.book_shared" as const,
      at: row.updatedAt,
      entityId: row.id,
      attrs: { shared: true },
    }));
}

/**
 * Load durable Engine evidence for a speaker. TipProgress is NOT included —
 * pass tipShownKeys separately for `shown`.
 */
export async function loadCapabilityEvidenceEvents(input: {
  userId: string;
  employeeId: string;
}): Promise<CapabilityEvidenceEvent[]> {
  const { userId, employeeId } = input;

  const [reminders, listItems, filings, mediaLinks, contacts, books] =
    await Promise.all([
      prisma.reminder.findMany({
        where: {
          userId,
          OR: [{ ownerId: employeeId }, { actorId: employeeId }],
        },
        select: {
          id: true,
          createdAt: true,
          recurrence: true,
          repeat: true,
          composeCondition: true,
          composeAtFire: true,
          composeSource: true,
          status: true,
        },
      }),
      prisma.employeeListItem.findMany({
        where: {
          deletedAt: null,
          OR: [
            { list: { employeeId, deletedAt: null } },
            { addedById: employeeId },
          ],
        },
        select: {
          id: true,
          createdAt: true,
          data: true,
          scope: true,
          visibleTo: true,
          list: {
            select: {
              listType: true,
              scope: true,
              visibleTo: true,
              employeeId: true,
            },
          },
        },
      }),
      prisma.employeeFiling.findMany({
        where: { employeeId, deletedAt: null },
        select: {
          id: true,
          createdAt: true,
          scope: true,
          visibleTo: true,
          attachmentLinks: { select: { id: true }, take: 1 },
        },
      }),
      prisma.attachmentLink.findMany({
        where: {
          filingId: { not: null },
          filing: { employeeId, deletedAt: null },
        },
        select: {
          id: true,
          createdAt: true,
          filingId: true,
        },
      }),
      prisma.contact.findMany({
        where: { ownerEmployeeId: employeeId },
        select: {
          id: true,
          createdAt: true,
          scope: true,
          visibleTo: true,
        },
      }),
      prisma.contactBook.findMany({
        where: { ownerEmployeeId: employeeId },
        select: {
          id: true,
          updatedAt: true,
          scope: true,
          visibleTo: true,
        },
      }),
    ]);

  const events: CapabilityEvidenceEvent[] = [
    ...evidenceFromReminderRows(reminders),
    ...evidenceFromListItemRows(
      listItems.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        listType: row.list.listType,
        data: row.data,
        scope: row.scope,
        visibleTo: row.visibleTo,
        listScope: row.list.scope,
        listVisibleTo: row.list.visibleTo,
      })),
    ),
    ...evidenceFromFilingRows(
      filings.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        scope: row.scope,
        visibleTo: row.visibleTo,
        hasMedia: row.attachmentLinks.length > 0,
      })),
    ),
    ...evidenceFromFilingMediaRows(
      mediaLinks
        .filter((row): row is typeof row & { filingId: string } =>
          Boolean(row.filingId),
        )
        .map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          filingId: row.filingId,
        })),
    ),
    ...evidenceFromContactRows(contacts),
    ...evidenceFromContactBookRows(books),
  ];

  return events;
}

export async function loadTipShownKeys(input: {
  employeeId: string;
  digitalEmployeeId: string;
  tipKeys: string[];
}): Promise<Set<string>> {
  if (input.tipKeys.length === 0) {
    return new Set();
  }
  const tips = await prisma.tip.findMany({
    where: { key: { in: input.tipKeys } },
    select: { id: true, key: true },
  });
  if (tips.length === 0) {
    return new Set();
  }
  const idToKey = new Map(tips.map((t) => [t.id, t.key]));
  const progress = await prisma.tipProgress.findMany({
    where: {
      employeeId: input.employeeId,
      digitalEmployeeId: input.digitalEmployeeId,
      tipId: { in: tips.map((t) => t.id) },
      showCount: { gt: 0 },
    },
    select: { tipId: true },
  });
  const shown = new Set<string>();
  for (const row of progress) {
    const key = idToKey.get(row.tipId);
    if (key) {
      shown.add(key);
    }
  }
  return shown;
}

/** Resolve familiarity for Offer filtering in tips.service. */
export async function resolveSpeakerCapabilityFamiliarity(input: {
  userId: string;
  employeeId: string;
  digitalEmployeeId: string;
  now?: Date;
}): Promise<Map<string, CapabilityFamiliarity>> {
  const allTipKeys = CAPABILITY_CATALOG.flatMap((c) => [...c.tipKeys]);
  const [events, tipShownKeys] = await Promise.all([
    loadCapabilityEvidenceEvents({
      userId: input.userId,
      employeeId: input.employeeId,
    }),
    loadTipShownKeys({
      employeeId: input.employeeId,
      digitalEmployeeId: input.digitalEmployeeId,
      tipKeys: allTipKeys,
    }),
  ]);
  return evaluateAllCapabilityFamiliarity(
    events,
    tipShownKeys,
    input.now ?? new Date(),
  );
}
