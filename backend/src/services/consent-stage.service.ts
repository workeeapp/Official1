/**
 * Wave 1 C1/C2 — ConsentStage reader/writer (Prospect vs Member).
 */
import { prisma } from "../database/prisma.js";
import { recordAuditEvent } from "./audit.service.js";

/** Prospect = consentPending true (awaiting Explicit Join). */
export async function isUserProspect(userId: string): Promise<boolean> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { consentPending: true },
  });
  return row?.consentPending === true;
}

/**
 * Atomic Explicit Join: Prospect → Member.
 * Free-text must never call this — only ExplicitJoinHandler / opaque button.
 */
export async function acceptExplicitJoin(input: {
  userId: string;
  actorEmployeeId?: string | null;
}): Promise<"joined" | "already_member" | "missing"> {
  const existing = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { consentPending: true },
  });
  if (!existing) {
    return "missing";
  }
  if (!existing.consentPending) {
    return "already_member";
  }
  const now = new Date();
  const updated = await prisma.user.updateMany({
    where: { id: input.userId, consentPending: true },
    data: { consentPending: false, consentAcceptedAt: now },
  });
  if (updated.count !== 1) {
    return "already_member";
  }
  await recordAuditEvent({
    userId: input.userId,
    actorEmployeeId: input.actorEmployeeId ?? undefined,
    action: "explicit_join",
    entityType: "user",
    entityId: input.userId,
    summary: "Explicit Join: Prospect → Member",
  });
  return "joined";
}
