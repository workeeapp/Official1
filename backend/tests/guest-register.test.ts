import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { GUEST_LUCY_NAME } from "@workee/shared";

const {
  userCreate,
  employeeCreate,
  employeeUpdate,
  employeeFindFirst,
  employeeFindMany,
  clearSticky,
} = vi.hoisted(() => ({
  userCreate: vi.fn(),
  employeeCreate: vi.fn(),
  employeeUpdate: vi.fn(),
  employeeFindFirst: vi.fn(),
  employeeFindMany: vi.fn(),
  clearSticky: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    user: { create: userCreate },
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
    employeeCreate.mockReset();
    employeeUpdate.mockReset();
    employeeFindFirst.mockReset();
    employeeFindMany.mockReset();
    clearSticky.mockReset();

    // ensureProtectedLucy / ensureGuestLucy find existing; phone unique check finds none.
    employeeFindFirst.mockImplementation(
      async ({ where }: { where?: { phone?: string } }) => {
        if (where && "phone" in where) {
          return null;
        }
        return { id: "lucy" };
      },
    );
    employeeFindMany.mockResolvedValue([]);
    userCreate.mockResolvedValue({
      id: newUserId,
      username: "michal",
      passwordHash: "hash",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    employeeCreate.mockResolvedValue({
      id: newEmployeeId,
      userId: newUserId,
      kind: "human",
      name: "מיכל",
      surname: "כהן",
      nickname: "מיכל",
      email: null,
      phone: "972501234567",
      isProtected: false,
      isOwner: true,
      addressGender: null,
      shareMirrorEmployeeId: null,
      model: null,
      temperature: null,
      reasoningEffort: null,
      instructions: null,
      createdAt: new Date(),
    });
    employeeUpdate.mockResolvedValue({});
  });

  it("creates a User, member, share mirror link, and clears WhatsApp sticky", async () => {
    const result = await registerGuestMember({
      hostUserId,
      guest,
      digital: guestLucy,
      register: {
        name: "מיכל",
        surname: "כהן",
        username: "michal",
        password: "SecretPass1",
      },
    });

    expect(result).toEqual({
      ok: true,
      newUserId,
      newEmployeeId,
      mirrorEmployeeId: guestId,
      username: "michal",
      displayName: "מיכל",
    });
    expect(employeeUpdate).toHaveBeenCalledWith({
      where: { id: guestId },
      data: {
        name: "מיכל",
        surname: "כהן",
        nickname: "מיכל",
        phone: null,
      },
    });
    expect(employeeUpdate).toHaveBeenCalledWith({
      where: { id: newEmployeeId },
      data: { shareMirrorEmployeeId: guestId },
    });
    // Guest phone is normalized to WhatsApp digits before sticky clear.
    expect(clearSticky).toHaveBeenCalledWith("972501234567");
  });

  it("rejects non-guest speakers", async () => {
    const result = await registerGuestMember({
      hostUserId,
      guest: { ...guest, name: "טל", nickname: "טל" },
      digital: guestLucy,
      register: {
        name: "טל",
        surname: "כהן",
        username: "taluser",
        password: "SecretPass1",
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
        surname: "כהן",
        username: "michal",
        password: "SecretPass1",
      },
    });
    expect(result).toEqual({ ok: false, reason: "not_guest_lucy" });
  });

  it("rejects taken usernames", async () => {
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
        surname: "כהן",
        username: "taken",
        password: "SecretPass1",
      },
    });
    expect(result).toEqual({ ok: false, reason: "username_taken" });
  });

  it("rejects invalid password", async () => {
    const result = await registerGuestMember({
      hostUserId,
      guest,
      digital: guestLucy,
      register: {
        name: "מיכל",
        surname: "כהן",
        username: "michal",
        password: "short",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_fields");
    }
  });
});
