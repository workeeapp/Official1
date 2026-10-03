import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,
    // Phase 4 live Lucy eval — separate config / workflow (needs OPENAI_API_KEY).
    exclude: ["**/node_modules/**", "**/dist/**", "**/model-eval.live.test.ts"],
    reporters: ci
      ? [
          "default",
          ["junit", { outputFile: "./test-results/junit.xml" }],
          ["html", { outputFile: "./test-results/index.html", open: "never" }],
        ]
      : ["default"],
  },
});
