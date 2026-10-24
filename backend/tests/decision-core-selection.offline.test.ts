/**
 * Offline: decision-core tag selection + proof-kind labeling.
 * Does not call OpenAI.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { filterCasesByTags } from "../src/eval/corpus.js";

const qa = resolve(import.meta.dirname, "../../docs/qa");

function loadCases(name: string): Array<{ id: string; tags?: string[] }> {
  const raw = JSON.parse(readFileSync(resolve(qa, name), "utf8")) as {
    cases: Array<{ id: string; tags?: string[] }>;
  };
  return raw.cases;
}

describe("decision-core selection (offline)", () => {
  it("selects the decision-core gate across ST / MT / attachment corpora", () => {
    const st = filterCasesByTags(loadCases("phase-4-corpus.json"), [
      "decision-core",
    ]);
    const mt = filterCasesByTags(loadCases("phase-4-multi-turn-corpus.json"), [
      "decision-core",
    ]);
    const att = filterCasesByTags(loadCases("attachment-intent-corpus.json"), [
      "decision-core",
    ]);
    // P0 compact 26 + P1 gap 4 = 30
    expect(st).toHaveLength(16);
    expect(mt).toHaveLength(9);
    expect(att).toHaveLength(5);
    expect(st.length + mt.length + att.length).toBe(30);
    expect(st.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        "dm-update-existing-task",
        "dm-multi-shop-and-filing",
      ]),
    );
    expect(mt.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        "dm-intervening-reminder-draft",
        "dm-soft-offer-accept-mt",
      ]),
    );
  });

  it("documents proof kinds: LIVE tracks = actual-model; pack suites = stub/offline", () => {
    // Contract labels — not runtime execution.
    const liveProof = {
      track: "LIVE_MODEL | LIVE_MODEL_MT | attachment-intent",
      proofKind: "actual-model",
      productionApply: false,
      proves: "NL → ACTION (+ optional response ask/forbid)",
      doesNotProve: "engine apply, DB, WA, Lucy2 DB prompt",
    };
    const stubProof = {
      track: "domain pack MODEL / MODEL_APPLY / ENGINE",
      proofKind: "stub-or-fixture",
      proves: "ACTION contract / apply when fixture-fed",
      doesNotProve: "live model decision quality",
    };
    expect(liveProof.proofKind).toBe("actual-model");
    expect(stubProof.proofKind).toBe("stub-or-fixture");
    expect(liveProof.productionApply).toBe(false);
  });
});
