/**
 * eval-db track only (runs with tests/setup-eval-env.ts): the real
 * `.env.live-full-eval` must lock DATABASE_URL to the approved workee_test URL
 * and disable WhatsApp outbound + reminder fire. Moved out of the offline file
 * so it always runs in its own track instead of a silent skipIf.
 */
import { describe, expect, it } from "vitest";

describe("eval-db vitest setup (real .env.live-full-eval)", () => {
  it("after setup-eval-env, DATABASE_URL exactly matches approved workee_test URL", () => {
    expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
    expect(process.env.DATABASE_URL).toBeTruthy();
    expect(process.env.WORKEE_APPROVED_TEST_DATABASE_URL).toBeTruthy();
    expect(process.env.DATABASE_URL).toBe(
      process.env.WORKEE_APPROVED_TEST_DATABASE_URL,
    );
    const db = new URL(process.env.DATABASE_URL!).pathname
      .replace(/^\//, "")
      .split("/")[0];
    expect(db).toBe("workee_test");
    expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
    expect(process.env.WORKEE_DISABLE_REMINDER_FIRE).toBe("1");
  });
});
