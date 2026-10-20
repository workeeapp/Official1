/**
 * Phase 4 multi-turn — offline stub wire (no LLM, no Prisma apply).
 * Proves each turn's constraints are satisfiable and the corpus loads.
 */
import { describe, expect, it } from "vitest";
import {
  filterCasesByTags,
  loadModelEvalCorpus,
  loadModelEvalMultiTurnCorpus,
  parseModelEvalTags,
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

  it("tags filter selects topic subsets (and all/empty means no filter)", () => {
    expect(parseModelEvalTags("")).toBeNull();
    expect(parseModelEvalTags("all")).toBeNull();
    expect(parseModelEvalTags("reminders, shopping")).toEqual([
      "reminders",
      "shopping",
    ]);
    const single = loadModelEvalCorpus();
    const mt = loadModelEvalMultiTurnCorpus();
    expect(single.cases.every((c) => (c.tags?.length ?? 0) > 0)).toBe(true);
    expect(mt.cases.every((c) => c.tags?.includes("multi-turn"))).toBe(true);
    const rem = filterCasesByTags(single.cases, ["reminders"]);
    expect(rem.length).toBeGreaterThan(0);
    expect(rem.every((c) => c.tags?.includes("reminders"))).toBe(true);
    // OR semantics: tags=[reminders] keeps reminder-topic cases only.
    const mtRem = filterCasesByTags(mt.cases, ["reminders"]);
    expect(mtRem.length).toBeGreaterThan(0);
    expect(mtRem.every((c) => c.tags?.includes("reminders"))).toBe(true);
    const mtOnly = filterCasesByTags(mt.cases, ["multi-turn"]);
    expect(mtOnly.length).toBe(mt.cases.length);
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
