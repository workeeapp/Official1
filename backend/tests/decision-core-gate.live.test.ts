/**
 * Combined decision-core gate (ST + MT + attachment-intent).
 * Writes docs/qa/decision-core-last-eval.json only when the full tagged set ran
 * with no MODEL_EVAL_CASES filter. Partial runs keep any prior full artifact.
 *
 * Opt-in (model-only; no Prisma apply / WA / clocks / Lucy sync):
 *   MODEL_EVAL_LIVE=1 npm run test:decision-core-gate -w backend
 * Optional subset (will NOT overwrite the full-gate artifact):
 *   MODEL_EVAL_CASES=mt-multi-add-then-buy,core-shopping-crud-mt
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DECISION_CORE_TAG,
  listExpectedDecisionCoreIds,
  maybeWriteDecisionCoreFullArtifact,
} from "../src/eval/decision-core-report.js";
import {
  loadModelEvalCorpus,
  loadModelEvalMultiTurnCorpus,
} from "../src/eval/corpus.js";
import {
  runModelEvalCorpus,
  runModelEvalMultiTurnCorpus,
} from "../src/eval/run-case.js";
import {
  loadAttachmentIntentCorpus,
  runAttachmentIntentCorpus,
} from "../src/eval/run-attachment-intent.js";

describe("decision-core gate (live, model-only)", () => {
  it("runs the full tagged gate and writes a durable artifact only when complete", async () => {
    const liveEnabled =
      process.env.MODEL_EVAL_LIVE === "1" || process.env.CI === "true";
    if (!liveEnabled) {
      throw new Error(
        "Refusing decision-core gate LIVE: set MODEL_EVAL_LIVE=1 locally (or run under CI=true)",
      );
    }
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error("OPENAI_API_KEY is required for decision-core gate");
    }

    const caseFilter = process.env.MODEL_EVAL_CASES?.split(",")
      .map((row) => row.trim())
      .filter(Boolean);
    const tags = [DECISION_CORE_TAG];
    const caseIds = caseFilter?.length ? caseFilter : undefined;

    const st = await runModelEvalCorpus(loadModelEvalCorpus(), {
      tags,
      caseIds,
    });
    const mt = await runModelEvalMultiTurnCorpus(
      loadModelEvalMultiTurnCorpus(),
      { tags, caseIds },
    );
    const att = await runAttachmentIntentCorpus(loadAttachmentIntentCorpus(), {
      tags,
      caseIds,
    });

    const executedCaseIds = [
      ...st.results.map((row) => row.id),
      ...mt.multiTurnResults.map((row) => row.id),
      ...att.results.map((row) => row.id),
    ];
    const expected = listExpectedDecisionCoreIds();
    const passed = st.passed + mt.passed + att.passed;
    const failed = st.failed + mt.failed + att.failed;
    const ok = st.ok && mt.ok && att.ok;

    const artifact = maybeWriteDecisionCoreFullArtifact({
      path: resolve(
        import.meta.dirname,
        "../../docs/qa/decision-core-last-eval.json",
      ),
      executedCaseIds,
      expectedCaseIds: expected,
      caseIdsFilter: caseFilter?.length ? caseFilter : null,
      slices: [
        {
          suite: "phase-4-corpus",
          track: "LIVE_MODEL",
          caseIds: st.results.map((row) => row.id),
          results: st.results.map((row) => ({
            id: row.id,
            ok: row.ok,
            failures: row.failures,
            tag: row.tag,
            llmMs: row.llmMs,
          })),
        },
        {
          suite: "phase-4-multi-turn-corpus",
          track: "LIVE_MODEL_MT",
          caseIds: mt.multiTurnResults.map((row) => row.id),
          results: mt.multiTurnResults.map((row) => ({
            id: row.id,
            ok: row.ok,
            failures: row.failures,
            tag: row.tag,
            llmMs: row.llmMs,
            turns: row.turns.map((t) => ({
              index: t.index,
              ok: t.ok,
              failures: t.failures,
            })),
          })),
        },
        {
          suite: "attachment-intent-corpus",
          track: "LIVE_MODEL",
          caseIds: att.results.map((row) => row.id),
          results: att.results.map((row) => ({
            id: row.id,
            ok: row.ok,
            failures: row.failures,
            tag: row.tag,
            llmMs: row.llmMs,
          })),
        },
      ],
      passed,
      failed,
      ok,
      model: st.prompt.model,
      temperature: st.prompt.temperature,
      reasoningEffort: st.prompt.reasoningEffort,
      promptSource: st.prompt.promptSource,
      instructionsSha256: st.prompt.instructionsSha256,
      envelopeMode: st.prompt.envelopeMode,
      attachLucyRuntimeEngine: st.prompt.attachLucyRuntimeEngine,
      evalPath:
        "model-output-constraints-only+multi-turn-snapshot+attachment-fixture-context",
    });

    if (caseFilter?.length) {
      expect(artifact.wrote).toBe(false);
    } else {
      expect(executedCaseIds).toHaveLength(expected.length);
      expect(artifact.wrote, artifact.reason ?? "full gate write failed").toBe(
        true,
      );
    }

    expect(
      ok,
      [
        !st.ok
          ? `ST failed: ${st.results
              .filter((r) => !r.ok)
              .map((r) => `${r.id}[${r.failures.join("|")}]`)
              .join(", ")}`
          : null,
        !mt.ok
          ? `MT failed: ${mt.multiTurnResults
              .filter((r) => !r.ok)
              .map((r) => `${r.id}[${r.failures.join("|")}]`)
              .join(", ")}`
          : null,
        !att.ok
          ? `ATT failed: ${att.results
              .filter((r) => !r.ok)
              .map((r) => `${r.id}[${r.failures.join("|")}]`)
              .join(", ")}`
          : null,
        artifact.wrote === false && !caseFilter?.length
          ? `artifact not written: ${artifact.reason}`
          : null,
      ]
        .filter(Boolean)
        .join("; "),
    ).toBe(true);
  }, 1_800_000);
});
