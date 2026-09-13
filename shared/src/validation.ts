export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Letters, numbers, underscores, and hyphens only. */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface FieldErrors {
  username?: string;
  password?: string;
}

export function validateUsername(username: unknown): string | undefined {
  if (typeof username !== "string" || username.trim().length === 0) {
    return "Username is required";
  }

  const value = username.trim();

  if (value.length < USERNAME_MIN_LENGTH) {
    return `Username must be at least ${USERNAME_MIN_LENGTH} characters`;
  }

  if (value.length > USERNAME_MAX_LENGTH) {
    return `Username must be at most ${USERNAME_MAX_LENGTH} characters`;
  }

  if (!USERNAME_PATTERN.test(value)) {
    return "Username can only contain letters, numbers, underscores, and hyphens";
  }

  return undefined;
}

export function validatePassword(password: unknown): string | undefined {
  if (typeof password !== "string" || password.length === 0) {
    return "Password is required";
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }

  return undefined;
}

export function validateLoginInput(input: {
  username?: unknown;
  password?: unknown;
}): FieldErrors {
  const errors: FieldErrors = {};
  const usernameError = validateUsername(input.username);
  const passwordError = validatePassword(input.password);

  if (usernameError) {
    errors.username = usernameError;
  }

  if (passwordError) {
    errors.password = passwordError;
  }

  return errors;
}

export function hasFieldErrors(errors: FieldErrors): boolean {
  return Boolean(errors.username || errors.password);
}

export const EMPLOYEE_NAME_MAX_LENGTH = 100;
export const EMPLOYEE_EMAIL_MAX_LENGTH = 254;
export const EMPLOYEE_PHONE_MAX_LENGTH = 32;
export const EMPLOYEE_MODEL_MAX_LENGTH = 100;
export const EMPLOYEE_INSTRUCTIONS_MAX_LENGTH = 50_000;

export interface EmployeeFieldErrors {
  kind?: string;
  name?: string;
  surname?: string;
  nickname?: string;
  email?: string;
  phone?: string;
  model?: string;
  temperature?: string;
  instructions?: string;
}

function validatePersonName(value: unknown, label: string): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return `${label} is required`;
  }

  if (value.trim().length > EMPLOYEE_NAME_MAX_LENGTH) {
    return `${label} must be at most ${EMPLOYEE_NAME_MAX_LENGTH} characters`;
  }

  return undefined;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+]?[\d\s().-]{6,}$/;

export function parseEmployeeKind(value: unknown): "human" | "digital" {
  return value === "digital" ? "digital" : "human";
}

function parseTemperature(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

export function validateEmployeeInput(input: {
  kind?: unknown;
  name?: unknown;
  surname?: unknown;
  nickname?: unknown;
  email?: unknown;
  phone?: unknown;
  model?: unknown;
  temperature?: unknown;
  instructions?: unknown;
}): EmployeeFieldErrors {
  const errors: EmployeeFieldErrors = {};
  const kind = parseEmployeeKind(input.kind);
  const nameError = validatePersonName(input.name, "Name");

  if (nameError) {
    errors.name = nameError;
  }

  if (kind === "digital") {
    if (typeof input.model !== "string" || input.model.trim().length === 0) {
      errors.model = "Model is required";
    } else if (input.model.trim().length > EMPLOYEE_MODEL_MAX_LENGTH) {
      errors.model = `Model must be at most ${EMPLOYEE_MODEL_MAX_LENGTH} characters`;
    }

    const temperature = parseTemperature(input.temperature);
    if (temperature === undefined) {
      errors.temperature = "Temperature is required";
    } else if (temperature < 0 || temperature > 2) {
      errors.temperature = "Temperature must be between 0 and 2";
    }

    if (
      typeof input.instructions !== "string" ||
      input.instructions.trim().length === 0
    ) {
      errors.instructions = "Instructions are required";
    } else if (input.instructions.trim().length > EMPLOYEE_INSTRUCTIONS_MAX_LENGTH) {
      errors.instructions = `Instructions must be at most ${EMPLOYEE_INSTRUCTIONS_MAX_LENGTH} characters`;
    }

    if (
      typeof input.nickname === "string" &&
      input.nickname.trim().length > EMPLOYEE_NAME_MAX_LENGTH
    ) {
      errors.nickname = `Nickname must be at most ${EMPLOYEE_NAME_MAX_LENGTH} characters`;
    }

    return errors;
  }

  const surnameError = validatePersonName(input.surname, "Surname");

  if (surnameError) {
    errors.surname = surnameError;
  }

  if (
    typeof input.nickname === "string" &&
    input.nickname.trim().length > EMPLOYEE_NAME_MAX_LENGTH
  ) {
    errors.nickname = `Nickname must be at most ${EMPLOYEE_NAME_MAX_LENGTH} characters`;
  }

  if (typeof input.email === "string" && input.email.trim().length > 0) {
    const email = input.email.trim();
    if (email.length > EMPLOYEE_EMAIL_MAX_LENGTH) {
      errors.email = `Email must be at most ${EMPLOYEE_EMAIL_MAX_LENGTH} characters`;
    } else if (!EMAIL_PATTERN.test(email)) {
      errors.email = "Email is invalid";
    }
  }

  if (typeof input.phone === "string" && input.phone.trim().length > 0) {
    const phone = input.phone.trim();
    if (phone.length > EMPLOYEE_PHONE_MAX_LENGTH) {
      errors.phone = `Phone must be at most ${EMPLOYEE_PHONE_MAX_LENGTH} characters`;
    } else if (!PHONE_PATTERN.test(phone)) {
      errors.phone = "Phone is invalid";
    }
  }

  return errors;
}

export function hasEmployeeFieldErrors(errors: EmployeeFieldErrors): boolean {
  return Boolean(
    errors.kind ||
      errors.name ||
      errors.surname ||
      errors.nickname ||
      errors.email ||
      errors.phone ||
      errors.model ||
      errors.temperature ||
      errors.instructions,
  );
}

export const CHAT_MESSAGE_MAX_LENGTH = 4000;

export interface ChatFieldErrors {
  message?: string;
  employeeId?: string;
  digitalEmployeeId?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateEmployeeId(employeeId: unknown): string | undefined {
  if (typeof employeeId !== "string" || employeeId.trim().length === 0) {
    return "Employee is required";
  }

  if (!UUID_PATTERN.test(employeeId)) {
    return "Employee is invalid";
  }

  return undefined;
}

export function validateChatMessage(message: unknown): string | undefined {
  if (typeof message !== "string" || message.trim().length === 0) {
    return "Message is required";
  }

  if (message.trim().length > CHAT_MESSAGE_MAX_LENGTH) {
    return `Message must be at most ${CHAT_MESSAGE_MAX_LENGTH} characters`;
  }

  return undefined;
}

export function validateChatInput(input: {
  message?: unknown;
  employeeId?: unknown;
  digitalEmployeeId?: unknown;
}): ChatFieldErrors {
  const errors: ChatFieldErrors = {};
  const messageError = validateChatMessage(input.message);

  if (messageError) {
    errors.message = messageError;
  }

  const employeeIdError = validateEmployeeId(input.employeeId);

  if (employeeIdError) {
    errors.employeeId = employeeIdError;
  }

  if (
    input.digitalEmployeeId !== undefined &&
    input.digitalEmployeeId !== null &&
    input.digitalEmployeeId !== ""
  ) {
    const digitalEmployeeIdError = validateEmployeeId(input.digitalEmployeeId);
    if (digitalEmployeeIdError) {
      errors.digitalEmployeeId = digitalEmployeeIdError;
    }
  }

  return errors;
}

export function hasChatFieldErrors(errors: ChatFieldErrors): boolean {
  return Boolean(errors.message || errors.employeeId || errors.digitalEmployeeId);
}
