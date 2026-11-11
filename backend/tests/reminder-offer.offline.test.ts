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
  it("timed tasks add → soft offer; engine may inject; never duplicate", () => {
    expect(config).toContain("OFFER WHEN THE TASK HAS A DATE AND/OR TIME");
    expect(config).toContain("Engine may inject the soft offer if you omit it after a timed add");
    expect(config).toContain("FORBIDDEN a second offer bubble when one already exists this turn");
    expect(config).toContain(
      "□ Post-save reminder offer: tasks only; after timed add always soft כן/לא (engine may inject; never duplicate; skip if reminder already requested/saved)",
    );
    expect(config).toContain("□ ONE-OFF TIMED TASK IDENTITY:");
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
