import { hasFieldErrors, validateLoginInput } from "@workee/shared";
import { ValidationError } from "../utils/errors.js";

export function parseLoginBody(body: unknown): {
  username: string;
  password: string;
} {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Username and password are required", {
      username: "Username is required",
      password: "Password is required",
    });
  }

  const record = body as Record<string, unknown>;
  const errors = validateLoginInput({
    username: record.username,
    password: record.password,
  });

  if (hasFieldErrors(errors)) {
    throw new ValidationError(
      "Please correct the highlighted fields",
      Object.fromEntries(
        Object.entries(errors).filter((entry): entry is [string, string] =>
          Boolean(entry[1]),
        ),
      ),
    );
  }

  return {
    username: String(record.username).trim(),
    password: String(record.password),
  };
}
