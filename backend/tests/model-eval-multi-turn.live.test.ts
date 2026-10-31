import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadModelEvalMultiTurnCorpus,
  parseModelEvalTags,
} from "../src/eval/corpus.js";
import {
  casesFromMultiTurnResults,
  writeEvalReportArtifacts,
} from "../src/eval/human-report.js";
import { runModelEvalMultiTurnCorpus } from "../src/eval/run-case.js";

/**
 * Phase 4 multi-turn LIVE Lucy eval — opt-in, not merge CI.
 * Same conversationId across turns; metadata scoring only (no Prisma apply).
 *
 *   MODEL_EVAL_LIVE=1 npm run test:model-eval-mt -w backend
 * Optional: MODEL_EVAL_CASES=id1,id2
 * Optional: MODEL_EVAL_TAGS=reminders,multi-turn,shopping,…
 */
describe("Phase 4 multi-turn model eval (live Lucy)", () => {
  it("meets soft pass-rate on the multi-turn corpus", async () => {
    const liveEnabled =
      process.env.MODEL_EVAL_LIVE === "1" || process.env.CI === "true";
    if (!liveEnabled) {
      throw new Error(
        "Refusing multi-turn LIVE: set MODEL_EVAL_LIVE=1 locally (or run under CI=true)",
      );
    }
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error("OPENAI_API_KEY is required for multi-turn model eval");
    }

    const caseFilter = process.env.MODEL_EVAL_CASES?.split(",")
      .map((row) => row.trim())
      .filter(Boolean);
    const corpus = loadModelEvalMultiTurnCorpus();
    const tagsFilter = parseModelEvalTags();
    const summary = await runModelEvalMultiTurnCorpus(corpus, {
      caseIds: caseFilter?.length ? caseFilter : undefined,
    });

    const generatedAt = new Date().toISOString();
    const corpusById = new Map(corpus.cases.map((c) => [c.id, c]));
    const reportCases = casesFromMultiTurnResults(
      summary.multiTurnResults,
      corpusById,
    );

    const reportPath = resolve(
      import.meta.dirname,
      "../../docs/qa/phase-4-multi-turn-last-eval.json",
    );
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          generatedAt,
          suite: "phase-4-multi-turn-corpus",
          track: "LIVE_MODEL_MT",
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
          evalPath: "model-output-constraints-only-multi-turn",
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
          results: summary.multiTurnResults.map((row) => ({
            id: row.id,
            tag: row.tag,
            ok: row.ok,
            failures: row.failures,
            llmMs: row.llmMs,
            turns: row.turns.map((t) => ({
              index: t.index,
              utterance: t.utterance,
              response: t.response,
              ok: t.ok,
              failures: t.failures,
              llmMs: t.llmMs,
              metadata: t.metadata,
              injectedLocationFacts: t.injectedLocationFacts ?? null,
            })),
          })),
        },
        null,
        2,
      ),
      "utf8",
    );

    writeEvalReportArtifacts(
      resolve(
        import.meta.dirname,
        "../../docs/qa/phase-4-multi-turn-last-report",
      ),
      {
        track: "LIVE_MODEL_MT",
        suite: "phase-4-multi-turn-corpus",
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
        `failed: ${summary.multiTurnResults
          .filter((row) => !row.ok)
          .map((row) => `${row.id}[${row.failures.join("|")}]`)
          .join(", ")}`,
      ]
        .filter(Boolean)
        .join("; "),
    ).toBe(true);
  }, 900_000);
});
