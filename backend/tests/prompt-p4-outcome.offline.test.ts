/**
 * Prompt alignment P4 (offline): outcome over form. The prompt says what Lucy
 * must achieve, not a fixed sentence or a fixed-size answer. The server-side
 * failure reply for a too-fast repeat (SUB_HOURLY_REFUSAL) is unchanged —
 * it is the apply-failure override, covered by chat.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const config = (JSON.parse(readFileSync(resolve(process.cwd(), "..", "LLM.config.json"), "utf8")) as {
  systemMessage: string[];
}).systemMessage.join("\n");
const chat = readFileSync(resolve(process.cwd(), "src/services/chat.service.ts"), "utf8");

describe("P4: outcome over form", () => {
  it("capabilities: a clear picture fitted to the ask (whole range vs one area), not always the full catalog", () => {
    expect(config).not.toContain("When asked what you can do: full catalog in Hebrew");
    expect(config).toContain("a general ask gets the whole range, an ask about one area gets that area");
    // Unchanged requirements.
    expect(config).toContain("Lead with managing any list. Empty actions.");
    expect(config).toContain("Do not answer capabilities from EMPLOYEE_SAVED_DATA");
  });

  it("too-fast repeat: no actions + the 5-minute minimum, no prescribed sentence", () => {
    expect(chat).not.toContain("answer «אי אפשר לקבוע חזרה כל פחות מ־5 דקות");
    expect(chat).toContain("→ no actions; answer that a repeat can be at most every 5 minutes (never in seconds) and offer every 5 minutes");
  });

  it("calendar repeat without a time: ask for the time, reminders empty", () => {
    expect(chat).not.toContain("ask באיזו שעה? with reminders empty");
    expect(chat).toContain("missing → ask for the time, with reminders empty.");
  });
});
