/**
 * Q2 contract: LIVE_FULL scores the real production path (sendChatMessage),
 * not a harness re-implementation. Source-level checks plus the pure helpers;
 * the end-to-end behaviour is exercised by the LIVE run on workee_test.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONVERSATION_IDLE_MS } from "../src/services/chat.service.js";
import type { LlmClient, LlmResponseInput } from "../src/services/llm-client.js";
import { recordingClient, ROTATION_AGE_MS } from "../src/eval/run-live-full-production.js";
import { liveFullExecutionScope, useHarnessApplyPath } from "../src/eval/run-live-full.js";

const src = (rel: string) => readFileSync(resolve(import.meta.dirname, "../src", rel), "utf8");

describe("LIVE_FULL production path (Q2)", () => {
  const saved = { path: process.env.MODEL_EVAL_LIVE_FULL_PATH, legacy: process.env.MODEL_EVAL_LEGACY_CONTEXT };
  afterEach(() => {
    process.env.MODEL_EVAL_LIVE_FULL_PATH = saved.path;
    process.env.MODEL_EVAL_LEGACY_CONTEXT = saved.legacy;
    if (saved.path === undefined) delete process.env.MODEL_EVAL_LIVE_FULL_PATH;
    if (saved.legacy === undefined) delete process.env.MODEL_EVAL_LEGACY_CONTEXT;
  });

  it("defaults to production-path; harness only on explicit A/B switches", () => {
    delete process.env.MODEL_EVAL_LIVE_FULL_PATH;
    delete process.env.MODEL_EVAL_LEGACY_CONTEXT;
    expect(useHarnessApplyPath()).toBe(false);
    expect(liveFullExecutionScope()).toBe("production-path");
    process.env.MODEL_EVAL_LIVE_FULL_PATH = "harness";
    expect(liveFullExecutionScope()).toBe("model+harness-apply");
    delete process.env.MODEL_EVAL_LIVE_FULL_PATH;
    process.env.MODEL_EVAL_LEGACY_CONTEXT = "1";
    expect(liveFullExecutionScope()).toBe("model+harness-apply");
  });

  it("each turn goes through sendChatMessage; no harness apply or harness context building (D2/D3)", () => {
    const prod = src("eval/run-live-full-production.ts");
    expect(prod).toContain("chat.sendChatMessage(");
    expect(prod).toContain("applyByProposer: true");
    expect(prod).toContain("cleanup: cleanupProductionAccount");
    expect(prod).toContain("setLlmClientForTests(null)");
    for (const banned of ["applyModelMetadataTurn", "correctModelApplyTurnResponse", "buildProductionLiveFacts", "composeTurnContext"]) {
      expect(prod, banned).not.toContain(banned);
    }
  });

  it("D1: instructions sent are checked against buildLucyInstructions every turn", () => {
    const prod = src("eval/run-live-full-production.ts");
    expect(prod).toContain("chat.buildLucyInstructions(");
    expect(prod).toMatch(/built !== main\.input\.instructions\)\s*\{\s*throw/);
  });

  it("applyByProposer skips the harness apply and the response correction", () => {
    const apply = src("eval/run-model-apply.ts");
    expect(apply).toMatch(/if \(options\?\.applyByProposer\) \{[\s\S]*?\} else if \(metadataHasMutations\(metadata\)\)/);
    expect(apply).toMatch(/options\?\.applyByProposer\s*\?\s*rawResponse\s*:\s*correctModelApplyTurnResponse/);
  });

  it("dispatches to the production runner unless the harness A/B path is selected", () => {
    const live = src("eval/run-live-full.ts");
    expect(live).toMatch(/if \(!useHarnessApplyPath\(\)\) \{[\s\S]*?runLiveFullProductionCase/);
  });

  it("rotation ages past the production idle window (CONVERSATION_IDLE_MS unchanged)", () => {
    expect(CONVERSATION_IDLE_MS).toBe(40 * 60 * 1000);
    expect(ROTATION_AGE_MS).toBeGreaterThan(CONVERSATION_IDLE_MS);
  });

  it("recordingClient forwards unchanged and records input + raw reply", async () => {
    const seen: string[] = [];
    const real: LlmClient = {
      createConversation: async () => "conv-1",
      createResponse: async (input: LlmResponseInput) => {
        seen.push(input.instructions);
        return { reply: '{"response":"hi"}' } as Awaited<ReturnType<LlmClient["createResponse"]>>;
      },
      appendAssistantMessage: async (id: string, text: string) => {
        seen.push(`${id}:${text}`);
      },
    } as LlmClient;
    const calls: Array<{ input: LlmResponseInput; reply: string }> = [];
    const rec = recordingClient(real, calls);
    expect(await rec.createConversation()).toBe("conv-1");
    const out = await rec.createResponse({ instructions: "INS" } as LlmResponseInput);
    expect(out.reply).toBe('{"response":"hi"}');
    await rec.appendAssistantMessage!("conv-1", "relay");
    expect(seen).toEqual(["INS", "conv-1:relay"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.instructions).toBe("INS");
  });

  it("the live test stubs WhatsApp / reminder delivery and fails on cleanup leaks (D6)", () => {
    const t = readFileSync(resolve(import.meta.dirname, "model-eval-full.live.test.ts"), "utf8");
    for (const s of ['"sendWhatsAppText"', '"sendWhatsAppButtons"', '"sendWhatsAppMedia"', '"fireDueReminders"', '"scheduleSoon"']) {
      expect(t).toContain(s);
    }
    expect(t).toContain("productionCleanupLeaks");
  });
});
