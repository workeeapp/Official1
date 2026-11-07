import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadLiveFullCorpus, parseModelEvalTags } from "../src/eval/corpus.js";
import {
  casesFromLiveFullResults,
  writeEvalReportArtifacts,
} from "../src/eval/human-report.js";
import { buildPostApplyEvidence } from "../src/eval/post-apply-evidence.js";
import {
  liveFullExecutionScope,
  runLiveFullCorpus,
  useLegacyEvalContext,
} from "../src/eval/run-live-full.js";
import { productionCleanupLeaks } from "../src/eval/run-live-full-production.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import {
  aggregateStability,
  formatStabilityMarkdown,
} from "../src/eval/stability.js";

/** MODEL_EVAL_REPEAT=N → run the selection N times (G7 stability report). */
function parseRepeat(): number {
  const n = Number.parseInt(process.env.MODEL_EVAL_REPEAT ?? "1", 10);
  return Number.isFinite(n) && n > 1 ? Math.min(n, 50) : 1;
}
const REPEAT = parseRepeat();

/**
 * LIVE-full: Lucy + production apply on disposable workee_test.
 *
 *   MODEL_EVAL_FULL_LIVE=1 MODEL_EVAL_LIVE=1 npm run test:model-eval-full -w backend
 * Optional: MODEL_EVAL_TAGS=shopping,reminders
 * Optional: MODEL_EVAL_CASES=full-list-buy-milk
 * Optional: MODEL_EVAL_REPEAT=5 → stability report (docs/qa/live-full-stability.*)
 * Optional: MODEL_EVAL_LEGACY_CONTEXT=1 → pre-G8 message composition (A/B only)
 * Optional: MODEL_EVAL_LIVE_FULL_PATH=harness → model + harness apply (A/B only;
 *   default is the production path: every turn through sendChatMessage)
 *
 * Production path safety: WhatsApp sends and reminder delivery are stubbed;
 * every harness account is deleted and verified (leaks fail the run).
 *
 * Requires DATABASE_URL === WORKEE_APPROVED_TEST_DATABASE_URL (workee_test).
 */
describe("LIVE-full model→apply→facts (Lucy)", () => {
  // No outbound delivery from the production path (same stubs as live-sendchat suites).
  beforeAll(() => {
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent");
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent");
    vi.spyOn(whatsappSend, "sendWhatsAppMedia").mockResolvedValue("sent");
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0);
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => {});
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

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
    const runs: Awaited<ReturnType<typeof runLiveFullCorpus>>[] = [];
    for (let i = 0; i < REPEAT; i += 1) {
      runs.push(
        await runLiveFullCorpus(corpus, {
          caseIds: caseFilter?.length ? caseFilter : undefined,
        }),
      );
    }
    // Per-run artifacts below describe the LAST run; stability covers all.
    const summary = runs[runs.length - 1]!;
    const stability =
      REPEAT > 1
        ? aggregateStability(
            runs.map((run) =>
              run.results.map((row) => ({
                id: row.id,
                ok: row.ok,
                failures: row.failures,
                turns: row.turns.map((t) => ({
                  turnIndex: t.turnIndex,
                  utterance: t.utterance,
                  response: t.response,
                  ok: t.ok,
                  metadata: t.metadata,
                })),
              })),
            ),
          )
        : null;
    if (stability) {
      const stamp = new Date().toISOString();
      const header = {
        generatedAt: stamp,
        filter: caseFilter?.length
          ? `cases=${caseFilter.join(",")}`
          : `tags=${(tagsFilter ?? []).join(",") || "(all)"}`,
        contextMode: useLegacyEvalContext() ? "legacy (pre-G8)" : "production",
        executionScope: liveFullExecutionScope(),
      };
      const base = resolve(import.meta.dirname, "../../docs/qa/live-full-stability");
      writeFileSync(
        `${base}.json`,
        JSON.stringify({ ...header, ...stability }, null, 2),
        "utf8",
      );
      writeFileSync(`${base}.md`, formatStabilityMarkdown(stability, header), "utf8");
    }

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
          evalPath:
            liveFullExecutionScope() === "production-path"
              ? "production-sendChatMessage"
              : "model-then-harness-apply",
          executionScope: liveFullExecutionScope(),
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
              ...(t.rawActionDiagnostic
                ? { rawActionDiagnostic: t.rawActionDiagnostic }
                : {}),
              // Focused post-apply slice from harness turn (before destroy).
              postApplyEvidence: buildPostApplyEvidence({
                facts: t.facts,
                snapshot: t.snapshot,
              }),
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
        promptSource: summary.prompt.promptSource,
        promptProvenance: summary.prompt,
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
      productionCleanupLeaks,
      `harness accounts left in workee_test: ${productionCleanupLeaks.join(", ")}`,
    ).toEqual([]);

    if (stability) {
      // Measurement mode: gate on the aggregate rate; details live in the report.
      expect(
        stability.overallPassRate + 1e-9 >= summary.requiredPassRate,
        `stability overall ${stability.overallPassRate.toFixed(2)} < ${summary.requiredPassRate}`,
      ).toBe(true);
      return;
    }
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
  }, 900_000 * REPEAT);
});
