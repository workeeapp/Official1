import type { Request, Response } from "express";
import { authenticate, resolveAuthenticatedUser } from "../services/auth.service.js";
import { parseLoginBody } from "../validation/auth.validation.js";
import {
  clearSessionCookie,
  setSessionCookie,
} from "../auth/session.js";
import { forgetConversation } from "../services/chat.service.js";
import { UnauthorizedError } from "../utils/errors.js";

export async function login(req: Request, res: Response): Promise<void> {
  const { username, password } = parseLoginBody(req.body);
  const { user, token } = await authenticate(username, password);

  setSessionCookie(res, token);
  res.status(200).json({ user });
}

export async function me(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const user = await resolveAuthenticatedUser(req.user.id);
  res.status(200).json({ user });
}

export async function logout(req: Request, res: Response): Promise<void> {
  if (req.sessionId) {
    forgetConversation(req.sessionId);
  }

  clearSessionCookie(res);
  res.status(200).json({ ok: true });
}
