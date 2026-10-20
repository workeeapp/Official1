import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadModelEvalCorpus } from "../src/eval/corpus.js";
import { runModelEvalCorpus } from "../src/eval/run-case.js";

/**
 * Phase 4 live Lucy eval — not part of merge CI.
 * Requires OPENAI_API_KEY and explicit opt-in (MODEL_EVAL_LIVE=1) for local runs.
 * CI sets CI=true (workflow_dispatch / nightly). Run:
 *   MODEL_EVAL_LIVE=1 npm run test:model-eval -w backend
 * Optional: MODEL_EVAL_CASES=id1,id2
 * Scores model metadata only — no production Prisma apply / no WhatsApp.
 */
describe("Phase 4 model eval (live Lucy)", () => {
  it("meets soft pass-rate on the seeded corpus", async () => {
    const liveEnabled =
      process.env.MODEL_EVAL_LIVE === "1" || process.env.CI === "true";
    if (!liveEnabled) {
      throw new Error(
        "Refusing Phase 4 LIVE: set MODEL_EVAL_LIVE=1 locally (or run under CI=true)",
      );
    }
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
          suite: "phase-4-corpus",
          track: "LIVE",
          promptSource: "LLM.config.json (worktree via loadLlmConfig)",
          evalPath: "model-output-constraints-only",
          productionApply: false,
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          passRate: summary.passRate,
          requiredPassRate: summary.requiredPassRate,
          softOk: summary.softOk,
          criticalOk: summary.criticalOk,
          criticalFailed: summary.criticalFailed,
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

    // Soft pass-rate AND critical deletion-safety gate.
    expect(
      summary.ok,
      [
        !summary.softOk
          ? `passRate ${summary.passRate.toFixed(2)} < required ${summary.requiredPassRate}`
          : null,
        !summary.criticalOk
          ? `critical failed: ${summary.criticalFailed.join(", ")}`
          : null,
        `failed: ${summary.results
          .filter((row) => !row.ok)
          .map((row) => `${row.id}[${row.failures.join("|")}]`)
          .join(", ")}`,
      ]
        .filter(Boolean)
        .join("; "),
    ).toBe(true);
  }, 600_000);
});
