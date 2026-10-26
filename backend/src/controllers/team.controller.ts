import type { Request, Response } from "express";
import { getTeamForUser } from "../services/employee.service.js";
import { UnauthorizedError } from "../utils/errors.js";

export async function getTeam(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const team = await getTeamForUser(req.user.id);
  res.status(200).json({ team });
}
