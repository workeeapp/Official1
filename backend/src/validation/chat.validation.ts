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
  });

  if (hasChatFieldErrors(errors)) {
    throw new ValidationError(
      "Please correct the highlighted fields",
      compactFieldErrors(errors),
    );
  }

  return {
    message: String(record.message).trim(),
    employeeId: String(record.employeeId),
  };
}

export function parseEmployeeIdBody(body: unknown): string {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Please correct the highlighted fields", {
      employeeId: "Employee is required",
    });
  }

  return parseEmployeeIdQuery((body as Record<string, unknown>).employeeId);
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
