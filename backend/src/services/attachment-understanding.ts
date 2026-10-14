import OpenAI, { toFile } from "openai";
import { getEnv } from "../config/env.js";
import { extensionForMime } from "./attachment-storage.js";

export type Transcriber = (input: {
  bytes: Buffer;
  mimeType: string;
}) => Promise<string>;

let override: Transcriber | null = null;

export function setTranscriberForTests(transcriber: Transcriber | null): void {
  override = transcriber;
}

/** Speech → text for voice notes / audio files. Empty string when unavailable. */
export async function transcribeAudio(input: {
  bytes: Buffer;
  mimeType: string;
}): Promise<string> {
  if (override) {
    return override(input);
  }
  const env = getEnv();
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey || env.NODE_ENV === "test") {
    return "";
  }
  const client = new OpenAI({ apiKey });
  const file = await toFile(input.bytes, `audio.${extensionForMime(input.mimeType)}`, {
    type: input.mimeType.split(";")[0]?.trim() || "audio/ogg",
  });
  const result = await client.audio.transcriptions.create({
    file,
    model: env.TRANSCRIBE_MODEL,
  });
  return typeof result.text === "string" ? result.text.trim() : "";
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
