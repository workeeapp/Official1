import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadModelEvalCorpus } from "../src/eval/corpus.js";
import { runModelEvalCorpus } from "../src/eval/run-case.js";

/**
 * Phase 4 live Lucy eval — not part of merge CI.
 * Requires OPENAI_API_KEY. Run:
 *   npm run test:model-eval -w backend
 */
describe("Phase 4 model eval (live Lucy)", () => {
  it("meets soft pass-rate on the seeded corpus", async () => {
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error("OPENAI_API_KEY is required for Phase 4 model eval");
    }

    const caseFilter = process.env.MODEL_EVAL_CASES?.split(",")
      .map((row) => row.trim())
      .filter(Boolean);
    const corpus = loadModelEvalCorpus();
    const summary = await runModelEvalCorpus(corpus, {
      caseIds: caseFilter?.length ? caseFilter : undefined,
    });

    const reportPath = resolve(
      import.meta.dirname,
      "../../docs/qa/phase-4-last-eval.json",
    );
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          passRate: summary.passRate,
          requiredPassRate: summary.requiredPassRate,
          ok: summary.ok,
          results: summary.results.map((row) => ({
            id: row.id,
            tag: row.tag,
            ok: row.ok,
            failures: row.failures,
            utterance: row.utterance,
            response: row.response,
            llmMs: row.llmMs,
            metadata: row.metadata,
          })),
        },
        null,
        2,
      ),
      "utf8",
    );

    // Soft gate: pass-rate, not every case.
    expect(
      summary.ok,
      `passRate ${summary.passRate.toFixed(2)} < required ${summary.requiredPassRate}; failed: ${summary.results
        .filter((row) => !row.ok)
        .map((row) => `${row.id}[${row.failures.join("|")}]`)
        .join(", ")}`,
    ).toBe(true);
  }, 600_000);
});
