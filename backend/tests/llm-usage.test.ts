import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { usageCreate, usageAggregate, usageGroupBy, conversationCount, priceFindMany } =
  vi.hoisted(() => ({
    usageCreate: vi.fn(),
    usageAggregate: vi.fn(),
    usageGroupBy: vi.fn(),
    conversationCount: vi.fn(),
    priceFindMany: vi.fn(),
  }));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    llmUsage: { create: usageCreate, aggregate: usageAggregate, groupBy: usageGroupBy },
    llmModelPrice: { findMany: priceFindMany },
    chatConversation: { count: conversationCount },
  },
}));

import {
  computeLlmCost,
  getEmployeeUsageSummary,
  getTeamUsageSummary,
  priceModelCandidates,
  recordLlmUsage,
} from "../src/services/llm-usage.service.js";

describe("getTeamUsageSummary", () => {
  it("sums every visible employee's amount and the humans-only amount", async () => {
    usageGroupBy.mockReset().mockImplementation(async ({ by }: { by: string[] }) =>
      by[0] === "employeeId"
        ? [
            { employeeId: "amit", _sum: { costUsd: new Prisma.Decimal("0.006") } },
            { employeeId: "tal", _sum: { costUsd: new Prisma.Decimal("0.002") } },
            { employeeId: "guest", _sum: { costUsd: new Prisma.Decimal("0.5") } },
          ]
        : [{ digitalEmployeeId: "lucy", _sum: { costUsd: new Prisma.Decimal("0.508") } }],
    );

    const summary = await getTeamUsageSummary("u1", [
      { id: "amit", kind: "human", name: "עמית", nickname: "עמית" },
      { id: "tal", kind: "human", name: "טל", nickname: "טל" },
      { id: "guest", kind: "human", name: "אורח", nickname: "אורח" },
      { id: "lucy", kind: "digital", name: "לוסי", nickname: "לוסי" },
    ]);

    expect(summary.humanEmployeesUsd).toBeCloseTo(0.008);
    expect(summary.allEmployeesUsd).toBeCloseTo(0.516);
  });
});

describe("getEmployeeUsageSummary", () => {
  it("counts each reset session as a conversation and sums cost as speaker or worker", async () => {
    // Same ChatConversation row, reset twice → three OpenAI conversations.
    usageGroupBy.mockReset().mockResolvedValue([
      { openaiConversationId: "conv_a" },
      { openaiConversationId: "conv_b" },
      { openaiConversationId: "conv_c" },
    ]);
    // Plus one older chat with messages but no tracked usage.
    conversationCount.mockResolvedValue(1);
    usageAggregate.mockResolvedValue({
      _sum: { costUsd: new Prisma.Decimal("0.0125") },
      _count: { _all: 9 },
    });

    const summary = await getEmployeeUsageSummary("u1", "e1");

    expect(summary).toEqual({
      employeeId: "e1",
      conversations: 4,
      interactions: 9,
      totalUsd: 0.0125,
    });
    const involves = { OR: [{ employeeId: "e1" }, { digitalEmployeeId: "e1" }] };
    expect(usageGroupBy.mock.calls[0][0]).toMatchObject({
      by: ["openaiConversationId"],
      where: { ...involves, conversation: { userId: "u1" } },
    });
    expect(conversationCount.mock.calls[0][0].where).toMatchObject({
      userId: "u1",
      AND: [involves, { messages: { some: {} } }, { llmUsages: { none: {} } }],
    });
    expect(usageAggregate.mock.calls[0][0].where).toMatchObject({
      ...involves,
      conversation: { userId: "u1" },
    });
  });

  it("returns zero cost when there is no usage yet", async () => {
    usageGroupBy.mockResolvedValue([]);
    conversationCount.mockResolvedValue(0);
    usageAggregate.mockResolvedValue({ _sum: { costUsd: null }, _count: { _all: 0 } });
    expect(await getEmployeeUsageSummary("u1", "e2")).toEqual({
      employeeId: "e2",
      conversations: 0,
      interactions: 0,
      totalUsd: 0,
    });
  });
});

const miniPrice = {
  model: "gpt-4.1-mini",
  inputPer1m: new Prisma.Decimal("0.40"),
  cachedInputPer1m: new Prisma.Decimal("0.10"),
  outputPer1m: new Prisma.Decimal("1.60"),
};

const base = {
  conversationId: "c1111111-1111-4111-8111-111111111111",
  employeeId: "e1111111-1111-4111-8111-111111111111",
  digitalEmployeeId: "d1111111-1111-4111-8111-111111111111",
  openaiConversationId: "conv_1",
  model: "gpt-4.1-mini",
};

describe("computeLlmCost", () => {
  it("bills cached input at the cached rate and the rest at the input rate", () => {
    // 1000 uncached * 0.40 + 1000 cached * 0.10 + 500 output * 1.60 = 1300 / 1M
    const cost = computeLlmCost(
      { inputTokens: 2000, cachedTokens: 1000, outputTokens: 500 },
      miniPrice,
    );
    expect(cost.toString()).toBe("0.0013");
  });
});

describe("priceModelCandidates", () => {
  it("maps dated snapshots to their base model", () => {
    expect(priceModelCandidates("gpt-4.1-mini-2025-04-14", "gpt-4.1-mini")).toEqual([
      "gpt-4.1-mini-2025-04-14",
      "gpt-4.1-mini",
    ]);
  });
});

describe("recordLlmUsage", () => {
  beforeEach(() => {
    usageCreate.mockReset().mockResolvedValue({});
    priceFindMany.mockReset().mockResolvedValue([miniPrice]);
  });

  it("stores full usage and cost per conversation and employee", async () => {
    await recordLlmUsage({
      ...base,
      turn: {
        reply: "{}",
        raw: {
          id: "resp_1",
          model: "gpt-4.1-mini-2025-04-14",
          usage: {
            input_tokens: 2000,
            input_tokens_details: { cached_tokens: 1000 },
            output_tokens: 500,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2500,
          },
        },
      },
    });

    expect(usageCreate).toHaveBeenCalledOnce();
    const data = usageCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      ...base,
      model: "gpt-4.1-mini-2025-04-14",
      responseId: "resp_1",
      inputTokens: 2000,
      outputTokens: 500,
      cachedTokens: 1000,
      reasoningTokens: 0,
      totalTokens: 2500,
      priceModel: "gpt-4.1-mini",
      usage: expect.objectContaining({ input_tokens: 2000 }),
    });
    expect(data.costUsd.toString()).toBe("0.0013");
  });

  it("stores usage without cost when the model has no price", async () => {
    priceFindMany.mockResolvedValue([]);
    await recordLlmUsage({
      ...base,
      model: "gpt-unknown",
      turn: {
        reply: "{}",
        raw: { model: "gpt-unknown", usage: { input_tokens: 5, output_tokens: 5 } },
      },
    });
    expect(usageCreate.mock.calls[0][0].data).toMatchObject({
      costUsd: null,
      priceModel: null,
      totalTokens: 10,
    });
  });

  it("skips when the LLM returned no usage", async () => {
    await recordLlmUsage({ ...base, turn: { reply: "{}", raw: {} } });
    expect(usageCreate).not.toHaveBeenCalled();
  });

  it("does not throw when the insert fails", async () => {
    usageCreate.mockRejectedValue(new Error("db down"));
    await expect(
      recordLlmUsage({
        ...base,
        turn: {
          reply: "{}",
          raw: { usage: { input_tokens: 1, output_tokens: 1 } },
        },
      }),
    ).resolves.toBeUndefined();
  });
});
