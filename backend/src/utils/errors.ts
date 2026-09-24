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

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service temporarily unavailable. Please try again later.") {
    super(503, "SERVICE_UNAVAILABLE", message);
  }
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
