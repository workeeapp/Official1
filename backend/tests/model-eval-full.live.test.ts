import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLiveFullCorpus, parseModelEvalTags } from "../src/eval/corpus.js";
import {
  casesFromLiveFullResults,
  writeEvalReportArtifacts,
} from "../src/eval/human-report.js";
import { runLiveFullCorpus } from "../src/eval/run-live-full.js";

/**
 * LIVE-full: Lucy + production apply on disposable workee_test.
 *
 *   MODEL_EVAL_FULL_LIVE=1 MODEL_EVAL_LIVE=1 npm run test:model-eval-full -w backend
 * Optional: MODEL_EVAL_TAGS=shopping,reminders
 * Optional: MODEL_EVAL_CASES=full-list-buy-milk
 *
 * Requires DATABASE_URL === WORKEE_APPROVED_TEST_DATABASE_URL (workee_test).
 */
describe("LIVE-full model→apply→facts (Lucy)", () => {
  it("meets soft pass-rate on the live-full corpus", async () => {
    const liveEnabled =
      process.env.MODEL_EVAL_FULL_LIVE === "1" ||
      (process.env.MODEL_EVAL_LIVE === "1" &&
        process.env.MODEL_EVAL_FULL === "1");
    if (!liveEnabled) {
      throw new Error(
        "Refusing LIVE-full: set MODEL_EVAL_FULL_LIVE=1 (and approved workee_test URL)",
      );
    }
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error("OPENAI_API_KEY is required for LIVE-full");
    }

    const caseFilter = process.env.MODEL_EVAL_CASES?.split(",")
      .map((row) => row.trim())
      .filter(Boolean);
    const corpus = loadLiveFullCorpus();
    const tagsFilter = parseModelEvalTags();
    const summary = await runLiveFullCorpus(corpus, {
      caseIds: caseFilter?.length ? caseFilter : undefined,
    });

    const generatedAt = new Date().toISOString();
    const corpusById = new Map(corpus.cases.map((c) => [c.id, c]));
    const reportCases = casesFromLiveFullResults(summary.results, corpusById);

    const reportPath = resolve(
      import.meta.dirname,
      "../../docs/qa/live-full-last-eval.json",
    );
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          generatedAt,
          suite: "live-full-corpus",
          track: "LIVE_FULL",
          promptSource: "LLM.config.json (worktree via loadLlmConfig)",
          evalPath: "model-then-production-apply",
          productionApply: true,
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
            ok: row.ok,
            failures: row.failures,
            turns: row.turns.map((t) => ({
              index: t.turnIndex,
              utterance: t.utterance,
              response: t.response,
              ok: t.ok,
              constraintFailures: t.constraintFailures,
              stateFailures: t.stateFailures,
              appliedViaProduction: t.appliedViaProduction,
              metadata: t.metadata,
            })),
          })),
        },
        null,
        2,
      ),
      "utf8",
    );

    writeEvalReportArtifacts(
      resolve(import.meta.dirname, "../../docs/qa/live-full-last-report"),
      {
        track: "LIVE_FULL",
        suite: "live-full-corpus",
        generatedAt,
        promptSource: "LLM.config.json (worktree via loadLlmConfig)",
        productionApply: true,
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
  }, 900_000);
});
