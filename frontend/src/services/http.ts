import type { ApiErrorBody } from "@workee/shared";
import { ApiError } from "@/types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) {
      throw new ApiError("ABORTED", "Request cancelled", 0);
    }

    throw new ApiError(
      "NETWORK_ERROR",
      "Unable to connect. Please check your connection and try again.",
      0,
    );
  }

  let body: unknown = null;
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    body = await response.json();
  }

  if (!response.ok) {
    const errorBody = body as ApiErrorBody | null;
    throw new ApiError(
      errorBody?.error.code ?? "REQUEST_FAILED",
      errorBody?.error.message ?? "Something went wrong. Please try again.",
      response.status,
      errorBody?.error.fields,
    );
  }

  return body as T;
}
