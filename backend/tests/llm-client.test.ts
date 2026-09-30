import { describe, expect, it } from "vitest";
import {
  extractUsage,
  toResponsesCreateBody,
  usesGpt6RequestRules,
} from "../src/services/llm-client.js";

describe("extractUsage", () => {
  it("reads input, output, cached, reasoning, and total tokens", () => {
    const usage = extractUsage({
      id: "resp_1",
      model: "gpt-4.1-mini-2025-04-14",
      usage: {
        input_tokens: 1200,
        input_tokens_details: { cached_tokens: 1024 },
        output_tokens: 80,
        output_tokens_details: { reasoning_tokens: 12 },
        total_tokens: 1280,
      },
    });

    expect(usage).toMatchObject({
      responseId: "resp_1",
      model: "gpt-4.1-mini-2025-04-14",
      inputTokens: 1200,
      outputTokens: 80,
      cachedTokens: 1024,
      reasoningTokens: 12,
      totalTokens: 1280,
    });
  });

  it("returns null when the response has no usage", () => {
    expect(extractUsage({ id: "resp_2" })).toBeNull();
    expect(extractUsage(null)).toBeNull();
  });

  it("defaults missing details to zero and derives total", () => {
    expect(
      extractUsage({ usage: { input_tokens: 10, output_tokens: 5 } }),
    ).toMatchObject({ cachedTokens: 0, reasoningTokens: 0, totalTokens: 15 });
  });
});

describe("gpt-6 Responses request", () => {
  it("adds reasoning.effort none so temperature is allowed", () => {
    const body = toResponsesCreateBody({
      conversationId: "conv_1",
      message: "hi",
      model: "gpt-6-luna",
      temperature: 0,
      instructions: "You are לוסי.",
    });

    expect(usesGpt6RequestRules("gpt-6-luna")).toBe(true);
    expect(body).toMatchObject({
      model: "gpt-6-luna",
      temperature: 0,
      conversation: "conv_1",
      input: "hi",
      reasoning: { effort: "none" },
    });
  });

  it("does not add reasoning for gpt-4.1", () => {
    const body = toResponsesCreateBody({
      conversationId: "conv_1",
      message: "hi",
      model: "gpt-4.1-mini",
      temperature: 0,
      instructions: "You are דוד.",
    });

    expect(body.reasoning).toBeUndefined();
    expect(body.temperature).toBe(0);
  });
});
