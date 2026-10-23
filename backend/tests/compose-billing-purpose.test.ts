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
