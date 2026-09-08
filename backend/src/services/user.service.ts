import type { User } from "@prisma/client";
import type { PublicUser } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { hashPassword } from "../auth/password.js";
import { ConflictError, isUniqueConstraintError } from "../utils/errors.js";

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
  };
}

export async function findUserByUsername(username: string): Promise<User | null> {
  return prisma.user.findUnique({
    where: { username },
  });
}

export async function findUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({
    where: { id },
  });
}

export async function createUser(
  username: string,
  password: string,
): Promise<User> {
  const passwordHash = await hashPassword(password);

  try {
    return await prisma.user.create({
      data: {
        username,
        passwordHash,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ConflictError("A user with this username already exists");
    }
    throw error;
  }
}
