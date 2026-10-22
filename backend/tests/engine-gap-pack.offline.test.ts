/**
 * ENGINE gap pack — production apply + stateAfter (offline).
 * Complements Gate 1 regression-suite + Workflow W1–W4.
 * Requires DATABASE_URL === WORKEE_APPROVED_TEST_DATABASE_URL (workee_test).
 * No OpenAI / LIVE / MODEL_APPLY.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRegressionSuite } from "../src/eval/corpus.js";
import { runMultiTurnOffline } from "../src/eval/run-multi-turn.js";

/** backend/tests → repo root is ../.. (same as gate1b1 / llm-config tests). */
function defaultEngineGapSuitePath(
  repoRoot = resolve(import.meta.dirname, "../.."),
): string {
  return resolve(repoRoot, "docs/qa/engine-gap-suite.json");
}

describe("ENGINE gap pack (offline apply + stateAfter)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads engine-gap-suite.json with 18 ENGINE cases", () => {
    const path = defaultEngineGapSuitePath();
    expect(existsSync(path), path).toBe(true);
    // Path must stay under this repo's docs/qa (not Desktop or other parents).
    expect(path.replace(/\\/g, "/")).toMatch(
      /Official1\/docs\/qa\/engine-gap-suite\.json$/,
    );
    const suite = loadRegressionSuite(path);
    expect(suite.speaker).toBe("טל");
    expect(suite.cases).toHaveLength(18);
    expect(suite.cases.every((row) => row.track === "ENGINE")).toBe(true);
    expect(suite.criticalCaseIds?.length).toBeGreaterThanOrEqual(8);
    for (const id of suite.criticalCaseIds ?? []) {
      expect(suite.cases.some((row) => row.id === id)).toBe(true);
    }
  });

  describe("gap cases", () => {
    const suite = loadRegressionSuite(defaultEngineGapSuitePath());

    for (const row of suite.cases) {
      it(`ENGINE ${row.id}`, async () => {
        const result = await runMultiTurnOffline(row, {
          speaker: suite.speaker,
          partners: ["עמית", "מיכל"],
        });
        expect(result.track).toBe("ENGINE");
        if (!result.ok) {
          expect.fail(
            `${row.id} failed:\n${result.failures.map((f) => ` - ${f}`).join("\n")}`,
          );
        }
        expect(result.ok).toBe(true);
        expect(result.turns.length).toBe(row.turns.length);
        for (const turn of result.turns) {
          expect(turn.ok).toBe(true);
          expect(turn.appliedViaProduction).toBe(true);
          expect(turn.facts).toContain("EMPLOYEE_SAVED_DATA");
        }
      });
    }
  });
});
