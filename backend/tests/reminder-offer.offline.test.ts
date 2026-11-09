/**
 * Post-save reminder offer (owner decision 2026-11-08) — prompt contract.
 * Behavior: LIVE_FULL tag `reminder-offer` (ro-* cases, production path).
 *  - offer only when a reminder would genuinely help (contextual, never mandatory);
 *  - a suggestion is not consent: no clock until an explicit yes + complete time;
 *  - explicit reminder requests are created immediately (Branch A, no offer);
 *  - never for shopping / custom lists;
 *  - when offered: a separate entry with כן/לא, in Lucy's own words.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const config = (JSON.parse(readFileSync(resolve(process.cwd(), "..", "LLM.config.json"), "utf8")) as {
  systemMessage: string[];
}).systemMessage.join("\n");

describe("post-save reminder offer", () => {
  it("offered only when useful — never mandatory", () => {
    expect(config).toContain("OFFER ONLY WHEN USEFUL (contextual judgment, never mandatory)");
    expect(config).toContain("No offer → [0] confirm only.");
    expect(config).not.toContain("FORBIDDEN a single responses entry with no offer");
    expect(config).toContain("tasks → a separate reminder offer entry only when a reminder would genuinely help");
    expect(config).toContain("□ Post-save reminder offer: tasks only, only when useful (separate entry, כן/לא); never for shopping / custom lists;");
  });

  it("when offered: separate entry, כן+לא only, own words (no prescribed sentence)", () => {
    expect(config).toContain("[1] a short reminder offer in your own words — כן+לא on THAT entry");
    expect(config).toContain("FORBIDDEN merging confirm+offer; FORBIDDEN כן/לא on confirm");
    expect(config).not.toContain("רוצה שאוסיף גם תזכורת למשימה הזו?");
  });

  it("a suggestion is not consent; explicit requests run now; never for shopping / custom", () => {
    expect(config).toContain("(3) Soft seed ≠ consent. This turn: FORBIDDEN list_type reminders");
    expect(config).toContain("Branch A — EXPLICIT REMINDER SAME TURN");
    expect(config).toContain("FORBIDDEN soft-offer bubble");
    expect(config).toContain("NEVER offer a reminder seed for those adds");
  });
});
