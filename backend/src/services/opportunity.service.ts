import { randomUUID } from "node:crypto";
import type { LlmOpportunity, LlmSpokenBubble, OpportunityCapability } from "@workee/shared";
import { OPPORTUNITY_CAPABILITIES, parseLlmReply } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import {
  setEngineResponse,
  setEngineSpokenBubbles,
} from "./whatsapp-send.js";

/** Same capability is not offered again inside this window. */
export const OPPORTUNITY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const OFFER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OpportunityAside = {
  /** Engine appends this only after the offer row is stored. */
  showPreview: string | null;
  /** Exact preview text to remove from the answer when the offer is not shown. */
  hidePreview: string | null;
  offerId: string | null;
};

/** A row this turn's apply actually persisted. */
export type PersistedOpportunityRow = {
  capability: OpportunityCapability;
  id: string;
  title: string;
  created: boolean;
};

type StoredOffer = {
  id: string;
  capability: OpportunityCapability;
  at: Date;
  accepted: boolean;
  subject: string;
};

type AuditShape = {
  action: string;
  entityId: string | null;
  actorEmployeeId: string | null;
  userId: string;
  summary: string;
  detail: unknown;
  createdAt: Date;
};

function isCapability(value: unknown): value is OpportunityCapability {
  return (
    typeof value === "string" &&
    (OPPORTUNITY_CAPABILITIES as readonly string[]).includes(value)
  );
}

function detailOf(detail: unknown): { capability: OpportunityCapability | null; subject: string } {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return { capability: null, subject: "" };
  }
  const record = detail as { capability?: unknown; subject?: unknown };
  return {
    capability: isCapability(record.capability) ? record.capability : null,
    subject: typeof record.subject === "string" ? record.subject.trim() : "",
  };
}

function asStored(row: AuditShape, accepted: boolean): StoredOffer | null {
  const detail = detailOf(row.detail);
  if (!row.entityId || !detail.capability) {
    return null;
  }
  return {
    id: row.entityId,
    capability: detail.capability,
    at: row.createdAt,
    accepted,
    subject: detail.subject,
  };
}

async function writeAudit(input: {
  userId: string;
  speakerId: string;
  action: "opportunity_offer" | "opportunity_suppress" | "opportunity_accept";
  entityId: string;
  summary: string;
  detail: Record<string, unknown>;
}): Promise<boolean> {
  if (!prisma.auditEvent?.create) {
    return false;
  }
  try {
    await prisma.auditEvent.create({
      data: {
        userId: input.userId,
        actorEmployeeId: input.speakerId,
        action: input.action,
        entityType: "Opportunity",
        entityId: input.entityId,
        summary: input.summary.slice(0, 500),
        detail: input.detail,
      },
    });
    return true;
  } catch (error) {
    console.error(
      "Opportunity audit write failed",
      error instanceof Error ? error.message : "unknown",
    );
    return false;
  }
}

async function latestOffer(input: {
  userId: string;
  speakerId: string;
  capability: OpportunityCapability;
  now: Date;
}): Promise<StoredOffer | null> {
  if (!prisma.auditEvent?.findFirst) {
    return null;
  }
  const since = new Date(input.now.getTime() - OPPORTUNITY_COOLDOWN_MS);
  const row = (await prisma.auditEvent.findFirst({
    where: {
      userId: input.userId,
      actorEmployeeId: input.speakerId,
      action: "opportunity_offer",
      summary: input.capability,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
  })) as AuditShape | null;
  if (!row) {
    return null;
  }
  const stored = asStored(row, false);
  if (!stored) {
    return null;
  }
  const accept = await prisma.auditEvent.findFirst({
    where: {
      userId: input.userId,
      actorEmployeeId: input.speakerId,
      action: "opportunity_accept",
      entityId: stored.id,
    },
  });
  stored.accepted = Boolean(accept);
  return stored;
}

async function openOffers(input: {
  userId: string;
  speakerId: string;
  now: Date;
}): Promise<StoredOffer[]> {
  const found: StoredOffer[] = [];
  for (const capability of OPPORTUNITY_CAPABILITIES) {
    const offer = await latestOffer({ ...input, capability });
    if (offer && !offer.accepted) {
      found.push(offer);
    }
  }
  return found;
}

export async function formatRecentOffersForSpeaker(input: {
  userId: string;
  speakerId: string;
  now?: Date;
}): Promise<string> {
  const offers = await openOffers({
    userId: input.userId,
    speakerId: input.speakerId,
    now: input.now ?? new Date(),
  });
  if (offers.length === 0) {
    return "";
  }
  const lines = offers.map(
    (offer) => `- offer_id: ${offer.id} capability: ${offer.capability}`,
  );
  return ["RECENT_OFFERS:", ...lines].join("\n");
}

/**
 * Share counts only when apply proved a saved audience change or a new shared row.
 * Model targets alone are not proof.
 */
export function persistedRowsFromApply(input: {
  lists: Array<{
    action: string;
    itemId: string;
    itemLabel: string;
    fromReminderCascade?: boolean;
    shareOutcome?: { newlySharedCount: number };
    collabApply?: { mode: string };
  }>;
  filings: Array<{ action: string; filingId?: string; itemName: string }>;
  reminders: Array<{ id: string; title: string; created: boolean }>;
}): PersistedOpportunityRow[] {
  const rows: PersistedOpportunityRow[] = [];
  for (const row of input.lists) {
    if (
      row.fromReminderCascade ||
      (row.action !== "add" && row.action !== "update" && row.action !== "remove")
    ) {
      continue;
    }
    const created = row.action === "add";
    const base = {
      id: row.itemId,
      title: row.itemLabel.trim(),
      created,
    };
    rows.push({ capability: "lists", ...base });
    const shareProved =
      (row.shareOutcome?.newlySharedCount ?? 0) > 0 ||
      Boolean(row.collabApply);
    if (shareProved) {
      rows.push({ capability: "share", ...base });
    }
  }
  for (const row of input.filings) {
    if (row.action !== "add" && row.action !== "update" && row.action !== "remove") {
      continue;
    }
    rows.push({
      capability: "filing",
      id: row.filingId?.trim() ?? "",
      title: row.itemName.trim(),
      created: row.action === "add",
    });
  }
  for (const row of input.reminders) {
    rows.push({
      capability: "reminders",
      id: row.id.trim(),
      title: row.title.trim(),
      created: row.created,
    });
  }
  return rows;
}

/** True only when the persisted rows confirm the stored subject. */
export function subjectConfirmed(
  subject: string,
  capability: OpportunityCapability,
  rows: PersistedOpportunityRow[],
): boolean {
  const mine = rows.filter((row) => row.capability === capability);
  const needle = subject.trim();
  if (!needle || mine.length === 0) {
    return false;
  }
  if (OFFER_ID.test(needle)) {
    const hits = mine.filter((row) => row.id === needle);
    return new Set(hits.map((row) => row.id)).size === 1 && hits.length > 0;
  }
  const created = mine.filter((row) => row.created && row.title === needle);
  const distinct = new Set(created.map((row) => row.id || row.title));
  return created.length > 0 && distinct.size === 1;
}

function none(hide: string | null = null): OpportunityAside {
  return { showPreview: null, hidePreview: hide, offerId: null };
}

/**
 * Gate one Member offer. Does not write lists, filings, or reminders.
 * The preview is shown only after the offer row is stored.
 */
export async function settleMemberOpportunity(input: {
  userId: string;
  speakerId: string;
  digitalEmployeeId: string;
  member: boolean;
  slotTaken: boolean;
  opportunity: LlmOpportunity | null;
  applied: PersistedOpportunityRow[];
  now?: Date;
}): Promise<OpportunityAside> {
  const opportunity = input.opportunity;
  if (!opportunity) {
    return none();
  }
  const hide = opportunity.preview?.trim() || null;
  if (!input.member) {
    return none(hide);
  }
  const now = input.now ?? new Date();

  if (opportunity.accept) {
    if (!prisma.auditEvent?.findFirst) {
      return none();
    }
    const row = (await prisma.auditEvent.findFirst({
      where: {
        userId: input.userId,
        actorEmployeeId: input.speakerId,
        action: "opportunity_offer",
        entityId: opportunity.accept,
      },
    })) as AuditShape | null;
    const offer = row ? asStored(row, false) : null;
    if (!offer || now.getTime() - offer.at.getTime() > OPPORTUNITY_COOLDOWN_MS) {
      return none();
    }
    const latest = await latestOffer({
      userId: input.userId,
      speakerId: input.speakerId,
      capability: offer.capability,
      now,
    });
    if (
      !latest ||
      latest.id !== offer.id ||
      latest.accepted ||
      !latest.subject ||
      !subjectConfirmed(latest.subject, latest.capability, input.applied)
    ) {
      return none();
    }
    await writeAudit({
      userId: input.userId,
      speakerId: input.speakerId,
      action: "opportunity_accept",
      entityId: offer.id,
      summary: offer.capability,
      detail: {
        capability: offer.capability,
        subject: latest.subject,
        digitalEmployeeId: input.digitalEmployeeId,
      },
    });
    return none();
  }

  if (!opportunity.capability || !hide) {
    return none();
  }
  const open = await latestOffer({
    userId: input.userId,
    speakerId: input.speakerId,
    capability: opportunity.capability,
    now,
  });
  if (input.slotTaken || (open && !open.accepted)) {
    await writeAudit({
      userId: input.userId,
      speakerId: input.speakerId,
      action: "opportunity_suppress",
      entityId: randomUUID(),
      summary: opportunity.capability,
      detail: {
        capability: opportunity.capability,
        reason: input.slotTaken ? "slot" : "cooldown",
        digitalEmployeeId: input.digitalEmployeeId,
      },
    });
    return none(hide);
  }

  const offerId = randomUUID();
  const stored = await writeAudit({
    userId: input.userId,
    speakerId: input.speakerId,
    action: "opportunity_offer",
    entityId: offerId,
    summary: opportunity.capability,
    detail: {
      capability: opportunity.capability,
      ...(opportunity.subject ? { subject: opportunity.subject } : {}),
      digitalEmployeeId: input.digitalEmployeeId,
    },
  });
  if (!stored) {
    return none(hide);
  }
  return { showPreview: hide, hidePreview: null, offerId };
}

function withoutExact(text: string, preview: string): string {
  return text.split(preview).join("").replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * Hide strips the exact preview from the answer. Show appends it once.
 * A paraphrase that is not the preview string is left untouched.
 */
export function presentOpportunityReply(
  reply: string,
  input: { hide: string | null; show: string | null },
): string {
  const hide = input.hide?.trim() || "";
  const show = input.show?.trim() || "";
  const parsed = parseLlmReply(reply);
  const source = parsed.responseBubbles.length
    ? parsed.responseBubbles
    : parsed.response.trim()
      ? [{ text: parsed.response }]
      : [];
  let bubbles: LlmSpokenBubble[] = source.map((bubble) => ({
    ...bubble,
    text: hide ? withoutExact(bubble.text, hide) : bubble.text,
  }));
  bubbles = bubbles.filter((bubble) => bubble.text.trim());
  if (show && !bubbles.some((bubble) => bubble.text.includes(show))) {
    bubbles.push({ text: show });
  }
  if (bubbles.length === 0) {
    return setEngineResponse(reply, "");
  }
  const rewritten = setEngineSpokenBubbles(reply, bubbles);
  if (rewritten !== reply || !hide) {
    return rewritten;
  }
  return withoutExact(reply, hide);
}
