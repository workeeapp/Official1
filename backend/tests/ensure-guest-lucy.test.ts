import { beforeEach, describe, expect, it, vi } from "vitest";
import { GUEST_LUCY_NAME } from "@workee/shared";

const { findFirst, update, findUnique, teamFindUnique, teamCreate } = vi.hoisted(
  () => ({
    findFirst: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
    teamFindUnique: vi.fn(),
    teamCreate: vi.fn(),
  }),
);

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    employee: { findFirst, update, findMany: vi.fn(), create: vi.fn() },
    user: { findUnique },
    team: { findUnique: teamFindUnique, create: teamCreate },
  },
}));

import { ensureGuestLucy } from "../src/services/employee.service.js";

const userId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";
const guestLucyId = "33333333-3333-4333-8333-333333333333";

describe("ensureGuestLucy", () => {
  beforeEach(() => {
    findFirst.mockReset();
    update.mockReset();
    findUnique.mockReset();
    teamFindUnique.mockReset().mockResolvedValue({
      id: teamId,
      userId,
      name: "Amit",
    });
    teamCreate.mockReset();
  });

  it("does not overwrite a custom UI-edited prompt", async () => {
    findFirst.mockResolvedValue({
      id: guestLucyId,
      userId,
      teamId,
      kind: "digital",
      name: GUEST_LUCY_NAME,
      nickname: GUEST_LUCY_NAME,
      instructions: "Custom guest Lucy prompt from the Employees UI",
      isGuest: false,
    });

    await ensureGuestLucy(userId);

    expect(update).not.toHaveBeenCalled();
  });

  it("still attaches a missing team without touching instructions", async () => {
    findFirst.mockResolvedValue({
      id: guestLucyId,
      userId,
      teamId: null,
      kind: "digital",
      name: GUEST_LUCY_NAME,
      nickname: GUEST_LUCY_NAME,
      instructions: "Custom guest Lucy prompt from the Employees UI",
      isGuest: false,
    });

    await ensureGuestLucy(userId);

    expect(update).toHaveBeenCalledWith({
      where: { id: guestLucyId },
      data: { teamId, isGuest: false },
    });
  });
});
