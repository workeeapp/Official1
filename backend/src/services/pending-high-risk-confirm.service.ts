/**
 * M1–M3 PendingHighRiskConfirm — stage / offer / Class V ingest / claim.
 * Execute reuses existing CORE apply paths in sendChatMessage (authorized snapshot).
 */
import { createHash, randomBytes } from "node:crypto";
import type { LlmMetadata, LlmReplyButton } from "@workee/shared";
import { emptyLlmMetadata } from "@workee/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { phonesMatch, toWhatsAppAddress } from "../utils/phone.js";
import type { HighRiskActionKind } from "./high-risk-action-gate.js";
import {
  HIGH_RISK_NEEDS_CONFIRM,
  type HighRiskOpenJobRef,
} from "./high-risk-action-gate.js";

export const PENDING_CONFIRM_TTL_MS = 15 * 60 * 1000;

export type PendingConfirmStatus =
  | "pending_offer"
  | "offered"
  | "consuming"
  | "consumed"
  | "consumed_partial"
  | "cancelled"
  | "expired"
  | "superseded"
  | "failed_pre_effect"
  | "failed_partial"
  | "needs_reconciliation";

export const CONFIRM_COMMAND_PREFIX = "hrc:ok:";
export const CANCEL_COMMAND_PREFIX = "hrc:no:";

/** PendingConfirm actionKind for deferred share/assign Accept/Decline (S8). */
export const COLLAB_INVITE_ACTION_KIND = "collab_invite";

export type CollabInviteConfirmSnapshot = {
  v: 1;
  type: "collab_invite";
  inviteId: string;
  inviteKind: "share" | "assign";
};

export function isCollabInviteConfirmSnapshot(
  value: unknown,
): value is CollabInviteConfirmSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const o = value as Record<string, unknown>;
  return (
    o.v === 1 &&
    o.type === "collab_invite" &&
    typeof o.inviteId === "string" &&
    (o.inviteKind === "share" || o.inviteKind === "assign")
  );
}

export function generateOpaqueConfirmCommands(): {
  confirmCommand: string;
  cancelCommand: string;
} {
  const a = randomBytes(18).toString("base64url");
  const b = randomBytes(18).toString("base64url");
  return {
    confirmCommand: `${CONFIRM_COMMAND_PREFIX}${a}`,
    cancelCommand: `${CANCEL_COMMAND_PREFIX}${b}`,
  };
}

/** Stable JSON for hashing (Postgres jsonb key order is not stable). */
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") {
      return v;
    }
    if (Array.isArray(v)) {
      return v.map(normalize);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = normalize((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

export function hashConfirmSummary(summaryText: string, snapshot: unknown): string {
  return createHash("sha256")
    .update(summaryText, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(snapshot), "utf8")
    .digest("hex");
}

export function isOpaqueConfirmCommand(text: string): boolean {
  const t = text.trim();
  return t.startsWith(CONFIRM_COMMAND_PREFIX) || t.startsWith(CANCEL_COMMAND_PREFIX);
}

export function buildPendingConfirmRow(input: {
  userId: string;
  speakerEmployeeId: string;
  recipientPhone: string;
  conversationId?: string | null;
  actionKind: HighRiskActionKind | string;
  snapshot: unknown;
  summaryText: string;
}): {
  actionKind: string;
  snapshot: unknown;
  summaryText: string;
  summaryHash: string;
  confirmCommand: string;
  cancelCommand: string;
  status: PendingConfirmStatus;
  expiresAt: Date;
} {
  const { confirmCommand, cancelCommand } = generateOpaqueConfirmCommands();
  return {
    actionKind: input.actionKind,
    snapshot: input.snapshot,
    summaryText: input.summaryText,
    summaryHash: hashConfirmSummary(input.summaryText, input.snapshot),
    confirmCommand,
    cancelCommand,
    status: "pending_offer",
    expiresAt: new Date(Date.now() + PENDING_CONFIRM_TTL_MS),
  };
}

/** Soft cap per prose field — keep readable; never drop whole ops (F29). */
const SUMMARY_FIELD_CHARS = 400;

function clipSummaryField(text: string, max = SUMMARY_FIELD_CHARS): string {
  const t = text.trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max)}…`;
}

/** Engine summary from snapshot — not model copy. F29: every op, no 6-line drop. */
export function summarizeHighRiskSnapshot(
  snapshot: LlmMetadata,
  actionKind: HighRiskActionKind | string,
  openJobs?: HighRiskOpenJobRef[],
): string {
  const lines: string[] = [];
  const outboundFiles = snapshot.sendAttachments?.length ?? 0;
  for (const msg of snapshot.messages ?? []) {
    const who = msg.targets.join(", ") || "?";
    const body = clipSummaryField(msg.text);
    lines.push(`שליחה אל ${who}: «${body}»`);
  }
  if (outboundFiles > 0) {
    lines.push(`שליחת ${outboundFiles} קבצים שמורים`);
  }
  for (const row of snapshot.lists ?? []) {
    if (row.targets.length > 0) {
      lines.push(
        `${row.action === "add" ? "הוספה" : row.action === "remove" ? "מחיקה" : "עדכון"} עם ${row.targets.join(", ")} (${row.listType}, ${row.items.length} פריטים)`,
      );
    } else if (row.action === "remove") {
      lines.push(`מחיקת ${row.items.length} פריטים מ-${row.listType}`);
    } else if (row.action === "add" || row.action === "update") {
      lines.push(
        `${row.action === "add" ? "הוספה" : "עדכון"} ב-${row.listType} (${row.items.length} פריטים)`,
      );
    }
  }
  for (const row of snapshot.filing ?? []) {
    if (row.targets.length > 0) {
      lines.push(`תיוק «${row.itemName}» עם ${row.targets.join(", ")}`);
    } else if (row.action === "remove_filing") {
      lines.push(`מחיקת תיוק «${row.itemName}»`);
    } else {
      lines.push(`תיוק «${row.itemName}»`);
    }
  }
  for (const op of snapshot.listOps ?? []) {
    if (op.action === "delete_list") {
      lines.push(
        `מחיקת רשימה שלמה${op.listId?.trim() ? ` (${op.listId.trim()})` : ""}`,
      );
    } else if (op.addParticipants.length || op.removeParticipants.length) {
      const bits: string[] = [];
      if (op.addParticipants.length) {
        bits.push(`הוספת ${op.addParticipants.join(", ")}`);
      }
      if (op.removeParticipants.length) {
        bits.push(`הסרת ${op.removeParticipants.join(", ")}`);
      }
      lines.push(`שינוי משתתפים ברשימה: ${bits.join("; ")}`);
    }
  }
  for (const row of snapshot.reminders ?? []) {
    const dest = [...row.ping, ...row.targets].join(", ") || "?";
    const parts = [`תזכורת/שעון אל ${dest}`];
    if (row.item?.trim()) {
      parts.push(`«${clipSummaryField(row.item, 200)}»`);
    }
    if (row.compose) {
      parts.push(
        row.composeSource?.trim()
          ? `compose:${row.composeSource.trim()}`
          : "compose",
      );
    }
    if ((row.attachmentIds?.length ?? 0) > 0) {
      parts.push(`+${row.attachmentIds!.length} קבצים`);
    }
    lines.push(parts.join(" · "));
  }
  for (const row of snapshot.directory ?? []) {
    const phone = row.phone?.trim() ? ` (${row.phone.trim()})` : "";
    lines.push(`ספר טלפונים: ${row.action} ${row.name}${phone}`.trim());
  }
  for (const row of snapshot.jobs ?? []) {
    const report = row.reportText.trim();
    const said = row.answerText.trim();
    const job = openJobs?.find((j) => j.id === row.jobId);
    const asker =
      job?.askerName?.trim() ||
      (job && job.askerId !== job.subjectId ? "השואל" : "");
    if (report) {
      const toWhom = asker ? `אל ${asker}` : "לאדם אחר";
      lines.push(
        said
          ? `דיווח ${toWhom}: «${clipSummaryField(report)}» (על בסיס: «${clipSummaryField(said, 200)}»)`
          : `דיווח ${toWhom}: «${clipSummaryField(report)}»`,
      );
      continue;
    }
    // No technical enum names (answer/decline/counter/…) in user-facing copy.
    if (row.action === "counter") {
      lines.push(
        said
          ? `הצעת מועד חלופי שתישלח לאישור: «${clipSummaryField(said)}»`
          : "הצעת מועד חלופי שתישלח לאישור",
      );
    } else if (row.action === "decline" || row.action === "close") {
      const who = asker ? ` אל ${asker}` : " לשואל";
      lines.push(
        said
          ? `סיום בדיקה עם עדכון${who}: «${clipSummaryField(said)}»`
          : `סיום בדיקה עם עדכון${who}`,
      );
    } else if (row.action === "clear_clock") {
      lines.push("ביטול תזכורת מעקב לבדיקה פתוחה");
    } else {
      const who = asker ? ` אל ${asker}` : " לשואל";
      lines.push(
        said
          ? `עדכון${who} על התשובה: «${clipSummaryField(said)}»`
          : `עדכון${who} על תשובה לבדיקה פתוחה`,
      );
    }
  }
  if (lines.length === 0) {
    const kindLabel =
      actionKind === "job_outbound"
        ? "עדכון לשואל על בדיקה פתוחה"
        : actionKind === "send"
          ? "שליחת הודעה לאדם אחר"
          : actionKind === "schedule_foreign"
            ? "תזכורת לאדם אחר"
            : actionKind === "share" || actionKind === "assign"
              ? "שיתוף או הקצאה"
              : actionKind === "multi_remove" || actionKind === "delete_list"
                ? "מחיקה מרובה"
                : "פעולה שדורשת אישור";
    lines.push(kindLabel);
  }
  return lines.join("\n");
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function snapshotHasOps(snapshot: LlmMetadata): boolean {
  return (
    (snapshot.lists?.length ?? 0) > 0 ||
    (snapshot.listOps?.length ?? 0) > 0 ||
    (snapshot.filing?.length ?? 0) > 0 ||
    (snapshot.messages?.length ?? 0) > 0 ||
    (snapshot.reminders?.length ?? 0) > 0 ||
    (snapshot.directory?.length ?? 0) > 0 ||
    (snapshot.jobs?.length ?? 0) > 0
  );
}

export async function stageHighRiskConfirm(input: {
  userId: string;
  speakerEmployeeId: string;
  recipientPhone: string;
  conversationId: string;
  actionKind: HighRiskActionKind | string;
  snapshot: LlmMetadata;
  openJobs?: HighRiskOpenJobRef[];
}): Promise<{
  id: string;
  summaryText: string;
  confirmCommand: string;
  cancelCommand: string;
  buttons: LlmReplyButton[];
} | null> {
  if (!snapshotHasOps(input.snapshot)) {
    return null;
  }
  const phone =
    toWhatsAppAddress(input.recipientPhone) || input.recipientPhone.trim();
  if (!phone) {
    return null;
  }
  const summaryText = summarizeHighRiskSnapshot(
    input.snapshot,
    input.actionKind,
    input.openJobs,
  );
  const built = buildPendingConfirmRow({
    ...input,
    recipientPhone: phone,
    summaryText,
    snapshot: input.snapshot,
  });

  // Supersede older offered/pending_offer of same speaker+kind still open.
  await prisma.pendingHighRiskConfirm.updateMany({
    where: {
      userId: input.userId,
      speakerEmployeeId: input.speakerEmployeeId,
      actionKind: String(input.actionKind),
      status: { in: ["pending_offer", "offered"] },
    },
    data: { status: "superseded", cancelReason: "superseded" },
  });

  const row = await prisma.pendingHighRiskConfirm.create({
    data: {
      userId: input.userId,
      speakerEmployeeId: input.speakerEmployeeId,
      recipientPhone: phone,
      conversationId: input.conversationId,
      actionKind: built.actionKind,
      snapshot: toJson(built.snapshot),
      summaryText: built.summaryText,
      summaryHash: built.summaryHash,
      confirmCommand: built.confirmCommand,
      cancelCommand: built.cancelCommand,
      status: "pending_offer",
      expiresAt: built.expiresAt,
    },
  });

  return {
    id: row.id,
    summaryText: built.summaryText,
    confirmCommand: built.confirmCommand,
    cancelCommand: built.cancelCommand,
    buttons: [
      { label: "אשר", command: built.confirmCommand },
      { label: "בטל", command: built.cancelCommand },
    ],
  };
}

export async function markHighRiskConfirmOffered(input: {
  id: string;
  offerChatMessageId: string;
  offerWamid?: string | null;
}): Promise<boolean> {
  const updated = await prisma.pendingHighRiskConfirm.updateMany({
    where: { id: input.id, status: "pending_offer" },
    data: {
      status: "offered",
      offerChatMessageId: input.offerChatMessageId,
      ...(input.offerWamid ? { offerWamid: input.offerWamid } : {}),
    },
  });
  return updated.count === 1;
}

export type PendingConfirmIngest =
  | {
      kind: "confirm";
      confirmId: string;
      snapshot: LlmMetadata;
      summaryText: string;
      actionKind: string;
    }
  | {
      kind: "collab_confirm";
      confirmId: string;
      inviteId: string;
      inviteKind: "share" | "assign";
      summaryText: string;
    }
  | { kind: "cancel"; confirmId: string; actionKind: string }
  | {
      kind: "collab_cancel";
      confirmId: string;
      inviteId: string;
      inviteKind: "share" | "assign";
    }
  | { kind: "dead"; reason: string };

function parseSnapshot(raw: unknown): LlmMetadata {
  if (!raw || typeof raw !== "object") {
    return emptyLlmMetadata();
  }
  const o = raw as LlmMetadata;
  return {
    ...emptyLlmMetadata(),
    lists: o.lists ?? [],
    listOps: o.listOps ?? [],
    filing: o.filing ?? [],
    messages: o.messages ?? [],
    reminders: o.reminders ?? [],
    directory: o.directory ?? [],
    jobs: o.jobs ?? [],
  };
}

/**
 * Class V ingest: opaque command + phone + offered + TTL.
 * Confirm uses CAS offered → consuming (one-shot).
 */
export async function ingestPendingHighRiskCommand(input: {
  command: string;
  userId: string;
  speakerEmployeeId: string;
  recipientPhone: string;
  conversationId?: string | null;
  replyToWamid?: string | null;
}): Promise<PendingConfirmIngest | null> {
  if (!isOpaqueConfirmCommand(input.command)) {
    return null;
  }
  const phone =
    toWhatsAppAddress(input.recipientPhone) || input.recipientPhone.trim();
  const isConfirm = input.command.startsWith(CONFIRM_COMMAND_PREFIX);
  const row = await prisma.pendingHighRiskConfirm.findFirst({
    where: isConfirm
      ? { confirmCommand: input.command }
      : { cancelCommand: input.command },
  });
  if (!row) {
    return { kind: "dead", reason: "unknown_command" };
  }
  if (row.userId !== input.userId || row.speakerEmployeeId !== input.speakerEmployeeId) {
    return { kind: "dead", reason: "actor_mismatch" };
  }
  if (!phonesMatch(row.recipientPhone, phone)) {
    return { kind: "dead", reason: "phone_mismatch" };
  }
  if (
    input.conversationId &&
    row.conversationId &&
    row.conversationId !== input.conversationId
  ) {
    return { kind: "dead", reason: "conversation_mismatch" };
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    await prisma.pendingHighRiskConfirm.updateMany({
      where: { id: row.id, status: { in: ["pending_offer", "offered"] } },
      data: { status: "expired" },
    });
    return { kind: "dead", reason: "expired" };
  }
  if (row.status === "pending_offer") {
    return { kind: "dead", reason: "not_offered" };
  }
  if (row.offerWamid && input.replyToWamid && row.offerWamid !== input.replyToWamid) {
    return { kind: "dead", reason: "offer_wamid_mismatch" };
  }

  if (!isConfirm) {
    if (row.status !== "offered") {
      return { kind: "dead", reason: `status_${row.status}` };
    }
    // Decline/cancel: verify hash before CAS so a tampered row cannot cancel.
    const cancelHash = hashConfirmSummary(row.summaryText, row.snapshot);
    if (cancelHash !== row.summaryHash) {
      await prisma.pendingHighRiskConfirm.update({
        where: { id: row.id },
        data: { status: "failed_pre_effect", cancelReason: "hash_mismatch" },
      });
      return { kind: "dead", reason: "hash_mismatch" };
    }
    const cancelled = await prisma.pendingHighRiskConfirm.updateMany({
      where: { id: row.id, status: "offered" },
      data: { status: "cancelled", cancelReason: "user_cancel", consumedAt: new Date() },
    });
    if (cancelled.count !== 1) {
      return { kind: "dead", reason: "cancel_race" };
    }
    if (
      row.actionKind === COLLAB_INVITE_ACTION_KIND &&
      isCollabInviteConfirmSnapshot(row.snapshot)
    ) {
      return {
        kind: "collab_cancel",
        confirmId: row.id,
        inviteId: row.snapshot.inviteId,
        inviteKind: row.snapshot.inviteKind,
      };
    }
    return { kind: "cancel", confirmId: row.id, actionKind: row.actionKind };
  }

  if (row.status === "consumed" || row.status === "consumed_partial") {
    return { kind: "dead", reason: "already_consumed" };
  }
  if (row.status !== "offered") {
    return { kind: "dead", reason: `status_${row.status}` };
  }

  const expectedHash = hashConfirmSummary(row.summaryText, row.snapshot);
  if (expectedHash !== row.summaryHash) {
    await prisma.pendingHighRiskConfirm.update({
      where: { id: row.id },
      data: { status: "failed_pre_effect", cancelReason: "hash_mismatch" },
    });
    return { kind: "dead", reason: "hash_mismatch" };
  }

  const claimed = await prisma.pendingHighRiskConfirm.updateMany({
    where: { id: row.id, status: "offered" },
    data: { status: "consuming" },
  });
  if (claimed.count !== 1) {
    return { kind: "dead", reason: "claim_race" };
  }

  if (
    row.actionKind === COLLAB_INVITE_ACTION_KIND &&
    isCollabInviteConfirmSnapshot(row.snapshot)
  ) {
    return {
      kind: "collab_confirm",
      confirmId: row.id,
      inviteId: row.snapshot.inviteId,
      inviteKind: row.snapshot.inviteKind,
      summaryText: row.summaryText,
    };
  }

  return {
    kind: "confirm",
    confirmId: row.id,
    snapshot: parseSnapshot(row.snapshot),
    summaryText: row.summaryText,
    actionKind: row.actionKind,
  };
}

/**
 * Execute-time recheck while status is consuming: hash must still match.
 * Dump/intent guards are not re-run for authorized snapshots; this is the
 * server integrity check that must never be skipped.
 */
export async function revalidateConsumingConfirm(confirmId: string): Promise<
  | { ok: true; actionKind: string; snapshot: unknown; summaryText: string }
  | { ok: false; reason: string }
> {
  const row = await prisma.pendingHighRiskConfirm.findUnique({
    where: { id: confirmId },
  });
  if (!row) {
    return { ok: false, reason: "missing" };
  }
  if (row.status !== "consuming") {
    return { ok: false, reason: `status_${row.status}` };
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    await prisma.pendingHighRiskConfirm.updateMany({
      where: { id: row.id, status: "consuming" },
      data: { status: "expired", cancelReason: "expired_at_execute" },
    });
    return { ok: false, reason: "expired" };
  }
  const expectedHash = hashConfirmSummary(row.summaryText, row.snapshot);
  if (expectedHash !== row.summaryHash) {
    await prisma.pendingHighRiskConfirm.updateMany({
      where: { id: row.id, status: "consuming" },
      data: { status: "failed_pre_effect", cancelReason: "hash_mismatch_execute" },
    });
    return { ok: false, reason: "hash_mismatch" };
  }
  return {
    ok: true,
    actionKind: row.actionKind,
    snapshot: row.snapshot,
    summaryText: row.summaryText,
  };
}

/** Stage opaque Accept/Decline for one pending collab invite (S8 / Stage 5a). */
export async function stageCollabInviteConfirm(input: {
  userId: string;
  speakerEmployeeId: string;
  recipientPhone: string;
  conversationId: string;
  inviteId: string;
  inviteKind: "share" | "assign";
  askerName: string;
  askSummary: string;
  /** When set, attach deterministic «חסימת שולח» for external askers. */
  askerPhone?: string | null;
}): Promise<{
  id: string;
  summaryText: string;
  confirmCommand: string;
  cancelCommand: string;
  buttons: LlmReplyButton[];
} | null> {
  const phone =
    toWhatsAppAddress(input.recipientPhone) || input.recipientPhone.trim();
  if (!phone) {
    return null;
  }
  const {
    BLOCK_SENDER_BUTTON_LABEL,
    blockSenderCommand,
  } = await import("./sender-block.service.js");
  const blockBtn =
    input.askerPhone && toWhatsAppAddress(input.askerPhone)
      ? {
          label: BLOCK_SENDER_BUTTON_LABEL,
          command: blockSenderCommand(input.askerPhone),
        }
      : null;
  const withBlock = (
    buttons: LlmReplyButton[],
  ): LlmReplyButton[] => (blockBtn ? [...buttons, blockBtn] : buttons);

  const snapshot: CollabInviteConfirmSnapshot = {
    v: 1,
    type: "collab_invite",
    inviteId: input.inviteId,
    inviteKind: input.inviteKind,
  };
  const verb = input.inviteKind === "assign" ? "לקבל" : "לשתף";
  const summaryText = [
    `${input.askerName} מזמינ/ה אותך ${verb}:`,
    input.askSummary.trim() || "פריט",
  ].join("\n");
  const built = buildPendingConfirmRow({
    userId: input.userId,
    speakerEmployeeId: input.speakerEmployeeId,
    recipientPhone: phone,
    conversationId: input.conversationId,
    actionKind: COLLAB_INVITE_ACTION_KIND,
    snapshot,
    summaryText,
  });

  // One open offer per invite id for this speaker.
  const open = await prisma.pendingHighRiskConfirm.findMany({
    where: {
      userId: input.userId,
      speakerEmployeeId: input.speakerEmployeeId,
      actionKind: COLLAB_INVITE_ACTION_KIND,
      status: { in: ["pending_offer", "offered"] },
    },
  });
  for (const row of open) {
    if (
      isCollabInviteConfirmSnapshot(row.snapshot) &&
      row.snapshot.inviteId === input.inviteId
    ) {
      // Reuse existing open offer (idempotent present).
      return {
        id: row.id,
        summaryText: row.summaryText,
        confirmCommand: row.confirmCommand,
        cancelCommand: row.cancelCommand,
        buttons: withBlock([
          { label: "קבל", command: row.confirmCommand },
          { label: "דחה", command: row.cancelCommand },
        ]),
      };
    }
  }

  const row = await prisma.pendingHighRiskConfirm.create({
    data: {
      userId: input.userId,
      speakerEmployeeId: input.speakerEmployeeId,
      recipientPhone: phone,
      conversationId: input.conversationId,
      actionKind: built.actionKind,
      snapshot: toJson(built.snapshot),
      summaryText: built.summaryText,
      summaryHash: built.summaryHash,
      confirmCommand: built.confirmCommand,
      cancelCommand: built.cancelCommand,
      status: "pending_offer",
      expiresAt: built.expiresAt,
    },
  });

  return {
    id: row.id,
    summaryText: built.summaryText,
    confirmCommand: built.confirmCommand,
    cancelCommand: built.cancelCommand,
    buttons: withBlock([
      { label: "קבל", command: built.confirmCommand },
      { label: "דחה", command: built.cancelCommand },
    ]),
  };
}

export function formatCollabInviteOfferReply(summaryText: string): string {
  return `${summaryText}\n\nקבלי או דחי:`;
}

export function formatCollabInviteAcceptedReply(summaryText: string): string {
  return `קיבלתי את ההזמנה:\n${summaryText}`;
}

export function formatCollabInviteDeclinedReply(): string {
  return "דחיתי את ההזמנה — לא נשמר כלום.";
}

export async function finalizePendingConfirm(input: {
  confirmId: string;
  status: Extract<
    PendingConfirmStatus,
    "consumed" | "consumed_partial" | "failed_partial" | "failed_pre_effect" | "needs_reconciliation"
  >;
}): Promise<void> {
  await prisma.pendingHighRiskConfirm.updateMany({
    where: { id: input.confirmId, status: "consuming" },
    data: { status: input.status, consumedAt: new Date() },
  });
}

export function formatHighRiskConfirmOfferReply(summaryText: string): string {
  const summary = summaryText.trim();
  const body = summary
    ? `${HIGH_RISK_NEEDS_CONFIRM}\n\n${summary}\n\nאפשר לאשר או לבטל:`
    : `${HIGH_RISK_NEEDS_CONFIRM}\n\nאפשר לאשר או לבטל:`;
  return body;
}

export function formatHighRiskConfirmDoneReply(summaryText: string): string {
  const summary = summaryText.trim();
  return summary
    ? `בוצע לפי האישור שלך:\n${summary}`
    : "בוצע לפי האישור שלך.";
}

export function formatHighRiskConfirmCancelReply(): string {
  return "ביטלתי — לא ביצעתי כלום.";
}

export function formatHighRiskConfirmDeadReply(): string {
  return "האישור הזה כבר לא בתוקף (פג או שטופל).";
}
