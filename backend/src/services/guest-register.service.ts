import type { LlmRegisterAction, PublicEmployee } from "@workee/shared";
import { isGuestEmployee, isGuestLucy } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { ConflictError, isUniqueConstraintError } from "../utils/errors.js";
import { ensureSharedRegisteredTeam } from "./employee.service.js";
import { normalizeEmployeePhone } from "../utils/phone.js";
import { clearWhatsAppWorkerSticky } from "./whatsapp-worker-sticky.js";

export type GuestRegisterResult =
  | {
      ok: true;
      /** Host account — registration stays on this User. */
      userId: string;
      /** Same employee id as the guest shell (promoted in place). */
      employeeId: string;
      displayName: string;
    }
  | {
      ok: false;
      reason:
        | "not_guest"
        | "not_guest_lucy"
        | "invalid_fields"
        | "failed";
      detail?: string;
    };

/**
 * Promote a WhatsApp guest in place on the host account.
 * Same employee id keeps phone; joins shared "New Registered 30 days" team.
 * Next WhatsApp turn talks with לוסי (not לוסי-אורח) on a new conversation.
 */
export async function registerGuestMember(input: {
  hostUserId: string;
  guest: PublicEmployee;
  digital: PublicEmployee;
  register: LlmRegisterAction;
}): Promise<GuestRegisterResult> {
  if (!isGuestEmployee(input.guest)) {
    return { ok: false, reason: "not_guest" };
  }
  if (!isGuestLucy(input.digital)) {
    return { ok: false, reason: "not_guest_lucy" };
  }

  const name = input.register.name.trim();
  const surname = (input.register.surname ?? "").trim();
  const gender = input.register.gender;
  if (!name || (gender !== "male" && gender !== "female")) {
    return {
      ok: false,
      reason: "invalid_fields",
      detail: "Missing name or gender",
    };
  }

  const phone = normalizeEmployeePhone(input.guest.phone);

  try {
    const sharedTeam = await ensureSharedRegisteredTeam(input.hostUserId);

    await prisma.employee.update({
      where: { id: input.guest.id },
      data: {
        name,
        surname,
        nickname: name,
        isGuest: false,
        isOwner: false,
        teamId: sharedTeam.id,
        addressGender: gender,
        // Keep phone on this row — no second User / human.
      },
    });

    if (phone) {
      clearWhatsAppWorkerSticky(phone);
    }

    return {
      ok: true,
      userId: input.hostUserId,
      employeeId: input.guest.id,
      displayName: name,
    };
  } catch (error) {
    if (error instanceof ConflictError) {
      return { ok: false, reason: "failed", detail: error.message };
    }
    if (isUniqueConstraintError(error)) {
      return { ok: false, reason: "failed", detail: "unique constraint" };
    }
    return {
      ok: false,
      reason: "failed",
      detail: error instanceof Error ? error.message : "unknown",
    };
  }
}
