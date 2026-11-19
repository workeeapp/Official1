import { randomUUID } from "node:crypto";
import type { LlmListAction, LlmOpportunity, OpportunityCapability } from "@workee/shared";
import { OPPORTUNITY_CAPABILITIES } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { recordAuditEvent } from "./audit.service.js";
import type { AppliedTipOp } from "./tips.service.js";

/** Same capability is not offered again inside this window. */
export const OPPORTUNITY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type OpportunityAside = {
  /** Appended only when the slot is free. Never a catalog tip. */
  preview: string | null;
  offerId: string | null;
};

type StoredOffer = {
  id: string;
  capability: OpportunityCapability;
  at: Date;
  accepted: boolean;
};

function isCapability(value: unknown): value is OpportunityCapability {
  return (
    typeof value === "string" &&
    (OPPORTUNITY_CAPABILITIES as readonly string[]).includes(value)
  );
}

function capabilityOf(detail: unknown): OpportunityCapability | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return null;
  }
  const capability = (detail as { capability?: unknown }).capability;
  return isCapability(capability) ? capability : null;
}

async function loadOffers(input: {
  userId: string;
  speakerId: string;
  now: Date;
}): Promise<StoredOffer[]> {
  if (!prisma.auditEvent?.findMany) {
    return [];
  }
  const since = new Date(input.now.getTime() - OPPORTUNITY_COOLDOWN_MS);
  const rows = await prisma.auditEvent.findMany({
    where: {
      userId: input.userId,
      actorEmployeeId: input.speakerId,
      action: { in: ["opportunity_offer", "opportunity_accept"] },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const byId = new Map<string, StoredOffer>();
  for (const row of rows) {
    if (!row.entityId) {
      continue;
    }
    const capability = capabilityOf(row.detail);
    if (row.action === "opportunity_offer" && capability) {
      byId.set(row.entityId, {
        id: row.entityId,
        capability,
        at: row.createdAt,
        accepted: false,
      });
    } else if (row.action === "opportunity_accept") {
      const existing = byId.get(row.entityId);
      if (existing) {
        existing.accepted = true;
      }
    }
  }
  return [...byId.values()];
}

export function formatRecentOffersContext(offers: StoredOffer[]): string {
  const open = offers.filter((offer) => !offer.accepted);
  if (open.length === 0) {
    return "";
  }
  const lines = open.map(
    (offer) => `- offer_id: ${offer.id} capability: ${offer.capability}`,
  );
  return ["RECENT_OFFERS:", ...lines].join("\n");
}

export async function formatRecentOffersForSpeaker(input: {
  userId: string;
  speakerId: string;
  now?: Date;
}): Promise<string> {
  const offers = await loadOffers({
    userId: input.userId,
    speakerId: input.speakerId,
    now: input.now ?? new Date(),
  });
  return formatRecentOffersContext(offers);
}

/** Capabilities this turn actually persisted. Share is a targeted list write. */
export function capabilitiesFromTurn(input: {
  tipOps: AppliedTipOp[];
  listApplied: boolean;
  listActions: LlmListAction[];
  filingApplied: boolean;
  remindersApplied: boolean;
}): Set<OpportunityCapability> {
  const applied = new Set<OpportunityCapability>();
  if (input.filingApplied || input.tipOps.some((op) => op.topic === "filing")) {
    applied.add("filing");
  }
  if (
    input.remindersApplied ||
    input.tipOps.some((op) => op.topic === "reminders")
  ) {
    applied.add("reminders");
  }
  const targeted = input.listActions.some((action) => action.targets.length > 0);
  const untargeted = input.listActions.some((action) => action.targets.length === 0);
  if (input.listApplied && targeted) {
    applied.add("share");
  }
  if (input.listApplied && (untargeted || input.listActions.length === 0)) {
    applied.add("lists");
  }
  return applied;
}

/**
 * Gate one Member offer. Does not write lists, filings, or reminders.
 * Acceptance counts only when this turn applied that offer's capability
 * and names that offer id.
 */
export async function settleMemberOpportunity(input: {
  userId: string;
  speakerId: string;
  digitalEmployeeId: string;
  member: boolean;
  slotTaken: boolean;
  opportunity: LlmOpportunity | null;
  applied: Set<OpportunityCapability>;
  now?: Date;
}): Promise<OpportunityAside> {
  const none: OpportunityAside = { preview: null, offerId: null };
  const opportunity = input.opportunity;
  if (!opportunity || !input.member) {
    return none;
  }
  const now = input.now ?? new Date();
  const offers = await loadOffers({
    userId: input.userId,
    speakerId: input.speakerId,
    now,
  });

  if (opportunity.accept) {
    const offer = offers.find((row) => row.id === opportunity.accept);
    const latestOpen = offer
      ? offers.filter(
          (row) =>
            row.capability === offer.capability &&
            !row.accepted &&
            row.at.getTime() >= offer.at.getTime(),
        )
      : [];
    const latest = latestOpen[latestOpen.length - 1];
    if (
      !offer ||
      offer.accepted ||
      latest?.id !== offer.id ||
      !input.applied.has(offer.capability)
    ) {
      return none;
    }
    await recordAuditEvent({
      userId: input.userId,
      actorEmployeeId: input.speakerId,
      action: "opportunity_accept",
      entityType: "Opportunity",
      entityId: offer.id,
      summary: offer.capability,
      detail: {
        capability: offer.capability,
        digitalEmployeeId: input.digitalEmployeeId,
      },
    });
    return none;
  }

  if (!opportunity.capability || !opportunity.preview) {
    return none;
  }
  const cooling = offers.some(
    (row) => row.capability === opportunity.capability && !row.accepted,
  );
  if (input.slotTaken || cooling) {
    await recordAuditEvent({
      userId: input.userId,
      actorEmployeeId: input.speakerId,
      action: "opportunity_suppress",
      entityType: "Opportunity",
      entityId: randomUUID(),
      summary: opportunity.capability,
      detail: {
        capability: opportunity.capability,
        reason: input.slotTaken ? "slot" : "cooldown",
        digitalEmployeeId: input.digitalEmployeeId,
      },
    });
    return none;
  }

  const offerId = randomUUID();
  await recordAuditEvent({
    userId: input.userId,
    actorEmployeeId: input.speakerId,
    action: "opportunity_offer",
    entityType: "Opportunity",
    entityId: offerId,
    summary: opportunity.capability,
    detail: {
      capability: opportunity.capability,
      digitalEmployeeId: input.digitalEmployeeId,
    },
  });
  return { preview: opportunity.preview, offerId };
}
