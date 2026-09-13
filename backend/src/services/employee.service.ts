import type { Employee } from "@prisma/client";
import type { EmployeeInput, PublicEmployee } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { NotFoundError } from "../utils/errors.js";

export function toPublicEmployee(employee: Employee): PublicEmployee {
  return {
    id: employee.id,
    name: employee.name,
    surname: employee.surname,
    nickname: employee.nickname,
    email: employee.email,
    phone: employee.phone,
  };
}

export async function listEmployeesForUser(userId: string): Promise<PublicEmployee[]> {
  const employees = await prisma.employee.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

  return employees.map(toPublicEmployee);
}

export async function resolveActingEmployee(userId: string): Promise<PublicEmployee> {
  const employees = await listEmployeesForUser(userId);
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

export async function createEmployeeForUser(
  userId: string,
  input: EmployeeInput,
): Promise<PublicEmployee> {
  const employee = await prisma.employee.create({
    data: {
      userId,
      name: input.name,
      surname: input.surname,
      nickname: input.nickname ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
    },
  });

  return toPublicEmployee(employee);
}

export async function updateEmployeeForUser(
  userId: string,
  employeeId: string,
  input: EmployeeInput,
): Promise<PublicEmployee> {
  await findOwnedEmployee(userId, employeeId);

  const employee = await prisma.employee.update({
    where: { id: employeeId },
    data: {
      name: input.name,
      surname: input.surname,
      nickname: input.nickname ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
    },
  });

  return toPublicEmployee(employee);
}

export async function deleteEmployeeForUser(
  userId: string,
  employeeId: string,
): Promise<void> {
  await findOwnedEmployee(userId, employeeId);
  await prisma.employee.delete({
    where: { id: employeeId },
  });
}
