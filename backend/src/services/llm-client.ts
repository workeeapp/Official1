import OpenAI from "openai";
import type { LlmJsonSchemaFormat } from "../config/llm.js";
import { getEnv } from "../config/env.js";
import { ServiceUnavailableError } from "../utils/errors.js";

export interface LlmUsage {
  responseId: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  raw: unknown;
}

export interface LlmTurn {
  reply: string;
  raw: unknown;
  usage?: LlmUsage | null;
}

export type LlmResponseInput = {
  conversationId: string;
  message: string;
  model: string;
  temperature: number;
  instructions: string;
  textFormat?: LlmJsonSchemaFormat;
};

export interface LlmClient {
  createConversation(): Promise<string>;
  createResponse(input: LlmResponseInput): Promise<LlmTurn>;
}

export function usesGpt6RequestRules(model: string): boolean {
  return model.trim().toLowerCase().startsWith("gpt-6-");
}

export function toResponsesCreateBody(
  input: LlmResponseInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    instructions: input.instructions,
    conversation: input.conversationId,
    input: input.message,
  };
  if (input.textFormat) {
    body.text = { format: input.textFormat };
  }
  if (usesGpt6RequestRules(input.model)) {
    body.reasoning = { effort: "none" };
  }
  body.temperature = input.temperature;
  return body;
}

let override: LlmClient | null = null;
let cachedOpenAi: LlmClient | null = null;

export function setLlmClientForTests(client: LlmClient | null): void {
  override = client;
}

export function extractOutputText(response: {
  output_text?: string;
  output?: Array<{
    content?: Array<{ text?: string }>;
  }>;
}): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const parts: string[] = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string" && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }

  const text = parts.join("\n").trim();
  if (!text) {
    throw new ServiceUnavailableError();
  }

  return text;
}

function createOpenAiClient(apiKey: string): LlmClient {
  const client = new OpenAI({ apiKey });

  return {
    async createConversation() {
      const conversation = await client.conversations.create();
      return conversation.id;
    },
    async createResponse(input) {
      const response = await client.responses.create(
        toResponsesCreateBody(input) as Parameters<
          OpenAI["responses"]["create"]
        >[0],
      );
      const raw = toPlainJson(response);
      return {
        reply: extractOutputText(response),
        raw,
        usage: extractUsage(raw),
      };
    },
  };
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export function extractUsage(response: unknown): LlmUsage | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const row = response as Record<string, unknown>;
  const usage = row.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const u = usage as Record<string, unknown>;
  const inputDetails = (u.input_tokens_details ?? {}) as Record<string, unknown>;
  const outputDetails = (u.output_tokens_details ?? {}) as Record<string, unknown>;
  const inputTokens = tokenCount(u.input_tokens);
  const outputTokens = tokenCount(u.output_tokens);
  return {
    responseId: typeof row.id === "string" ? row.id : null,
    model: typeof row.model === "string" ? row.model : null,
    inputTokens,
    outputTokens,
    cachedTokens: tokenCount(inputDetails.cached_tokens),
    reasoningTokens: tokenCount(outputDetails.reasoning_tokens),
    totalTokens: tokenCount(u.total_tokens) || inputTokens + outputTokens,
    raw: usage,
  };
}

export function toPlainJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

export function getLlmClient(): LlmClient {
  if (override) {
    return override;
  }

  const apiKey = getEnv().OPENAI_API_KEY;
  if (!apiKey) {
    throw new ServiceUnavailableError();
  }

  cachedOpenAi ??= createOpenAiClient(apiKey);
  return cachedOpenAi;
}
