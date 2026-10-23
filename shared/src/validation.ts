import {
  parseReasoningEffort,
  TIP_AUDIENCES,
  TIP_OUTPUT_MODES,
  TIP_TIERS,
  TIP_TOPICS,
  TIP_TRIGGER_AREAS,
  TIP_TRIGGER_KINDS,
  TIP_TRIGGER_OPS,
  type TipAudience,
  type TipInput,
  type TipOutputMode,
  type TipTier,
  type TipTopic,
  type TipTriggerArea,
  type TipTriggerKind,
  type TipTriggerOp,
  type TipUpdateInput,
} from "./types.js";

export const TIP_KEY_MAX_LENGTH = 64;
export const TIP_TEXT_MAX_LENGTH = 8000;
/** tip keys: lowercase letter start, then letters/digits/_/- */
export const TIP_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

export interface TipFieldErrors {
  key?: string;
  audience?: string;
  digitalEmployeeId?: string;
  triggerKind?: string;
  triggerArea?: string;
  triggerOp?: string;
  tier?: string;
  topic?: string;
  listType?: string;
  unlockAfterKey?: string;
  outputMode?: string;
  minIntervalMinutes?: string;
  maxShows?: string;
  order?: string;
  text?: string;
  enabled?: string;
}

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
export const EMPLOYEE_INSTRUCTIONS_MAX_LENGTH = 200_000;

export interface EmployeeFieldErrors {
  kind?: string;
  name?: string;
  surname?: string;
  nickname?: string;
  email?: string;
  phone?: string;
  model?: string;
  temperature?: string;
  reasoningEffort?: string;
  instructions?: string;
  addressGender?: string;
}

/** Parse optional address gender; empty/null → null. Invalid non-empty → undefined (caller errors). */
export function parseAddressGender(
  value: unknown,
): "male" | "female" | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower === "male" || trimmed === "זכר") {
    return "male";
  }
  if (lower === "female" || trimmed === "נקבה") {
    return "female";
  }
  return undefined;
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
  reasoningEffort?: unknown;
  instructions?: unknown;
  addressGender?: unknown;
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

    if (!parseReasoningEffort(input.reasoningEffort)) {
      errors.reasoningEffort = "Reasoning effort is required";
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

  if (
    input.addressGender !== undefined &&
    parseAddressGender(input.addressGender) === undefined
  ) {
    errors.addressGender = "Address gender must be male, female, or empty";
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
      errors.reasoningEffort ||
      errors.instructions ||
      errors.addressGender,
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

export function parseTipAudience(value: unknown): TipAudience | null {
  return typeof value === "string" &&
    (TIP_AUDIENCES as readonly string[]).includes(value)
    ? (value as TipAudience)
    : null;
}

export function parseTipTriggerKind(value: unknown): TipTriggerKind | null {
  return typeof value === "string" &&
    (TIP_TRIGGER_KINDS as readonly string[]).includes(value)
    ? (value as TipTriggerKind)
    : null;
}

export function parseTipTriggerArea(value: unknown): TipTriggerArea | null {
  return typeof value === "string" &&
    (TIP_TRIGGER_AREAS as readonly string[]).includes(value)
    ? (value as TipTriggerArea)
    : null;
}

export function parseTipTriggerOp(value: unknown): TipTriggerOp | null {
  return typeof value === "string" &&
    (TIP_TRIGGER_OPS as readonly string[]).includes(value)
    ? (value as TipTriggerOp)
    : null;
}

export function parseTipTier(value: unknown): TipTier | null {
  return typeof value === "string" &&
    (TIP_TIERS as readonly string[]).includes(value)
    ? (value as TipTier)
    : null;
}

export function parseTipTopic(value: unknown): TipTopic | null {
  return typeof value === "string" &&
    (TIP_TOPICS as readonly string[]).includes(value)
    ? (value as TipTopic)
    : null;
}

export function parseTipOutputMode(value: unknown): TipOutputMode | null {
  return typeof value === "string" &&
    (TIP_OUTPUT_MODES as readonly string[]).includes(value)
    ? (value as TipOutputMode)
    : null;
}

export function validateTipKey(key: unknown): string | undefined {
  if (typeof key !== "string" || key.trim().length === 0) {
    return "Key is required";
  }
  const value = key.trim();
  if (value.length > TIP_KEY_MAX_LENGTH) {
    return `Key must be at most ${TIP_KEY_MAX_LENGTH} characters`;
  }
  if (!TIP_KEY_PATTERN.test(value)) {
    return "Key must start with a letter and use only lowercase letters, digits, _ or -";
  }
  return undefined;
}

export function validateTipText(text: unknown): string | undefined {
  if (typeof text !== "string" || text.trim().length === 0) {
    return "Text is required";
  }
  if (text.trim().length > TIP_TEXT_MAX_LENGTH) {
    return `Text must be at most ${TIP_TEXT_MAX_LENGTH} characters`;
  }
  return undefined;
}

export function validateTipInput(input: {
  key?: unknown;
  audience?: unknown;
  digitalEmployeeId?: unknown;
  triggerKind?: unknown;
  triggerArea?: unknown;
  triggerOp?: unknown;
  outputMode?: unknown;
  minIntervalMinutes?: unknown;
  maxShows?: unknown;
  order?: unknown;
  text?: unknown;
  enabled?: unknown;
}): TipFieldErrors {
  const errors: TipFieldErrors = {};
  const keyError = validateTipKey(input.key);
  if (keyError) {
    errors.key = keyError;
  }
  if (!parseTipAudience(input.audience)) {
    errors.audience = "Audience must be guest, member, or any";
  }
  const kind = parseTipTriggerKind(input.triggerKind);
  if (!kind) {
    errors.triggerKind = "Trigger must be action, model, or general";
  } else if (kind === "action") {
    if (!parseTipTriggerArea(input.triggerArea)) {
      errors.triggerArea =
        "Action tips need an area (reminders, filing, lists, or directory)";
    }
    const op =
      input.triggerOp === undefined ||
      input.triggerOp === null ||
      input.triggerOp === ""
        ? "add"
        : parseTipTriggerOp(input.triggerOp);
    if (!op) {
      errors.triggerOp = "Op must be add, remove, or update";
    }
  }
  if (
    input.digitalEmployeeId !== undefined &&
    input.digitalEmployeeId !== null &&
    input.digitalEmployeeId !== ""
  ) {
    const idError = validateEmployeeId(input.digitalEmployeeId);
    if (idError) {
      errors.digitalEmployeeId = idError;
    }
  }
  if (
    input.outputMode !== undefined &&
    input.outputMode !== null &&
    input.outputMode !== "" &&
    !parseTipOutputMode(input.outputMode)
  ) {
    errors.outputMode = "Output mode must be static or dynamic";
  }
  if (input.minIntervalMinutes !== undefined) {
    if (
      typeof input.minIntervalMinutes !== "number" ||
      !Number.isInteger(input.minIntervalMinutes) ||
      input.minIntervalMinutes < 0
    ) {
      errors.minIntervalMinutes =
        "Min interval must be an integer of at least 0";
    }
  }
  if (
    typeof input.maxShows !== "number" ||
    !Number.isInteger(input.maxShows) ||
    input.maxShows < 1
  ) {
    errors.maxShows = "Max shows must be an integer of at least 1";
  }
  if (
    typeof input.order !== "number" ||
    !Number.isInteger(input.order)
  ) {
    errors.order = "Order must be an integer";
  }
  const textError = validateTipText(input.text);
  if (textError) {
    errors.text = textError;
  }
  if (
    input.enabled !== undefined &&
    typeof input.enabled !== "boolean"
  ) {
    errors.enabled = "Enabled must be true or false";
  }
  return errors;
}

export function validateTipUpdateInput(input: {
  audience?: unknown;
  digitalEmployeeId?: unknown;
  triggerKind?: unknown;
  triggerArea?: unknown;
  triggerOp?: unknown;
  outputMode?: unknown;
  minIntervalMinutes?: unknown;
  maxShows?: unknown;
  order?: unknown;
  text?: unknown;
  enabled?: unknown;
}): TipFieldErrors {
  const errors: TipFieldErrors = {};
  if (input.audience !== undefined && !parseTipAudience(input.audience)) {
    errors.audience = "Audience must be guest, member, or any";
  }
  const kind =
    input.triggerKind === undefined
      ? undefined
      : parseTipTriggerKind(input.triggerKind);
  if (input.triggerKind !== undefined && !kind) {
    errors.triggerKind = "Trigger must be action, model, or general";
  }
  if (kind === "action" || (input.triggerArea !== undefined && input.triggerArea !== null)) {
    if (
      input.triggerArea !== undefined &&
      input.triggerArea !== null &&
      !parseTipTriggerArea(input.triggerArea)
    ) {
      errors.triggerArea =
        "Action tips need an area (reminders, filing, lists, or directory)";
    }
  }
  if (
    input.triggerOp !== undefined &&
    input.triggerOp !== null &&
    input.triggerOp !== "" &&
    !parseTipTriggerOp(input.triggerOp)
  ) {
    errors.triggerOp = "Op must be add, remove, or update";
  }
  if (
    input.digitalEmployeeId !== undefined &&
    input.digitalEmployeeId !== null &&
    input.digitalEmployeeId !== ""
  ) {
    const idError = validateEmployeeId(input.digitalEmployeeId);
    if (idError) {
      errors.digitalEmployeeId = idError;
    }
  }
  if (
    input.outputMode !== undefined &&
    input.outputMode !== null &&
    input.outputMode !== "" &&
    !parseTipOutputMode(input.outputMode)
  ) {
    errors.outputMode = "Output mode must be static or dynamic";
  }
  if (input.minIntervalMinutes !== undefined) {
    if (
      typeof input.minIntervalMinutes !== "number" ||
      !Number.isInteger(input.minIntervalMinutes) ||
      input.minIntervalMinutes < 0
    ) {
      errors.minIntervalMinutes =
        "Min interval must be an integer of at least 0";
    }
  }
  if (input.maxShows !== undefined) {
    if (
      typeof input.maxShows !== "number" ||
      !Number.isInteger(input.maxShows) ||
      input.maxShows < 1
    ) {
      errors.maxShows = "Max shows must be an integer of at least 1";
    }
  }
  if (input.order !== undefined) {
    if (typeof input.order !== "number" || !Number.isInteger(input.order)) {
      errors.order = "Order must be an integer";
    }
  }
  if (input.text !== undefined) {
    const textError = validateTipText(input.text);
    if (textError) {
      errors.text = textError;
    }
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    errors.enabled = "Enabled must be true or false";
  }
  return errors;
}

export function hasTipFieldErrors(errors: TipFieldErrors): boolean {
  return Object.values(errors).some(Boolean);
}

/** Normalize a create payload after field validation passed. */
export function normalizeTipInput(input: {
  key: string;
  audience: TipAudience;
  digitalEmployeeId?: string | null;
  triggerKind: TipTriggerKind;
  triggerArea?: TipTriggerArea | null;
  triggerOp?: TipTriggerOp | null;
  maxShows: number;
  order: number;
  text: string;
  enabled?: boolean;
  tier?: TipTier;
  topic?: TipTopic | null;
  listType?: string | null;
  unlockAfterKey?: string | null;
  outputMode?: TipOutputMode;
  minIntervalMinutes?: number;
}): TipInput {
  const triggerKind = input.triggerKind;
  return {
    key: input.key.trim(),
    audience: input.audience,
    digitalEmployeeId: input.digitalEmployeeId?.trim() || null,
    triggerKind,
    triggerArea:
      triggerKind === "action" ? (input.triggerArea ?? null) : null,
    triggerOp:
      triggerKind === "action" ? (input.triggerOp ?? "add") : null,
    tier: input.tier ?? "basic",
    topic: input.topic ?? null,
    listType: input.listType?.trim() || null,
    unlockAfterKey: input.unlockAfterKey?.trim() || null,
    outputMode: input.outputMode ?? "static",
    minIntervalMinutes: input.minIntervalMinutes ?? 0,
    maxShows: input.maxShows,
    order: input.order,
    text: input.text.trim(),
    enabled: input.enabled !== false,
  };
}

export function normalizeTipUpdateInput(input: TipUpdateInput): TipUpdateInput {
  const out: TipUpdateInput = {};
  if (input.audience !== undefined) {
    out.audience = input.audience;
  }
  if (input.digitalEmployeeId !== undefined) {
    out.digitalEmployeeId =
      input.digitalEmployeeId === null || input.digitalEmployeeId === ""
        ? null
        : String(input.digitalEmployeeId).trim();
  }
  if (input.triggerKind !== undefined) {
    out.triggerKind = input.triggerKind;
  }
  if (input.triggerArea !== undefined) {
    out.triggerArea = input.triggerArea;
  }
  if (input.triggerOp !== undefined) {
    out.triggerOp = input.triggerOp;
  }
  if (input.tier !== undefined) {
    out.tier = input.tier;
  }
  if (input.topic !== undefined) {
    out.topic = input.topic;
  }
  if (input.listType !== undefined) {
    out.listType =
      input.listType === null || input.listType === ""
        ? null
        : String(input.listType).trim();
  }
  if (input.unlockAfterKey !== undefined) {
    out.unlockAfterKey =
      input.unlockAfterKey === null || input.unlockAfterKey === ""
        ? null
        : String(input.unlockAfterKey).trim();
  }
  if (input.outputMode !== undefined) {
    out.outputMode = input.outputMode;
  }
  if (input.minIntervalMinutes !== undefined) {
    out.minIntervalMinutes = input.minIntervalMinutes;
  }
  if (input.maxShows !== undefined) {
    out.maxShows = input.maxShows;
  }
  if (input.order !== undefined) {
    out.order = input.order;
  }
  if (input.text !== undefined) {
    out.text = String(input.text).trim();
  }
  if (input.enabled !== undefined) {
    out.enabled = input.enabled;
  }
  if (out.triggerKind === "model" || out.triggerKind === "general") {
    out.triggerArea = null;
    out.triggerOp = null;
  } else if (out.triggerKind === "action" && out.triggerOp === undefined) {
    // keep existing op on patch unless cleared
  }
  return out;
}
