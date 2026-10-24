/**
 * Durable decision-core gate artifact helpers.
 * Full tagged runs may write docs/qa/decision-core-last-eval.json.
 * Partial / filtered runs must not overwrite that file as a "complete" gate.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { filterCasesByTags } from "./corpus.js";

export const DECISION_CORE_TAG = "decision-core";
export const DECISION_CORE_PROOF_KIND = "actual-model" as const;

export type DecisionCoreSuiteSlice = {
  suite: string;
  track: string;
  caseIds: string[];
  results: unknown[];
};

export type DecisionCoreLastEvalPayload = {
  generatedAt: string;
  suite: "decision-core-gate";
  proofKind: typeof DECISION_CORE_PROOF_KIND;
  productionApply: false;
  evalPath: string;
  fullGate: true;
  expectedCaseCount: number;
  executedCaseCount: number;
  expectedCaseIds: string[];
  executedCaseIds: string[];
  model?: string;
  temperature?: number;
  reasoningEffort?: string | null;
  promptSource?: string;
  instructionsSha256?: string;
  envelopeMode?: string;
  attachLucyRuntimeEngine?: boolean;
  slices: DecisionCoreSuiteSlice[];
  total: number;
  passed: number;
  failed: number;
  ok: boolean;
};

export function defaultDecisionCoreLastEvalPath(
  repoRoot = resolve(import.meta.dirname, "../../.."),
): string {
  return resolve(repoRoot, "docs/qa/decision-core-last-eval.json");
}

function loadTaggedIds(corpusPath: string): string[] {
  const raw = JSON.parse(readFileSync(corpusPath, "utf8")) as {
    cases: Array<{ id: string; tags?: string[] }>;
  };
  return filterCasesByTags(raw.cases, [DECISION_CORE_TAG]).map((row) => row.id);
}

/** All decision-core ids across ST / MT / attachment corpora (sorted). */
export function listExpectedDecisionCoreIds(
  repoRoot = resolve(import.meta.dirname, "../../.."),
): string[] {
  const qa = resolve(repoRoot, "docs/qa");
  const ids = [
    ...loadTaggedIds(resolve(qa, "phase-4-corpus.json")),
    ...loadTaggedIds(resolve(qa, "phase-4-multi-turn-corpus.json")),
    ...loadTaggedIds(resolve(qa, "attachment-intent-corpus.json")),
  ];
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export function sameIdSet(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort((x, y) => x.localeCompare(y));
  const e = [...expected].sort((x, y) => x.localeCompare(y));
  return a.every((id, i) => id === e[i]);
}

/**
 * Write the durable full-gate artifact only when:
 * - no MODEL_EVAL_CASES-style filter was applied, and
 * - executed ids exactly match the expected decision-core set.
 */
export function shouldWriteDecisionCoreFullArtifact(input: {
  executedCaseIds: string[];
  expectedCaseIds?: string[];
  caseIdsFilter?: string[] | null;
}): boolean {
  if (input.caseIdsFilter && input.caseIdsFilter.length > 0) {
    return false;
  }
  const expected = input.expectedCaseIds ?? listExpectedDecisionCoreIds();
  return sameIdSet(input.executedCaseIds, expected);
}

export function buildDecisionCoreLastEvalPayload(input: {
  generatedAt?: string;
  expectedCaseIds: string[];
  executedCaseIds: string[];
  slices: DecisionCoreSuiteSlice[];
  model?: string;
  temperature?: number;
  reasoningEffort?: string | null;
  promptSource?: string;
  instructionsSha256?: string;
  envelopeMode?: string;
  attachLucyRuntimeEngine?: boolean;
  passed: number;
  failed: number;
  ok: boolean;
  evalPath?: string;
}): DecisionCoreLastEvalPayload {
  const expected = [...input.expectedCaseIds].sort((a, b) =>
    a.localeCompare(b),
  );
  const executed = [...input.executedCaseIds].sort((a, b) =>
    a.localeCompare(b),
  );
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    suite: "decision-core-gate",
    proofKind: DECISION_CORE_PROOF_KIND,
    productionApply: false,
    evalPath:
      input.evalPath ??
      "model-output-constraints-only+attachment-fixture-context",
    fullGate: true,
    expectedCaseCount: expected.length,
    executedCaseCount: executed.length,
    expectedCaseIds: expected,
    executedCaseIds: executed,
    model: input.model,
    temperature: input.temperature,
    reasoningEffort: input.reasoningEffort ?? null,
    promptSource: input.promptSource,
    instructionsSha256: input.instructionsSha256,
    envelopeMode: input.envelopeMode,
    attachLucyRuntimeEngine: input.attachLucyRuntimeEngine,
    slices: input.slices,
    total: executed.length,
    passed: input.passed,
    failed: input.failed,
    ok: input.ok,
  };
}

export function writeDecisionCoreLastEval(
  payload: DecisionCoreLastEvalPayload,
  path = defaultDecisionCoreLastEvalPath(),
): { wrote: true; path: string } | { wrote: false; reason: string } {
  if (!payload.fullGate) {
    return { wrote: false, reason: "payload.fullGate is false" };
  }
  if (
    !shouldWriteDecisionCoreFullArtifact({
      executedCaseIds: payload.executedCaseIds,
      expectedCaseIds: payload.expectedCaseIds,
      caseIdsFilter: null,
    })
  ) {
    return {
      wrote: false,
      reason: "executedCaseIds do not match expected decision-core set",
    };
  }
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { wrote: true, path };
}

/**
 * Attempt to write the durable artifact. Partial runs return wrote:false
 * without touching the file.
 */
export function maybeWriteDecisionCoreFullArtifact(input: {
  executedCaseIds: string[];
  caseIdsFilter?: string[] | null;
  path?: string;
  expectedCaseIds?: string[];
  slices: DecisionCoreSuiteSlice[];
  passed: number;
  failed: number;
  ok: boolean;
  generatedAt?: string;
  evalPath?: string;
  model?: string;
  temperature?: number;
  reasoningEffort?: string | null;
  promptSource?: string;
  instructionsSha256?: string;
  envelopeMode?: string;
  attachLucyRuntimeEngine?: boolean;
}): { wrote: boolean; path?: string; reason?: string } {
  const expected = input.expectedCaseIds ?? listExpectedDecisionCoreIds();
  if (
    !shouldWriteDecisionCoreFullArtifact({
      executedCaseIds: input.executedCaseIds,
      expectedCaseIds: expected,
      caseIdsFilter: input.caseIdsFilter,
    })
  ) {
    return {
      wrote: false,
      reason:
        input.caseIdsFilter?.length
          ? "caseIdsFilter present — partial run"
          : "executed set is not the full decision-core gate",
    };
  }
  const payload = buildDecisionCoreLastEvalPayload({
    generatedAt: input.generatedAt,
    expectedCaseIds: expected,
    executedCaseIds: input.executedCaseIds,
    slices: input.slices,
    model: input.model,
    temperature: input.temperature,
    reasoningEffort: input.reasoningEffort,
    promptSource: input.promptSource,
    instructionsSha256: input.instructionsSha256,
    envelopeMode: input.envelopeMode,
    attachLucyRuntimeEngine: input.attachLucyRuntimeEngine,
    passed: input.passed,
    failed: input.failed,
    ok: input.ok,
    evalPath: input.evalPath,
  });
  return writeDecisionCoreLastEval(
    payload,
    input.path ?? defaultDecisionCoreLastEvalPath(),
  );
}
