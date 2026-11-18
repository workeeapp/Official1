/**
 * Anti-abuse: SenderBlock + external assign rate caps.
 * Opaque button `block_sender:<phone>` and free-text «תחסמי את …».
 */
import type { PublicEmployee } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { normalizePhoneDigits, phonesMatch, toWhatsAppAddress } from "../utils/phone.js";
import { employeeDisplayName } from "./employee-targets.service.js";

export const BLOCK_SENDER_PREFIX = "block_sender:";
export const BLOCK_SENDER_BUTTON_LABEL = "חסימת שולח";

/** Max concurrent pending assign invites from one asker → one recipient. */
export const MAX_PENDING_ASSIGNS_PER_PAIR = 3;
/** Max external invites/assigns per 24h for accounts younger than 48h. */
export const MAX_EXTERNAL_INVITES_PER_24H_NEW_ACCOUNT = 3;
export const NEW_ACCOUNT_AGE_MS = 48 * 60 * 60 * 1000;
export const EXTERNAL_INVITE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Neutral copy — never reveal that the recipient blocked the sender. */
export const SENDER_BLOCKED_NEUTRAL_NOTICE =
  "לא הצלחתי לשלוח את זה כרגע — נסו שוב מאוחר יותר.";
export const ASSIGN_RATE_CAP_NOTICE =
  "יש כבר כמה משימות ממתינות אצל הנמען — חכו שיגיב/תגיב לפני שתשלחו עוד.";
export const NEW_ACCOUNT_INVITE_CAP_NOTICE =
  "הגעתם למכסת ההזמנות לזמן הקרוב — נסו שוב מחר.";

export function isBlockSenderCommand(text: string): boolean {
  return text.trim().startsWith(BLOCK_SENDER_PREFIX);
}

export function blockSenderCommand(blockedPhone: string): string {
  const digits =
    toWhatsAppAddress(blockedPhone) || normalizePhoneDigits(blockedPhone);
  return `${BLOCK_SENDER_PREFIX}${digits}`.slice(0, 256);
}

export function parseBlockSenderCommand(text: string): string | null {
  const raw = text.trim();
  if (!raw.startsWith(BLOCK_SENDER_PREFIX)) {
    return null;
  }
  const phone = raw.slice(BLOCK_SENDER_PREFIX.length).trim();
  const digits = toWhatsAppAddress(phone) || normalizePhoneDigits(phone);
  return digits || null;
}

/** Free-text: «תחסמי את דני» / «תחסום את 050…». */
export function parseBlockSenderFreeText(text: string): string | null {
  const t = text.trim();
  const m = t.match(
    /^(?:תחסמי|תחסום|לחסום|חסימת)\s+(?:את\s+)?(.+?)(?:\s+בבקשה)?[.!]?$/u,
  );
  if (!m?.[1]) {
    return null;
  }
  const target = m[1].trim();
  const digits = toWhatsAppAddress(target) || normalizePhoneDigits(target);
  if (digits && digits.length >= 9) {
    return digits;
  }
  // Name — caller resolves via contacts.
  return target.length > 0 ? `name:${target}` : null;
}

export function normalizeBlockPhone(phone: string): string {
  return toWhatsAppAddress(phone) || normalizePhoneDigits(phone) || phone.trim();
}

export async function isSenderBlockedByPhones(
  blockerPhone: string,
  blockedPhone: string,
): Promise<boolean> {
  const blocker = normalizeBlockPhone(blockerPhone);
  const blocked = normalizeBlockPhone(blockedPhone);
  if (!blocker || !blocked) {
    return false;
  }
  const row = await prisma.senderBlock.findFirst({
    where: { blockerPhone: blocker, blockedPhone: blocked },
    select: { id: true },
  });
  return Boolean(row);
}

export async function createSenderBlock(input: {
  blockerPhone: string;
  blockedPhone: string;
}): Promise<{ created: boolean; blockerPhone: string; blockedPhone: string }> {
  const blockerPhone = normalizeBlockPhone(input.blockerPhone);
  const blockedPhone = normalizeBlockPhone(input.blockedPhone);
  if (!blockerPhone || !blockedPhone || blockerPhone === blockedPhone) {
    return { created: false, blockerPhone, blockedPhone };
  }
  try {
    await prisma.senderBlock.create({
      data: { blockerPhone, blockedPhone },
    });
    return { created: true, blockerPhone, blockedPhone };
  } catch {
    // Unique conflict — already blocked.
    return { created: false, blockerPhone, blockedPhone };
  }
}

/**
 * Display name for shared-item notify: recipient's contact roster first,
 * then employee nickname/name, then masked phone.
 */
export async function resolveNotifyActorDisplayName(input: {
  actor: PublicEmployee;
  recipientUserId: string;
  recipientEmployeeId: string;
}): Promise<string> {
  const actorPhone = input.actor.phone?.trim();
  if (actorPhone) {
    const contacts = await prisma.contact.findMany({
      where: {
        userId: input.recipientUserId,
        ownerEmployeeId: input.recipientEmployeeId,
        phone: { not: null },
      },
      select: { name: true, phone: true },
      take: 200,
    });
    const hit = contacts.find(
      (row) => row.phone && phonesMatch(row.phone, actorPhone),
    );
    const rosterName = hit?.name?.trim();
    if (rosterName) {
      return rosterName;
    }
  }
  const named = employeeDisplayName(input.actor).trim();
  if (named && !/^אורח/.test(named)) {
    return named;
  }
  if (named) {
    return named;
  }
  if (actorPhone) {
    const digits = normalizeBlockPhone(actorPhone);
    return digits ? `אורח …${digits.slice(-4)}` : "מישהו";
  }
  return "מישהו";
}

export async function countPendingAssignInvites(input: {
  askerEmployeeId: string;
  recipientPhone: string;
}): Promise<number> {
  const phone = normalizeBlockPhone(input.recipientPhone);
  if (!phone) {
    return 0;
  }
  const rows = await prisma.whatsAppInvite.findMany({
    where: {
      askerEmployeeId: input.askerEmployeeId,
      status: "pending",
      recipientPhone: { contains: phone.slice(-9) },
      payload: { not: null },
    },
    select: { id: true, payload: true, recipientPhone: true },
    take: 50,
  });
  return rows.filter((row) => {
    if (!phonesMatch(row.recipientPhone, phone)) {
      return false;
    }
    const payload = row.payload as { kind?: string } | null;
    return payload?.kind === "assign";
  }).length;
}

export async function countExternalInvitesLast24h(userId: string): Promise<number> {
  const since = new Date(Date.now() - EXTERNAL_INVITE_WINDOW_MS);
  return prisma.whatsAppInvite.count({
    where: {
      userId,
      createdAt: { gte: since },
      payload: { not: null },
    },
  });
}

export async function isNewAccountUnder48h(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { createdAt: true },
  });
  if (!user) {
    return false;
  }
  return Date.now() - user.createdAt.getTime() < NEW_ACCOUNT_AGE_MS;
}

export type ExternalAssignGateResult =
  | { ok: true }
  | { ok: false; reason: "blocked" | "pending_cap" | "new_account_cap"; notice: string };

/**
 * Gate cold/deferred external assign before WhatsAppInvite create.
 */
export async function gateExternalAssignInvite(input: {
  userId: string;
  askerEmployeeId: string;
  askerPhone: string | null | undefined;
  recipientPhone: string;
  kind: "share" | "assign";
}): Promise<ExternalAssignGateResult> {
  const recipientPhone = normalizeBlockPhone(input.recipientPhone);
  const askerPhone = input.askerPhone
    ? normalizeBlockPhone(input.askerPhone)
    : "";
  if (!recipientPhone) {
    return { ok: true };
  }

  if (askerPhone && (await isSenderBlockedByPhones(recipientPhone, askerPhone))) {
    return { ok: false, reason: "blocked", notice: SENDER_BLOCKED_NEUTRAL_NOTICE };
  }

  if (input.kind === "assign") {
    const pending = await countPendingAssignInvites({
      askerEmployeeId: input.askerEmployeeId,
      recipientPhone,
    });
    if (pending >= MAX_PENDING_ASSIGNS_PER_PAIR) {
      return { ok: false, reason: "pending_cap", notice: ASSIGN_RATE_CAP_NOTICE };
    }
  }

  if (await isNewAccountUnder48h(input.userId)) {
    const recent = await countExternalInvitesLast24h(input.userId);
    if (recent >= MAX_EXTERNAL_INVITES_PER_24H_NEW_ACCOUNT) {
      return {
        ok: false,
        reason: "new_account_cap",
        notice: NEW_ACCOUNT_INVITE_CAP_NOTICE,
      };
    }
  }

  return { ok: true };
}

export async function resolveBlockedPhoneFromLabel(input: {
  userId: string;
  ownerEmployeeId: string;
  labelOrPhone: string;
}): Promise<string | null> {
  const raw = input.labelOrPhone.trim();
  if (raw.startsWith("name:")) {
    const name = raw.slice("name:".length).trim();
    const contacts = await prisma.contact.findMany({
      where: {
        userId: input.userId,
        ownerEmployeeId: input.ownerEmployeeId,
        name: { contains: name },
      },
      select: { phone: true, name: true },
      take: 20,
    });
    const exact = contacts.find(
      (row) => row.name.trim() === name && row.phone,
    );
    const hit = exact ?? contacts.find((row) => row.phone);
    return hit?.phone ? normalizeBlockPhone(hit.phone) : null;
  }
  return normalizeBlockPhone(raw) || null;
}

export async function handleBlockSenderAction(input: {
  blockerPhone: string;
  blockedPhone: string;
}): Promise<{ ok: boolean; spoken: string }> {
  const result = await createSenderBlock({
    blockerPhone: input.blockerPhone,
    blockedPhone: input.blockedPhone,
  });
  if (!result.blockerPhone || !result.blockedPhone) {
    return { ok: false, spoken: "לא הצלחתי לזהות את השולח לחסימה." };
  }
  return {
    ok: true,
    spoken: result.created
      ? "חסמתי את השולח. לא תקבלו ממנו הזמנות או עדכונים."
      : "השולח כבר חסום אצלכם.",
  };
}
