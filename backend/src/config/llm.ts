import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const llmConfigSchema = z.object({
  model: z.string().trim().min(1),
  temperature: z.number().min(0).max(2),
  systemMessage: z.string().trim().min(1),
});

export type LlmConfig = z.infer<typeof llmConfigSchema>;

const CANDIDATES = [
  "LLM.config",
  "LLM.config.json",
  "../LLM.config",
  "../LLM.config.json",
];

export function loadLlmConfig(cwd = process.cwd()): LlmConfig {
  const errors: string[] = [];

  for (const relativePath of CANDIDATES) {
    const path = resolve(cwd, relativePath);
    try {
      const parsed = llmConfigSchema.safeParse(
        parseLlmConfigText(readFileSync(path, "utf8")),
      );

      if (parsed.success) {
        return parsed.data;
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
