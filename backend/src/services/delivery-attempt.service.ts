/**
 * M1–M3 DeliveryAttempt — durable outbound ledger.
 * Never auto-resend status accepted | unknown | sending.
 * Covers PendingConfirm executes, F1 reminder-fire, and O11 invite continuation.
 */
import { prisma } from "../database/prisma.js";

export type DeliveryAttemptStatus =
  | "queued"
  | "sending"
  | "accepted"
  | "failed"
  | "unknown";

export function deliveryStepKey(destination: string, purpose: string): string {
  return `${purpose}:${destination.trim()}`;
}

/** Stable unique ledger key for confirm-scoped or source-scoped steps. */
export function buildDeliveryLedgerKey(input: {
  confirmId?: string | null;
  sourceKey?: string | null;
  destination: string;
  purpose: string;
}): string {
  const step = deliveryStepKey(input.destination, input.purpose);
  if (input.confirmId?.trim()) {
    return `hrc:${input.confirmId.trim()}:${step}`;
  }
  if (input.sourceKey?.trim()) {
    return `${input.sourceKey.trim()}:${step}`;
  }
  return step;
}

export function mustNotAutoResend(status: DeliveryAttemptStatus): boolean {
  return status === "accepted" || status === "unknown" || status === "sending";
}

export type ClaimSendDecision =
  | { action: "send" }
  | { action: "skip"; reason: "already_accepted" | "in_flight_or_unknown" | "missing" };

export function decideDeliverySend(
  existing: DeliveryAttemptStatus | null,
): ClaimSendDecision {
  if (existing == null || existing === "failed" || existing === "queued") {
    return { action: "send" };
  }
  if (existing === "accepted") {
    return { action: "skip", reason: "already_accepted" };
  }
  return { action: "skip", reason: "in_flight_or_unknown" };
}

/**
 * CAS to sending. Returns whether caller may invoke Graph.
 * If already accepted/unknown/sending → false (no auto-resend).
 */
export async function claimDeliverySend(input: {
  userId: string;
  destination: string;
  purpose: string;
  confirmId?: string | null;
  /** Alternate source when no PendingHighRiskConfirm (F1 reminder id / O11 invite id). */
  sourceKey?: string | null;
}): Promise<{
  maySend: boolean;
  attemptId: string | null;
  skipReason?: "already_accepted" | "in_flight_or_unknown";
}> {
  const stepKey = deliveryStepKey(input.destination, input.purpose);
  const ledgerKey = buildDeliveryLedgerKey({
    confirmId: input.confirmId,
    sourceKey: input.sourceKey,
    destination: input.destination,
    purpose: input.purpose,
  });
  const existing = await prisma.deliveryAttempt.findUnique({
    where: { ledgerKey },
  });
  if (existing) {
    const decision = decideDeliverySend(existing.status as DeliveryAttemptStatus);
    if (decision.action === "skip") {
      return {
        maySend: false,
        attemptId: existing.id,
        skipReason: decision.reason,
      };
    }
    if (existing.status === "failed" || existing.status === "queued") {
      await prisma.deliveryAttempt.update({
        where: { id: existing.id },
        data: { status: "sending", lastError: null },
      });
      return { maySend: true, attemptId: existing.id };
    }
  }

  try {
    const created = await prisma.deliveryAttempt.create({
      data: {
        userId: input.userId,
        ledgerKey,
        stepKey,
        destination: input.destination.trim(),
        purpose: input.purpose,
        status: "sending",
        ...(input.confirmId ? { confirmId: input.confirmId } : {}),
      },
    });
    return { maySend: true, attemptId: created.id };
  } catch {
    const again = await prisma.deliveryAttempt.findUnique({
      where: { ledgerKey },
    });
    if (again) {
      const decision = decideDeliverySend(again.status as DeliveryAttemptStatus);
      if (decision.action === "skip") {
        return {
          maySend: false,
          attemptId: again.id,
          skipReason: decision.reason,
        };
      }
    }
    return { maySend: false, attemptId: again?.id ?? null };
  }
}

export async function completeDeliveryAttempt(input: {
  attemptId: string;
  status: "accepted" | "failed" | "unknown";
  providerMessageId?: string | null;
  lastError?: string | null;
}): Promise<void> {
  await prisma.deliveryAttempt.update({
    where: { id: input.attemptId },
    data: {
      status: input.status,
      ...(input.providerMessageId
        ? { providerMessageId: input.providerMessageId }
        : {}),
      ...(input.lastError != null ? { lastError: input.lastError.slice(0, 500) } : {}),
    },
  });
}
