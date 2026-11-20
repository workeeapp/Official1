/**
 * PIE-2 — Durable Interaction State (Opportunity + InitiativePreference).
 *
 * TipProgress stays shown-only. Accept / decline / ignore / expire / Quiet
 * preference live here. Value attribution (valueAt) is reserved for PIE-3.
 *
 * Explicit suppress ledger rows use entityRef = pie:explicit_suppress so
 * future Offer→Decline metrics can exclude them (including offered→declined
 * via «אל תציעי לי את זה»).
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../database/prisma.js";
import type { PieOpportunityKind } from "./pie-arbitration.js";

export type InitiativePreferenceMode = "quiet" | "balanced" | "proactive";

export type OpportunityStatus =
  | "offered"
  | "accepted"
  | "declined"
  | "ignored"
  | "expired";

export const PIE_OFFERED_IGNORE_INBOUND_TURNS = 3;
export const PIE_OFFERED_IGNORE_MS = 24 * 60 * 60 * 1000;
export const PIE_IGNORED_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const PIE_DECLINED_ACT_FOLLOWUP_MS = 14 * 24 * 60 * 60 * 1000;
export const PIE_DECLINED_CAPABILITY_MS = 30 * 24 * 60 * 60 * 1000;

/** Marker for explicit «אל תציעי X» ledger / declined-from-offered — not a regular decline. */
export const PIE_EXPLICIT_SUPPRESS_ENTITY_REF = "pie:explicit_suppress";

const SCOPED_SUPPRESS_UTTERANCE_RE =
  /אל תציע[י]?(?:\s+לי)?\s+את\s+(?:זה|ההצעה(?:\s+הזאת)?|התזכורת(?:\s+הזאת)?)/u;

const LIFT_SCOPED_SUPPRESS_RE =
  /(?:אפשר|תוכלי?|תציע[י]?)\s+(?:שוב\s+)?(?:להציע|תזכורת)|תציע[י]?\s+שוב/u;

export type PiePreferenceState = {
  mode: InitiativePreferenceMode;
  source: "explicit_utterance" | "default";
};

export type PieStateScope = {
  userId: string;
  employeeId: string;
  digitalEmployeeId: string;
};

export type RecordOfferedResult = {
  id: string;
  created: boolean;
};

export function reminderOfferOpportunityKey(entityId: string): string {
  return `act_followup:reminder_offer:${entityId.trim()}`;
}

export function tipOpportunityKey(tipKey: string): string {
  return `capability_opportunity:tip:${tipKey.trim()}`;
}

export function raiseOpportunityKey(
  jobOrTaskId: string,
  action: string,
): string {
  return `open_item_raise:${jobOrTaskId.trim()}:${action.trim()}`;
}

export function consentOpportunityKey(contextId: string): string {
  return `consent_cta:${contextId.trim()}`;
}

export function softOfferFallbackKey(
  conversationId: string,
  turnRef: number,
): string {
  return `act_followup:soft_offer:${conversationId}:${turnRef}`;
}

export function isExplicitScopedSuppressUtterance(text: string): boolean {
  return SCOPED_SUPPRESS_UTTERANCE_RE.test(String(text ?? "").trim());
}

export function isLiftScopedSuppressUtterance(text: string): boolean {
  return LIFT_SCOPED_SUPPRESS_RE.test(String(text ?? "").trim());
}

export function isExplicitSuppressLedgerRow(row: {
  entityRef?: string | null;
}): boolean {
  return row.entityRef === PIE_EXPLICIT_SUPPRESS_ENTITY_REF;
}

export function declinedSuppressMs(kind: PieOpportunityKind): number {
  if (kind === "capability_opportunity") {
    return PIE_DECLINED_CAPABILITY_MS;
  }
  return PIE_DECLINED_ACT_FOLLOWUP_MS;
}

function isActivelySuppressed(
  row: {
    status: string;
    suppressUntil: Date | null;
    suppressIndefinite: boolean;
  },
  now: Date,
): boolean {
  if (row.status === "accepted" || row.status === "offered") {
    return true;
  }
  if (row.status === "expired") {
    return false;
  }
  if (row.status === "declined") {
    if (row.suppressIndefinite) {
      return true;
    }
    return Boolean(
      row.suppressUntil && row.suppressUntil.getTime() > now.getTime(),
    );
  }
  if (row.status === "ignored") {
    return Boolean(
      row.suppressUntil && row.suppressUntil.getTime() > now.getTime(),
    );
  }
  return false;
}

export async function loadInitiativePreference(
  scope: Pick<PieStateScope, "employeeId" | "digitalEmployeeId">,
): Promise<PiePreferenceState> {
  const row = await prisma.initiativePreference.findUnique({
    where: {
      employeeId_digitalEmployeeId: {
        employeeId: scope.employeeId,
        digitalEmployeeId: scope.digitalEmployeeId,
      },
    },
  });
  if (!row) {
    return { mode: "balanced", source: "default" };
  }
  const mode =
    row.mode === "quiet" || row.mode === "proactive" || row.mode === "balanced"
      ? row.mode
      : "balanced";
  return {
    mode,
    source: row.source === "explicit_utterance" ? "explicit_utterance" : "default",
  };
}

export async function setInitiativePreference(input: {
  scope: PieStateScope;
  mode: InitiativePreferenceMode;
  source?: "explicit_utterance" | "default";
}): Promise<PiePreferenceState> {
  const source = input.source ?? "explicit_utterance";
  await prisma.initiativePreference.upsert({
    where: {
      employeeId_digitalEmployeeId: {
        employeeId: input.scope.employeeId,
        digitalEmployeeId: input.scope.digitalEmployeeId,
      },
    },
    create: {
      id: randomUUID(),
      userId: input.scope.userId,
      employeeId: input.scope.employeeId,
      digitalEmployeeId: input.scope.digitalEmployeeId,
      mode: input.mode,
      source,
    },
    update: {
      mode: input.mode,
      source,
    },
  });
  return { mode: input.mode, source };
}

/**
 * Single-pass: load rows once, mark stale offered→ignored, build suppressKeys.
 * Preference loads in parallel with the opportunities query.
 */
export async function loadPieStateForTurn(input: {
  scope: PieStateScope;
  inboundTurnCount: number;
  conversationId: string;
  now?: Date;
}): Promise<{
  preference: PiePreferenceState;
  suppressKeys: Set<string>;
}> {
  const now = input.now ?? new Date();
  const scopeWhere = {
    employeeId: input.scope.employeeId,
    digitalEmployeeId: input.scope.digitalEmployeeId,
  };

  const [preference, rows] = await Promise.all([
    loadInitiativePreference(input.scope),
    prisma.interactionOpportunity.findMany({
      where: {
        ...scopeWhere,
        status: { in: ["offered", "accepted", "declined", "ignored"] },
      },
      select: {
        id: true,
        opportunityKey: true,
        status: true,
        offeredAt: true,
        turnRef: true,
        suppressUntil: true,
        suppressIndefinite: true,
        entityRef: true,
      },
    }),
  ]);

  const staleIds: string[] = [];
  for (const row of rows) {
    if (row.status !== "offered") {
      continue;
    }
    const ageMs = now.getTime() - row.offeredAt.getTime();
    const turnGap =
      row.turnRef != null
        ? input.inboundTurnCount - row.turnRef
        : Number.POSITIVE_INFINITY;
    if (
      ageMs >= PIE_OFFERED_IGNORE_MS ||
      turnGap >= PIE_OFFERED_IGNORE_INBOUND_TURNS
    ) {
      staleIds.push(row.id);
    }
  }

  if (staleIds.length > 0) {
    const suppressUntil = new Date(now.getTime() + PIE_IGNORED_COOLDOWN_MS);
    await prisma.interactionOpportunity.updateMany({
      where: { id: { in: staleIds } },
      data: {
        status: "ignored",
        resolvedAt: now,
        suppressUntil,
        suppressIndefinite: false,
      },
    });
    for (const row of rows) {
      if (staleIds.includes(row.id)) {
        row.status = "ignored";
        row.suppressUntil = suppressUntil;
        row.suppressIndefinite = false;
      }
    }
  }

  const suppressKeys = new Set<string>();
  for (const row of rows) {
    if (isActivelySuppressed(row, now)) {
      suppressKeys.add(row.opportunityKey);
    }
  }

  return { preference, suppressKeys };
}

/** Test/helper: resolve stale offered without preference load. */
export async function resolveStaleOfferedOpportunities(input: {
  scope: Pick<PieStateScope, "employeeId" | "digitalEmployeeId">;
  inboundTurnCount: number;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const offered = await prisma.interactionOpportunity.findMany({
    where: {
      employeeId: input.scope.employeeId,
      digitalEmployeeId: input.scope.digitalEmployeeId,
      status: "offered",
    },
  });
  const staleIds: string[] = [];
  for (const row of offered) {
    const ageMs = now.getTime() - row.offeredAt.getTime();
    const turnGap =
      row.turnRef != null
        ? input.inboundTurnCount - row.turnRef
        : Number.POSITIVE_INFINITY;
    if (
      ageMs >= PIE_OFFERED_IGNORE_MS ||
      turnGap >= PIE_OFFERED_IGNORE_INBOUND_TURNS
    ) {
      staleIds.push(row.id);
    }
  }
  if (staleIds.length === 0) {
    return 0;
  }
  await prisma.interactionOpportunity.updateMany({
    where: { id: { in: staleIds } },
    data: {
      status: "ignored",
      resolvedAt: now,
      suppressUntil: new Date(now.getTime() + PIE_IGNORED_COOLDOWN_MS),
      suppressIndefinite: false,
    },
  });
  return staleIds.length;
}

export async function loadSuppressKeys(input: {
  scope: Pick<PieStateScope, "employeeId" | "digitalEmployeeId">;
  now?: Date;
}): Promise<Set<string>> {
  const now = input.now ?? new Date();
  const rows = await prisma.interactionOpportunity.findMany({
    where: {
      employeeId: input.scope.employeeId,
      digitalEmployeeId: input.scope.digitalEmployeeId,
      status: { in: ["offered", "accepted", "declined", "ignored"] },
    },
    select: {
      opportunityKey: true,
      status: true,
      suppressUntil: true,
      suppressIndefinite: true,
    },
  });
  const keys = new Set<string>();
  for (const row of rows) {
    if (isActivelySuppressed(row, now)) {
      keys.add(row.opportunityKey);
    }
  }
  return keys;
}

export async function recordOpportunityOffered(input: {
  scope: PieStateScope;
  opportunityKey: string;
  kind: PieOpportunityKind;
  capabilityId?: string | null;
  entityRef?: string | null;
  conversationId?: string | null;
  turnRef?: number | null;
  now?: Date;
}): Promise<RecordOfferedResult> {
  const now = input.now ?? new Date();
  const existing = await prisma.interactionOpportunity.findFirst({
    where: {
      employeeId: input.scope.employeeId,
      digitalEmployeeId: input.scope.digitalEmployeeId,
      opportunityKey: input.opportunityKey,
      status: "offered",
    },
  });
  if (existing) {
    // Idempotent hit — do not bump offeredAt (would look like a new offer).
    return { id: existing.id, created: false };
  }

  const blocking = await prisma.interactionOpportunity.findFirst({
    where: {
      employeeId: input.scope.employeeId,
      digitalEmployeeId: input.scope.digitalEmployeeId,
      opportunityKey: input.opportunityKey,
      status: { in: ["accepted", "declined", "ignored"] },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (
    blocking &&
    isActivelySuppressed(
      {
        status: blocking.status,
        suppressUntil: blocking.suppressUntil,
        suppressIndefinite: blocking.suppressIndefinite,
      },
      now,
    )
  ) {
    return { id: blocking.id, created: false };
  }

  const id = randomUUID();
  await prisma.interactionOpportunity.create({
    data: {
      id,
      userId: input.scope.userId,
      employeeId: input.scope.employeeId,
      digitalEmployeeId: input.scope.digitalEmployeeId,
      opportunityKey: input.opportunityKey,
      kind: input.kind,
      capabilityId: input.capabilityId ?? null,
      status: "offered",
      offeredAt: now,
      conversationId: input.conversationId ?? null,
      turnRef: input.turnRef ?? null,
      entityRef: input.entityRef ?? null,
      suppressIndefinite: false,
    },
  });
  return { id, created: true };
}

async function resolveOfferedRow(input: {
  scope: Pick<PieStateScope, "employeeId" | "digitalEmployeeId">;
  opportunityKey: string;
  opportunityId?: string | null;
}) {
  if (input.opportunityId) {
    return prisma.interactionOpportunity.findFirst({
      where: {
        id: input.opportunityId,
        employeeId: input.scope.employeeId,
        digitalEmployeeId: input.scope.digitalEmployeeId,
        status: "offered",
      },
    });
  }
  return prisma.interactionOpportunity.findFirst({
    where: {
      employeeId: input.scope.employeeId,
      digitalEmployeeId: input.scope.digitalEmployeeId,
      opportunityKey: input.opportunityKey,
      status: "offered",
    },
    orderBy: { offeredAt: "desc" },
  });
}

export async function resolveOpportunityAccepted(input: {
  scope: Pick<PieStateScope, "employeeId" | "digitalEmployeeId">;
  opportunityKey: string;
  opportunityId?: string | null;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const row = await resolveOfferedRow(input);
  if (!row) {
    return false;
  }
  await prisma.interactionOpportunity.update({
    where: { id: row.id },
    data: {
      status: "accepted",
      resolvedAt: now,
      suppressUntil: null,
      suppressIndefinite: false,
    },
  });
  return true;
}

export async function resolveOpportunityDeclined(input: {
  scope: Pick<PieStateScope, "employeeId" | "digitalEmployeeId">;
  opportunityKey: string;
  opportunityId?: string | null;
  kind?: PieOpportunityKind;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const row = await resolveOfferedRow(input);
  if (!row) {
    return false;
  }
  const kind = (input.kind ?? row.kind) as PieOpportunityKind;
  await prisma.interactionOpportunity.update({
    where: { id: row.id },
    data: {
      status: "declined",
      resolvedAt: now,
      suppressUntil: new Date(now.getTime() + declinedSuppressMs(kind)),
      suppressIndefinite: false,
    },
  });
  return true;
}

/** Expire a specific offered row by id (orphan cleanup — never by key alone). */
export async function expireOpportunityById(input: {
  opportunityId: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const row = await prisma.interactionOpportunity.findFirst({
    where: { id: input.opportunityId, status: "offered" },
  });
  if (!row) {
    return false;
  }
  await prisma.interactionOpportunity.update({
    where: { id: row.id },
    data: {
      status: "expired",
      resolvedAt: now,
      suppressUntil: null,
      suppressIndefinite: false,
    },
  });
  return true;
}

export async function expireOpportunity(input: {
  scope: Pick<PieStateScope, "employeeId" | "digitalEmployeeId">;
  opportunityKey: string;
  opportunityId?: string | null;
  now?: Date;
}): Promise<boolean> {
  if (input.opportunityId) {
    return expireOpportunityById({
      opportunityId: input.opportunityId,
      now: input.now,
    });
  }
  const now = input.now ?? new Date();
  const row = await resolveOfferedRow(input);
  if (!row) {
    return false;
  }
  await prisma.interactionOpportunity.update({
    where: { id: row.id },
    data: {
      status: "expired",
      resolvedAt: now,
      suppressUntil: null,
      suppressIndefinite: false,
    },
  });
  return true;
}

export async function findScopedSuppressTarget(input: {
  scope: Pick<PieStateScope, "employeeId" | "digitalEmployeeId">;
  conversationId: string;
}): Promise<{
  opportunityKey: string;
  id: string;
  kind: string;
  status: string;
  offeredAt: Date;
} | null> {
  const offered = await prisma.interactionOpportunity.findFirst({
    where: {
      employeeId: input.scope.employeeId,
      digitalEmployeeId: input.scope.digitalEmployeeId,
      conversationId: input.conversationId,
      status: "offered",
    },
    orderBy: { offeredAt: "desc" },
  });
  if (offered) {
    return {
      opportunityKey: offered.opportunityKey,
      id: offered.id,
      kind: offered.kind,
      status: offered.status,
      offeredAt: offered.offeredAt,
    };
  }
  const recent = await prisma.interactionOpportunity.findFirst({
    where: {
      employeeId: input.scope.employeeId,
      digitalEmployeeId: input.scope.digitalEmployeeId,
      conversationId: input.conversationId,
      status: { in: ["declined", "accepted", "ignored", "expired"] },
      NOT: { entityRef: PIE_EXPLICIT_SUPPRESS_ENTITY_REF },
    },
    orderBy: { offeredAt: "desc" },
  });
  if (!recent) {
    return null;
  }
  return {
    opportunityKey: recent.opportunityKey,
    id: recent.id,
    kind: recent.kind,
    status: recent.status,
    offeredAt: recent.offeredAt,
  };
}

async function findExplicitSuppressLedger(input: {
  scope: Pick<PieStateScope, "employeeId" | "digitalEmployeeId">;
  opportunityKey: string;
}) {
  return prisma.interactionOpportunity.findFirst({
    where: {
      employeeId: input.scope.employeeId,
      digitalEmployeeId: input.scope.digitalEmployeeId,
      opportunityKey: input.opportunityKey,
      entityRef: PIE_EXPLICIT_SUPPRESS_ENTITY_REF,
      suppressIndefinite: true,
    },
    orderBy: { updatedAt: "desc" },
  });
}

async function upsertExplicitSuppressLedger(input: {
  scope: PieStateScope;
  opportunityKey: string;
  kind: string;
  offeredAt: Date;
  conversationId: string;
  now: Date;
}): Promise<void> {
  const existing = await findExplicitSuppressLedger({
    scope: input.scope,
    opportunityKey: input.opportunityKey,
  });
  if (existing) {
    await prisma.interactionOpportunity.update({
      where: { id: existing.id },
      data: {
        resolvedAt: input.now,
        suppressIndefinite: true,
        suppressUntil: null,
        status: "declined",
      },
    });
    return;
  }
  await prisma.interactionOpportunity.create({
    data: {
      id: randomUUID(),
      userId: input.scope.userId,
      employeeId: input.scope.employeeId,
      digitalEmployeeId: input.scope.digitalEmployeeId,
      opportunityKey: input.opportunityKey,
      kind: input.kind,
      status: "declined",
      offeredAt: input.offeredAt,
      resolvedAt: input.now,
      conversationId: input.conversationId,
      suppressUntil: null,
      suppressIndefinite: true,
      entityRef: PIE_EXPLICIT_SUPPRESS_ENTITY_REF,
    },
  });
}

/**
 * Explicit indefinite suppress for exactly one opportunityKey.
 * - offered → decline in place + entityRef marker (metrics ≠ regular decline)
 * - resolved / none → idempotent ledger row (never mutates accepted/declined/ignored/expired history)
 */
export async function applyExplicitScopedSuppress(input: {
  scope: PieStateScope;
  conversationId: string;
  /** Optional key when no conversation opportunity exists. */
  opportunityKeyHint?: string | null;
  now?: Date;
}): Promise<{ opportunityKey: string } | null> {
  const now = input.now ?? new Date();
  const target = await findScopedSuppressTarget({
    scope: input.scope,
    conversationId: input.conversationId,
  });

  const opportunityKey =
    target?.opportunityKey ?? input.opportunityKeyHint?.trim() ?? "";
  if (!opportunityKey) {
    return null;
  }

  if (target?.status === "offered") {
    await prisma.interactionOpportunity.update({
      where: { id: target.id },
      data: {
        status: "declined",
        resolvedAt: now,
        suppressUntil: null,
        suppressIndefinite: true,
        entityRef: PIE_EXPLICIT_SUPPRESS_ENTITY_REF,
      },
    });
    return { opportunityKey };
  }

  await upsertExplicitSuppressLedger({
    scope: input.scope,
    opportunityKey,
    kind: target?.kind ?? "act_followup",
    offeredAt: target?.offeredAt ?? now,
    conversationId: input.conversationId,
    now,
  });
  return { opportunityKey };
}

export async function liftExplicitScopedSuppress(input: {
  scope: Pick<PieStateScope, "employeeId" | "digitalEmployeeId">;
  conversationId: string;
  now?: Date;
}): Promise<{ opportunityKey: string } | null> {
  const now = input.now ?? new Date();
  const target = await findScopedSuppressTarget({
    scope: input.scope,
    conversationId: input.conversationId,
  });
  const key = target?.opportunityKey;
  if (!key) {
    return null;
  }
  const row = await prisma.interactionOpportunity.findFirst({
    where: {
      employeeId: input.scope.employeeId,
      digitalEmployeeId: input.scope.digitalEmployeeId,
      opportunityKey: key,
      suppressIndefinite: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!row) {
    return null;
  }
  await prisma.interactionOpportunity.update({
    where: { id: row.id },
    data: {
      suppressIndefinite: false,
      suppressUntil: null,
      updatedAt: now,
    },
  });
  return { opportunityKey: row.opportunityKey };
}

export async function findOpenReminderOffer(input: {
  scope: Pick<PieStateScope, "employeeId" | "digitalEmployeeId">;
  conversationId?: string | null;
}): Promise<{ id: string; opportunityKey: string } | null> {
  const row = await prisma.interactionOpportunity.findFirst({
    where: {
      employeeId: input.scope.employeeId,
      digitalEmployeeId: input.scope.digitalEmployeeId,
      status: "offered",
      kind: "act_followup",
      opportunityKey: { startsWith: "act_followup:reminder_offer:" },
      ...(input.conversationId
        ? { conversationId: input.conversationId }
        : {}),
    },
    orderBy: { offeredAt: "desc" },
  });
  if (!row) {
    return null;
  }
  return { id: row.id, opportunityKey: row.opportunityKey };
}
