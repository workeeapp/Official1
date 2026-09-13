import {
  hasEmployeeFieldErrors,
  parseEmployeeKind,
  validateEmployeeInput,
  type EmployeeFieldErrors,
  type EmployeeInput,
  type EmployeeRecordField,
} from "@workee/shared";
import { ValidationError } from "../utils/errors.js";

function compactFieldErrors(errors: EmployeeFieldErrors): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseEmployeeBody(body: unknown): EmployeeInput {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Employee details are required", {
      name: "Name is required",
    });
  }

  const record = body as Record<string, unknown>;
  const kind = parseEmployeeKind(record.kind);
  const errors = validateEmployeeInput({
    kind,
    name: record.name,
    surname: record.surname,
    nickname: record.nickname,
    email: record.email,
    phone: record.phone,
    model: record.model,
    temperature: record.temperature,
    instructions: record.instructions,
  });

  if (hasEmployeeFieldErrors(errors)) {
    throw new ValidationError(
      "Please correct the highlighted fields",
      compactFieldErrors(errors),
    );
  }

  const name = String(record.name).trim();

  if (kind === "digital") {
    return {
      kind,
      name,
      surname: "",
      nickname: optionalText(record.nickname) ?? name,
      email: null,
      phone: null,
      model: String(record.model).trim(),
      temperature: Number(record.temperature),
      instructions: String(record.instructions).trim(),
    };
  }

  return {
    kind,
    name,
    surname: String(record.surname).trim(),
    nickname: optionalText(record.nickname),
    email: optionalText(record.email),
    phone: optionalText(record.phone),
  };
}

export function parseRecordFields(body: unknown): EmployeeRecordField[] {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Fields are required", { fields: "Fields are required" });
  }

  const fields = (body as Record<string, unknown>).fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new ValidationError("Fields are required", { fields: "Fields are required" });
  }

  return fields.map((field) => {
    if (!field || typeof field !== "object") {
      throw new ValidationError("Fields are required", { fields: "Fields are required" });
    }
    const record = field as Record<string, unknown>;
    return {
      label: String(record.label ?? "").trim(),
      value: String(record.value ?? ""),
    };
  });
}
