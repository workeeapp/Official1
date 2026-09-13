import type { Request, Response } from "express";
import { humanEmployees, isProtectedEmployee } from "@workee/shared";
import { notifySharedItemEvents } from "../services/chat.service.js";
import {
  deleteEmployeeRecord,
  getEmployeeOwnedRecords,
  updateEmployeeRecord,
} from "../services/employee-records.service.js";
import {
  createEmployeeForUser,
  deleteEmployeeForUser,
  getDigitalEmployeeDefaults,
  getEmployeeForUser,
  listEmployeesForUser,
  resolveActingEmployee,
  updateEmployeeForUser,
} from "../services/employee.service.js";
import { parseEmployeeIdQuery } from "../validation/chat.validation.js";
import { parseEmployeeBody, parseRecordFields } from "../validation/employee.validation.js";
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

export async function getDigitalDefaults(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  res.status(200).json(getDigitalEmployeeDefaults());
}

export async function getEmployeeRecords(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const employeeId = parseEmployeeIdQuery(req.params.id);
  await getEmployeeForUser(req.user.id, employeeId);
  const records = await getEmployeeOwnedRecords(employeeId);
  res.status(200).json(records);
}

export async function updateEmployeeRecordItem(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const employeeId = parseEmployeeIdQuery(req.params.id);
  const itemId = parseEmployeeIdQuery(req.params.itemId);
  const fields = parseRecordFields(req.body);
  await getEmployeeForUser(req.user.id, employeeId);
  const [actor, employees] = await Promise.all([
    resolveActingEmployee(req.user.id),
    listEmployeesForUser(req.user.id),
  ]);
  const events = await updateEmployeeRecord(employeeId, itemId, fields, actor.id);
  const digital =
    employees.find((employee) => isProtectedEmployee(employee)) ??
    employees.find((employee) => employee.kind === "digital");
  const notifications = digital
    ? await notifySharedItemEvents({
        userId: req.user.id,
        actor,
        employees: humanEmployees(employees),
        events,
        digitalEmployeeId: digital.id,
      })
    : [];
  const records = await getEmployeeOwnedRecords(employeeId);
  res.status(200).json({ records, notifications });
}

export async function deleteEmployeeRecordItem(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const employeeId = parseEmployeeIdQuery(req.params.id);
  const itemId = parseEmployeeIdQuery(req.params.itemId);
  await getEmployeeForUser(req.user.id, employeeId);
  const [actor, employees] = await Promise.all([
    resolveActingEmployee(req.user.id),
    listEmployeesForUser(req.user.id),
  ]);
  const events = await deleteEmployeeRecord(employeeId, itemId, actor.id);
  const digital =
    employees.find((employee) => isProtectedEmployee(employee)) ??
    employees.find((employee) => employee.kind === "digital");
  const notifications = digital
    ? await notifySharedItemEvents({
        userId: req.user.id,
        actor,
        employees: humanEmployees(employees),
        events,
        digitalEmployeeId: digital.id,
      })
    : [];
  const records = await getEmployeeOwnedRecords(employeeId);
  res.status(200).json({ records, notifications });
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
