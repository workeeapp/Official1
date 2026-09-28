import { describe, expect, it } from "vitest";
import {
  toResponsesCreateBody,
  usesGpt6RequestRules,
} from "../src/services/llm-client.js";

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
