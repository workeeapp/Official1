import OpenAI from "openai";
import type { ReasoningEffort } from "@workee/shared";
import type { LlmJsonSchemaFormat } from "../config/llm.js";
import { getEnv } from "../config/env.js";
import { formatSessionClockContext } from "../utils/relative-date.js";
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
  /** gpt-6 only; defaults to "none". */
  reasoningEffort?: ReasoningEffort;
  instructions: string;
  textFormat?: LlmJsonSchemaFormat;
  /** Images (data or https URLs) the model looks at together with `message`. */
  imageUrls?: string[];
  /**
   * Live fact blocks for THIS turn only. Sent ahead of `message` but never kept
   * in the model conversation (only `message` + the reply are stored), so each
   * turn sees one current snapshot and the history prefix stays cacheable.
   */
  liveFacts?: string;
};

export interface LlmClient {
  createConversation(): Promise<string>;
  createResponse(input: LlmResponseInput): Promise<LlmTurn>;
  /** Record text the speaker saw from this assistant that the model did not generate. */
  appendAssistantMessage?(conversationId: string, text: string): Promise<void>;
}

export function usesGpt6RequestRules(model: string): boolean {
  return model.trim().toLowerCase().startsWith("gpt-6-");
}

/** What the model reads as this turn's user text (live facts, then the message). */
export function turnInputText(input: Pick<LlmResponseInput, "message" | "liveFacts">): string {
  return [input.liveFacts?.trim() ?? "", input.message].filter(Boolean).join("\n\n");
}

/**
 * Request body as stored for debugging: the conversation id plus exactly the
 * user text the model read this turn (live facts included).
 */
export function toResponsesCreateBody(
  input: LlmResponseInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    instructions: input.instructions,
    conversation: input.conversationId,
    input: toResponsesInput(turnInputText(input), input.imageUrls),
    truncation: "auto",
  };
  return withModelSettings(body, input);
}

/**
 * Stateless body for a live-facts turn: instructions + replayed history +
 * this turn's facts and message. Not stored by OpenAI; the caller appends the
 * plain message and the reply to the conversation itself.
 */
export function toStatelessResponsesBody(
  input: LlmResponseInput,
  history: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const current = toResponsesInput(turnInputText(input), input.imageUrls);
  const body: Record<string, unknown> = {
    model: input.model,
    instructions: input.instructions,
    input: [
      ...history,
      ...(typeof current === "string" ? [{ role: "user", content: current }] : current),
    ],
    store: false,
    truncation: "auto",
  };
  return withModelSettings(body, input);
}

/**
 * One stored conversation item → a Responses input message (deterministic, so
 * the replayed history is a byte-identical prefix turn after turn).
 */
export function conversationItemToInput(
  item: unknown,
): Record<string, unknown> | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const row = item as { type?: unknown; role?: unknown; content?: unknown };
  if (row.type !== "message" || !Array.isArray(row.content)) {
    return null;
  }
  const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : null;
  if (!role) {
    return null;
  }
  const texts: string[] = [];
  const images: string[] = [];
  for (const part of row.content as Array<Record<string, unknown>>) {
    if (typeof part?.text === "string" && part.text) {
      texts.push(part.text);
    } else if (part?.type === "input_image" && typeof part.image_url === "string") {
      images.push(part.image_url);
    }
  }
  const text = texts.join("\n");
  if (role === "assistant") {
    return text ? { role, content: text } : null;
  }
  if (images.length === 0) {
    return text ? { role, content: text } : null;
  }
  return (toResponsesInput(text, images) as Array<Record<string, unknown>>)[0] ?? null;
}

function withModelSettings(
  body: Record<string, unknown>,
  input: LlmResponseInput,
): Record<string, unknown> {
  if (input.textFormat) {
    body.text = { format: input.textFormat };
  }
  if (usesGpt6RequestRules(input.model)) {
    const effort = input.reasoningEffort ?? "none";
    body.reasoning = { effort };
    // gpt-6 rejects temperature unless reasoning effort is "none".
    if (effort === "none") {
      body.temperature = input.temperature;
    }
    return body;
  }
  body.temperature = input.temperature;
  return body;
}

export function toResponsesInput(
  message: string,
  imageUrls?: string[],
): string | Array<Record<string, unknown>> {
  const images = (imageUrls ?? []).filter(Boolean);
  if (images.length === 0) {
    return message;
  }
  return [
    {
      role: "user",
      content: [
        { type: "input_text", text: message },
        ...images.map((url) => ({
          type: "input_image",
          image_url: url,
          detail: "auto",
        })),
      ],
    },
  ];
}

let override: LlmClient | null = null;
let cachedOpenAi: LlmClient | null = null;

export function setLlmClientForTests(client: LlmClient | null): void {
  override = client;
}

/**
 * Put a server-sent thread message (reminder fire, notification, relay) into the
 * model conversation so the next turn does not contradict it from stale memory.
 * Memory only: a failure here must never block delivery of the message itself.
 */
export async function rememberInModelConversation(
  conversationId: string,
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!conversationId || !trimmed) {
    return;
  }
  try {
    await getLlmClient().appendAssistantMessage?.(conversationId, trimmed);
  } catch {
    /* best effort */
  }
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
      if (input.liveFacts?.trim()) {
        return createLiveFactsResponse(client, input);
      }
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
    async appendAssistantMessage(conversationId, text) {
      await client.conversations.items.create(conversationId, {
        items: [{ type: "message", role: "assistant", content: text }],
      });
    },
  };
}

/** Replay the stored conversation (messages only, oldest first). */
async function loadConversationHistory(
  client: OpenAI,
  conversationId: string,
): Promise<Array<Record<string, unknown>>> {
  const history: Array<Record<string, unknown>> = [];
  for await (const item of client.conversations.items.list(conversationId, {
    order: "asc",
    limit: 100,
    include: ["message.input_image.image_url"],
  })) {
    const mapped = conversationItemToInput(item);
    if (mapped) {
      history.push(mapped);
    }
  }
  return history;
}

/**
 * Live-facts turn: history + (facts, message) statelessly, then store only the
 * message and the reply. Facts never accumulate in the conversation, and the
 * instructions + history prefix is identical to last turn's (prompt cache).
 */
export async function createLiveFactsResponse(
  client: OpenAI,
  input: LlmResponseInput,
): Promise<LlmTurn> {
  const history = await loadConversationHistory(client, input.conversationId);
  const response = await client.responses.create(
    toStatelessResponsesBody(input, history) as Parameters<
      OpenAI["responses"]["create"]
    >[0],
  );
  const raw = toPlainJson(response);
  const reply = extractOutputText(response);
  const stored = toResponsesInput(input.message, input.imageUrls);
  await client.conversations.items.create(input.conversationId, {
    items: [
      typeof stored === "string"
        ? { type: "message", role: "user", content: stored }
        : { type: "message", ...(stored[0] as Record<string, unknown>) },
      { type: "message", role: "assistant", content: reply },
    ] as Parameters<OpenAI["conversations"]["items"]["create"]>[1]["items"],
  });
  return { reply, raw, usage: extractUsage(raw) };
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

/** Default model for OpenAI hosted web_search (mission fact/generic bootstrap). */
export const HOSTED_WEB_SEARCH_MODEL = "gpt-6-luna";

export type HostedWebSearchResult = {
  text: string;
  sources: string[];
  usage: LlmUsage | null;
  raw: unknown;
};

/** Pull url_citation annotations from a Responses API payload. */
export function extractWebSearchSources(response: unknown): string[] {
  const sources: string[] = [];
  const seen = new Set<string>();
  if (!response || typeof response !== "object") {
    return sources;
  }
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return sources;
  }
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const annotations = (part as { annotations?: unknown }).annotations;
      if (!Array.isArray(annotations)) {
        continue;
      }
      for (const ann of annotations) {
        if (!ann || typeof ann !== "object") {
          continue;
        }
        const row = ann as { type?: unknown; url?: unknown; title?: unknown };
        if (row.type !== "url_citation" || typeof row.url !== "string") {
          continue;
        }
        const url = row.url.trim();
        if (!url || seen.has(url)) {
          continue;
        }
        seen.add(url);
        const title = typeof row.title === "string" ? row.title.trim() : "";
        sources.push(title ? `${title} — ${url}` : url);
      }
    }
  }
  return sources;
}

/**
 * One-shot Responses call with hosted `web_search` (no conversation / JSON schema).
 * Used by the mission `web.search` tool — results become TOOL_RESULTS evidence.
 */
/** Ground hosted search on the same Asia/Jerusalem clock Lucy uses. */
export function hostedWebSearchInput(query: string, now = new Date()): string {
  const clock = formatSessionClockContext(now, { rulesInInstructions: true });
  return [
    clock,
    "User timezone is Asia/Jerusalem. Prefer live results for current_date when the query is about היום/אתמול/מחר/today/yesterday.",
    `Search query: ${query.trim()}`,
  ].join("\n\n");
}

export async function runHostedWebSearch(input: {
  query: string;
  model?: string;
  now?: Date;
}): Promise<HostedWebSearchResult> {
  const query = input.query.trim();
  if (!query) {
    throw new Error("runHostedWebSearch requires a non-empty query");
  }
  const apiKey = getEnv().OPENAI_API_KEY;
  if (!apiKey) {
    throw new ServiceUnavailableError();
  }
  const client = new OpenAI({ apiKey });
  const model = input.model?.trim() || HOSTED_WEB_SEARCH_MODEL;
  const body: Record<string, unknown> = {
    model,
    tools: [{ type: "web_search" }],
    input: hostedWebSearchInput(query, input.now),
    store: false,
  };
  if (usesGpt6RequestRules(model)) {
    body.reasoning = { effort: "low" };
  }
  const response = await client.responses.create(
    body as OpenAI.Responses.ResponseCreateParamsNonStreaming,
  );
  const raw = toPlainJson(response);
  return {
    text: extractOutputText(response as unknown as Parameters<typeof extractOutputText>[0]),
    sources: extractWebSearchSources(raw),
    usage: extractUsage(raw),
    raw,
  };
}
