import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const llmConfigSchema = z.object({
  model: z.string().trim().min(1),
  temperature: z.number().min(0).max(2),
  systemMessage: z.string().trim().min(1),
});

export type LlmJsonSchemaFormat = {
  type: "json_schema";
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
  description?: string;
};

export type LlmConfig = z.infer<typeof llmConfigSchema> & {
  responseFormat?: LlmJsonSchemaFormat;
};

const CANDIDATES = [
  "LLM.config",
  "LLM.config.json",
  "../LLM.config",
  "../LLM.config.json",
];

const ACTION_CANDIDATES = ["LLM.action.json", "../LLM.action.json"];

export function loadLlmConfig(cwd = process.cwd()): LlmConfig {
  const errors: string[] = [];

  for (const relativePath of CANDIDATES) {
    const path = resolve(cwd, relativePath);
    try {
      const parsed = llmConfigSchema.safeParse(
        normalizeLlmConfig(parseLlmConfigText(readFileSync(path, "utf8"))),
      );

      if (parsed.success) {
        const responseFormat = loadLlmResponseFormat(cwd);
        return responseFormat
          ? { ...parsed.data, responseFormat }
          : parsed.data;
      }

      errors.push(
        `${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      errors.push(
        `${path}: ${error instanceof Error ? error.message : "invalid JSON"}`,
      );
    }
  }

  const detail = errors.length > 0 ? errors.join(" | ") : "file not found";
  throw new Error(`Invalid LLM configuration: ${detail}`);
}

export function loadLlmResponseFormat(
  cwd = process.cwd(),
): LlmJsonSchemaFormat | undefined {
  for (const relativePath of ACTION_CANDIDATES) {
    const path = resolve(cwd, relativePath);
    try {
      const format = toResponsesJsonSchemaFormat(
        JSON.parse(readFileSync(path, "utf8")),
      );
      if (format) {
        return format;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw new Error(
        `Invalid LLM action: ${path}: ${error instanceof Error ? error.message : "invalid JSON"}`,
      );
    }
  }

  return undefined;
}

function toResponsesJsonSchemaFormat(raw: unknown): LlmJsonSchemaFormat | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  const responseFormat =
    record.response_format &&
    typeof record.response_format === "object" &&
    !Array.isArray(record.response_format)
      ? (record.response_format as Record<string, unknown>)
      : record;

  if (responseFormat.type !== "json_schema") {
    return undefined;
  }

  const nested =
    responseFormat.json_schema &&
    typeof responseFormat.json_schema === "object" &&
    !Array.isArray(responseFormat.json_schema)
      ? (responseFormat.json_schema as Record<string, unknown>)
      : responseFormat;

  if (
    typeof nested.name !== "string" ||
    !nested.name.trim() ||
    !nested.schema ||
    typeof nested.schema !== "object" ||
    Array.isArray(nested.schema)
  ) {
    return undefined;
  }

  return {
    type: "json_schema",
    name: nested.name.trim(),
    schema: nested.schema as Record<string, unknown>,
    ...(typeof nested.strict === "boolean" ? { strict: nested.strict } : {}),
    ...(typeof nested.description === "string"
      ? { description: nested.description }
      : {}),
  };
}

function normalizeLlmConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }

  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.systemMessage)) {
    return raw;
  }

  return {
    ...record,
    systemMessage: record.systemMessage.map((line) => String(line)).join("\n"),
  };
}

function parseLlmConfigText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const model = text.match(/"model"\s*:\s*"([^"]+)"/)?.[1];
    const temperature = Number(text.match(/"temperature"\s*:\s*(-?[0-9.]+)/)?.[1]);
    const marker = text.indexOf('"systemMessage"');
    if (marker === -1) {
      throw new Error("invalid JSON");
    }

    const colon = text.indexOf(":", marker);
    const quote = text.indexOf('"', colon + 1);
    const end = text.lastIndexOf('"');
    if (quote === -1 || end <= quote) {
      throw new Error("invalid JSON");
    }

    let systemMessage = text.slice(quote + 1, end);
    if (systemMessage.startsWith("\n")) {
      systemMessage = systemMessage.slice(1);
    }
    if (systemMessage.endsWith("\n")) {
      systemMessage = systemMessage.slice(0, -1);
    }

    if (!model || Number.isNaN(temperature) || !systemMessage.trim()) {
      throw new Error("invalid JSON");
    }

    return { model, temperature, systemMessage };
  }
}
