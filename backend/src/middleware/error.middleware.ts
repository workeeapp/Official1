import type { NextFunction, Request, Response } from "express";
import {
  AppError,
  ServiceUnavailableError,
  isPrismaConnectionError,
} from "../utils/errors.js";

export function errorMiddleware(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields ? { fields: error.fields } : {}),
      },
    });
    return;
  }

  if (isPrismaConnectionError(error)) {
    const unavailable = new ServiceUnavailableError();
    res.status(unavailable.statusCode).json({
      error: {
        code: unavailable.code,
        message: unavailable.message,
      },
    });
    return;
  }

  console.error("Unhandled server error");
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong. Please try again.",
    },
  });
}

export function notFoundMiddleware(_req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    },
  });
}
