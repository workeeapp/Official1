import {
  hasEmployeeFieldErrors,
  validateEmployeeInput,
  type EmployeeFieldErrors,
  type EmployeeInput,
} from "@workee/shared";
import { ValidationError } from "../utils/errors.js";

function compactFieldErrors(errors: EmployeeFieldErrors): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
}

export function parseEmployeeBody(body: unknown): EmployeeInput {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Name and surname are required", {
      name: "Name is required",
      surname: "Surname is required",
    });
  }

  const record = body as Record<string, unknown>;
  const errors = validateEmployeeInput({
    name: record.name,
    surname: record.surname,
    nickname: record.nickname,
    email: record.email,
    phone: record.phone,
  });

  if (hasEmployeeFieldErrors(errors)) {
    throw new ValidationError(
      "Please correct the highlighted fields",
      compactFieldErrors(errors),
    );
  }

  const optionalText = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

  return {
    name: String(record.name).trim(),
    surname: String(record.surname).trim(),
    nickname: optionalText(record.nickname),
    email: optionalText(record.email),
    phone: optionalText(record.phone),
  };
}
