import type { Employee } from "@prisma/client";
import type {
  AddressGender,
  DigitalEmployeeDefaults,
  EmployeeInput,
  PublicEmployee,
} from "@workee/shared";
import {
  GUEST_LUCY_NAME,
  humanEmployees,
  parseAddressGender,
  parseReasoningEffort,
} from "@workee/shared";
import { loadLlmConfig } from "../config/llm.js";
import { prisma } from "../database/prisma.js";
import { normalizeEmployeePhone } from "../utils/phone.js";
import {
  ConflictError,
  isUniqueConstraintError,
  NotFoundError,
} from "../utils/errors.js";

const PHONE_IN_USE = "Phone number is already in use";

const LUCY_NAME = "לוסי";

/** Short custom prompt for WhatsApp guest onboarding (no Lucy capability catalog). */
const GUEST_LUCY_INSTRUCTIONS = [
  "SYSTEM:",
  "You are לוסי-אורח — Workee's guest guide. Your only job is to help this WhatsApp guest become a registered member with their own account.",
  "Speak Hebrew unless they write in English. Be warm and brief.",
  "You may answer questions about lists/filings already shared with them in EMPLOYEE_SAVED_DATA (scope=shared).",
  "You cannot add, change, or delete anything for them while they are a guest — say they can only view shared lists until they register.",
  "To register you need: first name, surname, username (login), and password. Ask for whatever is still missing; keep metadata.register null until all four are known.",
  "When you have all four, emit metadata.register with name, surname, username, password and confirm in responses that they are registered. Then they will talk with לוסי on their own account.",
  "Never invent private data. Never claim you are the guest. Do not hand off to other workers.",
].join("\n");

function publicAddressGender(
  kind: "human" | "digital",
  value: string | null | undefined,
): AddressGender | null {
  if (kind !== "human") {
    return null;
  }
  return parseAddressGender(value) ?? null;
}

export function toPublicEmployee(employee: Employee): PublicEmployee {
  const kind = employee.kind === "digital" ? "digital" : "human";
  return {
    id: employee.id,
    kind,
    name: employee.name,
    surname: employee.surname,
    nickname: employee.nickname,
    email: employee.email,
    phone: employee.phone,
    model: employee.model,
    temperature: employee.temperature,
    reasoningEffort: parseReasoningEffort(employee.reasoningEffort),
    instructions: employee.instructions,
    protected: employee.isProtected,
    isOwner: kind === "human" ? employee.isOwner : false,
    addressGender: publicAddressGender(kind, employee.addressGender),
    shareMirrorEmployeeId:
      kind === "human" ? (employee.shareMirrorEmployeeId ?? null) : null,
  };
}

export function getDigitalEmployeeDefaults(): DigitalEmployeeDefaults {
  const config = loadLlmConfig();
  return {
    model: config.model,
    temperature: config.temperature,
    reasoningEffort: config.reasoningEffort,
    instructions: config.systemMessage,
  };
}

/** Lucy's live prompt from DB (fallback: LLM.config). Used for “inherit from Lucy”. */
export async function getLucyPromptDefaults(
  userId: string,
): Promise<DigitalEmployeeDefaults> {
  await ensureProtectedLucy(userId);
  const lucy = await prisma.employee.findFirst({
    where: {
      userId,
      kind: "digital",
      OR: [
        { isProtected: true },
        { name: LUCY_NAME },
        { nickname: LUCY_NAME },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  const fileDefaults = getDigitalEmployeeDefaults();
  if (!lucy) {
    return fileDefaults;
  }
  return {
    model: lucy.model?.trim() || fileDefaults.model,
    temperature:
      typeof lucy.temperature === "number" && Number.isFinite(lucy.temperature)
        ? lucy.temperature
        : fileDefaults.temperature,
    reasoningEffort:
      parseReasoningEffort(lucy.reasoningEffort) ?? fileDefaults.reasoningEffort,
    instructions: lucy.instructions?.trim() || fileDefaults.instructions,
  };
}

async function ensureProtectedLucy(userId: string): Promise<void> {
  const existing = await prisma.employee.findFirst({
    where: { userId, isProtected: true },
  });
  if (existing) {
    return;
  }

  const namedLucy = await prisma.employee.findFirst({
    where: {
      userId,
      kind: "digital",
      OR: [{ name: LUCY_NAME }, { nickname: LUCY_NAME }],
    },
  });
  if (namedLucy) {
    await prisma.employee.update({
      where: { id: namedLucy.id },
      data: { isProtected: true },
    });
    return;
  }

  const defaults = getDigitalEmployeeDefaults();
  await prisma.employee.create({
    data: {
      userId,
      kind: "digital",
      isProtected: true,
      name: LUCY_NAME,
      surname: "",
      nickname: LUCY_NAME,
      model: defaults.model,
      temperature: defaults.temperature,
      reasoningEffort: defaults.reasoningEffort,
      instructions: defaults.instructions,
    },
  });
}

/** WhatsApp guest onboarding worker — not protected; hidden from Chat-with. */
export async function ensureGuestLucy(userId: string): Promise<void> {
  const existing = await prisma.employee.findFirst({
    where: {
      userId,
      kind: "digital",
      OR: [{ name: GUEST_LUCY_NAME }, { nickname: GUEST_LUCY_NAME }],
    },
  });
  if (existing) {
    return;
  }

  const defaults = getDigitalEmployeeDefaults();
  await prisma.employee.create({
    data: {
      userId,
      kind: "digital",
      isProtected: false,
      name: GUEST_LUCY_NAME,
      surname: "",
      nickname: GUEST_LUCY_NAME,
      model: defaults.model,
      temperature: defaults.temperature,
      reasoningEffort: defaults.reasoningEffort,
      instructions: GUEST_LUCY_INSTRUCTIONS,
    },
  });
}

export async function listEmployeesForUser(userId: string): Promise<PublicEmployee[]> {
  await ensureProtectedLucy(userId);
  await ensureGuestLucy(userId);
  const employees = await prisma.employee.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

  return employees.map(toPublicEmployee);
}

export async function resolveActingEmployee(userId: string): Promise<PublicEmployee> {
  const employees = humanEmployees(await listEmployeesForUser(userId));
  if (employees.length === 0) {
    throw new NotFoundError("Employee not found");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true },
  });
  const username = user?.username.trim();
  return (
    employees.find(
      (employee) =>
        employee.nickname?.trim() === username || employee.name === username,
    ) ?? employees[0]
  );
}

export async function getEmployeeForUser(
  userId: string,
  employeeId: string,
): Promise<PublicEmployee> {
  return toPublicEmployee(await findOwnedEmployee(userId, employeeId));
}

async function findOwnedEmployee(userId: string, employeeId: string): Promise<Employee> {
  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, userId },
  });

  if (!employee) {
    throw new NotFoundError("Employee not found");
  }

  return employee;
}

function persistEmployeeData(input: EmployeeInput, kind: "human" | "digital") {
  if (kind === "digital") {
    const defaults = getDigitalEmployeeDefaults();
    const model = input.model?.trim() || defaults.model;
    const temperature =
      typeof input.temperature === "number" && Number.isFinite(input.temperature)
        ? input.temperature
        : defaults.temperature;
    const reasoningEffort =
      parseReasoningEffort(input.reasoningEffort) ?? defaults.reasoningEffort;
    const instructions = input.instructions?.trim() || defaults.instructions;
    return {
      kind: "digital" as const,
      name: input.name,
      surname: input.surname?.trim() || "",
      nickname: input.nickname ?? input.name,
      email: null,
      phone: null,
      model,
      temperature,
      reasoningEffort,
      instructions,
      isOwner: false,
      addressGender: null,
    };
  }

  const addressGender = parseAddressGender(input.addressGender) ?? null;

  return {
    kind: "human" as const,
    name: input.name,
    surname: input.surname ?? "",
    nickname: input.nickname ?? null,
    email: input.email ?? null,
    phone: normalizeEmployeePhone(input.phone),
    model: null,
    temperature: null,
    reasoningEffort: null,
    instructions: null,
    isOwner: input.isOwner === true,
    addressGender,
  };
}

async function assertPhoneAvailable(
  phone: string | null,
  exceptEmployeeId?: string,
): Promise<void> {
  if (!phone) {
    return;
  }
  const existing = await prisma.employee.findFirst({
    where: {
      phone,
      ...(exceptEmployeeId ? { id: { not: exceptEmployeeId } } : {}),
    },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError(PHONE_IN_USE);
  }
}

function rethrowPhoneConflict(error: unknown): never {
  if (isUniqueConstraintError(error)) {
    throw new ConflictError(PHONE_IN_USE);
  }
  throw error;
}

export async function createEmployeeForUser(
  userId: string,
  input: EmployeeInput,
): Promise<PublicEmployee> {
  const kind = input.kind === "digital" ? "digital" : "human";
  const data = persistEmployeeData(input, kind);
  await assertPhoneAvailable(data.phone);
  try {
    const employee = await prisma.employee.create({
      data: {
        userId,
        isProtected: false,
        ...data,
      },
    });
    return toPublicEmployee(employee);
  } catch (error) {
    rethrowPhoneConflict(error);
  }
}

export async function updateEmployeeForUser(
  userId: string,
  employeeId: string,
  input: EmployeeInput,
): Promise<PublicEmployee> {
  const existing = await findOwnedEmployee(userId, employeeId);
  const kind = existing.kind === "digital" ? "digital" : "human";
  const data = persistEmployeeData(input, kind);
  await assertPhoneAvailable(data.phone, employeeId);
  try {
    const employee = await prisma.employee.update({
      where: { id: employeeId },
      data,
    });
    return toPublicEmployee(employee);
  } catch (error) {
    rethrowPhoneConflict(error);
  }
}

export async function deleteEmployeeForUser(
  userId: string,
  employeeId: string,
): Promise<void> {
  const employee = await findOwnedEmployee(userId, employeeId);
  if (employee.isProtected) {
    throw new ConflictError("Lucy cannot be deleted");
  }

  await prisma.employee.delete({
    where: { id: employeeId },
  });
}
