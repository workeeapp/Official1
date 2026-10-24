/**
 * Focused LIVE model eval for attachment intent (four acceptance requirements).
 * Model-only: createResponse (+ appendAssistantMessage). No Prisma apply / WA.
 *
 * Opt-in:
 *   MODEL_EVAL_LIVE=1 npm run test:attachment-intent-model -w backend
 * Optional: MODEL_EVAL_CASES=att-no-intent,att-item-default
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadAttachmentIntentCorpus,
  runAttachmentIntentCorpus,
} from "../src/eval/run-attachment-intent.js";

function loadOpenAiKeyFromDotenv(): string | undefined {
  for (const candidate of [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../.env"),
  ]) {
    if (!existsSync(candidate)) {
      continue;
    }
    const match = readFileSync(candidate, "utf8").match(
      /^OPENAI_API_KEY\s*=\s*(.+)$/m,
    );
    if (!match?.[1]) {
      continue;
    }
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

describe("attachment-intent model eval (live, model-only)", () => {
  it("scores fixture-backed attachment intent decisions", async () => {
    const liveEnabled =
      process.env.MODEL_EVAL_LIVE === "1" ||
      process.env.ATTACHMENT_INTENT_MODEL_EVAL === "1";
    if (!liveEnabled) {
      throw new Error(
        "Refusing attachment-intent LIVE: set MODEL_EVAL_LIVE=1 or ATTACHMENT_INTENT_MODEL_EVAL=1",
      );
    }
    if (!process.env.OPENAI_API_KEY?.trim()) {
      const fromFile = loadOpenAiKeyFromDotenv();
      if (fromFile) {
        process.env.OPENAI_API_KEY = fromFile;
      }
    }
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error("OPENAI_API_KEY is required for attachment-intent model eval");
    }

    const caseFilter = process.env.MODEL_EVAL_CASES?.split(",")
      .map((row) => row.trim())
      .filter(Boolean);
    const corpus = loadAttachmentIntentCorpus();
    const summary = await runAttachmentIntentCorpus(corpus, {
      caseIds: caseFilter?.length ? caseFilter : undefined,
    });

    const generatedAt = new Date().toISOString();
    const reportPath = resolve(
      import.meta.dirname,
      "../../docs/qa/attachment-intent-last-eval.json",
    );
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          generatedAt,
          suite: "attachment-intent-corpus",
          track: "LIVE_MODEL",
          evalPath: summary.evalPath,
          productionApply: summary.productionApply,
          isolation: {
            prismaApply: false,
            whatsapp: false,
            reminderFire: false,
            lucyDbSync: false,
            attachmentContext: "corpus-fixtures",
            interveningLucy: "appendAssistantMessage",
          },
          promptNotes: summary.promptNotes,
          promptSource: summary.prompt.promptSource,
          instructionsSha256: summary.prompt.instructionsSha256,
          envelopeMode: summary.prompt.envelopeMode,
          attachLucyRuntimeEngine: summary.prompt.attachLucyRuntimeEngine,
          model: summary.prompt.model,
          temperature: summary.prompt.temperature,
          reasoningEffort: summary.prompt.reasoningEffort,
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
            description: row.description,
            ok: row.ok,
            failures: row.failures,
            llmMs: row.llmMs,
            turns: row.turns.map((turn) => ({
              index: turn.index,
              utterance: turn.utterance,
              response: turn.response,
              ok: turn.ok,
              failures: turn.failures,
              llmMs: turn.llmMs,
              injectedAssistantAfter: turn.injectedAssistantAfter ?? null,
              metadata: turn.metadata,
              rawReply: turn.rawReply,
            })),
          })),
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(summary.productionApply).toBe(false);
    expect(summary.criticalOk, summary.criticalFailed.join(", ")).toBe(true);
    expect(summary.softOk, `passRate=${summary.passRate}`).toBe(true);
  }, 900_000);
});
