/**
 * Q3 — one result contract for every regression track.
 *
 * run-regression.ps1 only orchestrates (runs suites, writes a run manifest);
 * every classification / comparison decision lives here and is unit-tested.
 *
 * Contract:
 * - Every suite in the run manifest ends as PASS | FAIL | NOT_RUN, with a reason.
 *   A suite that was requested but produced no fresh results is NOT_RUN and the
 *   run fails — a test that did not run is never reported as passed.
 * - Skipped / todo tests are SKIPPED; only entries in the reviewed skip
 *   allow-list are tolerated, anything else fails the suite.
 * - Model-eval suites are gated per case against a committed baseline
 *   (not a flat pass-rate). Exceptions (known-fail / flaky / measurement) must
 *   carry a reason, measured evidence and a review date; an expired or
 *   incomplete exception never hides a failure.
 * - Results are always reported per scope; pass counts are never merged across
 *   scopes (model-only ≠ model+harness-apply ≠ production-path).
 */

export type SuiteScope =
  | "unit"
  | "db-harness"
  | "eval-db-harness"
  | "production-path"
  | "model+harness-apply"
  | "model-only"
  | "static";

export const SCOPE_LABEL: Record<SuiteScope, string> = {
  unit: "unit / offline (no DB, no model)",
  "db-harness": "DB harness (stub model, production apply)",
  "eval-db-harness": "eval-db harness (locked eval env)",
  "production-path": "production path (sendChatMessage, real model)",
  "model+harness-apply": "model + harness apply (not full production path)",
  "model-only": "model only (no apply, fixture context)",
  static: "static analysis",
};

export type SuiteStatus = "PASS" | "FAIL" | "NOT_RUN";

export type CaseStatus =
  | "PASS"
  | "FAIL"
  | "SKIPPED"
  | "KNOWN_FAIL"
  | "FLAKY_OK"
  | "MEASUREMENT"
  | "IMPROVED"
  | "NEW_PASS";

export type SuiteKind = "vitest" | "model-eval" | "tsc";

/** One suite as recorded by the orchestrator. */
export interface ManifestSuite {
  id: string;
  kind: SuiteKind;
  /** Fixed scope; vitest eval-db suites are split per file (see scopeForTestFile). */
  scope: SuiteScope;
  /** Requested by the profile / switches (only requested suites gate). */
  requested: boolean;
  executed: boolean;
  exitCode: number | null;
  /** ISO time the orchestrator started this suite (freshness check). */
  startedAt: string | null;
  /** vitest json / model-eval json / tsc text output. */
  resultFile: string | null;
  /** model-eval only: baseline section name (e.g. "live-full"). */
  baselineSuite?: string;
  /** model-eval only: stability JSON from a flaky re-run (MODEL_EVAL_REPEAT). */
  rerunFile?: string | null;
}

export interface RunManifest {
  profile: string;
  startedAt: string;
  suites: ManifestSuite[];
}

export interface CaseRow {
  id: string;
  status: CaseStatus;
  scope: SuiteScope;
  note?: string;
}

export interface SuiteOutcome {
  id: string;
  kind: SuiteKind;
  requested: boolean;
  status: SuiteStatus;
  reason: string;
  /** Per-scope counts — never merged across scopes. */
  byScope: Partial<Record<SuiteScope, Record<CaseStatus, number>>>;
  /** Rows worth showing (everything that is not a plain PASS). */
  details: CaseRow[];
}

export interface RunSummary {
  profile: string;
  ok: boolean;
  exitCode: 0 | 1;
  suites: SuiteOutcome[];
  problems: string[];
}

// ---------------------------------------------------------------------------
// Generic helpers

const ZERO = (): Record<CaseStatus, number> => ({
  PASS: 0,
  FAIL: 0,
  SKIPPED: 0,
  KNOWN_FAIL: 0,
  FLAKY_OK: 0,
  MEASUREMENT: 0,
  IMPROVED: 0,
  NEW_PASS: 0,
});

function count(outcome: SuiteOutcome, scope: SuiteScope, status: CaseStatus) {
  const bucket = (outcome.byScope[scope] ??= ZERO());
  bucket[status] += 1;
}

function emptyOutcome(suite: ManifestSuite): SuiteOutcome {
  return {
    id: suite.id,
    kind: suite.kind,
    requested: suite.requested,
    status: "PASS",
    reason: "",
    byScope: {},
    details: [],
  };
}

function notRun(suite: ManifestSuite, reason: string): SuiteOutcome {
  return { ...emptyOutcome(suite), status: "NOT_RUN", reason };
}

function baseName(file: string): string {
  return file.replace(/\\/g, "/").split("/").pop() ?? file;
}

/** eval-db files split into production-path (live-sendchat) vs harness scope. */
export function scopeForTestFile(file: string, suiteScope: SuiteScope): SuiteScope {
  if (suiteScope === "eval-db-harness" && /\.live-sendchat\.eval-db\.test\.ts$/.test(baseName(file))) {
    return "production-path";
  }
  return suiteScope;
}

// ---------------------------------------------------------------------------
// Pre-checks shared by all kinds

/**
 * Requested but not executed / no output / stale output → NOT_RUN.
 * Returns null when the suite may be evaluated from its result.
 */
export function precheck(
  suite: ManifestSuite,
  result: { exists: boolean; mtimeMs: number | null },
): SuiteOutcome | null {
  if (!suite.requested) return notRun(suite, "not requested by this profile");
  if (!suite.executed) return notRun(suite, "requested but did not execute");
  if (!suite.resultFile || !result.exists) {
    return notRun(suite, `no result file (runner exit code ${suite.exitCode ?? "?"})`);
  }
  if (suite.startedAt && result.mtimeMs !== null) {
    const started = Date.parse(suite.startedAt);
    // 2 s tolerance for filesystem clock granularity.
    if (Number.isFinite(started) && result.mtimeMs < started - 2000) {
      return notRun(suite, "result file is older than this run (stale)");
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// vitest JSON reporter

export interface SkipAllowEntry {
  file: string;
  test: string;
  kind: "todo" | "skip";
  reason: string;
}

interface VitestAssertion {
  fullName?: string;
  title?: string;
  ancestorTitles?: string[];
  status?: string;
  failureMessages?: string[];
}

interface VitestFile {
  name?: string;
  status?: string;
  message?: string;
  assertionResults?: VitestAssertion[];
}

export interface VitestJson {
  numTotalTests?: number;
  startTime?: number;
  success?: boolean;
  testResults?: VitestFile[];
}

function assertionName(a: VitestAssertion): string {
  return (a.fullName ?? [...(a.ancestorTitles ?? []), a.title ?? ""].join(" ")).trim();
}

export function evaluateVitest(
  suite: ManifestSuite,
  json: VitestJson,
  allowlist: SkipAllowEntry[],
): SuiteOutcome {
  const out = emptyOutcome(suite);
  const files = json.testResults ?? [];
  if (suite.startedAt && typeof json.startTime === "number") {
    const started = Date.parse(suite.startedAt);
    if (Number.isFinite(started) && json.startTime < started - 2000) {
      return notRun(suite, "vitest results are older than this run (stale)");
    }
  }
  let total = 0;
  for (const file of files) {
    const name = baseName(file.name ?? "?");
    const scope = scopeForTestFile(name, suite.scope);
    const assertions = file.assertionResults ?? [];
    if (assertions.length === 0 && file.status === "failed") {
      // Collection / beforeAll / import failure: no test ran but the file failed.
      count(out, scope, "FAIL");
      out.details.push({
        id: name,
        status: "FAIL",
        scope,
        note: `file failed before any test: ${(file.message ?? "").split("\n")[0]}`,
      });
      total += 1;
      continue;
    }
    for (const a of assertions) {
      total += 1;
      const id = `${name} › ${assertionName(a)}`;
      const status = a.status ?? "unknown";
      if (status === "passed") {
        count(out, scope, "PASS");
      } else if (status === "failed") {
        count(out, scope, "FAIL");
        out.details.push({ id, status: "FAIL", scope, note: (a.failureMessages?.[0] ?? "").split("\n")[0] });
      } else if (status === "skipped" || status === "pending" || status === "todo" || status === "disabled") {
        const kind = status === "todo" ? "todo" : "skip";
        const allowed = allowlist.find(
          (e) => e.file === name && e.test === assertionName(a) && e.kind === kind,
        );
        if (allowed) {
          count(out, scope, "SKIPPED");
          out.details.push({ id, status: "SKIPPED", scope, note: `allowed ${kind}: ${allowed.reason}` });
        } else {
          count(out, scope, "FAIL");
          out.details.push({ id, status: "FAIL", scope, note: `unexpected ${kind} (not in skip allow-list)` });
        }
      } else {
        count(out, scope, "FAIL");
        out.details.push({ id, status: "FAIL", scope, note: `unknown test status "${status}"` });
      }
    }
  }
  if (total === 0) return notRun(suite, "0 tests collected");
  const failed = Object.values(out.byScope).reduce((n, b) => n + (b?.FAIL ?? 0), 0);
  if (failed > 0) {
    out.status = "FAIL";
    out.reason = `${failed} failing / unexpected`;
  } else if (suite.exitCode !== null && suite.exitCode !== 0) {
    out.status = "FAIL";
    out.reason = `runner exit code ${suite.exitCode} with no failing test reported`;
  } else {
    out.reason = `${total} tests`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model-eval baseline gate

export type BaselineExpect = "pass" | "known-fail" | "flaky" | "measurement";

export interface BaselineCase {
  expect: BaselineExpect;
  reason?: string;
  /** Measured evidence: run ids / dates / rates (e.g. "9/10 on 2026-11-06 G7"). */
  evidence?: string;
  /** ISO date; after it the exception is ignored and the case gates as "pass". */
  reviewBy?: string;
  /** flaky only: required passes in a 3-run re-check. */
  minPassesOf3?: number;
}

export interface BaselineSuite {
  scope: SuiteScope;
  /** Cases that must always pass; may not carry an exception. */
  criticalCaseIds?: string[];
  cases: Record<string, BaselineCase>;
}

export interface ModelEvalBaseline {
  version: number;
  suites: Record<string, BaselineSuite>;
}

/** Problems that make a baseline unusable (an exception without evidence). */
export function validateBaseline(baseline: ModelEvalBaseline): string[] {
  const problems: string[] = [];
  for (const [suiteId, suite] of Object.entries(baseline.suites ?? {})) {
    const critical = new Set(suite.criticalCaseIds ?? []);
    for (const [caseId, entry] of Object.entries(suite.cases ?? {})) {
      const where = `${suiteId}/${caseId}`;
      if (!["pass", "known-fail", "flaky", "measurement"].includes(entry.expect)) {
        problems.push(`${where}: unknown expect "${entry.expect}"`);
        continue;
      }
      if (entry.expect === "pass") continue;
      if (critical.has(caseId)) problems.push(`${where}: critical case cannot carry a ${entry.expect} exception`);
      if (!entry.reason?.trim()) problems.push(`${where}: ${entry.expect} needs a reason`);
      if (!entry.evidence?.trim()) problems.push(`${where}: ${entry.expect} needs measured evidence`);
      if (!entry.reviewBy || !Number.isFinite(Date.parse(entry.reviewBy))) {
        problems.push(`${where}: ${entry.expect} needs a valid reviewBy date`);
      }
      if (entry.expect === "flaky") {
        const k = entry.minPassesOf3;
        if (typeof k !== "number" || k < 1 || k > 3) problems.push(`${where}: flaky needs minPassesOf3 in 1..3`);
      }
    }
  }
  return problems;
}

export interface ModelEvalResultJson {
  generatedAt?: string;
  results?: Array<{ id: string; ok: boolean; failures?: string[] }>;
}

/** Stability JSON written by MODEL_EVAL_REPEAT runs (see stability.ts). */
export interface StabilityJson {
  rows?: Array<{ id: string; runs: number; passed: number }>;
}

export function evaluateModelEval(
  suite: ManifestSuite,
  json: ModelEvalResultJson,
  baseline: BaselineSuite | undefined,
  now: Date,
  rerun?: StabilityJson | null,
): SuiteOutcome {
  const out = emptyOutcome(suite);
  const scope = suite.scope;
  if (suite.startedAt && json.generatedAt) {
    const started = Date.parse(suite.startedAt);
    if (Number.isFinite(started) && Date.parse(json.generatedAt) < started - 2000) {
      return notRun(suite, "eval report is older than this run (stale)");
    }
  }
  const results = json.results ?? [];
  if (results.length === 0) return notRun(suite, "0 cases in eval report");
  const critical = new Set(baseline?.criticalCaseIds ?? []);
  const rerunById = new Map((rerun?.rows ?? []).map((r) => [r.id, r]));
  for (const r of results) {
    const entry = baseline?.cases?.[r.id];
    const firstFailure = (r.failures?.[0] ?? "").split("\n")[0];
    const expired =
      entry && entry.expect !== "pass" && entry.reviewBy && Date.parse(entry.reviewBy) < now.getTime();
    const expect: BaselineExpect | "new" = !entry ? "new" : expired ? "pass" : entry.expect;
    const add = (status: CaseStatus, note?: string) => {
      count(out, scope, status);
      if (status !== "PASS") out.details.push({ id: r.id, status, scope, ...(note ? { note } : {}) });
    };
    if (expect === "measurement") {
      add("MEASUREMENT", `${r.ok ? "passed" : "failed"} — ${entry!.reason}`);
      continue;
    }
    // A flaky case with re-run evidence is judged by the re-run (≥ k of 3),
    // never by whichever single run happened to be last.
    const flakyRerun = expect === "flaky" ? rerunById.get(r.id) : undefined;
    if (flakyRerun) {
      const need = entry!.minPassesOf3 ?? 3;
      if (flakyRerun.runs >= 3 && flakyRerun.passed >= need) {
        add("FLAKY_OK", `re-run ${flakyRerun.passed}/${flakyRerun.runs} ≥ ${need}/3 — ${entry!.reason}`);
      } else {
        add("FAIL", `flaky re-run ${flakyRerun.passed}/${flakyRerun.runs} < ${need}/3 — regression`);
      }
      continue;
    }
    if (r.ok) {
      if (expect === "new") add("NEW_PASS", "not in baseline — review and add");
      else if (expect === "known-fail") add("IMPROVED", "known-fail now passes — review baseline");
      else add("PASS");
      continue;
    }
    // Failing case.
    if (critical.has(r.id)) {
      add("FAIL", `critical case failed: ${firstFailure}`);
    } else if (expect === "known-fail") {
      add("KNOWN_FAIL", `${entry!.reason} [evidence: ${entry!.evidence}; review by ${entry!.reviewBy}]`);
    } else if (expect === "flaky") {
      const need = entry!.minPassesOf3 ?? 3;
      add("FAIL", `flaky case failed and was not re-verified (needs ≥${need}/3 in a re-run)`);
    } else if (expect === "new") {
      add("FAIL", `not in baseline and failing: ${firstFailure}`);
    } else {
      add("FAIL", `${expired ? "exception expired → gates as pass; " : ""}regression: ${firstFailure}`);
    }
  }
  const failed = out.byScope[scope]?.FAIL ?? 0;
  if (failed > 0) {
    out.status = "FAIL";
    out.reason = `${failed} regression(s) vs baseline`;
  } else {
    out.reason = `${results.length} cases vs baseline`;
  }
  return out;
}

/** Flaky failures the orchestrator should re-run (3×) before the final summary. */
export function flakyCasesToRerun(json: ModelEvalResultJson, baseline: BaselineSuite | undefined, now: Date): string[] {
  return (json.results ?? [])
    .filter((r) => !r.ok)
    .filter((r) => {
      const e = baseline?.cases?.[r.id];
      if (!e || e.expect !== "flaky") return false;
      return !(e.reviewBy && Date.parse(e.reviewBy) < now.getTime());
    })
    .map((r) => r.id);
}

// ---------------------------------------------------------------------------
// TypeScript diagnostics baseline

/**
 * Normalize tsc output to one line per diagnostic, without line/column numbers
 * (they move with unrelated edits). Continuation lines are joined to their
 * diagnostic so a changed detail is a different diagnostic.
 */
export function normalizeTscOutput(text: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const m = raw.match(/^(.+?)\(\d+,\d+\): (error TS\d+: .*)$/);
    if (m) {
      if (current !== null) out.push(current);
      current = `${m[1]!.replace(/\\/g, "/").trim()}: ${m[2]!.trim()}`;
    } else if (current !== null && /^\s+\S/.test(raw)) {
      current += ` ⏎ ${raw.trim()}`;
    } else if (/^error TS\d+:/.test(raw.trim())) {
      if (current !== null) out.push(current);
      current = raw.trim();
    }
  }
  if (current !== null) out.push(current);
  return out.sort();
}

/** Multiset diff: diagnostics present more often now than in the baseline. */
export function diffTsc(baseline: string[], current: string[]): { added: string[]; removed: string[] } {
  const counts = new Map<string, number>();
  for (const d of baseline) counts.set(d, (counts.get(d) ?? 0) + 1);
  const added: string[] = [];
  for (const d of current) {
    const n = counts.get(d) ?? 0;
    if (n > 0) counts.set(d, n - 1);
    else added.push(d);
  }
  const removed: string[] = [];
  for (const [d, n] of counts) for (let i = 0; i < n; i += 1) removed.push(d);
  return { added, removed: removed.sort() };
}

export function evaluateTsc(
  suite: ManifestSuite,
  currentText: string,
  baselineLines: string[] | null,
): SuiteOutcome {
  const out = emptyOutcome(suite);
  const current = normalizeTscOutput(currentText);
  if (baselineLines === null) {
    out.status = "FAIL";
    out.reason = "no committed tsc baseline — generate it explicitly (-WriteTscBaseline) and review";
    return out;
  }
  if (current.length === 0 && suite.exitCode !== 0 && suite.exitCode !== null) {
    out.status = "FAIL";
    out.reason = `tsc exit code ${suite.exitCode} but no diagnostics parsed (crash?)`;
    return out;
  }
  const { added, removed } = diffTsc(baselineLines, current);
  for (const d of added) {
    count(out, "static", "FAIL");
    out.details.push({ id: d, status: "FAIL", scope: "static", note: "new diagnostic" });
  }
  if (added.length > 0) {
    out.status = "FAIL";
    out.reason = `${added.length} new diagnostic(s) (baseline ${baselineLines.length}, now ${current.length})`;
  } else {
    out.reason = `no new diagnostics (baseline ${baselineLines.length}, now ${current.length}${removed.length ? `, ${removed.length} fixed — baseline can shrink by explicit update` : ""})`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run verdict + rendering

export function summarizeRun(profile: string, outcomes: SuiteOutcome[], problems: string[] = []): RunSummary {
  const blocking = outcomes.filter((o) => o.requested && o.status !== "PASS");
  const ok = blocking.length === 0 && problems.length === 0;
  return { profile, ok, exitCode: ok ? 0 : 1, suites: outcomes, problems };
}

export function formatSummary(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push(`==================== REGRESSION SUMMARY (profile: ${summary.profile}) ====================`);
  for (const s of summary.suites) {
    lines.push(`${s.status.padEnd(8)} ${s.id.padEnd(26)} ${s.requested ? "" : "(not requested) "}${s.reason}`);
    for (const [scope, counts] of Object.entries(s.byScope)) {
      const parts = Object.entries(counts!)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ${n}`);
      if (parts.length) lines.push(`         · ${SCOPE_LABEL[scope as SuiteScope]}: ${parts.join(", ")}`);
    }
    for (const d of s.details.filter((x) => x.status !== "PASS")) {
      lines.push(`           ${d.status.padEnd(11)} ${d.id}${d.note ? ` — ${d.note}` : ""}`);
    }
  }
  for (const p of summary.problems) lines.push(`PROBLEM  ${p}`);
  lines.push(summary.ok ? "RESULT: PASS" : "RESULT: FAIL");
  return lines.join("\n");
}
