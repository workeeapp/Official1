import type { Request, Response } from "express";
import {
  createEmployeeForUser,
  deleteEmployeeForUser,
  listEmployeesForUser,
  updateEmployeeForUser,
} from "../services/employee.service.js";
import { parseEmployeeBody } from "../validation/employee.validation.js";
import { UnauthorizedError } from "../utils/errors.js";

export async function listEmployees(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const employees = await listEmployeesForUser(req.user.id);
  res.status(200).json({
    employees,
    count: employees.length,
  });
}

export async function createEmployee(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const input = parseEmployeeBody(req.body);
  const employee = await createEmployeeForUser(req.user.id, input);
  res.status(201).json({ employee });
}

export async function updateEmployee(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const input = parseEmployeeBody(req.body);
  const employee = await updateEmployeeForUser(req.user.id, req.params.id, input);
  res.status(200).json({ employee });
}

export async function deleteEmployee(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  await deleteEmployeeForUser(req.user.id, req.params.id);
  res.status(200).json({ ok: true });
}
