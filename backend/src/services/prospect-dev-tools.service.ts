/**
 * Wave 1 Stage 2 — gated /as-prospect, /reset-me, /reset-cold
 * (non-production + DEV_TEST_PHONES).
 */
import { prisma } from "../database/prisma.js";
import { getEnv, isProduction } from "../config/env.js";
import { normalizePhoneDigits, phonesMatch, toWhatsAppAddress } from "../utils/phone.js";
import { clearWhatsAppWorkerSticky } from "./whatsapp-worker-sticky.js";
import { clearWhatsAppInboundWindow } from "./whatsapp-window.js";

export const DEV_AS_PROSPECT_CMD = "/as-prospect";
export const DEV_RESET_ME_CMD = "/reset-me";
export const DEV_RESET_COLD_CMD = "/reset-cold";
export const PHONE_BACKUP_SUFFIX = "_backup";

export function isDevProspectToolCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t === DEV_AS_PROSPECT_CMD ||
    t === DEV_RESET_ME_CMD ||
    t === DEV_RESET_COLD_CMD
  );
}

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
  return { handled: true, reply: await runResetMe(input.phone) };
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
    return `as-prospect נכשל — ${bak} כבר תפוס. הריצו /reset-me קודם.`;
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
 * Delete a Wave-1 temp Prospect / harness account in FK-safe order.
 * Reminder.actor is Restrict — reminders must go before employees.
 */
export async function purgeDevUserAccount(userId: string): Promise<void> {
  const employees = await prisma.employee.findMany({
    where: { userId },
    select: { id: true },
  });
  const employeeIds = employees.map((row) => row.id);

  await prisma.pendingProspectAction.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.pendingHighRiskConfirm.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.deliveryAttempt.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.whatsAppInvite.deleteMany({ where: { userId } }).catch(() => undefined);

  // Reminders: by account userId, and any row whose actor/owner is this account
  // (cross-account actor Restrict would otherwise block employee delete).
  await prisma.reminder.deleteMany({ where: { userId } }).catch(() => undefined);
  if (employeeIds.length > 0) {
    await prisma.reminder
      .deleteMany({
        where: {
          OR: [{ actorId: { in: employeeIds } }, { ownerId: { in: employeeIds } }],
        },
      })
      .catch(() => undefined);
  }

  await prisma.chatMessage
    .deleteMany({ where: { conversation: { userId } } })
    .catch(() => undefined);
  await prisma.chatConversation.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.contact.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.contactBook.deleteMany({ where: { userId } }).catch(() => undefined);

  if (employeeIds.length > 0) {
    await prisma.mission
      .deleteMany({
        where: {
          OR: [
            { userId },
            { speakerId: { in: employeeIds } },
            { orchestratorId: { in: employeeIds } },
            { executorId: { in: employeeIds } },
          ],
        },
      })
      .catch(() => undefined);
    await prisma.employee
      .updateMany({
        where: { shareMirrorEmployeeId: { in: employeeIds } },
        data: { shareMirrorEmployeeId: null },
      })
      .catch(() => undefined);
  }

  await prisma.tipProgress.deleteMany({ where: { employee: { userId } } }).catch(() => undefined);
  await prisma.tip.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.employeeFiling.deleteMany({ where: { employee: { userId } } }).catch(() => undefined);
  await prisma.employeeList.deleteMany({ where: { employee: { userId } } }).catch(() => undefined);
  await prisma.attachment.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.secretVault.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.auditEvent.deleteMany({ where: { userId } }).catch(() => undefined);

  await prisma.employee.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

async function runResetMe(phone: string): Promise<string> {
  const digits = digitsOrRaw(phone);
  const bak = backupPhone(digits);

  try {
    // Delete temporary Prospect currently on this phone (if any).
    const current = await prisma.employee.findFirst({
      where: { phone: digits },
      select: { id: true, userId: true },
    });
    if (current) {
      await purgeDevUserAccount(current.userId);
    }

    const backupEmp = await prisma.employee.findFirst({
      where: { phone: bak },
    });
    if (!backupEmp) {
      clearWhatsAppWorkerSticky(phone);
      clearWhatsAppWorkerSticky(digits);
      const coldNote = await clearColdWindowForDevPhone(phone);
      return `reset-me: אין משתמש _backup לשחזור (המספר הזמני נמחק אם היה). ${coldNote}`;
    }
    await prisma.employee.update({
      where: { id: backupEmp.id },
      data: { phone: digits },
    });
    clearWhatsAppWorkerSticky(phone);
    clearWhatsAppWorkerSticky(digits);
    clearWhatsAppWorkerSticky(bak);
    const coldNote = await clearColdWindowForDevPhone(phone);
    return `reset-me: שוחזר המספר ${digits} למשתמש המקורי. ${coldNote}`;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[reset-me] teardown failed", { phone: digits, detail, err });
    return `reset-me נכשל: לא הצלחתי למחוק/לשחזר את המשתמש הזמני (${detail.slice(0, 180)}).`;
  }
}
