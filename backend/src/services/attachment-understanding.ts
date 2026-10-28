import OpenAI, { toFile } from "openai";
import { getEnv } from "../config/env.js";
import { extensionForMime } from "./attachment-storage.js";

/** Outcome of speech→text for voice notes / audio files. */
export type TranscriptStatus = "ok" | "empty" | "unavailable" | "error";

export type TranscribeResult = {
  text: string;
  status: TranscriptStatus;
};

export type Transcriber = (input: {
  bytes: Buffer;
  mimeType: string;
}) => Promise<TranscribeResult>;

let override: Transcriber | null = null;

export function setTranscriberForTests(transcriber: Transcriber | null): void {
  override = transcriber;
}

/**
 * Speech → text for voice notes / audio files.
 * Never throws to callers that need non-fatal ingest — maps failures to status.
 */
export async function transcribeAudio(input: {
  bytes: Buffer;
  mimeType: string;
}): Promise<TranscribeResult> {
  if (override) {
    return override(input);
  }
  if (!input.bytes.length) {
    return { text: "", status: "empty" };
  }
  const env = getEnv();
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey || env.NODE_ENV === "test") {
    return { text: "", status: "unavailable" };
  }
  try {
    const client = new OpenAI({ apiKey });
    const file = await toFile(
      input.bytes,
      `audio.${extensionForMime(input.mimeType)}`,
      {
        type: input.mimeType.split(";")[0]?.trim() || "audio/ogg",
      },
    );
    const result = await client.audio.transcriptions.create({
      file,
      model: env.TRANSCRIBE_MODEL,
    });
    const text =
      typeof result.text === "string" ? result.text.trim() : "";
    return text
      ? { text, status: "ok" }
      : { text: "", status: "empty" };
  } catch {
    return { text: "", status: "error" };
  }
}

/** Image formats the vision model accepts as `input_image`. */
const VISION_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function isVisionMime(mimeType: string): boolean {
  return VISION_MIME.has(mimeType.split(";")[0]?.trim().toLowerCase() ?? "");
}

export function imageDataUrl(bytes: Buffer, mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() || "image/jpeg";
  return `data:${base};base64,${bytes.toString("base64")}`;
}
