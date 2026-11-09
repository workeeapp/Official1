/**
 * Implicit save: desire ≠ decision (owner, 2026-11-10) — prompt contract.
 * «אני מעוניין ללכת למשחק… בעוד שבועיים וחצי» must not open a task; a need or
 * a decision of the speaker's own still saves immediately. Behavior: LIVE_FULL
 * tag `implicit-save` (is-* cases, production path).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const config = (JSON.parse(readFileSync(resolve(process.cwd(), "..", "LLM.config.json"), "utf8")) as {
  systemMessage: string[];
}).systemMessage.join("\n");

describe("implicit save: desire ≠ decision", () => {
  it("a need or a decision of the speaker's own saves now", () => {
    expect(config).toContain("a need or a decision of the speaker's own");
    expect(config).toContain("SAVE IMMEDIATELY this turn (B-IMPLICIT-SAVE)");
    expect(config).toContain("Buying something concrete counts as a need");
  });

  it("wanting / interest / considering an outing → at most one offer, no save; the offer is not consent", () => {
    expect(config).toContain("DESIRE ≠ DECISION");
    expect(config).toContain("is NOT a save — at most ONE short offer of a practical next step");
    expect(config).toContain("the offer is not consent");
    expect(config).not.toContain("needing to buy / do / go / arrange something trackable");
  });

  it("a vague time is never turned into an invented date", () => {
    expect(config).toContain("a vague time («בעוד שבועיים וחצי» / «בסביבות החג» / «בקרוב») is not a date: ask, or save without one");
  });

  it("pre-save checklist matches", () => {
    expect(config).toContain("clear practical intention (a need or a decision — not mere desire / interest) → lists.add NOW");
  });
});
