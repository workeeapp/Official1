import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  InvalidCredentialsError,
  ValidationError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  isPrismaConnectionError,
  isContextTooLargeError,
  isMissingTableError,
  missingTableName,
  isUniqueConstraintError,
  opsErrorDetail,
} from "../src/utils/errors.js";

describe("opsErrorDetail", () => {
  it("prefers ServiceUnavailableError.detail over the public 503 message", () => {
    expect(
      opsErrorDetail(
        new ServiceUnavailableError(undefined, {
          detail: "openai_api_key_missing",
        }),
      ),
    ).toBe("openai_api_key_missing");
  });

  it("walks cause and keeps OpenAI-like status/code/message", () => {
    const openai = Object.assign(new Error("429 You have no credits remaining"), {
      status: 429,
      code: "insufficient_quota",
      type: "insufficient_quota",
    });
    const wrapped = new ServiceUnavailableError(undefined, { cause: openai });
    expect(opsErrorDetail(wrapped)).toContain("status=429");
    expect(opsErrorDetail(wrapped)).toContain("insufficient_quota");
    expect(opsErrorDetail(wrapped)).toContain("no credits remaining");
    expect(opsErrorDetail(wrapped)).not.toMatch(
      /Service temporarily unavailable\. Please try again later\./,
    );
  });

  it("does not stop at the generic public message alone", () => {
    expect(opsErrorDetail(new ServiceUnavailableError())).toBe(
      "service_unavailable",
    );
  });
});

describe("error helpers still work", () => {
  it("detects context too large", () => {
    expect(isContextTooLargeError(new Error("Request too large"))).toBe(true);
  });

  it("reads missing table name", () => {
    expect(
      missingTableName(
        new Error(
          "The table `public.OpsEvents` does not exist in the current database.",
        ),
      ),
    ).toBe("OpsEvents");
    expect(
      isMissingTableError(
        new Error("does not exist in the current database"),
      ),
    ).toBe(true);
  });

  it("detects unique constraint", () => {
    expect(
      isUniqueConstraintError(
        new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "test",
        }),
      ),
    ).toBe(true);
  });

  it("keeps AppError subclasses constructible", () => {
    expect(new UnauthorizedError()).toBeInstanceOf(AppError);
    expect(new ForbiddenError()).toBeInstanceOf(AppError);
    expect(new InvalidCredentialsError().message).toMatch(/Invalid username/);
    expect(new ValidationError("bad").code).toBe("VALIDATION_ERROR");
    expect(new ConflictError("dup").statusCode).toBe(409);
    expect(new NotFoundError().statusCode).toBe(404);
    expect(isPrismaConnectionError(new Error("nope"))).toBe(false);
  });
});
