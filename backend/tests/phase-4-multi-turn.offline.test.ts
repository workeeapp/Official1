/**
 * Phase 4 multi-turn — offline stub wire (no LLM, no Prisma apply).
 * Proves each turn's constraints are satisfiable and the corpus loads.
 */
import { describe, expect, it } from "vitest";
import {
  loadModelEvalMultiTurnCorpus,
  defaultMultiTurnCorpusPath,
} from "../src/eval/corpus.js";
import {
  evaluateOfflineModelProposal,
  offlineStubForConstraints,
} from "../src/eval/offline-stub.js";
import { existsSync } from "node:fs";

describe("Phase 4 multi-turn corpus (offline wire)", () => {
  it("loads ≥2-turn cases with critical ids", () => {
    const path = defaultMultiTurnCorpusPath();
    expect(existsSync(path), path).toBe(true);
    const corpus = loadModelEvalMultiTurnCorpus(path);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(5);
    expect(corpus.cases.every((c) => c.turns.length >= 2)).toBe(true);
    for (const id of corpus.criticalCaseIds ?? []) {
      expect(corpus.cases.some((c) => c.id === id), id).toBe(true);
    }
  });

  it("every turn passes offline stub constraints", () => {
    const corpus = loadModelEvalMultiTurnCorpus();
    const failures: string[] = [];
    for (const row of corpus.cases) {
      for (let i = 0; i < row.turns.length; i += 1) {
        const turn = row.turns[i]!;
        const stub = offlineStubForConstraints(turn.constraints);
        const checked = evaluateOfflineModelProposal({
          constraints: turn.constraints,
          metadata: stub.metadata,
          response: stub.response,
        });
        if (!checked.ok) {
          failures.push(
            `${row.id} turn ${i}: ${checked.failures.join("; ")}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
