import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadModelEvalCorpus,
  parseModelEvalTags,
} from "../src/eval/corpus.js";
import {
  casesFromModelEvalResults,
  writeEvalReportArtifacts,
} from "../src/eval/human-report.js";
import { runModelEvalCorpus } from "../src/eval/run-case.js";

/**
 * Phase 4 live Lucy eval — not part of merge CI.
 * Requires OPENAI_API_KEY and explicit opt-in (MODEL_EVAL_LIVE=1) for local runs.
 * CI sets CI=true (workflow_dispatch / nightly). Run:
 *   MODEL_EVAL_LIVE=1 npm run test:model-eval -w backend
 * Optional: MODEL_EVAL_CASES=id1,id2
 * Optional: MODEL_EVAL_TAGS=reminders,shopping,tasks,filing,directory,lists-safety,show,single-turn
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
    const tagsFilter = parseModelEvalTags();
    const summary = await runModelEvalCorpus(corpus, {
      caseIds: caseFilter?.length ? caseFilter : undefined,
    });

    const generatedAt = new Date().toISOString();
    const corpusById = new Map(corpus.cases.map((c) => [c.id, c]));
    const reportCases = casesFromModelEvalResults(summary.results, corpusById);

    const reportPath = resolve(
      import.meta.dirname,
      "../../docs/qa/phase-4-last-eval.json",
    );
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          generatedAt,
          suite: "phase-4-corpus",
          track: "LIVE_MODEL",
          promptSource: summary.prompt.promptSource,
          instructionsSha256: summary.prompt.instructionsSha256,
          envelopeMode: summary.prompt.envelopeMode,
          attachLucyRuntimeEngine: summary.prompt.attachLucyRuntimeEngine,
          model: summary.prompt.model,
          temperature: summary.prompt.temperature,
          reasoningEffort: summary.prompt.reasoningEffort,
          workerName: summary.prompt.workerName,
          workerProtected: summary.prompt.workerProtected,
          employeeId: summary.prompt.employeeId,
          instructionsFile: summary.prompt.instructionsFile,
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

    writeEvalReportArtifacts(
      resolve(import.meta.dirname, "../../docs/qa/phase-4-last-report"),
      {
        track: "LIVE_MODEL",
        suite: "phase-4-corpus",
        generatedAt,
        promptSource: summary.prompt.promptSource,
        promptProvenance: summary.prompt,
        productionApply: false,
        tagsFilter,
        caseIdsFilter: caseFilter?.length ? caseFilter : null,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        passRate: summary.passRate,
        requiredPassRate: summary.requiredPassRate,
        softOk: summary.softOk,
        criticalOk: summary.criticalOk,
        criticalFailed: summary.criticalFailed,
        ok: summary.ok,
        cases: reportCases,
      },
    );

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
