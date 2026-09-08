import {
  hasChatFieldErrors,
  validateChatInput,
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
