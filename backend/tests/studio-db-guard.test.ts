/**
 * Pure unit tests for eval DB URL isolation.
 * Never opens Prisma / mutates a database.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertApprovedEvalDatabaseUrl,
  assertValidEvalPostgresUrl,
  evalDatabaseNameFromUrl,
  UnapprovedEvalDatabaseError,
} from "../src/eval/studio-db-guard.js";
import { approvedTestDatabaseConfigured } from "../src/eval/studio-safety.js";

const ISOLATED =
  "postgresql://workee:workee@127.0.0.1:5432/workee_eval_isolated";
const PRODUCT_WORKEE =
  "postgresql://workee:workee@127.0.0.1:5435/workee";
const OTHER =
  "postgresql://workee:workee@127.0.0.1:5432/other_db";
const EMPTY_PATH = "postgresql://workee:workee@127.0.0.1:5432/";
const EMPTY_PATH_NO_SLASH = "postgresql://workee:workee@127.0.0.1:5432";
const MALFORMED = "not-a-postgres-url";

describe("studio-db-guard (pure unit, no DB I/O)", () => {
  const prevApproved = process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
  const prevDb = process.env.DATABASE_URL;

  afterEach(() => {
    if (prevApproved === undefined) {
      delete process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
    } else {
      process.env.WORKEE_APPROVED_TEST_DATABASE_URL = prevApproved;
    }
    if (prevDb === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = prevDb;
    }
  });

  it("blocks when WORKEE_APPROVED_TEST_DATABASE_URL is missing", () => {
    delete process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
    expect(() => assertApprovedEvalDatabaseUrl(ISOLATED)).toThrow(
      UnapprovedEvalDatabaseError,
    );
    expect(() => assertApprovedEvalDatabaseUrl(ISOLATED)).toThrow(
      /not set/i,
    );
  });

  it("rejects DATABASE_URL pointing to product workee even when self-approved", () => {
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = PRODUCT_WORKEE;
    expect(() => assertApprovedEvalDatabaseUrl(PRODUCT_WORKEE)).toThrow(
      UnapprovedEvalDatabaseError,
    );
    expect(() => assertApprovedEvalDatabaseUrl(PRODUCT_WORKEE)).toThrow(
      /product database/i,
    );
  });

  it("rejects a mismatched URL", () => {
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = ISOLATED;
    expect(() => assertApprovedEvalDatabaseUrl(OTHER)).toThrow(
      UnapprovedEvalDatabaseError,
    );
    expect(() => assertApprovedEvalDatabaseUrl(OTHER)).toThrow(
      /exactly match/i,
    );
  });

  it("accepts a matching explicitly configured isolated test URL", () => {
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = ISOLATED;
    expect(() => assertApprovedEvalDatabaseUrl(ISOLATED)).not.toThrow();
  });

  it("rejects matching malformed / non-URL strings", () => {
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = MALFORMED;
    expect(() => assertApprovedEvalDatabaseUrl(MALFORMED)).toThrow(
      /malformed/i,
    );
  });

  it("rejects matching URLs with an empty database name", () => {
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = EMPTY_PATH;
    expect(() => assertApprovedEvalDatabaseUrl(EMPTY_PATH)).toThrow(
      /empty database name/i,
    );

    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = EMPTY_PATH_NO_SLASH;
    expect(() => assertApprovedEvalDatabaseUrl(EMPTY_PATH_NO_SLASH)).toThrow(
      /empty database name/i,
    );
  });

  it("rejects matching non-postgres schemes", () => {
    const httpUrl = "http://127.0.0.1:5432/workee_eval_isolated";
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = httpUrl;
    expect(() => assertApprovedEvalDatabaseUrl(httpUrl)).toThrow(
      /postgresql\/postgres scheme/i,
    );
  });

  it("does not treat a name containing test as authorization by itself", () => {
    delete process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
    const withTest =
      "postgresql://workee:workee@127.0.0.1:5432/workee_test";
    expect(() => assertApprovedEvalDatabaseUrl(withTest)).toThrow(
      /not set/i,
    );
  });

  it("assertValidEvalPostgresUrl rejects malformed and empty paths", () => {
    expect(() => assertValidEvalPostgresUrl(MALFORMED)).toThrow(/malformed/i);
    expect(() => assertValidEvalPostgresUrl(EMPTY_PATH)).toThrow(
      /empty database name/i,
    );
    expect(assertValidEvalPostgresUrl(ISOLATED)).toBe("workee_eval_isolated");
  });

  it("approvedTestDatabaseConfigured mirrors the same fail-closed rules", () => {
    delete process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
    process.env.DATABASE_URL = ISOLATED;
    expect(approvedTestDatabaseConfigured().ok).toBe(false);

    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = PRODUCT_WORKEE;
    process.env.DATABASE_URL = PRODUCT_WORKEE;
    expect(approvedTestDatabaseConfigured().ok).toBe(false);

    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = MALFORMED;
    process.env.DATABASE_URL = MALFORMED;
    expect(approvedTestDatabaseConfigured().ok).toBe(false);

    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = EMPTY_PATH;
    process.env.DATABASE_URL = EMPTY_PATH;
    expect(approvedTestDatabaseConfigured().ok).toBe(false);

    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = ISOLATED;
    process.env.DATABASE_URL = OTHER;
    expect(approvedTestDatabaseConfigured().ok).toBe(false);

    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = ISOLATED;
    process.env.DATABASE_URL = ISOLATED;
    expect(approvedTestDatabaseConfigured().ok).toBe(true);
  });

  it("evalDatabaseNameFromUrl extracts pathname", () => {
    expect(evalDatabaseNameFromUrl(PRODUCT_WORKEE)).toBe("workee");
    expect(evalDatabaseNameFromUrl(ISOLATED)).toBe("workee_eval_isolated");
    expect(evalDatabaseNameFromUrl(EMPTY_PATH)).toBeNull();
    expect(evalDatabaseNameFromUrl(MALFORMED)).toBeNull();
  });

  it("does not open a Prisma connection while evaluating URLs", async () => {
    const prismaConnect = vi.fn();
    vi.doMock("../src/database/prisma.js", () => ({
      prisma: { $connect: prismaConnect, $queryRaw: prismaConnect },
    }));
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = ISOLATED;
    assertApprovedEvalDatabaseUrl(ISOLATED);
    try {
      assertApprovedEvalDatabaseUrl(PRODUCT_WORKEE);
    } catch {
      // expected
    }
    expect(prismaConnect).not.toHaveBeenCalled();
  });
});

describe("model-only eval paths do not require DB-write approval", () => {
  it("run-case (LIVE_MODEL / LIVE_MODEL_MT) does not call assertApprovedEvalDatabaseUrl", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/eval/run-case.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/assertApprovedEvalDatabaseUrl/);
    expect(src).not.toMatch(/WORKEE_APPROVED_TEST_DATABASE_URL/);
    expect(src).not.toMatch(/createHarnessAccount/);
    expect(src).not.toMatch(/from ["'].*database\/prisma/);
  });

  it("live-model-snapshot-apply stays in-memory (no Prisma / harness)", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/eval/live-model-snapshot-apply.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/assertApprovedEvalDatabaseUrl/);
    expect(src).not.toMatch(/createHarnessAccount/);
    expect(src).not.toMatch(/from ["'].*database\/prisma/);
  });
});

describe("no test self-approves DATABASE_URL as WORKEE_APPROVED_TEST_DATABASE_URL", () => {
  it("scans backend/tests for self-approval assignments", () => {
    const testsDir = resolve(import.meta.dirname);
    const files = readdirSync(testsDir).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    // Direct self-approval: APPROVED assigned from DATABASE_URL or the usual `db` alias.
    const selfApprove =
      /WORKEE_APPROVED_TEST_DATABASE_URL\s*=\s*(?:db\b|process\.env\.DATABASE_URL)/;
    for (const file of files) {
      const text = readFileSync(join(testsDir, file), "utf8");
      if (selfApprove.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
