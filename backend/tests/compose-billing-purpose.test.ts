import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createConversation,
  createResponse,
  recordLlmUsage,
} = vi.hoisted(() => ({
  createConversation: vi.fn(),
  createResponse: vi.fn(),
  recordLlmUsage: vi.fn(),
}));

vi.mock("../src/services/llm-client.js", () => ({
  getLlmClient: () => ({
    createConversation,
    createResponse,
  }),
  extractUsage: () => null,
}));

vi.mock("../src/config/llm.js", () => ({
  loadLlmConfig: () => ({ model: "gpt-test", temperature: 0.5 }),
}));

vi.mock("../src/services/llm-usage.service.js", () => ({
  recordLlmUsage,
}));

vi.mock("../src/services/whatsapp-log.js", () => ({
  recordWhatsAppEvent: vi.fn(),
}));

import {
  composeScheduledOutbound,
  composeWeatherLiveTip,
} from "../src/services/reminder-compose.js";
import { composeCatalogTip } from "../src/services/tip-compose.js";

const billing = {
  conversationId: "chat-conv-1",
  employeeId: "human-1",
  digitalEmployeeId: "lucy-1",
};

describe("composeScheduledOutbound honesty helpers", () => {
  beforeEach(() => {
    createConversation.mockReset();
    createResponse.mockReset();
    recordLlmUsage.mockReset();
    createConversation.mockResolvedValue("openai-ephemeral");
  });

  it("non-watch fixedBody short-circuits without calling the LLM", async () => {
    const text = await composeScheduledOutbound({
      brief: "סכם מזג אוויר",
      itemLabel: "מזג",
      actorName: "לוסי",
      recipientName: "עמית",
      facts: {
        kind: "weather",
        facts: "",
        factsLabel: "FACTS",
        fixedBody: "מעונן בפתח תקווה.",
      },
    });
    expect(text).toBe("מעונן בפתח תקווה.");
    expect(createResponse).not.toHaveBeenCalled();
  });

  it("returns null when the LLM yields empty text on a fact clock without fixedBody", async () => {
    createResponse.mockResolvedValue({
      reply: "   ",
      usage: null,
      raw: {},
    });
    const text = await composeScheduledOutbound({
      brief: "סכם קומיטים",
      itemLabel: "דוח",
      actorName: "לוסי",
      recipientName: "עמית",
      facts: {
        kind: "git_log",
        facts: "commit: add feature",
        factsLabel: "COMMITS",
      },
    });
    expect(text).toBeNull();
  });

  it("watch falls back to fixedBody when the LLM fails", async () => {
    createResponse.mockRejectedValue(new Error("llm down"));
    const text = await composeScheduledOutbound({
      brief: "עדכון גשם",
      itemLabel: "גשם",
      actorName: "לוסי",
      recipientName: "עמית",
      watch: true,
      facts: {
        kind: "weather",
        facts: "rain=true",
        factsLabel: "FACTS",
        fixedBody: "יורד גשם בפתח תקווה.",
      },
    });
    expect(text).toBe("יורד גשם בפתח תקווה.");
  });
});

describe("compose LLM billing purpose", () => {
  beforeEach(() => {
    createConversation.mockReset();
    createResponse.mockReset();
    recordLlmUsage.mockReset();
    createConversation.mockResolvedValue("openai-ephemeral");
    createResponse.mockResolvedValue({
      reply: "טיפ קצר",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 15,
        model: "gpt-test",
      },
      raw: {},
    });
  });

  it("catalog tip records purpose=catalog_tip", async () => {
    await composeCatalogTip({
      instructions: "כתוב טיפ",
      facts: { item_label: "חלב", items: ["חלב"] },
      billing,
    });
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "catalog_tip",
        conversationId: billing.conversationId,
        employeeId: billing.employeeId,
        digitalEmployeeId: billing.digitalEmployeeId,
        openaiConversationId: "openai-ephemeral",
      }),
    );
  });

  it("weather tip records purpose=weather_tip", async () => {
    await composeWeatherLiveTip({
      factsBody: "גשם מחר",
      billing,
    });
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "weather_tip" }),
    );
  });

  it("reminder compose records purpose=reminder_compose", async () => {
    await composeScheduledOutbound({
      brief: "שלום",
      itemLabel: "בדיקה",
      actorName: "לוסי",
      recipientName: "עמית",
      billing,
    });
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "reminder_compose" }),
    );
  });

  it("skips LlmUsages when billing omitted", async () => {
    await composeCatalogTip({
      instructions: "כתוב טיפ",
      facts: { item_label: "חלב" },
    });
    expect(recordLlmUsage).not.toHaveBeenCalled();
  });
});
