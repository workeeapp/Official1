/**
 * Wave 1 Stage 2 — PendingProspectAction store (30m TTL).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "../database/prisma.js";
import type { ProspectBlockedKind } from "./prospect-write-gate.js";

export const EXPLICIT_JOIN_ACCEPT_PREFIX = "explicit_join_accept";
export const PENDING_PROSPECT_ACTION_TTL_MS = 30 * 60 * 1000;

export type ProspectActionKind = ProspectBlockedKind | "circuit_breaker";

export function isExplicitJoinAcceptCommand(text: string): boolean {
  const t = text.trim();
  return (
    t === EXPLICIT_JOIN_ACCEPT_PREFIX ||
    t.startsWith(`${EXPLICIT_JOIN_ACCEPT_PREFIX}:`)
  );
}

export function parseExplicitJoinPendingId(text: string): string | null {
  const t = text.trim();
  if (t === EXPLICIT_JOIN_ACCEPT_PREFIX) {
    return null;
  }
  const prefix = `${EXPLICIT_JOIN_ACCEPT_PREFIX}:`;
  if (!t.startsWith(prefix)) {
    return null;
  }
  const id = t.slice(prefix.length).trim();
  return id || null;
}

function newJoinCommand(pendingId: string | null): string {
  if (pendingId) {
    return `${EXPLICIT_JOIN_ACCEPT_PREFIX}:${pendingId}`;
  }
  // Circuit-breaker / bare join — unique per offer.
  return `${EXPLICIT_JOIN_ACCEPT_PREFIX}:${randomBytes(12).toString("base64url")}`;
}

export async function stagePendingProspectAction(input: {
  userId: string;
  speakerEmployeeId: string;
  recipientPhone?: string | null;
  actionKind: ProspectActionKind;
  snapshot: Record<string, unknown>;
  summaryText: string;
}): Promise<{
  id: string;
  joinCommand: string;
  expiresAt: Date;
}> {
  const id = randomUUID();
  const joinCommand =
    input.actionKind === "circuit_breaker"
      ? newJoinCommand(null)
      : `${EXPLICIT_JOIN_ACCEPT_PREFIX}:${id}`;
  const expiresAt = new Date(Date.now() + PENDING_PROSPECT_ACTION_TTL_MS);
  await prisma.pendingProspectAction.create({
    data: {
      id,
      userId: input.userId,
      speakerEmployeeId: input.speakerEmployeeId,
      recipientPhone: input.recipientPhone ?? null,
      actionKind: input.actionKind,
      snapshot: input.snapshot as object,
      summaryText: input.summaryText.slice(0, 2000),
      joinCommand,
      status: "pending",
      expiresAt,
    },
  });
  return { id, joinCommand, expiresAt };
}

export async function loadPendingProspectAction(input: {
  joinCommand: string;
  userId: string;
}): Promise<{
  id: string;
  actionKind: string;
  snapshot: unknown;
  summaryText: string;
  status: string;
} | null> {
  const row = await prisma.pendingProspectAction.findFirst({
    where: {
      joinCommand: input.joinCommand.trim(),
      userId: input.userId,
    },
  });
  if (!row) {
    return null;
  }
  if (row.status === "pending" && row.expiresAt.getTime() <= Date.now()) {
    await prisma.pendingProspectAction.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "expired" },
    });
    return null;
  }
  if (row.status !== "pending") {
    return null;
  }
  return {
    id: row.id,
    actionKind: row.actionKind,
    snapshot: row.snapshot,
    summaryText: row.summaryText,
    status: row.status,
  };
}

export async function consumePendingProspectAction(
  pendingId: string,
): Promise<boolean> {
  const updated = await prisma.pendingProspectAction.updateMany({
    where: { id: pendingId, status: "pending" },
    data: { status: "consumed" },
  });
  return updated.count === 1;
}
