/**
 * Q3 result contract: a test that did not run is never reported as passed;
 * skips need a reviewed reason; model-eval suites gate per case against an
 * explicit baseline; tsc gates only on genuinely new diagnostics; scopes are
 * never merged.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffTsc,
  evaluateModelEval,
  evaluateTsc,
  evaluateVitest,
  flakyCasesToRerun,
  formatSummary,
  normalizeTscOutput,
  precheck,
  summarizeRun,
  validateBaseline,
  type BaselineSuite,
  type ManifestSuite,
  type ModelEvalBaseline,
} from "../src/eval/regression-summary.js";

const T0 = "2026-11-07T10:00:00.000Z";
const LATER = Date.parse(T0) + 60_000;
const NOW = new Date("2026-11-07T12:00:00.000Z");

function suite(over: Partial<ManifestSuite> = {}): ManifestSuite {
  return {
    id: "offline-backend",
    kind: "vitest",
    scope: "unit",
    requested: true,
    executed: true,
    exitCode: 0,
    startedAt: T0,
    resultFile: "x.json",
    ...over,
  };
}

const fresh = { exists: true, mtimeMs: LATER };

describe("precheck — not run is never passed (B4)", () => {
  it("not requested → NOT_RUN without gating", () => {
    const o = precheck(suite({ requested: false }), fresh)!;
    expect(o.status).toBe("NOT_RUN");
    expect(summarizeRun("p", [o]).ok).toBe(true);
  });
  it("requested but not executed → NOT_RUN and the run fails", () => {
    const o = precheck(suite({ executed: false }), fresh)!;
    expect(o.status).toBe("NOT_RUN");
    expect(summarizeRun("p", [o]).exitCode).toBe(1);
  });
  it("missing result file → NOT_RUN", () => {
    expect(precheck(suite(), { exists: false, mtimeMs: null })!.status).toBe("NOT_RUN");
  });
  it("stale result file (older than this run) → NOT_RUN", () => {
    const o = precheck(suite(), { exists: true, mtimeMs: Date.parse(T0) - 60_000 })!;
    expect(o.status).toBe("NOT_RUN");
    expect(o.reason).toMatch(/stale/);
  });
  it("fresh result → evaluated", () => {
    expect(precheck(suite(), fresh)).toBeNull();
  });
});

describe("vitest results", () => {
  const file = (name: string, assertions: Array<{ title: string; status: string }>, extra: object = {}) => ({
    name: `C:/repo/backend/tests/${name}`,
    status: assertions.some((a) => a.status === "failed") ? "failed" : "passed",
    assertionResults: assertions.map((a) => ({ fullName: `d ${a.title}`, title: a.title, ancestorTitles: ["d"], status: a.status })),
    ...extra,
  });

  it("0 tests collected → NOT_RUN (B4)", () => {
    const o = evaluateVitest(suite(), { startTime: LATER, testResults: [] }, []);
    expect(o.status).toBe("NOT_RUN");
    expect(o.reason).toBe("0 tests collected");
  });

  it("stale vitest json → NOT_RUN", () => {
    const o = evaluateVitest(suite(), { startTime: Date.parse(T0) - 600_000, testResults: [file("a.test.ts", [{ title: "x", status: "passed" }])] }, []);
    expect(o.status).toBe("NOT_RUN");
  });

  it("all passed → PASS with counts", () => {
    const o = evaluateVitest(suite(), { startTime: LATER, testResults: [file("a.test.ts", [{ title: "x", status: "passed" }, { title: "y", status: "passed" }])] }, []);
    expect(o.status).toBe("PASS");
    expect(o.byScope.unit?.PASS).toBe(2);
  });

  it("a failing test → FAIL with the test named", () => {
    const o = evaluateVitest(suite(), { startTime: LATER, testResults: [file("a.test.ts", [{ title: "x", status: "failed" }])] }, []);
    expect(o.status).toBe("FAIL");
    expect(o.details[0]!.id).toBe("a.test.ts › d x");
  });

  it("file that fails before any test (beforeAll / import) → FAIL, not 0 tests", () => {
    const o = evaluateVitest(
      suite(),
      { startTime: LATER, testResults: [{ name: "b.db.test.ts", status: "failed", message: "refusing database use", assertionResults: [] }] },
      [],
    );
    expect(o.status).toBe("FAIL");
    expect(o.details[0]!.note).toMatch(/refusing database use/);
  });

  it("unexpected skip / todo → FAIL; allow-listed → SKIPPED with reason (B5)", () => {
    const results = { startTime: LATER, testResults: [file("a.test.ts", [{ title: "s", status: "skipped" }, { title: "t", status: "todo" }])] };
    const bad = evaluateVitest(suite(), results, []);
    expect(bad.status).toBe("FAIL");
    expect(bad.details.map((d) => d.note)).toEqual([
      "unexpected skip (not in skip allow-list)",
      "unexpected todo (not in skip allow-list)",
    ]);
    const ok = evaluateVitest(suite(), results, [
      { file: "a.test.ts", test: "d s", kind: "skip", reason: "R1" },
      { file: "a.test.ts", test: "d t", kind: "todo", reason: "R2" },
    ]);
    expect(ok.status).toBe("PASS");
    expect(ok.byScope.unit?.SKIPPED).toBe(2);
    expect(ok.details.every((d) => d.status === "SKIPPED" && /allowed/.test(d.note ?? ""))).toBe(true);
  });

  it("an allow-list entry for the wrong kind does not hide a skip", () => {
    const o = evaluateVitest(suite(), { startTime: LATER, testResults: [file("a.test.ts", [{ title: "s", status: "skipped" }])] }, [
      { file: "a.test.ts", test: "d s", kind: "todo", reason: "R" },
    ]);
    expect(o.status).toBe("FAIL");
  });

  it("non-zero exit with no failing test → FAIL", () => {
    const o = evaluateVitest(suite({ exitCode: 1 }), { startTime: LATER, testResults: [file("a.test.ts", [{ title: "x", status: "passed" }])] }, []);
    expect(o.status).toBe("FAIL");
  });

  it("eval-db: live-sendchat files are production-path, others eval-db harness (B7)", () => {
    const o = evaluateVitest(
      suite({ id: "eval-db", scope: "eval-db-harness" }),
      {
        startTime: LATER,
        testResults: [
          file("taps.live-sendchat.eval-db.test.ts", [{ title: "x", status: "passed" }]),
          file("share-pack-model-apply.eval-db.test.ts", [{ title: "y", status: "passed" }]),
        ],
      },
      [],
    );
    expect(o.byScope["production-path"]?.PASS).toBe(1);
    expect(o.byScope["eval-db-harness"]?.PASS).toBe(1);
  });
});

describe("model-eval baseline gate (B6)", () => {
  const base: BaselineSuite = {
    scope: "model+harness-apply",
    criticalCaseIds: ["crit"],
    cases: {
      p: { expect: "pass" },
      crit: { expect: "pass" },
      kf: { expect: "known-fail", reason: "G9", evidence: "3 runs failed", reviewBy: "2026-12-31" },
      expired: { expect: "known-fail", reason: "old", evidence: "x", reviewBy: "2026-01-01" },
      fl: { expect: "flaky", reason: "variance", evidence: "9/10", reviewBy: "2026-12-31", minPassesOf3: 2 },
      m: { expect: "measurement", reason: "measure only", evidence: "doc", reviewBy: "2026-12-31" },
    },
  };
  const ms = suite({ id: "live-full", kind: "model-eval", scope: "model+harness-apply" });
  const run = (results: Array<{ id: string; ok: boolean }>, rerun?: { rows: Array<{ id: string; runs: number; passed: number }> }) =>
    evaluateModelEval(ms, { generatedAt: new Date(LATER).toISOString(), results: results.map((r) => ({ ...r, failures: r.ok ? [] : ["turn 0: boom"] })) }, base, NOW, rerun);

  it("a baseline-pass case failing is a regression even when 95% pass", () => {
    const many = Array.from({ length: 19 }, (_, i) => ({ id: `n${i}`, ok: true }));
    const o = evaluateModelEval(
      ms,
      { generatedAt: new Date(LATER).toISOString(), results: [...many, { id: "p", ok: false, failures: ["x"] }] },
      { ...base, cases: { ...base.cases, ...Object.fromEntries(many.map((m) => [m.id, { expect: "pass" as const }])) } },
      NOW,
    );
    expect(o.status).toBe("FAIL");
    expect(o.details.find((d) => d.id === "p")!.status).toBe("FAIL");
  });

  it("known-fail failing → KNOWN_FAIL (not gating), shown with reason + evidence", () => {
    const o = run([{ id: "kf", ok: false }]);
    expect(o.status).toBe("PASS");
    expect(o.details[0]).toMatchObject({ status: "KNOWN_FAIL" });
    expect(o.details[0]!.note).toMatch(/G9.*evidence: 3 runs failed/);
  });

  it("known-fail passing → IMPROVED (review baseline)", () => {
    expect(run([{ id: "kf", ok: true }]).details[0]!.status).toBe("IMPROVED");
  });

  it("expired exception gates as pass — never hides a failure", () => {
    const o = run([{ id: "expired", ok: false }]);
    expect(o.status).toBe("FAIL");
    expect(o.details[0]!.note).toMatch(/expired/);
  });

  it("flaky failure without re-run → FAIL; re-run ≥ min → FLAKY_OK; below → FAIL", () => {
    expect(run([{ id: "fl", ok: false }]).status).toBe("FAIL");
    const ok = run([{ id: "fl", ok: false }], { rows: [{ id: "fl", runs: 3, passed: 2 }] });
    expect(ok.status).toBe("PASS");
    expect(ok.details[0]!.status).toBe("FLAKY_OK");
    expect(run([{ id: "fl", ok: false }], { rows: [{ id: "fl", runs: 3, passed: 1 }] }).status).toBe("FAIL");
  });

  it("with re-run evidence the re-run decides, even when the last single run passed", () => {
    const low = run([{ id: "fl", ok: true }], { rows: [{ id: "fl", runs: 3, passed: 1 }] });
    expect(low.status).toBe("FAIL");
    expect(low.details[0]!.note).toMatch(/1\/3 < 2\/3/);
    expect(run([{ id: "fl", ok: true }], { rows: [{ id: "fl", runs: 3, passed: 2 }] }).details[0]!.status).toBe("FLAKY_OK");
    // Without re-run evidence a single pass is a plain PASS.
    expect(run([{ id: "fl", ok: true }]).details).toEqual([]);
  });

  it("measurement never gates and is never counted as PASS", () => {
    const o = run([{ id: "m", ok: false }]);
    expect(o.status).toBe("PASS");
    expect(o.byScope["model+harness-apply"]?.PASS).toBe(0);
    expect(o.byScope["model+harness-apply"]?.MEASUREMENT).toBe(1);
  });

  it("case not in baseline: pass → NEW_PASS, failing → FAIL (no implicit exception)", () => {
    expect(run([{ id: "brand-new", ok: true }]).details[0]!.status).toBe("NEW_PASS");
    expect(run([{ id: "brand-new", ok: false }]).status).toBe("FAIL");
  });

  it("critical case failing is always FAIL", () => {
    expect(run([{ id: "crit", ok: false }]).status).toBe("FAIL");
  });

  it("stale or empty eval report → NOT_RUN", () => {
    expect(evaluateModelEval(ms, { generatedAt: "2026-01-01T00:00:00Z", results: [{ id: "p", ok: true }] }, base, NOW).status).toBe("NOT_RUN");
    expect(evaluateModelEval(ms, { generatedAt: new Date(LATER).toISOString(), results: [] }, base, NOW).status).toBe("NOT_RUN");
  });

  it("flakyCasesToRerun lists only live (unexpired) flaky failures", () => {
    expect(
      flakyCasesToRerun({ results: [{ id: "fl", ok: false }, { id: "p", ok: false }, { id: "fl2", ok: true }] }, base, NOW),
    ).toEqual(["fl"]);
  });
});

describe("baseline validation — exceptions must be explicit and reviewable", () => {
  it("rejects exceptions without reason / evidence / reviewBy and critical exceptions", () => {
    const bad: ModelEvalBaseline = {
      version: 1,
      suites: {
        s: {
          scope: "model-only",
          criticalCaseIds: ["c"],
          cases: {
            a: { expect: "known-fail" },
            b: { expect: "flaky", reason: "r", evidence: "e", reviewBy: "2026-12-01" },
            c: { expect: "known-fail", reason: "r", evidence: "e", reviewBy: "2026-12-01" },
          },
        },
      },
    };
    const problems = validateBaseline(bad);
    expect(problems).toEqual(
      expect.arrayContaining([
        "s/a: known-fail needs a reason",
        "s/a: known-fail needs measured evidence",
        "s/a: known-fail needs a valid reviewBy date",
        "s/b: flaky needs minPassesOf3 in 1..3",
        "s/c: critical case cannot carry a known-fail exception",
      ]),
    );
    expect(summarizeRun("p", [], problems).ok).toBe(false);
  });

  it("the committed model-eval baseline is valid and every exception is documented", () => {
    const baseline = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../docs/qa/baselines/model-eval-baseline.json"), "utf8"),
    ) as ModelEvalBaseline;
    expect(validateBaseline(baseline)).toEqual([]);
    const exceptions = Object.values(baseline.suites).flatMap((s) =>
      Object.entries(s.cases).filter(([, c]) => c.expect !== "pass"),
    );
    for (const [, c] of exceptions) {
      expect(c.reason!.length).toBeGreaterThan(10);
      expect(c.evidence!.length).toBeGreaterThan(10);
    }
  });

  it("the committed skip allow-list gives a reason for every entry", () => {
    const list = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../docs/qa/baselines/test-skip-allowlist.json"), "utf8"),
    ) as { entries: Array<{ file: string; test: string; kind: string; reason: string }> };
    expect(list.entries.length).toBeGreaterThan(0);
    for (const e of list.entries) {
      expect(["todo", "skip"]).toContain(e.kind);
      expect(e.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("tsc diagnostics baseline (no new errors)", () => {
  const OUT = [
    "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    "tests/b.ts(3,1): error TS2339: Property 'x' does not exist on type 'Y'.",
    "  The intersection 'Z' was reduced to 'never'.",
    "src/a.ts(40,2): error TS2322: Type 'string' is not assignable to type 'number'.",
  ].join("\r\n");

  it("normalizes away line/column and joins continuation lines", () => {
    expect(normalizeTscOutput(OUT)).toEqual([
      "src/a.ts: error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/a.ts: error TS2322: Type 'string' is not assignable to type 'number'.",
      "tests/b.ts: error TS2339: Property 'x' does not exist on type 'Y'. ⏎ The intersection 'Z' was reduced to 'never'.",
    ]);
  });

  it("moved lines are not new; a second copy of an existing message is new", () => {
    const base = normalizeTscOutput(OUT);
    const moved = OUT.replace("(10,5)", "(99,1)");
    expect(diffTsc(base, normalizeTscOutput(moved)).added).toEqual([]);
    const extra = `${OUT}\r\nsrc/a.ts(50,1): error TS2322: Type 'string' is not assignable to type 'number'.`;
    expect(diffTsc(base, normalizeTscOutput(extra)).added).toHaveLength(1);
  });

  it("gate: new diagnostic → FAIL; fixed only → PASS; no baseline → FAIL (never auto-created)", () => {
    const s = suite({ id: "tsc", kind: "tsc", scope: "static", exitCode: 2 });
    const base = normalizeTscOutput(OUT);
    expect(evaluateTsc(s, OUT, base).status).toBe("PASS");
    expect(evaluateTsc(s, `${OUT}\nsrc/c.ts(1,1): error TS1005: ';' expected.`, base).status).toBe("FAIL");
    const fewer = evaluateTsc(s, OUT.split("\r\n")[0]!, base);
    expect(fewer.status).toBe("PASS");
    expect(fewer.reason).toMatch(/fixed/);
    expect(evaluateTsc(s, OUT, null).status).toBe("FAIL");
  });
});

describe("rendering keeps scopes apart (B7)", () => {
  it("prints one line per scope and never a merged pass-rate", () => {
    const vitest = evaluateVitest(
      suite({ id: "eval-db", scope: "eval-db-harness" }),
      {
        startTime: LATER,
        testResults: [
          { name: "x.live-sendchat.eval-db.test.ts", status: "passed", assertionResults: [{ fullName: "a", status: "passed" }] },
          { name: "y.eval-db.test.ts", status: "passed", assertionResults: [{ fullName: "b", status: "passed" }] },
        ],
      },
      [],
    );
    const text = formatSummary(summarizeRun("release", [vitest]));
    expect(text).toContain("production path (sendChatMessage, real model): PASS 1");
    expect(text).toContain("eval-db harness (locked eval env): PASS 1");
    expect(text).not.toMatch(/passRate|%/);
  });
});
