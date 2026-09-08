import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const { findUnique, create } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    user: {
      findUnique,
      create,
    },
  },
}));

import {
  createUser,
  findUserById,
  findUserByUsername,
  toPublicUser,
} from "../src/services/user.service.js";
import { ConflictError } from "../src/utils/errors.js";
import { verifyPassword } from "../src/auth/password.js";

const sampleUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "Amit",
  passwordHash: "hashed",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

describe("user service", () => {
  beforeEach(() => {
    findUnique.mockReset();
    create.mockReset();
  });

  it("creates a user with a hashed password", async () => {
    create.mockImplementation(async ({ data }: { data: { username: string; passwordHash: string } }) => ({
      ...sampleUser,
      username: data.username,
      passwordHash: data.passwordHash,
    }));

    const user = await createUser("Amit", "ChangeMe123!");

    expect(create).toHaveBeenCalledOnce();
    expect(user.username).toBe("Amit");
    expect(user.passwordHash).not.toBe("ChangeMe123!");
    expect(await verifyPassword(user.passwordHash, "ChangeMe123!")).toBe(true);
  });

  it("prevents duplicate usernames", async () => {
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    await expect(createUser("Amit", "ChangeMe123!")).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("looks up a user by username and id", async () => {
    findUnique.mockResolvedValue(sampleUser);

    await expect(findUserByUsername("Amit")).resolves.toEqual(sampleUser);
    await expect(findUserById(sampleUser.id)).resolves.toEqual(sampleUser);
  });

  it("never includes the password hash in the public user shape", () => {
    const publicUser = toPublicUser(sampleUser);

    expect(publicUser).toEqual({
      id: sampleUser.id,
      username: "Amit",
    });
    expect(publicUser).not.toHaveProperty("passwordHash");
  });
});
