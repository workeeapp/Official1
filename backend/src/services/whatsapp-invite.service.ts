import { randomBytes } from "node:crypto";
import { prisma } from "../database/prisma.js";
import { getEnv } from "../config/env.js";
import { normalizePhoneDigits, toWhatsAppAddress } from "../utils/phone.js";
import { ensureGuestLucy } from "./employee.service.js";

export const INVITE_TOKEN_PREFIX = "WRK-INV-";
export const INVITE_TOKEN_RE = /\bWRK-INV-([A-Z0-9]{8,16})\b/i;
export const WHATSAPP_COMPOSE_LABEL = "שלח בוואטסאפ";
export const WHATSAPP_COMPOSE_URL_MAX = 2000;

export type WhatsAppInviteRow = {
  id: string;
  token: string;
  userId: string;
  askerEmployeeId: string;
  digitalEmployeeId: string;
  recipientPhone: string;
  recipientLabel: string;
  askSummary: string;
  draftText: string;
  status: string;
  guestEmployeeId: string | null;
};

export type PendingInviteContext = {
  inviteId: string;
  token: string;
  askerName: string;
  askSummary: string;
  recipientLabel: string;
};

function newInviteToken(): string {
  const raw = randomBytes(6).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = (raw + "XXXXXXXX").slice(0, 10);
  return `${INVITE_TOKEN_PREFIX}${body}`;
}

/** Digits-only business number for wa.me, or empty when unset. */
export function businessDisplayPhoneDigits(): string {
  const raw = getEnv().WHATSAPP_DISPLAY_PHONE?.trim() ?? "";
  return normalizePhoneDigits(raw) || toWhatsAppAddress(raw) || "";
}

export function buildWhatsAppComposeUrl(phone: string, text: string): string {
  const digits = toWhatsAppAddress(phone) || normalizePhoneDigits(phone);
  const encoded = encodeURIComponent(text);
  return `https://wa.me/${digits}?text=${encoded}`.slice(0, WHATSAPP_COMPOSE_URL_MAX);
}

export function parseInviteToken(text: string): string | null {
  const match = text.match(INVITE_TOKEN_RE);
  if (!match) {
    return null;
  }
  return `${INVITE_TOKEN_PREFIX}${match[1]!.toUpperCase()}`;
}

export const SAVE_CONTACT_BUTTON_LABEL = "שמור באנשי קשר";

/** Reply-button command so the next turn can emit directory add. */
export function saveContactButtonCommand(label: string, phone: string): string {
  const name = label.trim() || "איש קשר";
  const digits = toWhatsAppAddress(phone) || normalizePhoneDigits(phone) || phone.trim();
  return `שמור את ${name} באנשי הקשר ${digits}`.slice(0, 256);
}

export function saveContactReplyButton(
  label: string,
  phone: string,
): { label: string; command: string } {
  return {
    label: SAVE_CONTACT_BUTTON_LABEL,
    command: saveContactButtonCommand(label, phone),
  };
}

/**
 * Draft Amit forwards from personal WhatsApp.
 * Check-with (`expectsReply`) uses «לברר»; pure send quotes the outbound text.
 */
export function buildFatherInviteDraft(input: {
  askerName: string;
  askSummary: string;
  /** Full token including WRK-INV- prefix. */
  token: string;
  /** true = check-with / ask; false = pure info send. */
  expectsReply?: boolean;
}): { draftText: string; businessUrl: string | null } {
  const body = input.askSummary.trim() || "לעדכן אותי";
  const expectsReply = input.expectsReply !== false;
  const businessPhone = businessDisplayPhoneDigits();
  const opener = [
    input.token,
    `שלום, הגעתי דרך ההזמנה של ${input.askerName}`,
  ].join("\n");
  const businessUrl = businessPhone
    ? buildWhatsAppComposeUrl(businessPhone, opener)
    : null;
  const linkLine = businessUrl
    ? `לחץ כאן כדי לעדכן אותו דרכי:\n${businessUrl}`
    : "כתוב למספר העסק של Workee כדי לעדכן אותו דרכי.";
  const missionLine = expectsReply
    ? `${input.askerName} שלח אותי לברר איתך: ${body}`
    : `${input.askerName} ביקש שאעביר לך: ${body}`;
  const draftText = [
    "היי, כאן לוסי",
    `העוזרת האישית של ${input.askerName}`,
    missionLine,
    "",
    linkLine,
  ].join("\n");
  return { draftText, businessUrl };
}

export function formatColdInviteNotice(input: {
  recipientLabel: string;
  draftText: string;
}): string {
  return [
    `אי אפשר לשלוח ישירות ל«${input.recipientLabel}» מוואטסאפ העסק — הנמען עדיין לא כתב לנו.`,
    "שלח את ההודעה הזו מהוואטסאפ שלך (לחץ «שלח בוואטסאפ»):",
    "",
    `«${input.draftText}»`,
  ].join("\n");
}

export async function createWhatsAppInvite(input: {
  userId: string;
  askerEmployeeId: string;
  digitalEmployeeId: string;
  askerName: string;
  recipientPhone: string;
  recipientLabel: string;
  askSummary: string;
  expectsReply?: boolean;
}): Promise<{
  invite: WhatsAppInviteRow;
  composeUrl: string;
  notice: string;
} | null> {
  const phone =
    toWhatsAppAddress(input.recipientPhone) ||
    normalizePhoneDigits(input.recipientPhone);
  if (!phone) {
    return null;
  }
  const token = newInviteToken();
  const expectsReply = input.expectsReply !== false;
  const { draftText } = buildFatherInviteDraft({
    askerName: input.askerName,
    askSummary: input.askSummary,
    token,
    expectsReply,
  });
  const row = await prisma.whatsAppInvite.create({
    data: {
      token,
      userId: input.userId,
      askerEmployeeId: input.askerEmployeeId,
      digitalEmployeeId: input.digitalEmployeeId,
      recipientPhone: phone,
      recipientLabel: input.recipientLabel.slice(0, 100),
      askSummary: input.askSummary.trim().slice(0, 500) || "לעדכן אותי",
      draftText,
      status: "pending",
    },
  });
  const composeUrl = buildWhatsAppComposeUrl(phone, draftText);
  return {
    invite: toInviteRow(row),
    composeUrl,
    notice: formatColdInviteNotice({
      recipientLabel: input.recipientLabel,
      draftText,
    }),
  };
}

function toInviteRow(row: {
  id: string;
  token: string;
  userId: string;
  askerEmployeeId: string;
  digitalEmployeeId: string;
  recipientPhone: string;
  recipientLabel: string;
  askSummary: string;
  draftText: string;
  status: string;
  guestEmployeeId: string | null;
}): WhatsAppInviteRow {
  return {
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
  };
}

export async function findPendingInviteByToken(
  token: string,
): Promise<WhatsAppInviteRow | null> {
  const normalized = token.trim().toUpperCase().startsWith(INVITE_TOKEN_PREFIX)
    ? token.trim().toUpperCase()
    : `${INVITE_TOKEN_PREFIX}${token.trim().toUpperCase()}`;
  const row = await prisma.whatsAppInvite.findFirst({
    where: { token: normalized, status: "pending" },
  });
  return row ? toInviteRow(row) : null;
}

export async function findPendingInviteByPhone(
  phone: string,
): Promise<WhatsAppInviteRow | null> {
  const digits = toWhatsAppAddress(phone) || normalizePhoneDigits(phone);
  if (!digits) {
    return null;
  }
  const row = await prisma.whatsAppInvite.findFirst({
    where: { recipientPhone: digits, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  return row ? toInviteRow(row) : null;
}

export async function findPendingInviteForGuest(
  guestEmployeeId: string,
): Promise<WhatsAppInviteRow | null> {
  const row = await prisma.whatsAppInvite.findFirst({
    where: { guestEmployeeId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  return row ? toInviteRow(row) : null;
}

/**
 * Attach inbound WhatsApp speaker to the invite's host account as a guest,
 * and return context for לוסי-אורח.
 */
export async function bindInboundToInvite(input: {
  fromPhone: string;
  inboundText: string;
  currentUserId: string;
  currentEmployeeId: string;
}): Promise<{
  userId: string;
  employeeId: string;
  invite: WhatsAppInviteRow;
  context: PendingInviteContext;
} | null> {
  const token = parseInviteToken(input.inboundText);
  let invite = token ? await findPendingInviteByToken(token) : null;
  if (!invite) {
    invite = await findPendingInviteByPhone(input.fromPhone);
  }
  if (!invite) {
    return null;
  }

  await ensureGuestLucy(invite.userId);

  let employeeId = input.currentEmployeeId;
  let userId = input.currentUserId;

  if (userId !== invite.userId) {
    // Phone is globally unique — move the guest shell onto the asker's account.
    await prisma.employee.update({
      where: { id: employeeId },
      data: {
        userId: invite.userId,
        teamId: null,
        isGuest: true,
      },
    });
    userId = invite.userId;
  }

  await prisma.whatsAppInvite.update({
    where: { id: invite.id },
    data: { guestEmployeeId: employeeId },
  });
  invite = { ...invite, guestEmployeeId: employeeId };

  const asker = await prisma.employee.findUnique({
    where: { id: invite.askerEmployeeId },
    select: { name: true, nickname: true },
  });
  const askerName =
    asker?.nickname?.trim() || asker?.name?.trim() || "מישהו מהצוות";

  return {
    userId,
    employeeId,
    invite,
    context: {
      inviteId: invite.id,
      token: invite.token,
      askerName,
      askSummary: invite.askSummary,
      recipientLabel: invite.recipientLabel,
    },
  };
}

export function formatPendingInviteContext(ctx: PendingInviteContext): string {
  return [
    "PENDING_INVITE (cold WhatsApp invite — register before continuing the check):",
    `asker_name: ${ctx.askerName}`,
    `ask_summary: ${ctx.askSummary}`,
    `invite_token: ${ctx.token}`,
    "First: tell the guest that the asker wants to know the ask_summary (warm, brief Hebrew).",
    "Second: to continue they MUST register — collect first name + gender (זכר→male / נקבה→female); surname optional.",
    "FORBIDDEN: answering the ask_summary substance, messaging the asker, or claiming the check is done before metadata.register succeeds.",
    "When name+gender known emit metadata.register; empty mutate arrays otherwise.",
  ].join("\n");
}

export async function consumeWhatsAppInvite(
  inviteId: string,
): Promise<WhatsAppInviteRow | null> {
  try {
    const row = await prisma.whatsAppInvite.update({
      where: { id: inviteId },
      data: { status: "consumed", consumedAt: new Date() },
    });
    return toInviteRow(row);
  } catch {
    return null;
  }
}
