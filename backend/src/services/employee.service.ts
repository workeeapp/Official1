import type { Employee } from "@prisma/client";
import type {
  DigitalEmployeeDefaults,
  EmployeeInput,
  PublicEmployee,
} from "@workee/shared";
import { humanEmployees } from "@workee/shared";
import { loadDavidConfig, loadLlmConfig } from "../config/llm.js";
import { prisma } from "../database/prisma.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";

const LUCY_NAME = "לוסי";

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
    instructions: employee.instructions,
    protected: employee.isProtected,
  };
}

export function getDigitalEmployeeDefaults(): DigitalEmployeeDefaults {
  const config = loadLlmConfig();
  return {
    model: config.model,
    temperature: config.temperature,
    instructions: config.systemMessage,
  };
}

async function ensureProtectedLucy(userId: string): Promise<void> {
  const existing = await prisma.employee.findFirst({
    where: { userId, isProtected: true },
  });
  if (existing) {
    await refreshProtectedLucyInstructions(existing);
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
    await refreshProtectedLucyInstructions({
      ...namedLucy,
      isProtected: true,
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
      instructions: defaults.instructions,
    },
  });
}

async function refreshProtectedLucyInstructions(employee: Employee): Promise<void> {
  const defaults = getDigitalEmployeeDefaults();
  if (
    employee.instructions === defaults.instructions &&
    employee.model === defaults.model &&
    employee.temperature === defaults.temperature
  ) {
    return;
  }

  await prisma.employee.update({
    where: { id: employee.id },
    data: {
      instructions: defaults.instructions,
      model: defaults.model,
      temperature: defaults.temperature,
    },
  });
}

function isDavidEmployee(employee: Employee): boolean {
  if (employee.isProtected || employee.kind !== "digital") {
    return false;
  }
  const label = `${employee.name} ${employee.nickname ?? ""}`;
  return label.includes("דוד");
}

async function ensureDavidReminderPrompt(userId: string): Promise<void> {
  try {
    const config = loadDavidConfig();
    if (!config) {
      return;
    }
    const candidates = await prisma.employee.findMany({
      where: {
        userId,
        kind: "digital",
        isProtected: false,
      },
    });
    const david = candidates.find((employee) => isDavidEmployee(employee));
    if (!david) {
      return;
    }
    if (
      david.instructions === config.systemMessage &&
      david.model === config.model &&
      david.temperature === config.temperature
    ) {
      return;
    }
    await prisma.employee.update({
      where: { id: david.id },
      data: {
        instructions: config.systemMessage,
        model: config.model,
        temperature: config.temperature,
      },
    });
  } catch (error) {
    console.error(
      "David prompt sync failed",
      error instanceof Error ? error.message : "unknown",
    );
  }
}

export async function listEmployeesForUser(userId: string): Promise<PublicEmployee[]> {
  await ensureProtectedLucy(userId);
  await ensureDavidReminderPrompt(userId);
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
    return {
      kind: "digital",
      name: input.name,
      surname: input.surname?.trim() || "",
      nickname: input.nickname ?? input.name,
      email: null,
      phone: null,
      model: input.model ?? null,
      temperature: input.temperature ?? null,
      instructions: input.instructions ?? null,
    };
  }

  return {
    kind: "human",
    name: input.name,
    surname: input.surname ?? "",
    nickname: input.nickname ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    model: null,
    temperature: null,
    instructions: null,
  };
}

export async function createEmployeeForUser(
  userId: string,
  input: EmployeeInput,
): Promise<PublicEmployee> {
  const kind = input.kind === "digital" ? "digital" : "human";
  const employee = await prisma.employee.create({
    data: {
      userId,
      isProtected: false,
      ...persistEmployeeData(input, kind),
    },
  });

  return toPublicEmployee(employee);
}

export async function updateEmployeeForUser(
  userId: string,
  employeeId: string,
  input: EmployeeInput,
): Promise<PublicEmployee> {
  const existing = await findOwnedEmployee(userId, employeeId);
  const kind = existing.kind === "digital" ? "digital" : "human";

  const employee = await prisma.employee.update({
    where: { id: employeeId },
    data: persistEmployeeData(input, kind),
  });

  return toPublicEmployee(employee);
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
