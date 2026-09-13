import {
  hasChatFieldErrors,
  validateChatInput,
  validateEmployeeId,
  type ChatFieldErrors,
  type ChatMessageRequest,
} from "@workee/shared";
import { ValidationError } from "../utils/errors.js";

function compactFieldErrors(errors: ChatFieldErrors): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
}

export function parseChatMessageBody(body: unknown): ChatMessageRequest {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Message is required", {
      message: "Message is required",
    });
  }

  const record = body as Record<string, unknown>;
  const errors = validateChatInput({
    message: record.message,
    employeeId: record.employeeId,
    digitalEmployeeId: record.digitalEmployeeId,
  });

  if (hasChatFieldErrors(errors)) {
    throw new ValidationError(
      "Please correct the highlighted fields",
      compactFieldErrors(errors),
    );
  }

  const digitalEmployeeId =
    typeof record.digitalEmployeeId === "string" && record.digitalEmployeeId.trim()
      ? record.digitalEmployeeId.trim()
      : undefined;

  return {
    message: String(record.message).trim(),
    employeeId: String(record.employeeId),
    ...(digitalEmployeeId ? { digitalEmployeeId } : {}),
  };
}

export function parseEmployeeIdBody(body: unknown): string {
  return parseChatPairBody(body).employeeId;
}

export function parseChatPairBody(body: unknown): {
  employeeId: string;
  digitalEmployeeId?: string;
} {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Please correct the highlighted fields", {
      employeeId: "Employee is required",
    });
  }

  const record = body as Record<string, unknown>;
  return {
    employeeId: parseEmployeeIdQuery(record.employeeId),
    digitalEmployeeId: parseOptionalEmployeeId(record.digitalEmployeeId),
  };
}

export function parseOptionalEmployeeId(employeeId: unknown): string | undefined {
  if (employeeId === undefined || employeeId === null || employeeId === "") {
    return undefined;
  }

  return parseEmployeeIdQuery(employeeId);
}

export function parseEmployeeIdQuery(employeeId: unknown): string {
  const error = validateEmployeeId(employeeId);

  if (error) {
    throw new ValidationError("Please correct the highlighted fields", {
      employeeId: error,
    });
  }

  return String(employeeId);
}
