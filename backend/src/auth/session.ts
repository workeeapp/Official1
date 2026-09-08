import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import type { CookieOptions, Response } from "express";
import type { PublicUser } from "@workee/shared";
import { getEnv, isProduction } from "../config/env.js";

export const SESSION_COOKIE_NAME = "workee_session";
const SESSION_TTL = "7d";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function getSecret(): Uint8Array {
  return new TextEncoder().encode(getEnv().AUTH_SECRET);
}

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS,
  };
}

export async function createSessionToken(user: PublicUser): Promise<string> {
  return new SignJWT({ username: user.username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .setJti(crypto.randomUUID())
    .sign(getSecret());
}

export interface SessionPayload {
  user: PublicUser;
  sessionId: string;
}

export async function readSessionToken(token: string): Promise<SessionPayload> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ["HS256"],
    });

    const id = payload.sub;
    const username = payload.username;
    const sessionId = payload.jti;

    if (!id || typeof username !== "string" || !sessionId) {
      throw new Error("Invalid session payload");
    }

    return { user: { id, username }, sessionId };
  } catch (error) {
    if (error instanceof joseErrors.JOSEError) {
      throw new Error("Invalid session");
    }
    throw error;
  }
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
  });
}
