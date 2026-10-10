import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { usageCreate, usageFindMany, conversationFindMany, priceFindMany } = vi.hoisted(
  () => ({
    usageCreate: vi.fn(),
    usageFindMany: vi.fn(),
    conversationFindMany: vi.fn(),
    priceFindMany: vi.fn(),
  }),
);

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    llmUsage: {
      create: usageCreate,
      findMany: usageFindMany,
    },
    llmModelPrice: { findMany: priceFindMany },
    chatConversation: { findMany: conversationFindMany },
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
  const team = [
    { id: "amit", kind: "human" as const, name: "עמית", nickname: "עמית" },
    { id: "tal", kind: "human" as const, name: "טל", nickname: "טל" },
    { id: "guest", kind: "human" as const, name: "אורח", nickname: "אורח" },
    { id: "lucy", kind: "digital" as const, name: "לוסי", nickname: "לוסי" },
  ];
  const row = (employeeId: string, cost: string | null, createdAt: string) => ({
    employeeId,
    digitalEmployeeId: "lucy",
    costUsd: cost === null ? null : new Prisma.Decimal(cost),
    createdAt: new Date(createdAt),
  });

  it("sums every visible employee's amount and the humans-only amount", async () => {
    usageFindMany.mockReset().mockResolvedValue([
      row("amit", "0.006", "2026-10-05T10:00:00Z"),
      row("tal", "0.002", "2026-10-06T10:00:00Z"),
      row("guest", "0.5", "2026-10-07T10:00:00Z"),
    ]);

    const summary = await getTeamUsageSummary("u1", team);

    expect(summary.humanEmployeesUsd).toBeCloseTo(0.008);
    expect(summary.allEmployeesUsd).toBeCloseTo(0.516);
    expect(usageFindMany.mock.calls[0][0].where).toEqual({ conversation: { userId: "u1" } });
  });

  it("splits the amounts by Jerusalem month, newest first", async () => {
    usageFindMany.mockReset().mockResolvedValue([
      row("amit", "0.001", "2026-08-15T10:00:00Z"),
      // 22:30 UTC on Sep 30 is already Oct 1 in Jerusalem (UTC+3).
      row("amit", "0.002", "2026-09-30T22:30:00Z"),
      row("tal", "0.004", "2026-09-10T10:00:00Z"),
      row("amit", null, "2026-07-01T10:00:00Z"),
    ]);

    const summary = await getTeamUsageSummary("u1", team);

    expect(summary.months.map((m) => m.month)).toEqual(["2026-10", "2026-09", "2026-08"]);
    const [oct, sep, aug] = summary.months;
    expect(oct.humanEmployeesUsd).toBeCloseTo(0.002);
    expect(oct.allEmployeesUsd).toBeCloseTo(0.004);
    expect(sep.humanEmployeesUsd).toBeCloseTo(0.004);
    expect(sep.allEmployeesUsd).toBeCloseTo(0.008);
    expect(aug.humanEmployeesUsd).toBeCloseTo(0.001);
    expect(aug.allEmployeesUsd).toBeCloseTo(0.002);
    expect(summary.humanEmployeesUsd).toBeCloseTo(0.007);
    expect(summary.allEmployeesUsd).toBeCloseTo(0.014);
  });
});

describe("getEmployeeUsageSummary", () => {
  const usage = (id: string, cost: string | null, createdAt: string) => ({
    openaiConversationId: id,
    costUsd: cost === null ? null : new Prisma.Decimal(cost),
    createdAt: new Date(createdAt),
  });

  it("counts each reset session as a conversation and sums cost as speaker or worker", async () => {
    // Same ChatConversation row, reset twice → three OpenAI conversations.
    usageFindMany.mockReset().mockResolvedValue([
      usage("conv_a", "0.005", "2026-10-02T10:00:00Z"),
      usage("conv_a", "0.0025", "2026-10-02T10:05:00Z"),
      usage("conv_b", "0.005", "2026-10-03T10:00:00Z"),
      usage("conv_c", null, "2026-10-04T10:00:00Z"),
    ]);
    // Plus one older chat with messages but no tracked usage.
    conversationFindMany.mockReset().mockResolvedValue([
      { createdAt: new Date("2026-10-01T10:00:00Z") },
    ]);

    const summary = await getEmployeeUsageSummary("u1", "e1");

    expect(summary).toMatchObject({
      employeeId: "e1",
      conversations: 4,
      interactions: 4,
    });
    expect(summary.totalUsd).toBeCloseTo(0.0125);
    const involves = { OR: [{ employeeId: "e1" }, { digitalEmployeeId: "e1" }] };
    expect(usageFindMany.mock.calls[0][0].where).toEqual({
      ...involves,
      conversation: { userId: "u1" },
    });
    expect(conversationFindMany.mock.calls[0][0].where).toMatchObject({
      userId: "u1",
      AND: [involves, { messages: { some: {} } }, { llmUsages: { none: {} } }],
    });
  });

  it("splits conversations, interactions and cost by Jerusalem month, newest first", async () => {
    usageFindMany.mockReset().mockResolvedValue([
      usage("conv_a", "0.001", "2026-09-10T10:00:00Z"),
      // 22:30 UTC on Sep 30 is already Oct 1 in Jerusalem — same session spans both months.
      usage("conv_a", "0.002", "2026-09-30T22:30:00Z"),
      usage("conv_b", "0.004", "2026-10-05T10:00:00Z"),
    ]);
    conversationFindMany.mockReset().mockResolvedValue([
      { createdAt: new Date("2026-08-01T10:00:00Z") },
    ]);

    const summary = await getEmployeeUsageSummary("u1", "e1");

    expect(summary.conversations).toBe(3);
    expect(summary.interactions).toBe(3);
    expect(summary.months.map((m) => m.month)).toEqual(["2026-10", "2026-09", "2026-08"]);
    const [oct, sep, aug] = summary.months;
    expect(oct).toMatchObject({ conversations: 2, interactions: 2 });
    expect(oct.totalUsd).toBeCloseTo(0.006);
    expect(sep).toMatchObject({ conversations: 1, interactions: 1 });
    expect(sep.totalUsd).toBeCloseTo(0.001);
    expect(aug).toEqual({ month: "2026-08", conversations: 1, interactions: 0, totalUsd: 0 });
  });

  it("returns zero cost when there is no usage yet", async () => {
    usageFindMany.mockReset().mockResolvedValue([]);
    conversationFindMany.mockReset().mockResolvedValue([]);
    expect(await getEmployeeUsageSummary("u1", "e2")).toEqual({
      employeeId: "e2",
      conversations: 0,
      interactions: 0,
      totalUsd: 0,
      months: [],
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
