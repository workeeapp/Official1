import { Prisma } from "@prisma/client";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string | undefined>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, "FORBIDDEN", message);
  }
}

export class InvalidCredentialsError extends AppError {
  constructor() {
    super(401, "INVALID_CREDENTIALS", "Invalid username or password");
  }
}

export class ValidationError extends AppError {
  constructor(message: string, fields?: Record<string, string>) {
    super(400, "VALIDATION_ERROR", message, fields);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, "CONFLICT", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "The requested resource was not found.") {
    super(404, "NOT_FOUND", message);
  }
}

const SERVICE_UNAVAILABLE_PUBLIC =
  "Service temporarily unavailable. Please try again later.";

export class ServiceUnavailableError extends AppError {
  /** Operator-facing root cause — never sent on the public API body. */
  readonly detail?: string;

  constructor(
    message = SERVICE_UNAVAILABLE_PUBLIC,
    options?: { detail?: string; cause?: unknown },
  ) {
    super(503, "SERVICE_UNAVAILABLE", message);
    if (options?.detail?.trim()) {
      this.detail = options.detail.trim();
    }
    if (options && "cause" in options) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        configurable: true,
        writable: true,
      });
    }
  }
}

type ErrorWithOpsFields = Error & {
  status?: unknown;
  code?: unknown;
  type?: unknown;
  cause?: unknown;
  error?: { message?: unknown; code?: unknown; type?: unknown };
};

function pushOpsPart(parts: string[], value: string | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed) {
    return;
  }
  if (parts.some((part) => part.includes(trimmed) || trimmed.includes(part))) {
    return;
  }
  parts.push(trimmed);
}

/**
 * Rich root-cause text for OpsEvents / Admin — not the generic 503 user string.
 */
export function opsErrorDetail(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (current instanceof ServiceUnavailableError) {
      pushOpsPart(parts, current.detail);
      if (current.message !== SERVICE_UNAVAILABLE_PUBLIC) {
        pushOpsPart(parts, current.message);
      }
      const next = current.cause;
      // Only tag the generic shell when there is no detail and no nested cause.
      if (
        !current.detail &&
        current.message === SERVICE_UNAVAILABLE_PUBLIC &&
        next == null
      ) {
        pushOpsPart(parts, "service_unavailable");
      }
      current = next;
      continue;
    }

    if (current instanceof Error) {
      const row = current as ErrorWithOpsFields;
      const bits: string[] = [];
      if (typeof row.status === "number" || typeof row.status === "string") {
        bits.push(`status=${row.status}`);
      }
      if (typeof row.code === "string" || typeof row.code === "number") {
        bits.push(`code=${row.code}`);
      }
      if (typeof row.type === "string") {
        bits.push(`type=${row.type}`);
      }
      const nested = row.error;
      if (nested && typeof nested === "object") {
        if (typeof nested.code === "string" || typeof nested.code === "number") {
          bits.push(`err_code=${nested.code}`);
        }
        if (typeof nested.type === "string") {
          bits.push(`err_type=${nested.type}`);
        }
        if (typeof nested.message === "string" && nested.message.trim()) {
          bits.push(nested.message.trim());
        }
      }
      if (
        row.message &&
        row.message !== SERVICE_UNAVAILABLE_PUBLIC &&
        !bits.some((bit) => bit.includes(row.message))
      ) {
        bits.push(row.message);
      }
      if (bits.length === 0) {
        bits.push(row.name || "Error");
      }
      pushOpsPart(parts, bits.join(" "));
      current = row.cause;
      continue;
    }

    pushOpsPart(parts, String(current));
    break;
  }

  return (parts.join(" | ") || "unknown").slice(0, 500);
}

export function isPrismaConnectionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return true;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return ["P1001", "P1002", "P1017"].includes(error.code);
  }

  return false;
}

export function isContextTooLargeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /request too large|tokens per min \(TPM\)/i.test(message);
}

export function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not exist in the current database/i.test(message);
}

export function missingTableName(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/`public\.(\w+)`/)?.[1] ?? null;
}

export function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}
