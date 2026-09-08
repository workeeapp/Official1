import type { PublicUser } from "@workee/shared";
import {
  verifyAgainstDummyHash,
  verifyPassword,
} from "../auth/password.js";
import { createSessionToken } from "../auth/session.js";
import { findUserById, findUserByUsername, toPublicUser } from "./user.service.js";
import { InvalidCredentialsError, UnauthorizedError } from "../utils/errors.js";

export async function authenticate(
  username: string,
  password: string,
): Promise<{ user: PublicUser; token: string }> {
  const user = await findUserByUsername(username);

  if (!user) {
    await verifyAgainstDummyHash(password);
    throw new InvalidCredentialsError();
  }

  const matches = await verifyPassword(user.passwordHash, password);

  if (!matches) {
    throw new InvalidCredentialsError();
  }

  const publicUser = toPublicUser(user);
  const token = await createSessionToken(publicUser);

  return { user: publicUser, token };
}

export async function resolveAuthenticatedUser(userId: string): Promise<PublicUser> {
  const user = await findUserById(userId);

  if (!user) {
    throw new UnauthorizedError();
  }

  return toPublicUser(user);
}
