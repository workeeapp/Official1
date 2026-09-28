import OpenAI from "openai";
import type { LlmJsonSchemaFormat } from "../config/llm.js";
import { getEnv } from "../config/env.js";
import { ServiceUnavailableError } from "../utils/errors.js";

export interface LlmTurn {
  reply: string;
  raw: unknown;
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
      return {
        reply: extractOutputText(response),
        raw: toPlainJson(response),
      };
    },
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
