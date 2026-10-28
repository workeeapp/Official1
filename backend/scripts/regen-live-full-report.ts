/**
 * Rebuild docs/qa/live-full-last-report.{md,json} from last-eval.json + corpus
 * (no LLM re-run).
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLiveFullCorpus } from "../src/eval/corpus.js";
import {
  casesFromLiveFullResults,
  writeEvalReportArtifacts,
} from "../src/eval/human-report.js";
import { emptyLlmMetadata, parseLlmMetadata } from "@workee/shared";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evalPath = resolve(root, "docs/qa/live-full-last-eval.json");
const raw = JSON.parse(readFileSync(evalPath, "utf8")) as {
  generatedAt: string;
  suite: string;
  promptSource?: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  requiredPassRate: number;
  softOk: boolean;
  criticalOk: boolean;
  criticalFailed: string[];
  ok: boolean;
  results: Array<{
    id: string;
    ok: boolean;
    failures: string[];
    turns: Array<{
      index: number;
      utterance: string;
      response: string;
      ok: boolean;
      constraintFailures?: string[];
      stateFailures?: string[];
      appliedViaProduction?: boolean;
      metadata?: unknown;
    }>;
  }>;
};

const corpus = loadLiveFullCorpus();
const corpusById = new Map(corpus.cases.map((c) => [c.id, c]));
const results = raw.results.map((row) => ({
  id: row.id,
  ok: row.ok,
  failures: row.failures ?? [],
  turns: row.turns.map((t) => ({
    turnIndex: t.index,
    utterance: t.utterance,
    response: t.response,
    ok: t.ok,
    constraintFailures: t.constraintFailures ?? [],
    stateFailures: t.stateFailures ?? [],
    appliedViaProduction: Boolean(t.appliedViaProduction),
    metadata: t.metadata
      ? parseLlmMetadata(t.metadata)
      : emptyLlmMetadata(),
  })),
}));

const reportCases = casesFromLiveFullResults(results, corpusById);
writeEvalReportArtifacts(resolve(root, "docs/qa/live-full-last-report"), {
  track: "LIVE_FULL",
  suite: raw.suite ?? "live-full-corpus",
  generatedAt: raw.generatedAt,
  promptSource: raw.promptSource,
  productionApply: true,
  total: raw.total,
  passed: raw.passed,
  failed: raw.failed,
  passRate: raw.passRate,
  requiredPassRate: raw.requiredPassRate,
  softOk: raw.softOk,
  criticalOk: raw.criticalOk,
  criticalFailed: raw.criticalFailed ?? [],
  ok: raw.ok,
  cases: reportCases,
});

console.error(`Wrote live-full-last-report.md/json (${raw.failed} fails)`);
