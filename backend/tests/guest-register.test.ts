import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  DEFAULT_REGISTERED_TEAM_NAME,
  GUEST_LUCY_NAME,
} from "@workee/shared";

const {
  userFindUnique,
  teamFindFirst,
  teamCreate,
  employeeUpdate,
  clearSticky,
} = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  teamFindFirst: vi.fn(),
  teamCreate: vi.fn(),
  employeeUpdate: vi.fn(),
  clearSticky: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    team: { findFirst: teamFindFirst, create: teamCreate },
    employee: {
      update: employeeUpdate,
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
const sharedTeamId = "66666666-6666-4666-8666-666666666666";

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

const sharedTeam = {
  id: sharedTeamId,
  userId: hostUserId,
  name: DEFAULT_REGISTERED_TEAM_NAME,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("registerGuestMember", () => {
  beforeEach(() => {
    userFindUnique.mockReset();
    teamFindFirst.mockReset();
    teamCreate.mockReset();
    employeeUpdate.mockReset();
    clearSticky.mockReset();

    teamFindFirst.mockResolvedValue(sharedTeam);
    employeeUpdate.mockResolvedValue({});
  });

  it("promotes the guest in place on the shared team and keeps the phone", async () => {
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
      userId: hostUserId,
      employeeId: guestId,
      displayName: "מיכל",
    });
    expect(teamCreate).not.toHaveBeenCalled();
    expect(employeeUpdate).toHaveBeenCalledWith({
      where: { id: guestId },
      data: {
        name: "מיכל",
        surname: "כהן",
        nickname: "מיכל",
        isGuest: false,
        isOwner: false,
        teamId: sharedTeamId,
        addressGender: "female",
      },
    });
    expect(clearSticky).toHaveBeenCalledWith("972501234567");
  });

  it("creates the shared team when missing on host", async () => {
    teamFindFirst.mockResolvedValueOnce(null);
    userFindUnique.mockResolvedValue({ id: hostUserId });
    teamCreate.mockResolvedValue(sharedTeam);

    const result = await registerGuestMember({
      hostUserId,
      guest,
      digital: guestLucy,
      register: {
        name: "מיכל",
        gender: "female",
      },
    });

    expect(result.ok).toBe(true);
    expect(teamCreate).toHaveBeenCalledWith({
      data: {
        userId: hostUserId,
        name: DEFAULT_REGISTERED_TEAM_NAME,
      },
    });
  });

  it("allows missing surname", async () => {
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
        isGuest: false,
        teamId: sharedTeamId,
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
    expect(employeeUpdate).not.toHaveBeenCalled();
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
    expect(employeeUpdate).not.toHaveBeenCalled();
  });

  it("maps unique conflicts to failed", async () => {
    employeeUpdate.mockRejectedValue(
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
