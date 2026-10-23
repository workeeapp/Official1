/**
 * Vitest setup for write-capable eval tracks only (vitest.eval-db.config.ts).
 * Fail-closed load of repo `.env.live-full-eval` — no product `.env` fallback.
 */
import {
  loadLiveFullEvalEnv,
  summarizeLiveFullEvalEnv,
} from "../src/eval/load-live-full-eval-env.js";

const loaded = loadLiveFullEvalEnv({ apply: true });
// Sanitized confirmation for operators (no password).
console.info(summarizeLiveFullEvalEnv(loaded));
