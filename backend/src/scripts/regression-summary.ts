/**
 * Q3 regression summary CLI — called by scripts/run-regression.ps1.
 *
 *   npx tsx src/scripts/regression-summary.ts summarize <manifest.json> <summary-out.json>
 *   npx tsx src/scripts/regression-summary.ts rerun-list <manifest.json> <suiteId>
 *   npx tsx src/scripts/regression-summary.ts write-tsc-baseline <tsc-output.txt>
 *
 * summarize: prints the per-suite / per-scope table, writes the JSON summary and
 * exits 1 unless every requested suite is PASS (NOT_RUN and FAIL both fail).
 * write-tsc-baseline: the ONLY way the tsc baseline changes — explicit, reviewed.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateModelEval,
  evaluateTsc,
  evaluateVitest,
  flakyCasesToRerun,
  formatSummary,
  normalizeTscOutput,
  precheck,
  summarizeRun,
  validateBaseline,
  type ManifestSuite,
  type ModelEvalBaseline,
  type RunManifest,
  type SkipAllowEntry,
  type SuiteOutcome,
} from "../eval/regression-summary.js";

const REPO = resolve(import.meta.dirname, "../../..");
const BASELINE_DIR = resolve(REPO, "docs/qa/baselines");
const MODEL_BASELINE = resolve(BASELINE_DIR, "model-eval-baseline.json");
const SKIP_ALLOWLIST = resolve(BASELINE_DIR, "test-skip-allowlist.json");
const TSC_BASELINE = resolve(BASELINE_DIR, "tsc-diagnostics.txt");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as T;
}

function fileInfo(path: string | null): { exists: boolean; mtimeMs: number | null } {
  if (!path || !existsSync(path)) return { exists: false, mtimeMs: null };
  return { exists: true, mtimeMs: statSync(path).mtimeMs };
}

/** Reads a file that may have been written by PowerShell (UTF-16 LE). */
function readText(path: string): string {
  const buf = readFileSync(path);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  return buf.toString("utf8").replace(/^﻿/, "");
}

function evaluate(suite: ManifestSuite, baseline: ModelEvalBaseline, allowlist: SkipAllowEntry[], now: Date): SuiteOutcome {
  const pre = precheck(suite, fileInfo(suite.resultFile));
  if (pre) return pre;
  const file = suite.resultFile!;
  try {
    if (suite.kind === "vitest") return evaluateVitest(suite, readJson(file), allowlist);
    if (suite.kind === "model-eval") {
      const rerun = suite.rerunFile && existsSync(suite.rerunFile) ? readJson<{ rows?: [] }>(suite.rerunFile) : null;
      return evaluateModelEval(suite, readJson(file), baseline.suites[suite.baselineSuite ?? suite.id], now, rerun);
    }
    const tscBaseline = existsSync(TSC_BASELINE)
      ? readText(TSC_BASELINE).split("\n").map((l) => l.trim()).filter(Boolean)
      : null;
    return evaluateTsc(suite, readText(file), tscBaseline);
  } catch (error) {
    return {
      id: suite.id,
      kind: suite.kind,
      requested: suite.requested,
      status: "FAIL",
      reason: `result unreadable: ${(error as Error).message.split("\n")[0]}`,
      byScope: {},
      details: [],
    };
  }
}

function main(): number {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "write-tsc-baseline" && a) {
    const lines = normalizeTscOutput(readText(a));
    writeFileSync(TSC_BASELINE, `${lines.join("\n")}\n`, "utf8");
    console.log(`tsc baseline written: ${lines.length} diagnostics → ${TSC_BASELINE} (review the diff before committing)`);
    return 0;
  }
  const baseline = readJson<ModelEvalBaseline>(MODEL_BASELINE);
  const allowlist = existsSync(SKIP_ALLOWLIST) ? readJson<{ entries: SkipAllowEntry[] }>(SKIP_ALLOWLIST).entries : [];
  const now = new Date();
  if (cmd === "rerun-list" && a && b) {
    const manifest = readJson<RunManifest>(a);
    const suite = manifest.suites.find((s) => s.id === b);
    if (!suite?.resultFile || !existsSync(suite.resultFile)) return 0;
    console.log(flakyCasesToRerun(readJson(suite.resultFile), baseline.suites[suite.baselineSuite ?? suite.id], now).join(","));
    return 0;
  }
  if (cmd !== "summarize" || !a || !b) {
    console.error("usage: summarize <manifest> <out> | rerun-list <manifest> <suiteId> | write-tsc-baseline <tsc.txt>");
    return 2;
  }
  const manifest = readJson<RunManifest>(a);
  const problems = validateBaseline(baseline).map((p) => `invalid baseline: ${p}`);
  const outcomes = manifest.suites.map((suite) => evaluate(suite, baseline, allowlist, now));
  const summary = summarizeRun(manifest.profile, outcomes, problems);
  writeFileSync(b, JSON.stringify(summary, null, 2), "utf8");
  console.log(formatSummary(summary));
  return summary.exitCode;
}

process.exit(main());
