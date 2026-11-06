import { defineConfig } from "vitest/config";

/**
 * db track: ENGINE / MODEL_APPLY harness tests (stub model, production apply)
 * and other tests that read the database. The database comes ONLY from the
 * fail-closed `.env.live-full-eval` loader (same as eval-db: approved
 * workee_test, WhatsApp outbound + reminder fire disabled) — never from the
 * shell or the product `.env`. `tests/setup-db-track.ts` then re-asserts the
 * approval, so a missing approval fails the run instead of skipping.
 *
 *   npm run test:db -w backend
 */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts", "./tests/setup-eval-env.ts", "./tests/setup-db-track.ts"],
    include: ["tests/**/*.db.test.ts"],
    fileParallelism: false,
  },
});
