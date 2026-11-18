/**
 * Wave 1 Stage 2 — asker NL cancel → cancelPendingInviteByAsker.
 */
import { prisma } from "../database/prisma.js";
import {
  cancelPendingInviteByAsker,
  type WhatsAppInviteRow,
} from "./whatsapp-invite.service.js";
import { recordAuditEvent } from "./audit.service.js";

const CANCEL_RE =
  /(?:תבטל[יו]?|בטל[יו]?|לבטל)\s+(?:את\s+)?(?:ההזמנה|השיתוף|השליחה|האחריות)?\s*(?:ששלחתי|ששיתפתי|ששלחת)?\s*(?:ל|עבור)?\s*«?([^»\n]+)?»?/i;

export function messageLooksLikeAskerInviteCancel(text: string): boolean {
  const t = text.trim();
  if (!t) {
    return false;
  }
  return (
    /(?:תבטל|בטל|לבטל)/.test(t) &&
    /(?:הזמנה|שיתוף|שליחה|אחריות|invite)/i.test(t)
  );
}

export function extractAskerCancelRecipientHint(text: string): string | null {
  const match = text.trim().match(CANCEL_RE);
  const hint = match?.[1]?.trim() ?? "";
  if (hint.length >= 2) {
    return hint;
  }
  // Fallback: last token after ל
  const after = text.trim().match(/ל([א-תA-Za-z0-9]{2,40})\s*$/);
  return after?.[1]?.trim() ?? null;
}

export async function listPendingInvitesByAsker(input: {
  userId: string;
  askerEmployeeId: string;
}): Promise<WhatsAppInviteRow[]> {
  const rows = await prisma.whatsAppInvite.findMany({
    where: {
      userId: input.userId,
      askerEmployeeId: input.askerEmployeeId,
      status: "pending",
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((row) => ({
    id: row.id,
    token: row.token,
    userId: row.userId,
    askerEmployeeId: row.askerEmployeeId,
    digitalEmployeeId: row.digitalEmployeeId,
    recipientPhone: row.recipientPhone,
    recipientLabel: row.recipientLabel,
    askSummary: row.askSummary,
    draftText: row.draftText,
    status: row.status,
    guestEmployeeId: row.guestEmployeeId,
    payload: row.payload ?? null,
    createdAt: row.createdAt,
  }));
}

export async function tryCancelAskerPendingInvite(input: {
  userId: string;
  askerEmployeeId: string;
  message: string;
}): Promise<{ cancelled: boolean; notice: string }> {
  if (!messageLooksLikeAskerInviteCancel(input.message)) {
    return { cancelled: false, notice: "" };
  }
  const pending = await listPendingInvitesByAsker({
    userId: input.userId,
    askerEmployeeId: input.askerEmployeeId,
  });
  if (pending.length === 0) {
    return {
      cancelled: false,
      notice: "אין הזמנה ממתינה לביטול.",
    };
  }
  const hint = extractAskerCancelRecipientHint(input.message)?.toLowerCase();
  let target = pending[0]!;
  if (hint) {
    const matched = pending.find(
      (row) =>
        row.recipientLabel.toLowerCase().includes(hint) ||
        row.askSummary.toLowerCase().includes(hint) ||
        row.recipientPhone.includes(hint.replace(/\D/g, "")),
    );
    if (matched) {
      target = matched;
    }
  }
  const result = await cancelPendingInviteByAsker({
    inviteId: target.id,
    userId: input.userId,
    askerEmployeeId: input.askerEmployeeId,
  });
  if (result !== "cancelled") {
    return {
      cancelled: false,
      notice: "לא הצלחתי לבטל את ההזמנה — ייתכן שכבר לא ממתינה.",
    };
  }
  await recordAuditEvent({
    userId: input.userId,
    actorEmployeeId: input.askerEmployeeId,
    action: "invite_asker_cancel",
    entityType: "whatsapp_invite",
    entityId: target.id,
    summary: `Asker cancelled pending invite to ${target.recipientLabel}`,
  });
  return {
    cancelled: true,
    notice: `ביטלתי את ההזמנה הממתינה ל«${target.recipientLabel}».`,
  };
}
