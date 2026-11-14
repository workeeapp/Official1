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
  type WhatsAppInviteRow,
} from "./whatsapp-invite.service.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CollabInvitePayload = {
  v: 1;
  kind: "share" | "assign";
  domain: "list" | "filing";
  rowId: string;
  action: LlmListAction | LlmFilingAction;
};

export type PresentedCollabInvite = {
  inviteId: string;
  askerName: string;
  askSummary: string;
  kind: "share" | "assign";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseCollabInvitePayload(value: unknown): CollabInvitePayload | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.v !== 1) {
    return null;
  }
  if (value.kind !== "share" && value.kind !== "assign") {
    return null;
  }
  if (value.domain !== "list" && value.domain !== "filing") {
    return null;
  }
  if (typeof value.rowId !== "string" || !UUID_RE.test(value.rowId)) {
    return null;
  }
  const action = value.action;
  if (!isRecord(action)) {
    return null;
  }
  if (value.domain === "list") {
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
    return {
      v: 1,
      kind: value.kind,
      domain: "list",
      rowId: value.rowId,
      action: action as unknown as LlmListAction,
    };
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
  return {
    v: 1,
    kind: value.kind,
    domain: "filing",
    rowId: value.rowId,
    action: action as unknown as LlmFilingAction,
  };
}

export function formatCollabInviteContext(invites: PresentedCollabInvite[]): string {
  if (invites.length === 0) {
    return "";
  }
  const lines = [
    "COLLAB INVITE (pending share or assign — ask before applying):",
    "Ask in warm Hebrew whether to take this activity. Do not say it is already saved.",
    "To accept one invitation, emit metadata.collab_invite set to that invite_id and leave lists, filing, reminders, directory, jobs, and messages empty.",
    "To decline one invitation, emit metadata.decline_invite set to that invite_id the same way.",
    "metadata.confirm true or false does not accept or decline. A missing confirm is not a decline.",
    "Any other request on this turn does not accept or decline.",
  ];
  for (const invite of invites) {
    lines.push(
      [
        `invite_id: ${invite.inviteId}`,
        `kind: ${invite.kind}`,
        `asker_name: ${invite.askerName}`,
        `activity: ${invite.askSummary}`,
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
  const presented: PresentedCollabInvite[] = [];
  for (const row of rows) {
    const payload = parseCollabInvitePayload(row.payload);
    if (!payload) {
      await markCollabInviteFailed(row.id);
      continue;
    }
    const asker = await prisma.employee.findUnique({
      where: { id: row.askerEmployeeId },
      select: { name: true, nickname: true },
    });
    presented.push({
      inviteId: row.id,
      askerName: asker?.nickname?.trim() || asker?.name?.trim() || "מישהו",
      askSummary: row.askSummary,
      kind: payload.kind,
    });
  }
  return presented;
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
}): Promise<{ notice: string; inviteIds: string[] }> {
  const inviteIds: string[] = [];
  let notice = "";
  for (const row of input.deferred) {
    const rowId = randomUUID();
    const payload = JSON.parse(
      JSON.stringify({
        v: 1,
        kind: row.kind,
        domain: row.domain,
        rowId,
        action: row.action,
      }),
    ) as Prisma.InputJsonValue;
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
    const created = await createWhatsAppInvite({
      userId: input.userId,
      askerEmployeeId: input.asker.id,
      digitalEmployeeId: input.digitalId,
      askerName: input.asker.nickname?.trim() || input.asker.name,
      recipientPhone: row.phone,
      recipientLabel: row.label,
      askSummary,
      expectsReply: false,
      payload,
    });
    if (!created) {
      continue;
    }
    inviteIds.push(created.invite.id);
    if (!notice) {
      notice = created.notice;
    }
  }
  return { notice, inviteIds };
}

export type ConfirmCollabResult = "consumed" | "lost" | "failed" | "rolled_back";

/**
 * pending → consumed and the planned row, in one transaction.
 * A thrown insert rolls both back. A second caller sees count 0 and does not insert.
 */
export async function confirmCollabInvite(input: {
  inviteId: string;
  recipient: PublicEmployee;
  sharedLists: SharedListRef[];
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
  const payload = parseCollabInvitePayload(invite.payload);
  if (!payload) {
    await markCollabInviteFailed(invite.id);
    return "failed";
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
