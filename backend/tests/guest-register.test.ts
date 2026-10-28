import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { GUEST_LUCY_NAME } from "@workee/shared";

const {
  userCreate,
  userFindUnique,
  teamFindUnique,
  teamCreate,
  employeeCreate,
  employeeUpdate,
  employeeFindFirst,
  employeeFindMany,
  clearSticky,
} = vi.hoisted(() => ({
  userCreate: vi.fn(),
  userFindUnique: vi.fn(),
  teamFindUnique: vi.fn(),
  teamCreate: vi.fn(),
  employeeCreate: vi.fn(),
  employeeUpdate: vi.fn(),
  employeeFindFirst: vi.fn(),
  employeeFindMany: vi.fn(),
  clearSticky: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    user: { create: userCreate, findUnique: userFindUnique },
    team: { findUnique: teamFindUnique, create: teamCreate },
    employee: {
      create: employeeCreate,
      update: employeeUpdate,
      findFirst: employeeFindFirst,
      findMany: employeeFindMany,
    },
  },
}));

vi.mock("../src/services/whatsapp-worker-sticky.js", () => ({
  clearWhatsAppWorkerSticky: clearSticky,
}));

import { registerGuestMember } from "../src/services/guest-register.service.js";

const hostUserId = "11111111-1111-4111-8111-111111111111";
const guestId = "22222222-2222-4222-8222-222222222222";
const guestLucyId = "33333333-3333-4333-8333-333333333333";
const newUserId = "44444444-4444-4444-8444-444444444444";
const newEmployeeId = "55555555-5555-4555-8555-555555555555";
const newTeamId = "66666666-6666-4666-8666-666666666666";

const guest = {
  id: guestId,
  kind: "human" as const,
  name: "אורח",
  surname: "",
  nickname: "אורח …4567",
  email: null,
  phone: "972501234567",
  protected: false,
  isOwner: false,
  isGuest: true,
  teamId: null,
};

const guestLucy = {
  id: guestLucyId,
  kind: "digital" as const,
  name: GUEST_LUCY_NAME,
  surname: "",
  nickname: GUEST_LUCY_NAME,
  email: null,
  phone: null,
  protected: false,
  isOwner: false,
};

describe("registerGuestMember", () => {
  beforeEach(() => {
    userCreate.mockReset();
    userFindUnique.mockReset();
    teamFindUnique.mockReset();
    teamCreate.mockReset();
    employeeCreate.mockReset();
    employeeUpdate.mockReset();
    employeeFindFirst.mockReset();
    employeeFindMany.mockReset();
    clearSticky.mockReset();

    teamFindUnique.mockResolvedValue({
      id: newTeamId,
      userId: newUserId,
      name: "Team",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // ensureProtectedLucy / ensureGuestLucy find existing; phone unique check finds none.
    employeeFindFirst.mockImplementation(
      async ({ where }: { where?: { phone?: string } }) => {
        if (where && "phone" in where) {
          return null;
        }
        return { id: "lucy", teamId: newTeamId, isGuest: false };
      },
    );
    employeeFindMany.mockResolvedValue([]);
    userCreate.mockResolvedValue({
      id: newUserId,
      username: null,
      passwordHash: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    employeeCreate.mockResolvedValue({
      id: newEmployeeId,
      userId: newUserId,
      teamId: newTeamId,
      kind: "human",
      name: "מיכל",
      surname: "כהן",
      nickname: "מיכל",
      email: null,
      phone: "972501234567",
      isProtected: false,
      isOwner: true,
      isGuest: false,
      addressGender: "female",
      shareMirrorEmployeeId: null,
      model: null,
      temperature: null,
      reasoningEffort: null,
      instructions: null,
      createdAt: new Date(),
    });
    employeeUpdate.mockResolvedValue({});
  });

  it("creates a WhatsApp-only User, member with gender, share mirror, and clears sticky", async () => {
    const result = await registerGuestMember({
      hostUserId,
      guest,
      digital: guestLucy,
      register: {
        name: "מיכל",
        surname: "כהן",
        gender: "female",
      },
    });

    expect(result).toEqual({
      ok: true,
      newUserId,
      newEmployeeId,
      mirrorEmployeeId: guestId,
      displayName: "מיכל",
    });
    expect(userCreate).toHaveBeenCalledWith({
      data: { username: null, passwordHash: null },
    });
    expect(employeeUpdate).toHaveBeenCalledWith({
      where: { id: guestId },
      data: {
        name: "מיכל",
        surname: "כהן",
        nickname: "מיכל",
        phone: null,
        isGuest: true,
        teamId: null,
        addressGender: "female",
      },
    });
    expect(employeeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: newUserId,
        teamId: newTeamId,
        isGuest: false,
        isOwner: true,
        addressGender: "female",
      }),
    });
    expect(employeeUpdate).toHaveBeenCalledWith({
      where: { id: newEmployeeId },
      data: { shareMirrorEmployeeId: guestId },
    });
    expect(clearSticky).toHaveBeenCalledWith("972501234567");
  });

  it("allows missing surname", async () => {
    employeeCreate.mockResolvedValue({
      id: newEmployeeId,
      userId: newUserId,
      teamId: newTeamId,
      kind: "human",
      name: "טל",
      surname: "",
      nickname: "טל",
      email: null,
      phone: "972501234567",
      isProtected: false,
      isOwner: true,
      isGuest: false,
      addressGender: "male",
      shareMirrorEmployeeId: null,
      model: null,
      temperature: null,
      reasoningEffort: null,
      instructions: null,
      createdAt: new Date(),
    });

    const result = await registerGuestMember({
      hostUserId,
      guest,
      digital: guestLucy,
      register: {
        name: "טל",
        gender: "male",
      },
    });

    expect(result.ok).toBe(true);
    expect(employeeUpdate).toHaveBeenCalledWith({
      where: { id: guestId },
      data: expect.objectContaining({
        name: "טל",
        surname: "",
        addressGender: "male",
      }),
    });
  });

  it("rejects non-guest speakers", async () => {
    const result = await registerGuestMember({
      hostUserId,
      guest: { ...guest, name: "טל", nickname: "טל", isGuest: false },
      digital: guestLucy,
      register: {
        name: "טל",
        gender: "male",
      },
    });
    expect(result).toEqual({ ok: false, reason: "not_guest" });
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("rejects when digital is not לוסי-אורח", async () => {
    const result = await registerGuestMember({
      hostUserId,
      guest,
      digital: { ...guestLucy, name: "לוסי", nickname: "לוסי" },
      register: {
        name: "מיכל",
        gender: "female",
      },
    });
    expect(result).toEqual({ ok: false, reason: "not_guest_lucy" });
  });

  it("rejects missing name", async () => {
    const result = await registerGuestMember({
      hostUserId,
      guest,
      digital: guestLucy,
      register: {
        name: "   ",
        gender: "female",
      },
    });
    expect(result).toEqual({
      ok: false,
      reason: "invalid_fields",
      detail: "Missing name or gender",
    });
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("maps phone conflicts to failed", async () => {
    userCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    const result = await registerGuestMember({
      hostUserId,
      guest,
      digital: guestLucy,
      register: {
        name: "מיכל",
        gender: "female",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("failed");
    }
  });
});
