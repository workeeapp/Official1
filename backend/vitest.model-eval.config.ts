import { defineConfig } from "vitest/config";

/**
 * Phase 4 live model eval only. Keep out of default `npm test` / merge CI.
 * Requires OPENAI_API_KEY (and optional MODEL_EVAL_CASES=id1,id2).
 */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/model-eval.live.test.ts"],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 60_000,
    reporters: ["default"],
  },
});
