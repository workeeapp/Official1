import type { Request, Response } from "express";
import { humanEmployees, isProtectedEmployee } from "@workee/shared";
import { notifySharedItemEvents } from "../services/chat.service.js";
import {
  deleteEmployeeRecord,
  getEmployeeOwnedRecords,
  updateEmployeeRecord,
} from "../services/employee-records.service.js";
import {
  clearEmployeeProfilePhoto,
  createEmployeeForUser,
  deleteEmployeeForUser,
  getDigitalEmployeeDefaults,
  getLucyPromptDefaults,
  getEmployeeForUser,
  listEmployeesForUser,
  resolveActingEmployee,
  setEmployeeProfilePhoto,
  updateEmployeeForUser,
} from "../services/employee.service.js";
import { ingestUploadedBytes } from "../services/attachment.service.js";
import {
  getEmployeeUsageSummary,
  getTeamUsageSummary,
} from "../services/llm-usage.service.js";
import { parseEmployeeIdQuery } from "../validation/chat.validation.js";
import { parseEmployeeBody, parseRecordFields } from "../validation/employee.validation.js";
import {
  UnauthorizedError,
  ValidationError,
} from "../utils/errors.js";
import { ATTACHMENT_MAX_BYTES } from "@workee/shared";

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

  // Prefer Lucy's saved prompt so "inherit from Lucy" matches what she actually runs.
  res.status(200).json(await getLucyPromptDefaults(req.user.id));
}

/** The shipped LLM.config.json base (not Lucy's saved DB prompt). */
export async function getConfigFileDefaults(req: Request, res: Response): Promise<void> {
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

export async function getTeamUsage(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const employees = await listEmployeesForUser(req.user.id);
  const teamId =
    typeof req.query.teamId === "string" && req.query.teamId.trim().length > 0
      ? req.query.teamId.trim()
      : null;
  const scoped = teamId
    ? employees.filter((employee) => employee.teamId === teamId)
    : employees;
  res.status(200).json(await getTeamUsageSummary(req.user.id, scoped));
}

export async function getEmployeeUsage(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const employeeId = parseEmployeeIdQuery(req.params.id);
  await getEmployeeForUser(req.user.id, employeeId);
  res.status(200).json(await getEmployeeUsageSummary(req.user.id, employeeId));
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
    ? (
        await notifySharedItemEvents({
          userId: req.user.id,
          actor,
          employees: humanEmployees(employees),
          events,
          digitalEmployeeId: digital.id,
        })
      ).notifications
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
    ? (
        await notifySharedItemEvents({
          userId: req.user.id,
          actor,
          employees: humanEmployees(employees),
          events,
          digitalEmployeeId: digital.id,
        })
      ).notifications
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

/** POST /api/employees/:id/profile-photo — JSON { contentBase64, mimeType?, fileName? }. */
export async function uploadEmployeeProfilePhoto(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  const employeeId = typeof req.params.id === "string" ? req.params.id : "";
  const body = req.body as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    throw new ValidationError("Profile photo body is required", {
      body: "Required",
    });
  }
  const fileName = String(body.fileName ?? body.file_name ?? "profile.jpg").trim();
  const mimeType = String(body.mimeType ?? body.mime_type ?? "image/jpeg").trim();
  const b64 = String(body.contentBase64 ?? body.content_base64 ?? "").trim();
  if (!b64) {
    throw new ValidationError("File content is required", {
      contentBase64: "Required",
    });
  }
  if (!mimeType.toLowerCase().startsWith("image/")) {
    throw new ValidationError("Profile photo must be an image", {
      mimeType: "image required",
    });
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ""), "base64");
  } catch {
    throw new ValidationError("Invalid base64 content", {
      contentBase64: "Invalid",
    });
  }
  const max = ATTACHMENT_MAX_BYTES.image;
  if (!bytes.length || bytes.length > max) {
    throw new ValidationError("File too large or empty", {
      contentBase64: "Size",
    });
  }
  const row = await ingestUploadedBytes({
    userId: req.user.id,
    uploaderId: employeeId,
    bytes,
    mimeType,
    fileName,
  });
  if (!row) {
    throw new ValidationError("Could not store profile photo", {
      contentBase64: "Rejected",
    });
  }
  const employee = await setEmployeeProfilePhoto(
    req.user.id,
    employeeId,
    row.id,
  );
  res.status(200).json({ employee });
}

export async function removeEmployeeProfilePhoto(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  const employeeId = typeof req.params.id === "string" ? req.params.id : "";
  const employee = await clearEmployeeProfilePhoto(req.user.id, employeeId);
  res.status(200).json({ employee });
}
