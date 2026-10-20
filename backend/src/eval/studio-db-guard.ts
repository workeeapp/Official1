/**
 * Gate 1b.1 — database URL safety for ENGINE / Studio harnesses.
 *
 * Authorization is an exact string match against
 * WORKEE_APPROVED_TEST_DATABASE_URL. A database name containing "_test"
 * (or any other heuristic) is never sufficient by itself.
 *
 * Pure function: never opens a Prisma / DB connection.
 */

export class UnapprovedEvalDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnapprovedEvalDatabaseError";
  }
}

/**
 * Reject missing, empty, or unapproved candidate URLs.
 * Approved URL must be set in WORKEE_APPROVED_TEST_DATABASE_URL and match
 * the candidate exactly (including credentials, host, port, and path).
 */
export function assertApprovedEvalDatabaseUrl(
  url: string | undefined,
): void {
  const approved = process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
  if (typeof approved !== "string" || approved.trim() === "") {
    throw new UnapprovedEvalDatabaseError(
      "WORKEE_APPROVED_TEST_DATABASE_URL is not set; refusing database use",
    );
  }

  if (url === undefined || url === null) {
    throw new UnapprovedEvalDatabaseError(
      "database URL is missing; refusing database use",
    );
  }
  if (typeof url !== "string" || url.trim() === "") {
    throw new UnapprovedEvalDatabaseError(
      "database URL is empty; refusing database use",
    );
  }

  // Exact match only — no hostname / _test / path heuristics.
  if (url !== approved) {
    throw new UnapprovedEvalDatabaseError(
      "database URL does not exactly match WORKEE_APPROVED_TEST_DATABASE_URL; refusing database use",
    );
  }
}
