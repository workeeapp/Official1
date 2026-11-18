import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { getEnv } from "../config/env.js";
import { normalizePhoneDigits, phonesMatch, toWhatsAppAddress } from "../utils/phone.js";
export const INVITE_TOKEN_PREFIX = "WRK-INV-";
export const INVITE_TOKEN_RE = /\bWRK-INV-([A-Z0-9]{8,16})\b/i;
export const WHATSAPP_COMPOSE_LABEL = "שלח בוואטסאפ";
export const WHATSAPP_COMPOSE_URL_MAX = 2000;

/** Wave 1 D4b — lazy 14-day invite TTL. */
export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type InviteIntentKind = "send" | "share" | "assign";

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
  /** Null for a legacy message invite. */
  payload: unknown | null;
  createdAt: Date;
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

/** Clean bare `https://wa.me/<digits>` — no `?text=` (trustworthy preview). */
export function buildWhatsAppBareUrl(phone: string): string | null {
  const digits = toWhatsAppAddress(phone) || normalizePhoneDigits(phone);
  if (!digits) {
    return null;
  }
  return `https://wa.me/${digits}`;
}

export function buildWhatsAppComposeUrl(phone: string, text: string): string {
  const digits = toWhatsAppAddress(phone) || normalizePhoneDigits(phone);
  const encoded = encodeURIComponent(text);
  return `https://wa.me/${digits}?text=${encoded}`.slice(0, WHATSAPP_COMPOSE_URL_MAX);
}

/**
 * Human ask-summary for drafts. Never leave the generic «לעדכן אותי» when we
 * have a real item title; prefix assign chores as «משימה: …».
 */
export function formatInviteDraftSummary(input: {
  askSummary: string;
  intentKind?: InviteIntentKind;
}): string {
  const raw = input.askSummary.trim();
  const body =
    !raw || raw === "לעדכן אותי"
      ? input.intentKind === "assign"
        ? "משימה"
        : input.intentKind === "share"
          ? "פריט משותף"
          : "הודעה"
      : raw;
  if (input.intentKind === "assign" && !/^משימה\s*:/i.test(body)) {
    return `משימה: ${body}`;
  }
  return body;
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

export function inviteIsPastTtl(
  createdAt: Date,
  now: Date = new Date(),
): boolean {
  return createdAt.getTime() + INVITE_TTL_MS <= now.getTime();
}

/** Lazy expire one pending invite past TTL. Returns true when THIS call expired it. */
export async function lazyExpireInvite(input: {
  id: string;
  status: string;
  createdAt: Date;
}): Promise<boolean> {
  if (input.status !== "pending" || !inviteIsPastTtl(input.createdAt)) {
    return false;
  }
  const updated = await prisma.whatsAppInvite.updateMany({
    where: { id: input.id, status: "pending" },
    data: { status: "expired" },
  });
  return updated.count === 1;
}

/** Asker cancels their own still-pending invite (Wave 1 Stage 1). */
export async function cancelPendingInviteByAsker(input: {
  inviteId: string;
  userId: string;
  askerEmployeeId: string;
}): Promise<"cancelled" | "lost"> {
  const updated = await prisma.whatsAppInvite.updateMany({
    where: {
      id: input.inviteId,
      userId: input.userId,
      askerEmployeeId: input.askerEmployeeId,
      status: "pending",
    },
    data: { status: "cancelled" },
  });
  return updated.count === 1 ? "cancelled" : "lost";
}

/**
 * Draft the asker forwards from personal WhatsApp.
 * Wave 1: intentKind selects Share/Assign/Send Lucy-branded wording.
 * Gender-safe: no masculine «ביקש» / feminine-only verbs on asker names.
 * Business link inside the draft is a **bare** `https://wa.me/<Lucy>` (no `?text=`).
 */
export function buildFatherInviteDraft(input: {
  askerName: string;
  askSummary: string;
  /** Full token including WRK-INV- prefix (kept for bind; not required in body). */
  token: string;
  /** true = check-with / ask; false = pure info send. */
  expectsReply?: boolean;
  intentKind?: InviteIntentKind;
}): { draftText: string; businessUrl: string | null } {
  const intent =
    input.intentKind ?? (input.expectsReply === false ? "send" : "send");
  const expectsReply =
    input.intentKind != null
      ? input.intentKind === "assign"
      : input.expectsReply !== false;
  const body = formatInviteDraftSummary({
    askSummary: input.askSummary,
    intentKind: intent,
  });
  const asker = input.askerName.trim() || "מישהו";
  const businessPhone = businessDisplayPhoneDigits();
  const businessUrl = businessPhone
    ? buildWhatsAppBareUrl(businessPhone)
    : null;
  const linkLine = businessUrl
    ? businessUrl
    : "כתבו למספר של לוסי בוואטסאפ כדי להמשיך.";
  let missionLine: string;
  if (intent === "share") {
    missionLine = `יש שיתוף מ${asker} בלוסי: ${body}`;
  } else if (intent === "assign") {
    missionLine = `הוקצתה לך משימה מ${asker} בלוסי: ${body.replace(/^משימה:\s*/i, "")}`;
  } else if (expectsReply) {
    missionLine = `בקשה לברר איתך (מאת ${asker}) בלוסי: ${body}`;
  } else {
    missionLine = `הודעה מ${asker} בלוסי: ${body}`;
  }
  const draftText = [
    "היי, כאן לוסי",
    `העוזרת האישית של ${asker}`,
    missionLine,
    "",
    linkLine,
  ].join("\n");
  return { draftText, businessUrl };
}

/** Honest asker status while invite is still pending — never «בוצע». */
export function formatAskerPendingNotice(input: {
  recipientLabel: string;
  intentKind: InviteIntentKind;
  /** Cold Prospect / no open WhatsApp chat with Lucy yet. */
  coldProspect?: boolean;
}): string {
  const label = input.recipientLabel.trim() || "הנמען";
  if (input.coldProspect) {
    if (input.intentKind === "share") {
      return `ממתין — השיתוף עם «${label}» עדיין לא הושלם. «${label}» עדיין לא פתח/ה שיחה עם לוסי בוואטסאפ, אז לא שלחתי ישירות.`;
    }
    if (input.intentKind === "assign") {
      return `ממתין — האחריות ל«${label}» עדיין ממתינה. «${label}» עדיין לא פתח/ה שיחה עם לוסי בוואטסאפ, אז לא שלחתי ישירות.`;
    }
    return `ממתין — ההודעה ל«${label}» עדיין ממתינה. «${label}» עדיין לא פתח/ה שיחה עם לוסי בוואטסאפ, אז לא שלחתי ישירות.`;
  }
  if (input.intentKind === "share") {
    return `ממתין — השיתוף עם «${label}» עדיין לא הושלם (ממתין שהנמען יראה/יצטרף).`;
  }
  if (input.intentKind === "assign") {
    return `ממתין — האחריות ל«${label}» עדיין ממתינה לאישור הנמען.`;
  }
  return `ממתין — ההודעה ל«${label}» עדיין ממתינה (הנמען עדיין לא כתב / התוכן עדיין לא הוצג).`;
}

export function formatColdInviteNotice(input: {
  recipientLabel: string;
  draftText: string;
  intentKind?: InviteIntentKind;
  /** When true, copy explains Cold Prospect / no open Lucy chat yet. */
  coldProspect?: boolean;
}): string {
  const pending = formatAskerPendingNotice({
    recipientLabel: input.recipientLabel,
    intentKind: input.intentKind ?? "send",
    coldProspect: input.coldProspect ?? true,
  });
  return [
    pending,
    "כדי לפתוח את השיחה עם לוסי, שלחו את ההודעה הזו מהוואטסאפ שלכם (לחצו «שלח בוואטסאפ» — קישור מוכן להעברה):",
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
  intentKind?: InviteIntentKind;
  /** Deferred share/assign. Omit for a legacy message invite. */
  payload?: Prisma.InputJsonValue | null;
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
  const intentKind =
    input.intentKind ??
    (input.payload != null ? undefined : input.expectsReply === false ? "send" : "send");
  const expectsReply = input.expectsReply !== false;
  const { draftText } = buildFatherInviteDraft({
    askerName: input.askerName,
    askSummary: input.askSummary,
    token,
    expectsReply,
    ...(intentKind ? { intentKind } : {}),
  });
  const row = await prisma.whatsAppInvite.create({
    data: {
      token,
      userId: input.userId,
      askerEmployeeId: input.askerEmployeeId,
      digitalEmployeeId: input.digitalEmployeeId,
      recipientPhone: phone,
      recipientLabel: input.recipientLabel.slice(0, 100),
      askSummary: (
        input.askSummary.trim() ||
        (intentKind === "assign"
          ? "משימה"
          : intentKind === "share"
            ? "פריט משותף"
            : "הודעה")
      ).slice(0, 500),
      draftText,
      status: "pending",
      ...(input.payload != null ? { payload: input.payload } : {}),
    },
  });
  const composeUrl = buildWhatsAppComposeUrl(phone, draftText);
  const noticeIntent: InviteIntentKind =
    intentKind ??
    (expectsReply ? "send" : "send");
  return {
    invite: toInviteRow(row),
    composeUrl,
    notice: formatColdInviteNotice({
      recipientLabel: input.recipientLabel,
      draftText,
      intentKind: noticeIntent,
      // Cold path only creates invites when free-form Graph send cannot run
      // (no 24h window) — AskerNotice always explains Pending + wa.me forward.
      coldProspect: true,
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
  payload?: unknown | null;
  createdAt: Date;
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
    payload: row.payload ?? null,
    createdAt: row.createdAt,
  };
}

/** Return pending invite only if still within TTL (lazy-expires otherwise). */
async function keepIfPendingFresh(
  row: WhatsAppInviteRow | null,
): Promise<WhatsAppInviteRow | null> {
  if (!row) {
    return null;
  }
  if (await lazyExpireInvite(row)) {
    return null;
  }
  return row.status === "pending" ? row : null;
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
  return keepIfPendingFresh(row ? toInviteRow(row) : null);
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
  return keepIfPendingFresh(row ? toInviteRow(row) : null);
}

/** Pending share/assign invites for this phone, oldest first. Legacy rows are omitted. */
export async function findPendingCollabInvites(
  phone: string,
): Promise<WhatsAppInviteRow[]> {
  const digits = toWhatsAppAddress(phone) || normalizePhoneDigits(phone);
  if (!digits) {
    return [];
  }
  const rows = await prisma.whatsAppInvite.findMany({
    where: {
      status: "pending",
      recipientPhone: digits,
      payload: { not: Prisma.DbNull },
    },
    orderBy: { createdAt: "asc" },
  });
  const out: WhatsAppInviteRow[] = [];
  for (const raw of rows) {
    const row = toInviteRow(raw);
    if (!phonesMatch(row.recipientPhone, digits)) {
      continue;
    }
    const fresh = await keepIfPendingFresh(row);
    if (fresh) {
      out.push(fresh);
    }
  }
  return out;
}

/** Latest pending message invite (no share/assign payload) for this phone. */
export async function findPendingMessageInviteByPhone(
  phone: string,
): Promise<WhatsAppInviteRow | null> {
  const digits = toWhatsAppAddress(phone) || normalizePhoneDigits(phone);
  if (!digits) {
    return null;
  }
  const rows = await prisma.whatsAppInvite.findMany({
    where: {
      status: "pending",
      recipientPhone: digits,
      payload: { equals: Prisma.DbNull },
    },
    orderBy: { createdAt: "desc" },
  });
  for (const raw of rows) {
    const row = toInviteRow(raw);
    if (!phonesMatch(row.recipientPhone, digits)) {
      continue;
    }
    const fresh = await keepIfPendingFresh(row);
    if (fresh) {
      return fresh;
    }
  }
  return null;
}

export async function findPendingInviteForGuest(
  guestEmployeeId: string,
): Promise<WhatsAppInviteRow | null> {
  const row = await prisma.whatsAppInvite.findFirst({
    where: { guestEmployeeId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  return keepIfPendingFresh(row ? toInviteRow(row) : null);
}

/**
 * Remember which employee opened this invite, and return its context.
 * Never changes that employee's account, guest flag, or team.
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
  // A deferred share/assign belongs to one phone. A forwarded token must not bind it.
  if (invite.payload != null && !phonesMatch(invite.recipientPhone, input.fromPhone)) {
    return null;
  }

  const employeeId = input.currentEmployeeId;
  const userId = input.currentUserId;

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

/** Leftover אורח shell only. A normal account must not see this block. */
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

/** Opening subject for someone who already has their own Lucy. Not a gate. */
export function formatInviteOpeningContext(ctx: PendingInviteContext): string {
  return [
    "INVITE CONTEXT (first exposure — warm welcome):",
    `asker_name: ${ctx.askerName}`,
    `activity: ${ctx.askSummary}`,
    "First reply: warm Hebrew greeting that clearly presents this activity from asker_name.",
    "Let them know they can immediately manage tasks, shopping lists, reminders, and filings with you — zero signup friction for that.",
    "FORBIDDEN: product-brand jargon in spoken replies, login/password talk, or inventing a registration wall for ordinary chat/lists.",
    "Explicit Join / outreach gate only when they try Member-only durable personal saves or invite/assign a new third-party contact.",
    "This is not a limit. Handle any other normal request on this turn the same way you would without this block.",
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
