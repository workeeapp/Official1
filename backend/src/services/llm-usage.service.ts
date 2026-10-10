import { Prisma } from "@prisma/client";
import {
  digitalEmployees,
  jerusalemParts,
  workspaceHumans,
  type EmployeeUsageSummary,
  type PublicEmployee,
  type TeamUsageSummary,
} from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { extractUsage, type LlmTurn, type LlmUsage } from "./llm-client.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";

export type LlmPrice = {
  model: string;
  inputPer1m: Prisma.Decimal;
  cachedInputPer1m: Prisma.Decimal;
  outputPer1m: Prisma.Decimal;
};

export function priceModelCandidates(...models: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const model of models) {
    const name = model?.trim().toLowerCase();
    if (!name) {
      continue;
    }
    for (const candidate of [name, name.replace(/-\d{4}-\d{2}-\d{2}$/, "")]) {
      if (!out.includes(candidate)) {
        out.push(candidate);
      }
    }
  }
  return out;
}

/** OpenAI `input_tokens` already includes `cached_tokens`; reasoning is inside `output_tokens`. */
export function computeLlmCost(
  usage: Pick<LlmUsage, "inputTokens" | "cachedTokens" | "outputTokens">,
  price: LlmPrice,
): Prisma.Decimal {
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  return new Prisma.Decimal(uncached)
    .mul(price.inputPer1m)
    .add(new Prisma.Decimal(cached).mul(price.cachedInputPer1m))
    .add(new Prisma.Decimal(usage.outputTokens).mul(price.outputPer1m))
    .div(1_000_000);
}

async function findPrice(candidates: string[]): Promise<LlmPrice | null> {
  if (candidates.length === 0) {
    return null;
  }
  try {
    const rows = await prisma.llmModelPrice.findMany({
      where: { model: { in: candidates } },
    });
    for (const candidate of candidates) {
      const row = rows.find((price) => price.model === candidate);
      if (row) {
        return row;
      }
    }
  } catch (error) {
    recordWhatsAppEvent(
      "llm_price_failed",
      error instanceof Error ? error.message : "unknown",
    );
  }
  return null;
}

/**
 * A human is the speaker (`employee_id`); a digital worker is the partner (`digital_employee_id`).
 * Reset / idle / context rotation keeps the ChatConversation row but swaps the OpenAI
 * conversation, so each distinct `openai_conversation_id` with usage is one conversation.
 * Rows chatted in before usage tracking (messages, no usage) count once each.
 */
export async function getEmployeeUsageSummary(
  userId: string,
  employeeId: string,
): Promise<EmployeeUsageSummary> {
  const involves = {
    OR: [{ employeeId }, { digitalEmployeeId: employeeId }],
  };
  const usageWhere = { ...involves, conversation: { userId } };
  const [sessions, untracked, totals] = await Promise.all([
    prisma.llmUsage.groupBy({
      by: ["openaiConversationId"],
      where: usageWhere,
    }),
    prisma.chatConversation.count({
      where: {
        userId,
        AND: [involves, { messages: { some: {} } }, { llmUsages: { none: {} } }],
      },
    }),
    prisma.llmUsage.aggregate({
      where: usageWhere,
      _sum: { costUsd: true },
      _count: { _all: true },
    }),
  ]);

  return {
    employeeId,
    conversations: sessions.length + untracked,
    interactions: totals._count?._all ?? 0,
    totalUsd: totals._sum.costUsd ? Number(totals._sum.costUsd) : 0,
  };
}

/**
 * Each chat's cost appears on both its human speaker and its digital worker, so
 * `allEmployeesUsd` (sum over every visible employee) counts it twice by design.
 */
export async function getTeamUsageSummary(
  userId: string,
  employees: Array<Pick<PublicEmployee, "id" | "kind" | "name" | "nickname">>,
): Promise<TeamUsageSummary> {
  const humanIds = new Set(workspaceHumans(employees).map((employee) => employee.id));
  const digitalIds = new Set(digitalEmployees(employees).map((employee) => employee.id));
  const rows = await prisma.llmUsage.findMany({
    where: { conversation: { userId } },
    select: { employeeId: true, digitalEmployeeId: true, costUsd: true, createdAt: true },
  });

  const perEmployee = new Map<string, number>();
  const perMonth = new Map<string, Map<string, number>>();
  const add = (bucket: Map<string, number>, id: string, cost: number) => {
    bucket.set(id, (bucket.get(id) ?? 0) + cost);
  };
  for (const row of rows) {
    const cost = row.costUsd ? Number(row.costUsd) : 0;
    const { year, month } = jerusalemParts(row.createdAt);
    const key = `${year}-${String(month).padStart(2, "0")}`;
    let monthBucket = perMonth.get(key);
    if (!monthBucket) {
      monthBucket = new Map();
      perMonth.set(key, monthBucket);
    }
    for (const bucket of [perEmployee, monthBucket]) {
      add(bucket, row.employeeId, cost);
      add(bucket, row.digitalEmployeeId, cost);
    }
  }

  const totals = (bucket: Map<string, number>) => {
    const sum = (ids: Set<string>) =>
      [...ids].reduce((total, id) => total + (bucket.get(id) ?? 0), 0);
    const humanEmployeesUsd = sum(humanIds);
    return { allEmployeesUsd: humanEmployeesUsd + sum(digitalIds), humanEmployeesUsd };
  };
  const months = [...perMonth.entries()]
    .map(([month, bucket]) => ({ month, ...totals(bucket) }))
    .filter((row) => row.allEmployeesUsd !== 0 || row.humanEmployeesUsd !== 0)
    .sort((a, b) => b.month.localeCompare(a.month));
  return { ...totals(perEmployee), months };
}

export async function recordLlmUsage(input: {
  conversationId: string;
  employeeId: string;
  digitalEmployeeId: string;
  openaiConversationId: string;
  model: string;
  turn: LlmTurn;
}): Promise<void> {
  const usage = input.turn.usage ?? extractUsage(input.turn.raw);
  if (!usage) {
    return;
  }

  const price = await findPrice(priceModelCandidates(usage.model, input.model));
  if (!price) {
    recordWhatsAppEvent("llm_price_missing", `model=${usage.model ?? input.model}`);
  }

  try {
    await prisma.llmUsage.create({
      data: {
        conversationId: input.conversationId,
        employeeId: input.employeeId,
        digitalEmployeeId: input.digitalEmployeeId,
        openaiConversationId: input.openaiConversationId,
        responseId: usage.responseId,
        model: usage.model ?? input.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens,
        costUsd: price ? computeLlmCost(usage, price) : null,
        priceModel: price?.model ?? null,
        usage:
          usage.raw === undefined || usage.raw === null
            ? Prisma.JsonNull
            : (usage.raw as Prisma.InputJsonValue),
      },
    });
  } catch (error) {
    recordWhatsAppEvent(
      "llm_usage_failed",
      error instanceof Error ? error.message : "unknown",
    );
  }
}
