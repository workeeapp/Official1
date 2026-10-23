import { defineConfig } from "vitest/config";

/**
 * Explicit eval-DB track: loads `.env.live-full-eval` fail-closed after the
 * normal test setup, then runs the requested suites against workee_test.
 *
 * Usage (cwd backend):
 *   npx vitest run --config vitest.eval-db.config.ts tests/load-live-full-eval-env.test.ts
 *   npm run test:eval-db -- tests/batch-a-model-apply.offline.test.ts
 *
 * Default `npm test` / vitest.config.ts is unchanged (no eval env required).
 */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts", "./tests/setup-eval-env.ts"],
    fileParallelism: false,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/model-eval.live.test.ts",
      "**/model-eval-multi-turn.live.test.ts",
      "**/model-eval-full.live.test.ts",
    ],
  },
});
