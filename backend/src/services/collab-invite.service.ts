import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  isGuestEmployee,
  llmItemLabel,
  type LlmFilingAction,
  type LlmListAction,
  type LlmMetadata,
  type PublicEmployee,
} from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { phonesMatch } from "../utils/phone.js";
import { applyEmployeeRecords } from "./employee-records.service.js";
import {
  collabPlanMatchesKind,
  planTargetedActions,
  replayCollabMetadata,
  type DeferredCollabTarget,
  type SharedListRef,
} from "./employee-targets.service.js";
import { getEmployeeUserId, listEmployeesForUser } from "./employee.service.js";
import {
  createWhatsAppInvite,
  findPendingCollabInvites,
  formatAskerPendingNotice,
  lazyExpireInvite,
  type InviteIntentKind,
  type WhatsAppInviteRow,
} from "./whatsapp-invite.service.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Wave 1 contentRef — bound to this invite's deferred row / live source id. */
export type CollabContentRef =
  | { type: "list_item"; id: string }
  | { type: "filing"; id: string };

/**
 * Normalized collab payload used by present/confirm paths.
 * Writers emit v2; parsers accept v1 and v2.
 */
export type CollabInvitePayload = {
  v: 1 | 2;
  kind: "share" | "assign";
  intentKind: "share" | "assign";
  domain: "list" | "filing";
  rowId: string;
  action: LlmListAction | LlmFilingAction;
  contentRef: CollabContentRef;
  requireRecipientAck: boolean;
};

export type PresentedCollabInvite = {
  inviteId: string;
  askerName: string;
  askSummary: string;
  kind: "share" | "assign";
  /** Asker WhatsApp digits — for «חסימת שולח» CTA. */
  askerPhone?: string | null;
  /** Scoped invite value for Prospect Share live present (no visibleTo). */
  inviteValueText?: string;
};

/**
 * Stage 5b cutover + Wave 1 Stage 1: pending share/assign must be presented.
 * Assign → opaque Accept/Decline. Prospect Share → present-only (no co-mutate).
 * Auto-apply stays off (`applyPendingCollabInvites` is a no-op).
 */
export function collabInviteAckRequired(): boolean {
  return true;
}

/** Whether this presented invite should get opaque Accept/Decline buttons. */
export function shouldOfferCollabAcceptDecline(input: {
  kind: "share" | "assign";
  recipientIsProspect: boolean;
}): boolean {
  if (input.kind === "assign") {
    return true;
  }
  // Share: Member may Accept → confirmCollabInvite; Prospect is present-only.
  return !input.recipientIsProspect;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseActionForDomain(
  domain: "list" | "filing",
  action: unknown,
): LlmListAction | LlmFilingAction | null {
  if (!isRecord(action)) {
    return null;
  }
  if (domain === "list") {
    if (action.action !== "add") {
      return null;
    }
    const listType = action.listType;
    if (
      listType !== "shopping" &&
      listType !== "tasks" &&
      listType !== "custom"
    ) {
      return null;
    }
    if (listType === "custom" && !String(action.listName ?? "").trim()) {
      return null;
    }
    if (!Array.isArray(action.items) || action.items.length !== 1) {
      return null;
    }
    if (Array.isArray(action.targets) && action.targets.length > 0) {
      return null;
    }
    return action as unknown as LlmListAction;
  }
  if (action.action !== "add_filing") {
    return null;
  }
  if (!String(action.itemName ?? "").trim() || !String(action.itemDescription ?? "").trim()) {
    return null;
  }
  if (Array.isArray(action.targets) && action.targets.length > 0) {
    return null;
  }
  return action as unknown as LlmFilingAction;
}

function contentRefFor(
  domain: "list" | "filing",
  rowId: string,
): CollabContentRef {
  return domain === "list"
    ? { type: "list_item", id: rowId }
    : { type: "filing", id: rowId };
}

function normalizeParsed(input: {
  v: 1 | 2;
  kind: "share" | "assign";
  domain: "list" | "filing";
  rowId: string;
  action: LlmListAction | LlmFilingAction;
  requireRecipientAck?: boolean;
  contentRef?: CollabContentRef;
}): CollabInvitePayload {
  return {
    v: input.v,
    kind: input.kind,
    intentKind: input.kind,
    domain: input.domain,
    rowId: input.rowId,
    action: input.action,
    contentRef: input.contentRef ?? contentRefFor(input.domain, input.rowId),
    requireRecipientAck:
      input.requireRecipientAck ?? input.kind === "assign",
  };
}

export function parseCollabInvitePayload(value: unknown): CollabInvitePayload | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.v === 1) {
    if (value.kind !== "share" && value.kind !== "assign") {
      return null;
    }
    if (value.domain !== "list" && value.domain !== "filing") {
      return null;
    }
    if (typeof value.rowId !== "string" || !UUID_RE.test(value.rowId)) {
      return null;
    }
    const action = parseActionForDomain(value.domain, value.action);
    if (!action) {
      return null;
    }
    return normalizeParsed({
      v: 1,
      kind: value.kind,
      domain: value.domain,
      rowId: value.rowId,
      action,
    });
  }
  if (value.v !== 2) {
    return null;
  }
  const intentKind =
    value.intentKind === "share" || value.intentKind === "assign"
      ? value.intentKind
      : value.kind === "share" || value.kind === "assign"
        ? value.kind
        : null;
  if (!intentKind) {
    return null;
  }
  if (value.domain !== "list" && value.domain !== "filing") {
    return null;
  }
  if (typeof value.rowId !== "string" || !UUID_RE.test(value.rowId)) {
    return null;
  }
  const action = parseActionForDomain(value.domain, value.action);
  if (!action) {
    return null;
  }
  let contentRef: CollabContentRef | undefined;
  if (isRecord(value.contentRef)) {
    const refType = value.contentRef.type;
    const refId =
      typeof value.contentRef.id === "string"
        ? value.contentRef.id
        : typeof value.contentRef.listItemId === "string"
          ? value.contentRef.listItemId
          : typeof value.contentRef.filingId === "string"
            ? value.contentRef.filingId
            : null;
    if (
      refId &&
      UUID_RE.test(refId) &&
      (refType === "list_item" || refType === "filing")
    ) {
      // contentRef must bind to this invite's rowId (S1).
      if (refId !== value.rowId) {
        return null;
      }
      contentRef =
        refType === "list_item"
          ? { type: "list_item", id: refId }
          : { type: "filing", id: refId };
    }
  }
  return normalizeParsed({
    v: 2,
    kind: intentKind,
    domain: value.domain,
    rowId: value.rowId,
    action,
    requireRecipientAck:
      typeof value.requireRecipientAck === "boolean"
        ? value.requireRecipientAck
        : intentKind === "assign",
    contentRef,
  });
}

/** Build a v2 payload for new deferred share/assign rows. */
export function buildCollabInvitePayloadV2(input: {
  kind: "share" | "assign";
  domain: "list" | "filing";
  rowId: string;
  action: LlmListAction | LlmFilingAction;
}): Prisma.InputJsonValue {
  const contentRef = contentRefFor(input.domain, input.rowId);
  return JSON.parse(
    JSON.stringify({
      v: 2,
      intentKind: input.kind,
      kind: input.kind,
      domain: input.domain,
      rowId: input.rowId,
      action: input.action,
      contentRef,
      requireRecipientAck: input.kind === "assign",
    }),
  ) as Prisma.InputJsonValue;
}

/** Scoped invite value text from a validated payload (no DB write). */
export function inviteValueTextFromPayload(
  payload: CollabInvitePayload,
): string {
  if (payload.domain === "list") {
    const label = llmItemLabel((payload.action as LlmListAction).items[0]);
    return label.trim() || "פריט";
  }
  const filing = payload.action as LlmFilingAction;
  const name = String(filing.itemName ?? "").trim();
  const desc = String(filing.itemDescription ?? "").trim();
  return desc ? `${name} — ${desc}` : name || "תיעוד";
}

export function formatCollabInviteContext(
  invites: PresentedCollabInvite[],
  options?: { mode?: "first" | "follow_up" },
): string {
  if (invites.length === 0) {
    return "";
  }
  const followUp = options?.mode === "follow_up";
  const lines = [
    followUp
      ? "COLLAB INVITE (follow-up — same pending invite; already presented):"
      : "COLLAB INVITE (pending — present only; do not claim it is saved):",
    "Do not emit metadata.collab_invite or metadata.decline_invite — Accept/Decline are engine buttons only when offered.",
    "metadata.confirm true or false does not accept or decline.",
    followUp
      ? "Answer from activity / INVITE_VALUE in THIS block only. Leave mutates empty unless they asked to update/complete/accept."
      : "Leave lists, filing, reminders, directory, jobs, and messages empty on this turn unless the user asked something else.",
  ];
  for (const invite of invites) {
    if (invite.kind === "assign") {
      lines.push(
        [
          `invite_id: ${invite.inviteId}`,
          `kind: assign`,
          `asker_name: ${invite.askerName}`,
          `activity: ${invite.askSummary}`,
          followUp
            ? [
                "Follow-up: responsibility already presented.",
                "FORBIDDEN re-opening as first exposure or inventing details not in activity.",
                "Missing detail → say it is not in the invite; clear new topic → handle normally.",
              ].join(" ")
            : [
                "First exposure: warm Hebrew greeting that presents this responsibility from asker_name.",
                "Mention they can manage tasks/shopping/reminders/filings with you right away (no signup).",
                "Then ask whether to accept this responsibility. Gender-safe Hebrew (no masculine «ביקש» on a feminine asker name).",
              ].join(" "),
        ].join("\n"),
      );
      continue;
    }
    // Share — InviteValuePresenter: show scoped value; do not claim co-mutate saved.
    lines.push(
      [
        `invite_id: ${invite.inviteId}`,
        `kind: share`,
        `asker_name: ${invite.askerName}`,
        `activity: ${invite.askSummary}`,
        invite.inviteValueText
          ? `INVITE_VALUE (scoped read only — not yet co-mutate):\n${invite.inviteValueText}`
          : "INVITE_VALUE: unavailable",
        followUp
          ? [
              "Follow-up: shared value already presented.",
              "Answer only from activity / INVITE_VALUE above.",
              "FORBIDDEN re-presenting as first exposure; FORBIDDEN inventing fields when INVITE_VALUE is unavailable or silent.",
              "Clear new topic → handle normally. Do not claim it was saved to their lists.",
            ].join(" ")
          : [
              "First exposure: warm Hebrew greeting presenting this shared value from asker_name.",
              "Mention they can manage tasks/shopping/reminders/filings with you right away (no signup).",
              "Do not claim it was saved to their lists. Gender-safe Hebrew (no masculine «ביקש»).",
            ].join(" "),
      ].join("\n"),
    );
  }
  return lines.join("\n");
}

function rawMetadata(reply: string): Record<string, unknown> | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.metadata)) {
      return null;
    }
    return parsed.metadata;
  } catch {
    return null;
  }
}

/** Explicit invite id only. Bare confirm true/false is ignored. */
export function readCollabInviteDecision(reply: string): {
  acceptId: string | null;
  declineId: string | null;
} {
  const metadata = rawMetadata(reply);
  if (!metadata) {
    return { acceptId: null, declineId: null };
  }
  const accept = metadata.collab_invite;
  const decline = metadata.decline_invite;
  return {
    acceptId: typeof accept === "string" && UUID_RE.test(accept.trim()) ? accept.trim() : null,
    declineId:
      typeof decline === "string" && UUID_RE.test(decline.trim()) ? decline.trim() : null,
  };
}

export async function loadPresentedCollabInvites(
  phone: string | null | undefined,
): Promise<PresentedCollabInvite[]> {
  if (!phone?.trim()) {
    return [];
  }
  const rows = await findPendingCollabInvites(phone);
  const out: PresentedCollabInvite[] = [];
  for (const row of rows) {
    const payload = parseCollabInvitePayload(row.payload);
    if (!payload) {
      // Broken payload cannot sit pending forever.
      await markCollabInviteFailed(row.id);
      continue;
    }
    if (payload.kind !== "share" && payload.kind !== "assign") {
      continue;
    }
    const asker = await prisma.employee.findUnique({
      where: { id: row.askerEmployeeId },
      select: { name: true, nickname: true, phone: true },
    });
    const askerName =
      asker?.nickname?.trim() || asker?.name?.trim() || "מישהו";
    out.push({
      inviteId: row.id,
      askerName,
      askSummary: row.askSummary.trim() || "פריט",
      kind: payload.kind,
      askerPhone: asker?.phone ?? null,
      ...(payload.kind === "share"
        ? { inviteValueText: inviteValueTextFromPayload(payload) }
        : {}),
    });
  }
  return out;
}

async function markCollabInviteFailed(inviteId: string): Promise<void> {
  await prisma.whatsAppInvite.updateMany({
    where: { id: inviteId, status: "pending" },
    data: { status: "failed" },
  });
}

export async function cancelCollabInvite(input: {
  inviteId: string;
  recipientPhone: string;
}): Promise<"cancelled" | "lost"> {
  const invite = await prisma.whatsAppInvite.findUnique({ where: { id: input.inviteId } });
  if (!invite || invite.status !== "pending" || invite.payload == null) {
    return "lost";
  }
  if (!phonesMatch(invite.recipientPhone, input.recipientPhone)) {
    return "lost";
  }
  const updated = await prisma.whatsAppInvite.updateMany({
    where: { id: invite.id, status: "pending" },
    data: { status: "cancelled" },
  });
  return updated.count === 1 ? "cancelled" : "lost";
}

export async function createDeferredCollabInvites(input: {
  userId: string;
  asker: PublicEmployee;
  digitalId: string;
  deferred: DeferredCollabTarget[];
}): Promise<{ notice: string; inviteIds: string[]; composeUrl: string | null }> {
  const { gateExternalAssignInvite } = await import("./sender-block.service.js");
  const inviteIds: string[] = [];
  const noticeParts: string[] = [];
  let composeUrl: string | null = null;
  for (const row of input.deferred) {
    const gate = await gateExternalAssignInvite({
      userId: input.userId,
      askerEmployeeId: input.asker.id,
      askerPhone: input.asker.phone,
      recipientPhone: row.phone,
      kind: row.kind,
    });
    if (!gate.ok) {
      noticeParts.push(gate.notice);
      continue;
    }
    const rowId = randomUUID();
    const payload = buildCollabInvitePayloadV2({
      kind: row.kind,
      domain: row.domain,
      rowId,
      action: row.action,
    });
    if (!parseCollabInvitePayload(payload)) {
      continue;
    }
    const askSummary = (
      row.domain === "list"
        ? llmItemLabel((row.action as LlmListAction).items[0])
        : (row.action as LlmFilingAction).itemName
    )
      .trim()
      .slice(0, 500) || "פריט";
    const intentKind: InviteIntentKind = row.kind;
    const created = await createWhatsAppInvite({
      userId: input.userId,
      askerEmployeeId: input.asker.id,
      digitalEmployeeId: input.digitalId,
      askerName: input.asker.nickname?.trim() || input.asker.name,
      recipientPhone: row.phone,
      recipientLabel: row.label,
      askSummary,
      expectsReply: row.kind === "assign",
      intentKind,
      payload,
    });
    if (!created) {
      continue;
    }
    inviteIds.push(created.invite.id);
    // created.notice already includes Pending AskerNotice + forwardable draft.
    noticeParts.push(created.notice);
    if (!composeUrl) {
      composeUrl = created.composeUrl;
    }
  }
  return { notice: noticeParts.join("\n\n"), inviteIds, composeUrl };
}

export type ConfirmCollabResult = "consumed" | "lost" | "failed" | "rolled_back";

/**
 * Stage 5b cutover: no auto-apply. Pending share/assign must be presented and
 * accepted via opaque Class V commands (confirmCollabInvite / cancelCollabInvite).
 * Kept as a named hook so call sites stay stable; body is intentionally empty.
 */
export async function applyPendingCollabInvites(_input: {
  recipient: PublicEmployee;
  sharedLists: SharedListRef[];
}): Promise<void> {
  return;
}

/**
 * pending → consumed and the planned row, in one transaction.
 * A thrown insert rolls both back. A second caller sees count 0 and does not insert.
 */
export async function confirmCollabInvite(input: {
  inviteId: string;
  recipient: PublicEmployee;
  sharedLists: SharedListRef[];
  /** Wave 1: Prospect must not consume Share via confirm (present-only). */
  recipientIsProspect?: boolean;
}): Promise<ConfirmCollabResult> {
  if (isGuestEmployee(input.recipient) || !input.recipient.phone) {
    return "lost";
  }
  const invite = await prisma.whatsAppInvite.findUnique({ where: { id: input.inviteId } });
  if (!invite || invite.status !== "pending") {
    return "lost";
  }
  if (!phonesMatch(invite.recipientPhone, input.recipient.phone)) {
    return "lost";
  }
  if (invite.payload == null) {
    return "lost";
  }
  // Lazy TTL before apply.
  if (
    await lazyExpireInvite({
      id: invite.id,
      status: invite.status,
      createdAt: invite.createdAt,
    })
  ) {
    return "lost";
  }
  const payload = parseCollabInvitePayload(invite.payload);
  if (!payload) {
    await markCollabInviteFailed(invite.id);
    return "failed";
  }
  // Prospect Share: no visibleTo / co-mutate until Member (Explicit Join → Stage 3).
  if (payload.kind === "share" && input.recipientIsProspect === true) {
    return "lost";
  }
  const askerRow = await prisma.employee.findUnique({
    where: { id: invite.askerEmployeeId },
  });
  if (!askerRow || askerRow.kind !== "human" || askerRow.isGuest || !askerRow.phone) {
    await markCollabInviteFailed(invite.id);
    return "failed";
  }
  const askerUserId = await getEmployeeUserId(askerRow.id);
  if (!askerUserId) {
    await markCollabInviteFailed(invite.id);
    return "failed";
  }
  const askerEmployees = await listEmployeesForUser(askerUserId);
  const asker = askerEmployees.find((row) => row.id === askerRow.id);
  if (!asker?.phone) {
    await markCollabInviteFailed(invite.id);
    return "failed";
  }
  const metadata = replayCollabMetadata({
    kind: payload.kind,
    domain: payload.domain,
    rowId: payload.rowId,
    action: payload.action,
    askerPhone: asker.phone,
    recipientPhone: input.recipient.phone,
  });
  const plan = planTargetedActions({
    actor: asker,
    employees: [asker],
    externalPartners: [input.recipient],
    workers: [],
    metadata,
    sharedLists: input.sharedLists,
  });
  if (
    plan.guestMutationBlocked ||
    !collabPlanMatchesKind(
      plan.applications,
      payload.kind,
      asker.id,
      input.recipient.id,
    )
  ) {
    await markCollabInviteFailed(invite.id);
    return "failed";
  }
  const application = plan.applications[0]!;
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.whatsAppInvite.updateMany({
        where: { id: invite.id, status: "pending" },
        data: {
          status: "consumed",
          consumedAt: new Date(),
          guestEmployeeId: input.recipient.id,
        },
      });
      if (claimed.count !== 1) {
        throw new Error("collab_invite_lost");
      }
      const existing =
        payload.domain === "list"
          ? await tx.employeeListItem.findUnique({
              where: { id: payload.rowId },
              select: { id: true, deletedAt: true },
            })
          : await tx.employeeFiling.findUnique({
              where: { id: payload.rowId },
              select: { id: true, deletedAt: true },
            });
      if (existing && !existing.deletedAt) {
        return;
      }
      if (existing?.deletedAt) {
        throw new Error("collab_row_id_taken");
      }
      await applyEmployeeRecords(
        application.employeeId,
        application.metadata,
        application.visibility,
        asker.id,
        { db: tx, stableRowId: payload.rowId },
      );
      const written =
        payload.domain === "list"
          ? await tx.employeeListItem.findUnique({
              where: { id: payload.rowId },
              select: { id: true },
            })
          : await tx.employeeFiling.findUnique({
              where: { id: payload.rowId },
              select: { id: true },
            });
      if (!written) {
        throw new Error("collab_row_missing");
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "collab_invite_lost") {
      return "lost";
    }
    const still = await prisma.whatsAppInvite.findUnique({
      where: { id: invite.id },
      select: { status: true },
    });
    if (still?.status === "pending") {
      return "rolled_back";
    }
    return "failed";
  }
  return "consumed";
}

export function collabMutationsAreEmpty(metadata: LlmMetadata): boolean {
  return (
    metadata.lists.length === 0 &&
    (metadata.listOps?.length ?? 0) === 0 &&
    metadata.filing.length === 0 &&
    (metadata.reminders?.length ?? 0) === 0 &&
    (metadata.directory?.length ?? 0) === 0 &&
    (metadata.jobs?.length ?? 0) === 0 &&
    (metadata.messages?.length ?? 0) === 0 &&
    (metadata.missions?.length ?? 0) === 0 &&
    metadata.handoff == null &&
    metadata.register == null
  );
}

export function presentedInvite(
  rows: PresentedCollabInvite[],
  inviteId: string | null,
): PresentedCollabInvite | null {
  if (!inviteId) {
    return null;
  }
  return rows.find((row) => row.inviteId === inviteId) ?? null;
}

export type { WhatsAppInviteRow };
