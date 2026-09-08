import type { NextFunction, Request, Response } from "express";
import {
  readSessionToken,
  SESSION_COOKIE_NAME,
} from "../auth/session.js";
import { UnauthorizedError } from "../utils/errors.js";
import { asyncHandler } from "./async-handler.js";

function applySession(req: Request, session: { user: { id: string; username: string }; sessionId: string }) {
  req.user = session.user;
  req.sessionId = session.sessionId;
}

export const requireAuth = asyncHandler(async (req, _res, next) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];

  if (typeof token !== "string" || token.length === 0) {
    throw new UnauthorizedError();
  }

  try {
    applySession(req, await readSessionToken(token));
  } catch {
    throw new UnauthorizedError();
  }

  next();
});

export function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const token = req.cookies?.[SESSION_COOKIE_NAME];

  if (typeof token !== "string" || token.length === 0) {
    next();
    return;
  }

  void readSessionToken(token)
    .then((session) => {
      applySession(req, session);
      next();
    })
    .catch(() => next());
}
