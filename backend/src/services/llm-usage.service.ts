import { Prisma } from "@prisma/client";
import {
  digitalEmployees,
  humanEmployees,
  isGuestEmployee,
  jerusalemParts,
  workspaceHumans,
  type EmployeeUsageSummary,
  type PublicEmployee,
  type TeamUsagePurposeBreakdown,
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
 * Rows chatted in before usage tracking (messages, no usage) count once each, in the
 * month the chat was created. A session spanning two months counts in both months.
 */
export async function getEmployeeUsageSummary(
  userId: string,
  employeeId: string,
): Promise<EmployeeUsageSummary> {
  const involves = {
    OR: [{ employeeId }, { digitalEmployeeId: employeeId }],
  };
  const [rows, untracked] = await Promise.all([
    prisma.llmUsage.findMany({
      where: { ...involves, conversation: { userId } },
      select: { openaiConversationId: true, costUsd: true, createdAt: true },
    }),
    prisma.chatConversation.findMany({
      where: {
        userId,
        AND: [involves, { messages: { some: {} } }, { llmUsages: { none: {} } }],
      },
      select: { createdAt: true },
    }),
  ]);

  type Bucket = { sessions: Set<string>; untracked: number; interactions: number; totalUsd: number };
  const newBucket = (): Bucket => ({
    sessions: new Set(),
    untracked: 0,
    interactions: 0,
    totalUsd: 0,
  });
  const all = newBucket();
  const perMonth = new Map<string, Bucket>();
  const monthBucket = (at: Date) => {
    const key = jerusalemMonthKey(at);
    let bucket = perMonth.get(key);
    if (!bucket) {
      bucket = newBucket();
      perMonth.set(key, bucket);
    }
    return bucket;
  };

  for (const row of rows) {
    const cost = row.costUsd ? Number(row.costUsd) : 0;
    for (const bucket of [all, monthBucket(row.createdAt)]) {
      bucket.sessions.add(row.openaiConversationId);
      bucket.interactions += 1;
      bucket.totalUsd += cost;
    }
  }
  for (const chat of untracked) {
    all.untracked += 1;
    monthBucket(chat.createdAt).untracked += 1;
  }

  const summarize = (bucket: Bucket) => ({
    conversations: bucket.sessions.size + bucket.untracked,
    interactions: bucket.interactions,
    totalUsd: bucket.totalUsd,
  });
  const months = [...perMonth.entries()]
    .map(([month, bucket]) => ({ month, ...summarize(bucket) }))
    .sort((a, b) => b.month.localeCompare(a.month));
  return { employeeId, ...summarize(all), months };
}

function jerusalemMonthKey(at: Date): string {
  const { year, month } = jerusalemParts(at);
  return `${year}-${String(month).padStart(2, "0")}`;
}

const EMPTY_PURPOSES = (): TeamUsagePurposeBreakdown => ({
  chatUsd: 0,
  catalogTipUsd: 0,
  weatherTipUsd: 0,
  reminderComposeUsd: 0,
  liveSelectUsd: 0,
});

function addPurposeCost(
  purposes: TeamUsagePurposeBreakdown,
  purpose: string,
  cost: number,
): void {
  switch (purpose) {
    case "catalog_tip":
      purposes.catalogTipUsd += cost;
      break;
    case "weather_tip":
      purposes.weatherTipUsd += cost;
      break;
    case "reminder_compose":
      purposes.reminderComposeUsd += cost;
      break;
    case "live_select":
      purposes.liveSelectUsd += cost;
      break;
    case "chat":
    default:
      purposes.chatUsd += cost;
      break;
  }
}

/**
 * Each chat's cost appears on both its human speaker and its digital worker, so
 * `allEmployeesUsd` (sum over every visible employee) counts it twice by design.
 * `guestsUsd` / `purposes` count each LlmUsages row once.
 */
export async function getTeamUsageSummary(
  userId: string,
  employees: Array<
    Pick<PublicEmployee, "id" | "kind" | "name" | "nickname" | "isGuest">
  >,
): Promise<TeamUsageSummary> {
  const humanIds = new Set(workspaceHumans(employees).map((employee) => employee.id));
  const digitalIds = new Set(digitalEmployees(employees).map((employee) => employee.id));
  const guestIds = new Set(
    humanEmployees(employees)
      .filter((employee) => isGuestEmployee(employee))
      .map((employee) => employee.id),
  );
  const rows = await prisma.llmUsage.findMany({
    where: { conversation: { userId } },
    select: {
      employeeId: true,
      digitalEmployeeId: true,
      costUsd: true,
      createdAt: true,
      purpose: true,
    },
  });

  const perEmployee = new Map<string, number>();
  const perMonth = new Map<string, Map<string, number>>();
  const purposes = EMPTY_PURPOSES();
  let totalUsd = 0;
  let guestsUsd = 0;
  const perMonthPurposes = new Map<string, TeamUsagePurposeBreakdown>();
  const perMonthGuests = new Map<string, number>();
  const perMonthTotal = new Map<string, number>();
  const add = (bucket: Map<string, number>, id: string, cost: number) => {
    bucket.set(id, (bucket.get(id) ?? 0) + cost);
  };
  for (const row of rows) {
    const cost = row.costUsd ? Number(row.costUsd) : 0;
    const key = jerusalemMonthKey(row.createdAt);
    let monthBucket = perMonth.get(key);
    if (!monthBucket) {
      monthBucket = new Map();
      perMonth.set(key, monthBucket);
    }
    for (const bucket of [perEmployee, monthBucket]) {
      add(bucket, row.employeeId, cost);
      add(bucket, row.digitalEmployeeId, cost);
    }
    totalUsd += cost;
    perMonthTotal.set(key, (perMonthTotal.get(key) ?? 0) + cost);
    const purpose = row.purpose ?? "chat";
    addPurposeCost(purposes, purpose, cost);
    let monthPurposes = perMonthPurposes.get(key);
    if (!monthPurposes) {
      monthPurposes = EMPTY_PURPOSES();
      perMonthPurposes.set(key, monthPurposes);
    }
    addPurposeCost(monthPurposes, purpose, cost);
    if (guestIds.has(row.employeeId)) {
      guestsUsd += cost;
      perMonthGuests.set(key, (perMonthGuests.get(key) ?? 0) + cost);
    }
  }

  const totals = (bucket: Map<string, number>) => {
    const sum = (ids: Set<string>) =>
      [...ids].reduce((total, id) => total + (bucket.get(id) ?? 0), 0);
    const humanEmployeesUsd = sum(humanIds);
    return { allEmployeesUsd: humanEmployeesUsd + sum(digitalIds), humanEmployeesUsd };
  };
  const monthKeys = new Set([
    ...perMonth.keys(),
    ...perMonthPurposes.keys(),
    ...perMonthGuests.keys(),
    ...perMonthTotal.keys(),
  ]);
  const months = [...monthKeys]
    .map((month) => {
      const employeeTotals = totals(perMonth.get(month) ?? new Map());
      return {
        month,
        totalUsd: perMonthTotal.get(month) ?? 0,
        ...employeeTotals,
        guestsUsd: perMonthGuests.get(month) ?? 0,
        purposes: perMonthPurposes.get(month) ?? EMPTY_PURPOSES(),
      };
    })
    .filter(
      (row) =>
        row.totalUsd !== 0 ||
        row.allEmployeesUsd !== 0 ||
        row.humanEmployeesUsd !== 0 ||
        row.guestsUsd !== 0 ||
        row.purposes.chatUsd !== 0 ||
        row.purposes.catalogTipUsd !== 0 ||
        row.purposes.weatherTipUsd !== 0 ||
        row.purposes.reminderComposeUsd !== 0 ||
        row.purposes.liveSelectUsd !== 0,
    )
    .sort((a, b) => b.month.localeCompare(a.month));
  return { totalUsd, ...totals(perEmployee), guestsUsd, purposes, months };
}

/** Why this LlmUsages row was written (analytics / cost filters). */
export type LlmUsagePurpose =
  | "chat"
  | "catalog_tip"
  | "weather_tip"
  | "reminder_compose"
  | "live_select";

/** Billing context for ephemeral compose LLM calls (not the main chat turn). */
export type ComposeLlmBilling = {
  conversationId: string;
  employeeId: string;
  digitalEmployeeId: string;
};

export async function recordLlmUsage(input: {
  conversationId: string;
  employeeId: string;
  digitalEmployeeId: string;
  openaiConversationId: string;
  model: string;
  turn: LlmTurn;
  purpose?: LlmUsagePurpose;
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
        purpose: input.purpose ?? "chat",
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
