import { defineConfig } from "vitest/config";

/**
 * offline track (default `npm test`): unit + offline tests that need no
 * database and no model. Other tracks have their own configs:
 *   db       → vitest.db.config.ts        (*.db.test.ts; approved workee_test)
 *   eval-db  → vitest.eval-db.config.ts   (*.eval-db.test.ts; locked eval env)
 *   live     → vitest.model-eval.config.ts (*.live.test.ts; OpenAI)
 * Every test file belongs to exactly one track (by file suffix).
 */
export default defineConfig({
  test: {
    environment: "node",
    // setup-offline-track first: invalid DATABASE_URL, no approval (no DB in this track).
    setupFiles: ["./tests/setup-offline-track.ts", "./tests/setup.ts"],
    fileParallelism: false,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.db.test.ts",
      "**/*.eval-db.test.ts",
      "**/*.live.test.ts",
    ],
  },
});
