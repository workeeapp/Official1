import { defineConfig } from "vitest/config";

/**
 * eval-db track (*.eval-db.test.ts): loads `.env.live-full-eval` fail-closed
 * after the normal test setup, then runs write-capable suites against
 * workee_test. `*.live-sendchat.eval-db.test.ts` files drive the real
 * sendChatMessage with the real model (production-path scope).
 *
 * Usage (cwd backend):
 *   npm run test:eval-db                       # whole track
 *   npm run test:eval-db -- tests/<file>.eval-db.test.ts
 */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts", "./tests/setup-eval-env.ts"],
    fileParallelism: false,
    include: ["tests/**/*.eval-db.test.ts"],
  },
});
