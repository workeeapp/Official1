import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { resolve } from "node:path";

// Prefer file values over a polluted parent env (e.g. agent/eval shell left
// DATABASE_URL=workee_test:5436 and WhatsApp inbound then hit the wrong DB).
// Exception: eval harness that locked `.env.live-full-eval` must not be
// overwritten by product `.env` (see load-live-full-eval-env.ts).
const evalEnvLocked = process.env.WORKEE_EVAL_ENV_LOCKED === "1";
loadEnv({
  path: resolve(process.cwd(), ".env"),
  quiet: true,
  override: !evalEnvLocked,
});
loadEnv({
  path: resolve(process.cwd(), "../.env"),
  quiet: true,
  override: !evalEnvLocked,
});

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must be at least 32 characters"),
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  OPENAI_API_KEY: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  WHATSAPP_APP_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_DEFAULT_EMPLOYEE: z.string().optional(),
  /**
   * Public E.164 digits for wa.me business invite links (not the Graph phone number id).
   */
  WHATSAPP_DISPLAY_PHONE: z.string().optional(),

  /** Root folder for uploaded attachment bytes. */
  UPLOADS_DIR: z.string().default(".data/uploads"),
  /** OpenAI model for voice/audio transcription. */
  TRANSCRIBE_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  /** Google Places API key for live local business search (optional). */
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  /**
   * Max places returned per Text Search (Places API New `maxResultCount`).
   * Clamped 1–20 (API hard cap).
   */
  GOOGLE_PLACES_MAX_RESULTS: z.coerce.number().int().min(1).max(20).default(10),
  /**
   * Google Routes API key for live public-transit A→B (optional).
   * Falls back to GOOGLE_PLACES_API_KEY when unset.
   */
  GOOGLE_ROUTES_API_KEY: z.string().optional(),
  /**
   * AviationStack access key for live airport boards / flight status (optional).
   * Free tier is very limited — use for POC / light polling only.
   */
  AVIATIONSTACK_ACCESS_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) {
    return cached;
  }

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}

export function isProduction(): boolean {
  return getEnv().NODE_ENV === "production";
}
