/**
 * Wave 1 Stage 2 — gated /as-prospect, /restore-me (/reset-me alias), /reset-cold
 * (non-production + DEV_TEST_PHONES).
 *
 * Safety: these tools NEVER delete User / Employee / lists / reminders / chats.
 * Cold-prospect testing parks the real phone on `_backup` and restores it with
 * /restore-me. A temporary Prospect on the live digits (if any) is only
 * unlinked (phone cleared) — its rows stay in the DB as orphans.
 */
import { prisma } from "../database/prisma.js";
import { getEnv, isProduction } from "../config/env.js";
import { normalizePhoneDigits, phonesMatch, toWhatsAppAddress } from "../utils/phone.js";
import { clearWhatsAppWorkerSticky } from "./whatsapp-worker-sticky.js";
import { clearWhatsAppInboundWindow } from "./whatsapp-window.js";
import { consumeStickyMessageInvitesForPhone } from "./whatsapp-invite.service.js";

export const DEV_AS_PROSPECT_CMD = "/as-prospect";
/** Preferred restore command (safe phone un-park). */
export const DEV_RESTORE_ME_CMD = "/restore-me";
/** Legacy alias for /restore-me — same safe phone-park restore, zero DELETEs. */
export const DEV_RESET_ME_CMD = "/reset-me";
export const DEV_RESET_COLD_CMD = "/reset-cold";
export const PHONE_BACKUP_SUFFIX = "_backup";

export function isDevProspectToolCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t === DEV_AS_PROSPECT_CMD ||
    t === DEV_RESTORE_ME_CMD ||
    t === DEV_RESET_ME_CMD ||
    t === DEV_RESET_COLD_CMD
  );
}

/**
 * Hard gate: production / empty allowlist → tools are ignored.
 * DEV_TEST_PHONES should stay empty on LIVE by default.
 */
export function isDevTestPhoneAllowed(phone: string): boolean {
  if (isProduction() || getEnv().NODE_ENV === "production") {
    return false;
  }
  const raw = getEnv().DEV_TEST_PHONES?.trim() ?? "";
  if (!raw) {
    return false;
  }
  const allowed = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return allowed.some((entry) => phonesMatch(entry, phone));
}

function digitsOrRaw(phone: string): string {
  return toWhatsAppAddress(phone) || normalizePhoneDigits(phone) || phone.trim();
}

function backupPhone(phone: string): string {
  const base = digitsOrRaw(phone);
  return `${base}${PHONE_BACKUP_SUFFIX}`.slice(0, 32);
}

export async function handleDevProspectTool(input: {
  phone: string;
  text: string;
}): Promise<{ handled: boolean; reply: string }> {
  const cmd = input.text.trim().toLowerCase();
  if (!isDevProspectToolCommand(cmd)) {
    return { handled: false, reply: "" };
  }
  if (!isDevTestPhoneAllowed(input.phone)) {
    // Completely ignored outside allowlist / production.
    return { handled: false, reply: "" };
  }
  if (cmd === DEV_AS_PROSPECT_CMD) {
    return { handled: true, reply: await runAsProspect(input.phone) };
  }
  if (cmd === DEV_RESET_COLD_CMD) {
    return { handled: true, reply: await runResetCold(input.phone) };
  }
  // /restore-me and legacy /reset-me — reversible phone restore only.
  return { handled: true, reply: await runRestoreMe(input.phone, cmd) };
}

async function runAsProspect(phone: string): Promise<string> {
  const digits = digitsOrRaw(phone);
  const employee = await prisma.employee.findFirst({
    where: { phone: digits },
  });
  if (!employee?.phone) {
    // Also try loose match
    const all = await prisma.employee.findMany({
      where: { phone: { not: null } },
      select: { id: true, userId: true, phone: true },
    });
    const hit = all.find((row) => row.phone && phonesMatch(row.phone, phone));
    if (!hit?.phone) {
      return "אין משתמש פעיל על המספר הזה ל-/as-prospect.";
    }
    const bak = backupPhone(hit.phone);
    await prisma.employee.update({
      where: { id: hit.id },
      data: { phone: bak },
    });
    clearWhatsAppWorkerSticky(phone);
    clearWhatsAppWorkerSticky(digits);
    return `as-prospect: המספר הועבר ל־${bak}. ההודעה הבאה תיצור Prospect חדש.`;
  }
  const bak = backupPhone(employee.phone);
  const conflict = await prisma.employee.findFirst({
    where: { phone: bak, id: { not: employee.id } },
  });
  if (conflict) {
    return `as-prospect נכשל — ${bak} כבר תפוס. הריצו /restore-me קודם.`;
  }
  await prisma.employee.update({
    where: { id: employee.id },
    data: { phone: bak },
  });
  clearWhatsAppWorkerSticky(phone);
  clearWhatsAppWorkerSticky(digits);
  return `as-prospect: המספר הועבר ל־${bak}. ההודעה הבאה תיצור Prospect חדש (consentPending).`;
}

/**
 * Clear Meta 24h CS window for this phone. Must run after markWhatsAppInbound
 * for the command message itself, otherwise the tool inbound would leave the
 * session open.
 */
async function clearColdWindowForDevPhone(phone: string): Promise<string> {
  const digits = digitsOrRaw(phone);
  const cleared =
    (await clearWhatsAppInboundWindow(phone)) ||
    (await clearWhatsAppInboundWindow(digits));
  return cleared
    ? "חלון 24 שעות נוקה — המספר נחשב Cold (אין session)."
    : "חלון 24 שעות כבר היה סגור (או שלא נמצאה רשומת inbound).";
}

async function runResetCold(phone: string): Promise<string> {
  const note = await clearColdWindowForDevPhone(phone);
  return `reset-cold: ${note}`;
}

/**
 * Unlink a temp Prospect from this phone without deleting any rows.
 * Real member data on `_backup` is never touched here.
 */
async function unlinkTempPhoneHolder(input: {
  employeeId: string;
  userId: string;
}): Promise<void> {
  await prisma.employee.update({
    where: { id: input.employeeId },
    data: { phone: null },
  });
  // Soft-detach invite guest pointers — no DELETE of invite rows.
  await prisma.whatsAppInvite
    .updateMany({
      where: { guestEmployeeId: input.employeeId },
      data: { guestEmployeeId: null },
    })
    .catch(() => undefined);
}

/**
 * Safe restore: put the parked `_backup` phone back on the real member.
 * Never deletes Users, Employees, lists, reminders, or chats.
 */
async function runRestoreMe(phone: string, cmdLabel: string): Promise<string> {
  const digits = digitsOrRaw(phone);
  const bak = backupPhone(digits);
  const label = cmdLabel === DEV_RESET_ME_CMD ? "reset-me→restore-me" : "restore-me";

  try {
    const backupEmp = await prisma.employee.findFirst({
      where: { phone: bak },
      select: { id: true, userId: true, phone: true },
    });
    if (!backupEmp) {
      clearWhatsAppWorkerSticky(phone);
      clearWhatsAppWorkerSticky(digits);
      const coldNote = await clearColdWindowForDevPhone(phone);
      return `${label}: אין משתמש _backup לשחזור. ${coldNote}`;
    }

    const current = await prisma.employee.findFirst({
      where: { phone: digits },
      select: { id: true, userId: true },
    });
    // Only unlink a different account currently holding the live digits.
    // Never clear the backup member itself.
    if (current && current.userId !== backupEmp.userId) {
      await unlinkTempPhoneHolder({
        employeeId: current.id,
        userId: current.userId,
      });
    } else if (current && current.id !== backupEmp.id) {
      // Same user, different employee row somehow holding digits — free it.
      await prisma.employee.update({
        where: { id: current.id },
        data: { phone: null },
      });
    }

    await prisma.employee.update({
      where: { id: backupEmp.id },
      data: { phone: digits },
    });
    clearWhatsAppWorkerSticky(phone);
    clearWhatsAppWorkerSticky(digits);
    clearWhatsAppWorkerSticky(bak);
    // Registered Member restore: drop sticky message invites on this phone.
    // Collab Share/Assign stay pending. Prospect shells are not restored here.
    const restoredUser = await prisma.user.findUnique({
      where: { id: backupEmp.userId },
      select: { consentPending: true },
    });
    if (restoredUser?.consentPending === false) {
      await consumeStickyMessageInvitesForPhone(digits).catch(() => undefined);
    }
    const coldNote = await clearColdWindowForDevPhone(phone);
    return `${label}: שוחזר המספר ${digits} למשתמש המקורי (ללא מחיקת נתונים). ${coldNote}`;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[restore-me] phone restore failed", { phone: digits, detail, err });
    return `${label} נכשל: לא הצלחתי לשחזר את המספר (${detail.slice(0, 180)}).`;
  }
}
