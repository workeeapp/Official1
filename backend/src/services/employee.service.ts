import type { Employee, Team } from "@prisma/client";
import type {
  AddressGender,
  DigitalEmployeeDefaults,
  EmployeeInput,
  PublicEmployee,
  PublicTeam,
} from "@workee/shared";
import {
  GUEST_LUCY_NAME,
  humanEmployees,
  parseAddressGender,
  parseReasoningEffort,
} from "@workee/shared";
import { loadLlmConfig } from "../config/llm.js";
import { prisma } from "../database/prisma.js";
import { normalizeEmployeePhone, normalizePhoneDigits } from "../utils/phone.js";
import {
  ConflictError,
  isUniqueConstraintError,
  NotFoundError,
} from "../utils/errors.js";
import { ensureDefaultTips } from "./tips.service.js";

const PHONE_IN_USE = "Phone number is already in use";

const LUCY_NAME = "לוסי";

export type CreateEmployeeOptions = {
  /** WhatsApp outsider shell — no team. Digitals ignore this and are never guests. */
  isGuest?: boolean;
};

export function toPublicTeam(team: Team): PublicTeam {
  return {
    id: team.id,
    userId: team.userId,
    name: team.name,
  };
}

/** Ensure the account's sole team exists (1 User → 1 Team). */
export async function ensureTeamForUser(userId: string): Promise<Team> {
  const existing = await prisma.team.findUnique({
    where: { userId },
  });
  if (existing) {
    return existing;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true },
  });
  if (!user) {
    throw new NotFoundError("User not found");
  }

  try {
    return await prisma.team.create({
      data: {
        userId,
        name: user.username,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const raced = await prisma.team.findUnique({ where: { userId } });
      if (raced) {
        return raced;
      }
    }
    throw error;
  }
}

export async function getTeamForUser(userId: string): Promise<PublicTeam> {
  return toPublicTeam(await ensureTeamForUser(userId));
}

/** Short custom prompt for WhatsApp guest onboarding (no Lucy capability catalog). */
const GUEST_LUCY_INSTRUCTIONS = [
  "SYSTEM:",
  "You are לוסי-אורח — Workee's guest guide. Your only job is to help this WhatsApp guest become a registered member with their own account.",
  "Speak Hebrew unless they write in English. Be warm and brief.",
  "You may answer questions about lists/filings already shared with them in EMPLOYEE_SAVED_DATA (scope=shared).",
  "You cannot add, change, or delete anything for them while they are a guest — say they can only view shared lists until they register.",
  "To register you need: first name and address gender (זכר → gender male, נקבה → gender female). Surname only if they offer it — never ask for username or password.",
  "Ask for whatever is still missing; keep metadata.register null until name and gender are known.",
  "When you have name and gender, emit metadata.register with name, gender (and surname only if given) and confirm in responses that they are registered. Then they will talk with לוסי on their own account.",
  "TIPS: when AVAILABLE_TIPS includes guest_terms and the guest asks how registration / usage works or about terms/תקנון, set metadata.tips=[\"guest_terms\"]. The engine sends the catalog text — do not paste תקנון into responses yourself. Otherwise tips null.",
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
  const isGuest = kind === "human" ? employee.isGuest === true : false;
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
    isGuest,
    teamId: isGuest ? null : (employee.teamId ?? null),
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
    if (!existing.teamId) {
      const team = await ensureTeamForUser(userId);
      await prisma.employee.update({
        where: { id: existing.id },
        data: { teamId: team.id, isGuest: false },
      });
    }
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
    const team = namedLucy.teamId
      ? null
      : await ensureTeamForUser(userId);
    await prisma.employee.update({
      where: { id: namedLucy.id },
      data: {
        isProtected: true,
        isGuest: false,
        ...(team ? { teamId: team.id } : {}),
      },
    });
    return;
  }

  const team = await ensureTeamForUser(userId);
  const defaults = getDigitalEmployeeDefaults();
  await prisma.employee.create({
    data: {
      userId,
      teamId: team.id,
      kind: "digital",
      isProtected: true,
      isGuest: false,
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
    // Keep product prompt in sync (incl. tip keys); לוסי-אורח is not user-edited.
    const patch: { instructions?: string; teamId?: string; isGuest?: boolean } =
      {};
    if (existing.instructions !== GUEST_LUCY_INSTRUCTIONS) {
      patch.instructions = GUEST_LUCY_INSTRUCTIONS;
    }
    if (!existing.teamId) {
      const team = await ensureTeamForUser(userId);
      patch.teamId = team.id;
      patch.isGuest = false;
    }
    if (Object.keys(patch).length > 0) {
      await prisma.employee.update({
        where: { id: existing.id },
        data: patch,
      });
    }
    return;
  }

  const team = await ensureTeamForUser(userId);
  const defaults = getDigitalEmployeeDefaults();
  await prisma.employee.create({
    data: {
      userId,
      teamId: team.id,
      kind: "digital",
      isProtected: false,
      isGuest: false,
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
  await ensureTeamForUser(userId);
  await ensureProtectedLucy(userId);
  await ensureGuestLucy(userId);
  // Tip catalog sync must not block listing employees (Employees UI / chat-as).
  try {
    await ensureDefaultTips(userId);
  } catch (error) {
    console.error("ensureDefaultTips failed during listEmployeesForUser", error);
  }
  const employees = await prisma.employee.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

  return employees.map(toPublicEmployee);
}

/**
 * Registered non-guest humans whose phone matches any of the given numbers
 * (any account). Used so Contacts can address cross-account share partners.
 */
export async function listRegisteredHumansByPhones(
  phones: string[],
): Promise<PublicEmployee[]> {
  const canonical = [
    ...new Set(
      phones
        .map((phone) => normalizeEmployeePhone(phone) ?? normalizePhoneDigits(phone))
        .filter((phone): phone is string => Boolean(phone)),
    ),
  ];
  if (canonical.length === 0) {
    return [];
  }
  const variants = new Set<string>(canonical);
  for (const phone of canonical) {
    if (phone.startsWith("972") && phone.length >= 12) {
      variants.add(`0${phone.slice(3)}`);
    }
  }
  const rows = await prisma.employee.findMany({
    where: {
      kind: "human",
      isGuest: false,
      phone: { in: [...variants] },
    },
  });
  return rows.map(toPublicEmployee);
}

/** Protected Lucy id for an account (creates Lucy if missing). */
export async function getProtectedLucyIdForUser(
  userId: string,
): Promise<string | null> {
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
    select: { id: true },
  });
  return lucy?.id ?? null;
}

/** Account userId for an employee row (any team). */
export async function getEmployeeUserId(
  employeeId: string,
): Promise<string | null> {
  const row = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { userId: true },
  });
  return row?.userId ?? null;
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
  options?: CreateEmployeeOptions,
): Promise<PublicEmployee> {
  const kind = input.kind === "digital" ? "digital" : "human";
  const data = persistEmployeeData(input, kind);
  const isGuest = kind === "human" && options?.isGuest === true;
  const team = isGuest ? null : await ensureTeamForUser(userId);
  await assertPhoneAvailable(data.phone);
  try {
    const employee = await prisma.employee.create({
      data: {
        userId,
        teamId: team?.id ?? null,
        isGuest,
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
  // Preserve guest/team membership; UI updates do not promote or demote guests.
  const membership =
    existing.isGuest && kind === "human"
      ? { isGuest: true as const, teamId: null }
      : {
          isGuest: false as const,
          teamId: existing.teamId ?? (await ensureTeamForUser(userId)).id,
        };
  try {
    const employee = await prisma.employee.update({
      where: { id: employeeId },
      data: {
        ...data,
        ...membership,
      },
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
