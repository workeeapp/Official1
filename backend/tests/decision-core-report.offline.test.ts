/**
 * Offline: durable decision-core full-gate artifact vs partial overwrite guard.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDecisionCoreLastEvalPayload,
  listExpectedDecisionCoreIds,
  maybeWriteDecisionCoreFullArtifact,
  shouldWriteDecisionCoreFullArtifact,
  writeDecisionCoreLastEval,
} from "../src/eval/decision-core-report.js";

describe("decision-core durable artifact (offline)", () => {
  it("lists exactly the 30 tagged decision-core case ids", () => {
    const ids = listExpectedDecisionCoreIds();
    expect(ids).toHaveLength(30);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(ids).toEqual(
      expect.arrayContaining([
        "mt-multi-add-then-buy",
        "core-shopping-crud-mt",
        "att-no-intent",
      ]),
    );
  });

  it("allows write only when executed set is the full gate and unfiltered", () => {
    const expected = listExpectedDecisionCoreIds();
    expect(
      shouldWriteDecisionCoreFullArtifact({
        executedCaseIds: expected,
        expectedCaseIds: expected,
        caseIdsFilter: null,
      }),
    ).toBe(true);
    expect(
      shouldWriteDecisionCoreFullArtifact({
        executedCaseIds: expected,
        expectedCaseIds: expected,
        caseIdsFilter: [],
      }),
    ).toBe(true);
    expect(
      shouldWriteDecisionCoreFullArtifact({
        executedCaseIds: expected.slice(0, 5),
        expectedCaseIds: expected,
        caseIdsFilter: null,
      }),
    ).toBe(false);
    expect(
      shouldWriteDecisionCoreFullArtifact({
        executedCaseIds: expected,
        expectedCaseIds: expected,
        caseIdsFilter: ["mt-multi-add-then-buy"],
      }),
    ).toBe(false);
  });

  it("writes full-gate artifact and refuses to overwrite with a partial run", () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-core-artifact-"));
    const path = join(dir, "decision-core-last-eval.json");
    const expected = listExpectedDecisionCoreIds();

    const full = maybeWriteDecisionCoreFullArtifact({
      path,
      executedCaseIds: expected,
      caseIdsFilter: null,
      slices: [
        {
          suite: "phase-4-corpus",
          track: "LIVE_MODEL",
          caseIds: expected.slice(0, 16),
          results: expected.slice(0, 16).map((id) => ({ id, ok: true })),
        },
      ],
      passed: 30,
      failed: 0,
      ok: true,
      model: "test-model",
      promptSource: "lucy_eval",
      instructionsSha256: "abc",
      envelopeMode: "thin",
      attachLucyRuntimeEngine: true,
    });
    expect(full.wrote).toBe(true);
    expect(existsSync(path)).toBe(true);
    const before = readFileSync(path, "utf8");
    const parsed = JSON.parse(before) as {
      fullGate: boolean;
      suite: string;
      proofKind: string;
      productionApply: boolean;
      expectedCaseCount: number;
      executedCaseIds: string[];
      model: string;
    };
    expect(parsed.fullGate).toBe(true);
    expect(parsed.suite).toBe("decision-core-gate");
    expect(parsed.proofKind).toBe("actual-model");
    expect(parsed.productionApply).toBe(false);
    expect(parsed.expectedCaseCount).toBe(30);
    expect(parsed.executedCaseIds).toHaveLength(30);
    expect(parsed.model).toBe("test-model");

    const partial = maybeWriteDecisionCoreFullArtifact({
      path,
      executedCaseIds: expected.slice(0, 4),
      caseIdsFilter: expected.slice(0, 4),
      slices: [],
      passed: 4,
      failed: 0,
      ok: true,
      model: "stale-partial-should-not-land",
    });
    expect(partial.wrote).toBe(false);
    expect(partial.reason).toMatch(/partial|filter/i);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(path, "utf8")).model).toBe("test-model");
  });

  it("writeDecisionCoreLastEval rejects mismatched payload without touching an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-core-artifact-"));
    const path = join(dir, "decision-core-last-eval.json");
    const expected = listExpectedDecisionCoreIds();
    writeFileSync(path, '{"keep":true}\n', "utf8");

    const bad = buildDecisionCoreLastEvalPayload({
      expectedCaseIds: expected,
      executedCaseIds: expected.slice(0, 2),
      slices: [],
      passed: 2,
      failed: 0,
      ok: true,
    });
    // Force fullGate true with incomplete set — writer must still refuse.
    const result = writeDecisionCoreLastEval(bad, path);
    expect(result.wrote).toBe(false);
    expect(readFileSync(path, "utf8")).toBe('{"keep":true}\n');
  });
});
