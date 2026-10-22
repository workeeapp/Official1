/**
 * Gate 1b.1 — database URL safety for ENGINE / Studio harnesses.
 *
 * Authorization is an exact string match against
 * WORKEE_APPROVED_TEST_DATABASE_URL. A database name containing "_test"
 * (or any other heuristic) is never sufficient by itself.
 *
 * Exact match is necessary but not sufficient: the URL must be a valid
 * postgresql/postgres connection URL with a non-empty database name, and
 * the product database identity `workee` is never approvable (blocks
 * self-approval of production).
 *
 * Pure function: never opens a Prisma / DB connection.
 */

export class UnapprovedEvalDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnapprovedEvalDatabaseError";
  }
}

/** Product DB pathname — never allowed for eval writes, even on exact match. */
const PRODUCT_DATABASE_NAME = "workee";

const POSTGRES_SCHEMES = new Set(["postgresql", "postgres"]);

/**
 * Extract the database name (first URL pathname segment, no leading slash).
 * Returns null when the URL cannot be parsed or has an empty path.
 */
export function evalDatabaseNameFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname.replace(/^\//, "").trim();
    if (!path) return null;
    const name = path.split("/")[0]?.trim() ?? "";
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Require a parseable postgres URL with a non-empty database name.
 * Throws UnapprovedEvalDatabaseError on failure; never connects.
 */
export function assertValidEvalPostgresUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnapprovedEvalDatabaseError(
      "database URL is malformed; refusing database use",
    );
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (!POSTGRES_SCHEMES.has(scheme)) {
    throw new UnapprovedEvalDatabaseError(
      "database URL must use postgresql/postgres scheme; refusing database use",
    );
  }

  const name = parsed.pathname.replace(/^\//, "").trim().split("/")[0]?.trim() ?? "";
  if (!name) {
    throw new UnapprovedEvalDatabaseError(
      "database URL has an empty database name; refusing database use",
    );
  }

  return name;
}

/**
 * Reject missing, empty, or unapproved candidate URLs.
 * Approved URL must be set in WORKEE_APPROVED_TEST_DATABASE_URL and match
 * the candidate exactly (including credentials, host, port, and path).
 * The matched URL must be a valid postgres URL with a non-empty database
 * name; the product database name `workee` is always refused.
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

  // Exact match only — no hostname / _test / path heuristics for approval.
  if (url !== approved) {
    throw new UnapprovedEvalDatabaseError(
      "database URL does not exactly match WORKEE_APPROVED_TEST_DATABASE_URL; refusing database use",
    );
  }

  // Exact match is not enough: must be a real postgres URL with a DB name.
  const name = assertValidEvalPostgresUrl(url);

  // Never approve the product DB identity, even via exact self-match.
  if (name.toLowerCase() === PRODUCT_DATABASE_NAME) {
    throw new UnapprovedEvalDatabaseError(
      "database identity 'workee' is the product database; refusing database use",
    );
  }
}
