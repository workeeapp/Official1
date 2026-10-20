import type { Request, Response } from "express";
import {
  createTipForUser,
  deleteTipForUser,
  listTipsForUser,
  updateTipForUser,
} from "../services/tips.service.js";
import { UnauthorizedError } from "../utils/errors.js";
import {
  parseTipCreateBody,
  parseTipIdParam,
  parseTipUpdateBody,
} from "../validation/tip.validation.js";

export async function listTips(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  const tips = await listTipsForUser(req.user.id);
  res.status(200).json({ tips, count: tips.length });
}

export async function createTip(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  const input = parseTipCreateBody(req.body);
  const tip = await createTipForUser(req.user.id, input);
  res.status(201).json({ tip });
}

export async function updateTip(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  const tipId = parseTipIdParam(req.params.id);
  const input = parseTipUpdateBody(req.body);
  const tip = await updateTipForUser(req.user.id, tipId, input);
  res.status(200).json({ tip });
}

export async function deleteTip(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  const tipId = parseTipIdParam(req.params.id);
  await deleteTipForUser(req.user.id, tipId);
  res.status(200).json({ ok: true });
}
