/**
 * Batch A orchestration — MODEL (thin, no apply) + fingerprints.
 * Does not import an LLM client; LIVE wiring stays out of Steps 0–4.
 *
 * Default instructions share LIVE_FULL fixtures (includeMichal: false) via
 * buildDefaultEvalFixtures + buildLucyModelEvalInstructions. Intentionally does
 * NOT call resolveEvalPrompt — WORKEE_EVAL_PROMPT_SOURCE=file|employee must not
 * change Batch A fingerprints or offline MODEL scoring.
 */
import { parseLlmMetadata, type LlmMetadata } from "@workee/shared";
import { buildLucyModelEvalInstructions } from "../services/chat.service.js";
import {
  evaluateConstraints,
  type ModelEvalCaseResult,
} from "./constraints.js";
import {
  batchAModelCaseToEvalCase,
  defaultBatchASuitePath,
  loadBatchASuite,
  type BatchASuite,
  type BatchASuiteCase,
} from "./corpus.js";
import { buildDefaultEvalFixtures } from "./eval-prompt-source.js";
import {
  buildEvalFingerprint,
  type EvalFingerprint,
} from "./fingerprint.js";
import { bridgeListTypeAliasesForParse } from "./run-model-apply.js";

/**
 * Exact thin instructions string used for Batch A MODEL fingerprints.
 * Fixture parity: LIVE_FULL default (no מיכל). Not LIVE_MODEL (has מיכל).
 */
export function buildBatchAThinInstructions(speaker = "טל"): string {
  const { employees, worker } = buildDefaultEvalFixtures(speaker, {
    includeMichal: false,
  });
  return buildLucyModelEvalInstructions({ employees, speaker, worker });
}

export function buildBatchAFingerprint(options?: {
  speaker?: string;
  suitePath?: string;
  now?: Date;
}): EvalFingerprint {
  const instructions = buildBatchAThinInstructions(options?.speaker ?? "טל");
  return buildEvalFingerprint({
    instructions,
    suitePath: options?.suitePath ?? defaultBatchASuitePath(),
    now: options?.now,
  });
}

export interface BatchAModelOfflineResult extends ModelEvalCaseResult {
  id: string;
  track: "MODEL";
  contract?: string;
  variant?: string;
  utterance: string;
  response: string;
  metadata: LlmMetadata;
}

/**
 * Offline MODEL turn: constraints only against a stub/model-supplied ACTION.
 * Never applies; never calls an LLM client.
 */
export function runBatchAModelCaseOffline(
  row: BatchASuiteCase,
  proposed: { metadata: unknown; response?: string },
): BatchAModelOfflineResult {
  if (row.track !== "MODEL") {
    return {
      id: row.id,
      track: "MODEL",
      contract: row.contract,
      variant: row.variant,
      utterance: row.turns[0]?.utterance ?? "",
      response: "",
      metadata: parseLlmMetadata({}),
      ok: false,
      failures: [`expected MODEL track, got ${row.track}`],
    };
  }
  const evalCase = batchAModelCaseToEvalCase(row);
  const metadata = parseLlmMetadata(
    bridgeListTypeAliasesForParse(proposed.metadata),
  );
  const response = proposed.response ?? "";
  const checked = evaluateConstraints(
    evalCase.constraints,
    metadata,
    response,
  );
  return {
    id: row.id,
    track: "MODEL",
    contract: row.contract,
    variant: row.variant,
    utterance: evalCase.utterance,
    response,
    metadata,
    ...checked,
  };
}

export interface BatchAOfflineSummary {
  track: "MODEL";
  evalPath: "thin";
  productionParity: false;
  fingerprint: EvalFingerprint;
  total: number;
  passed: number;
  failed: number;
  results: BatchAModelOfflineResult[];
  /** Pass and fail preserved — no soft passRate hiding. */
  ok: boolean;
}

export function summarizeBatchAModelOffline(
  results: BatchAModelOfflineResult[],
  fingerprint: EvalFingerprint,
): BatchAOfflineSummary {
  const passed = results.filter((row) => row.ok).length;
  const failed = results.length - passed;
  return {
    track: "MODEL",
    evalPath: "thin",
    productionParity: false,
    fingerprint: {
      ...fingerprint,
      evalPath: "thin",
      productionParity: false,
    },
    total: results.length,
    passed,
    failed,
    results,
    ok: failed === 0,
  };
}

export function loadBatchAModelCases(
  suite: BatchASuite = loadBatchASuite(),
): BatchASuiteCase[] {
  return suite.cases.filter((row) => row.track === "MODEL");
}

export function loadBatchAModelApplyCases(
  suite: BatchASuite = loadBatchASuite(),
): BatchASuiteCase[] {
  return suite.cases.filter((row) => row.track === "MODEL_APPLY");
}
