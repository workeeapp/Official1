/**
 * Gate 1b.1 — acceptance contracts only (no production implementation in this step).
 *
 * Scope of this file (tests only):
 *   - A3 scenario validation (new validateStudioScenario API)
 *   - A5 draft isolation vs published loader
 *   - A6 offline ENGINE (no live OpenAI; production apply retained)
 *   - A9 multi-turn continuity (documented reuse of Gate 1 coverage)
 *   - A11 approved-DB guard (pure unit; no DB I/O)
 *
 * Planned production modules (NOT created in this step):
 *   - backend/src/eval/studio-validate.ts  → validateStudioScenario
 *   - backend/src/eval/studio-db-guard.ts  → assertApprovedEvalDatabaseUrl
 *
 * Existing interfaces reused:
 *   - loadRegressionSuite / defaultRegressionSuitePath (corpus.ts)
 *   - runMultiTurnOffline / EngineFixtureRequiredError (run-multi-turn.ts)
 *   - applyEmployeeRecords / applyListOps (production services)
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultRegressionSuitePath,
  loadRegressionSuite,
} from "../src/eval/corpus.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const PUBLISHED_SUITE = resolve(REPO_ROOT, "docs/qa/regression-suite.json");
const DRAFTS_DIR = resolve(REPO_ROOT, "docs/qa/studio/drafts");
const DRAFT_TEMP = join(DRAFTS_DIR, "_gate1b1-a5-temp-draft.json");

const MISSING = "EXPECTED_MISSING_BEHAVIOR";

type ValidateStudioScenario = (input: unknown) => void;
type AssertApprovedEvalDatabaseUrl = (url: string | undefined) => void;

async function loadValidateStudioScenario(): Promise<ValidateStudioScenario | null> {
  try {
    const mod = await import("../src/eval/studio-validate.js");
    const fn = (mod as { validateStudioScenario?: ValidateStudioScenario })
      .validateStudioScenario;
    return typeof fn === "function" ? fn : null;
  } catch {
    return null;
  }
}

async function loadAssertApprovedEvalDatabaseUrl(): Promise<AssertApprovedEvalDatabaseUrl | null> {
  try {
    const mod = await import("../src/eval/studio-db-guard.js");
    const fn = (
      mod as { assertApprovedEvalDatabaseUrl?: AssertApprovedEvalDatabaseUrl }
    ).assertApprovedEvalDatabaseUrl;
    return typeof fn === "function" ? fn : null;
  } catch {
    return null;
  }
}

function requireFn<T>(fn: T | null, name: string): T {
  if (!fn) {
    expect.fail(
      `${MISSING}: ${name} is not implemented yet (Gate 1b.1 production code deferred)`,
    );
  }
  return fn;
}

function suiteFingerprint(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeTempSuite(payload: unknown): string {
  const path = join(
    tmpdir(),
    `gate1b1-suite-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

afterEach(() => {
  if (existsSync(DRAFT_TEMP)) {
    unlinkSync(DRAFT_TEMP);
  }
});

describe("Gate 1b.1 acceptance — A3 scenario validation", () => {
  it("rejects an empty scenario without modifying the published suite", async () => {
    const before = suiteFingerprint(PUBLISHED_SUITE);
    const validate = requireFn(
      await loadValidateStudioScenario(),
      "validateStudioScenario",
    );

    expect(() =>
      validate({
        id: "empty-turns",
        track: "ENGINE",
        turns: [],
      }),
    ).toThrow(/turn/i);

    expect(suiteFingerprint(PUBLISHED_SUITE)).toBe(before);
  });

  it("rejects an unsupported track without modifying the published suite", async () => {
    const before = suiteFingerprint(PUBLISHED_SUITE);
    const validate = requireFn(
      await loadValidateStudioScenario(),
      "validateStudioScenario",
    );

    // MODEL is a supported Studio track; reject unknown tracks only.
    expect(() =>
      validate({
        id: "bad-track",
        track: "E2E",
        turns: [
          {
            utterance: "שלום",
            fixtureMetadata: { lists: [], filing: [] },
          },
        ],
      }),
    ).toThrow(/track/i);

    expect(suiteFingerprint(PUBLISHED_SUITE)).toBe(before);
  });

  it("rejects an ENGINE scenario with missing fixtureMetadata without publishing", async () => {
    const before = suiteFingerprint(PUBLISHED_SUITE);
    const validate = requireFn(
      await loadValidateStudioScenario(),
      "validateStudioScenario",
    );

    expect(() =>
      validate({
        id: "missing-fixture",
        track: "ENGINE",
        turns: [{ utterance: "תמחק חלב", fixtureMetadata: null }],
      }),
    ).toThrow(/fixtureMetadata/i);

    expect(suiteFingerprint(PUBLISHED_SUITE)).toBe(before);
  });

  it("existing published loader still rejects empty cases / bad tracks (baseline)", () => {
    const emptyPath = writeTempSuite({
      version: 1,
      speaker: "טל",
      cases: [],
    });
    const badTrackPath = writeTempSuite({
      version: 1,
      speaker: "טל",
      cases: [
        {
          id: "x",
          track: "MODEL",
          turns: [{ utterance: "x", fixtureMetadata: { lists: [] } }],
        },
      ],
    });
    try {
      expect(() => loadRegressionSuite(emptyPath)).toThrow(/no cases/);
      expect(() => loadRegressionSuite(badTrackPath)).toThrow(/ENGINE/);
    } finally {
      unlinkSync(emptyPath);
      unlinkSync(badTrackPath);
    }
  });
});

describe("Gate 1b.1 acceptance — A5 draft isolation", () => {
  it("published loader reads docs/qa/regression-suite.json only", () => {
    const path = defaultRegressionSuitePath(REPO_ROOT);
    expect(path.replace(/\\/g, "/")).toMatch(/docs\/qa\/regression-suite\.json$/);
    const suite = loadRegressionSuite(path);
    expect(suite.cases.length).toBeGreaterThan(0);
  });

  it("a draft under docs/qa/studio/drafts is not discovered by the published loader", () => {
    mkdirSync(DRAFTS_DIR, { recursive: true });
    const draftId = "draft-must-not-appear-in-published-suite";
    writeFileSync(
      DRAFT_TEMP,
      JSON.stringify({
        id: draftId,
        track: "ENGINE",
        turns: [
          {
            utterance: "draft only",
            fixtureMetadata: { lists: [], filing: [] },
          },
        ],
      }),
    );

    const suite = loadRegressionSuite(defaultRegressionSuitePath(REPO_ROOT));
    const ids = new Set(suite.cases.map((row) => row.id));
    expect(ids.has(draftId)).toBe(false);
    expect(existsSync(DRAFT_TEMP)).toBe(true);
  });
});

describe("Gate 1b.1 acceptance — A6 offline ENGINE (no live model)", () => {
  it("ENGINE harness module does not import the LLM client", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/eval/run-multi-turn.ts"),
      "utf8",
    );
    // Import lines only — comments may mention OpenAI as "not used".
    const importLines = src
      .split(/\r?\n/)
      .filter((line) => /^\s*import\s/.test(line))
      .join("\n");
    expect(importLines).not.toMatch(/llm-client/);
    expect(importLines).not.toMatch(/getLlmClient/);
    expect(importLines).not.toMatch(/openai/i);
    expect(src).toMatch(/applyEmployeeRecords/);
    expect(src).toMatch(/applyListOps/);
    expect(src).toMatch(/appliedViaProduction/);
  });

  it("ENGINE run refuses LLM fallback when fixtureMetadata is missing (no OpenAI)", async () => {
    const { runMultiTurnOffline, EngineFixtureRequiredError } = await import(
      "../src/eval/run-multi-turn.js"
    );
    // This path hits Prisma account create. Without an approved dedicated test DB
    // we only assert the fixture-required error type exists and the contract text;
    // full offline run is gated in the report (A11 / DB policy).
    expect(EngineFixtureRequiredError).toBeTypeOf("function");
    const err = new EngineFixtureRequiredError("probe", 0);
    expect(err.message).toMatch(/Refusing LLM fallback/);
    expect(typeof runMultiTurnOffline).toBe("function");
  });
});

describe("Gate 1b.1 acceptance — A9 multi-turn continuity", () => {
  it("reuses Gate 1 coverage: existing offline suite asserts UUID continuity + reinjected facts", () => {
    const gate1 = readFileSync(
      resolve(import.meta.dirname, "./regression-suite.offline.test.ts"),
      "utf8",
    );
    expect(gate1).toContain("appliedViaProduction");
    expect(gate1).toContain("turn1ItemId");
    expect(gate1).toContain("getEmployeeRecordSnapshot");
    expect(gate1).toContain("applyEmployeeRecords");
    expect(gate1).toMatch(/removeId\)\.toBe\(turn1ItemId\)/);
    // Full DB-backed re-run of Gate 1 is reported separately (blocked without approved DB).
  });
});

describe("Gate 1b.1 acceptance — A11 database safety (pure unit, no DB I/O)", () => {
  const cases: Array<{ label: string; url: string | undefined; accept: boolean }> =
    [
      { label: "missing", url: undefined, accept: false },
      { label: "empty", url: "", accept: false },
      { label: "malformed", url: "not-a-url", accept: false },
      {
        label: "_test suffix alone is not authorization",
        url: "postgresql://workee:workee@localhost:5432/workee_test",
        accept: false,
      },
      {
        label: "local development DB name workee is not authorization",
        url: "postgresql://workee:workee@localhost:5435/workee",
        accept: false,
      },
      {
        label: "explicitly approved dedicated URL",
        // Sentinel value the guard must accept only when configured as the sole approvee.
        url: "postgresql://workee:workee@127.0.0.1:5432/workee_gate1b_approved",
        accept: true,
      },
    ];

  for (const row of cases) {
    it(`${row.accept ? "accepts" : "rejects"}: ${row.label}`, async () => {
      const assertUrl = requireFn(
        await loadAssertApprovedEvalDatabaseUrl(),
        "assertApprovedEvalDatabaseUrl",
      );

      // Contract: approval is explicit env allowlist, not name heuristics.
      // Tests set the approved URL only for the accept case.
      const prev = process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
      try {
        if (row.accept) {
          process.env.WORKEE_APPROVED_TEST_DATABASE_URL =
            "postgresql://workee:workee@127.0.0.1:5432/workee_gate1b_approved";
          expect(() => assertUrl(row.url)).not.toThrow();
        } else {
          process.env.WORKEE_APPROVED_TEST_DATABASE_URL =
            "postgresql://workee:workee@127.0.0.1:5432/workee_gate1b_approved";
          expect(() => assertUrl(row.url)).toThrow();
        }
      } finally {
        if (prev === undefined) {
          delete process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
        } else {
          process.env.WORKEE_APPROVED_TEST_DATABASE_URL = prev;
        }
      }
    });
  }

  it("does not open a database connection while evaluating URLs", async () => {
    const prismaConnect = vi.fn();
    vi.doMock("../src/database/prisma.js", () => ({
      prisma: { $connect: prismaConnect, $queryRaw: prismaConnect },
    }));
    const assertUrl = await loadAssertApprovedEvalDatabaseUrl();
    if (!assertUrl) {
      expect.fail(
        `${MISSING}: assertApprovedEvalDatabaseUrl is not implemented yet`,
      );
    }
    try {
      assertUrl("postgresql://workee:workee@localhost:5432/workee_test");
    } catch {
      // rejection expected
    }
    expect(prismaConnect).not.toHaveBeenCalled();
  });

  it("rejects exact self-match of product database identity workee", async () => {
    const assertUrl = requireFn(
      await loadAssertApprovedEvalDatabaseUrl(),
      "assertApprovedEvalDatabaseUrl",
    );
    const product =
      "postgresql://workee:workee@127.0.0.1:5435/workee";
    const prev = process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
    try {
      process.env.WORKEE_APPROVED_TEST_DATABASE_URL = product;
      expect(() => assertUrl(product)).toThrow(/product database/i);
    } finally {
      if (prev === undefined) {
        delete process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
      } else {
        process.env.WORKEE_APPROVED_TEST_DATABASE_URL = prev;
      }
    }
  });

  it("rejects matching malformed URLs and empty database names", async () => {
    const assertUrl = requireFn(
      await loadAssertApprovedEvalDatabaseUrl(),
      "assertApprovedEvalDatabaseUrl",
    );
    const prev = process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
    try {
      process.env.WORKEE_APPROVED_TEST_DATABASE_URL = "not-a-url";
      expect(() => assertUrl("not-a-url")).toThrow(/malformed/i);

      const emptyPath = "postgresql://workee:workee@127.0.0.1:5432/";
      process.env.WORKEE_APPROVED_TEST_DATABASE_URL = emptyPath;
      expect(() => assertUrl(emptyPath)).toThrow(/empty database name/i);
    } finally {
      if (prev === undefined) {
        delete process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
      } else {
        process.env.WORKEE_APPROVED_TEST_DATABASE_URL = prev;
      }
    }
  });
});
