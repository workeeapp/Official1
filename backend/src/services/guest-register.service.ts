import type { LlmRegisterAction, PublicEmployee } from "@workee/shared";
import { isGuestEmployee, isGuestLucy } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { ConflictError, isUniqueConstraintError } from "../utils/errors.js";
import {
  createEmployeeForUser,
  listEmployeesForUser,
} from "./employee.service.js";
import { createWhatsAppOnlyUser } from "./user.service.js";
import { normalizeEmployeePhone } from "../utils/phone.js";
import { clearWhatsAppWorkerSticky } from "./whatsapp-worker-sticky.js";

export type GuestRegisterResult =
  | {
      ok: true;
      newUserId: string;
      newEmployeeId: string;
      mirrorEmployeeId: string;
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
 * Convert a WhatsApp guest into a registered member with their own User + Lucy.
 * Keeps the host employee row (renamed, phone cleared) as the share mirror.
 * WhatsApp-only: no username/password on the new User.
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
    const newUser = await createWhatsAppOnlyUser();
    // Seeds protected Lucy (and לוסי-אורח) on the new account.
    await listEmployeesForUser(newUser.id);

    // Clear host phone first so the global unique index allows the new member.
    // Keep isGuest + no team: renamed share-mirror stays a guest shell on the host.
    await prisma.employee.update({
      where: { id: input.guest.id },
      data: {
        name,
        surname,
        nickname: name,
        phone: null,
        isGuest: true,
        teamId: null,
        addressGender: gender,
      },
    });

    const member = await createEmployeeForUser(newUser.id, {
      kind: "human",
      name,
      surname,
      nickname: name,
      email: null,
      phone,
      isOwner: true,
      addressGender: gender,
    });

    await prisma.employee.update({
      where: { id: member.id },
      data: { shareMirrorEmployeeId: input.guest.id },
    });

    if (phone) {
      clearWhatsAppWorkerSticky(phone);
    }

    return {
      ok: true,
      newUserId: newUser.id,
      newEmployeeId: member.id,
      mirrorEmployeeId: input.guest.id,
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
