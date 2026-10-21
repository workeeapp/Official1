import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,
    // Phase 4 live Lucy eval — separate config / workflow (needs OPENAI_API_KEY).
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/model-eval.live.test.ts",
      "**/model-eval-multi-turn.live.test.ts",
      "**/model-eval-full.live.test.ts",
    ],
  },
});
