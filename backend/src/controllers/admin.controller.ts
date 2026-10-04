import type { Request, Response } from "express";
import {
  getAdminCodeChanges,
  getAdminMonitoring,
  listAdminUsers,
  setAdminUserFlag,
} from "../services/admin.service.js";
import { ValidationError } from "../utils/errors.js";
import { parseEmployeeIdQuery } from "../validation/chat.validation.js";

export async function getMonitoring(
  _req: Request,
  res: Response,
): Promise<void> {
  res.status(200).json(await getAdminMonitoring());
}

export async function getCodeChanges(
  req: Request,
  res: Response,
): Promise<void> {
  const raw = Number(req.query.hours);
  const hours = Number.isFinite(raw) ? raw : 24;
  res.status(200).json(await getAdminCodeChanges(hours));
}

export async function getUsers(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await listAdminUsers());
}

export async function patchUserAdmin(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = parseEmployeeIdQuery(req.params.id);
  const body = req.body;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof (body as { isAdmin?: unknown }).isAdmin !== "boolean"
  ) {
    throw new ValidationError("isAdmin must be a boolean.", {
      isAdmin: "isAdmin must be true or false",
    });
  }
  const isAdmin = (body as { isAdmin: boolean }).isAdmin;
  res.status(200).json(await setAdminUserFlag(userId, isAdmin));
}
