/**
 * Deterministic helpers for the VOICE naturalness LIVE suite (no model / DB).
 */
import { describe, expect, it } from "vitest";
import {
  loadSystemMessageFromGitCommit,
  normalizeForNearDup,
  openingPhrase,
  VOICE_AB_BASELINE_COMMIT,
  VOICE_AB_BASELINE_SHA16,
  VOICE_AB_CURRENT_COMMIT,
  VOICE_AB_CURRENT_SHA16,
} from "../src/eval/voice-naturalness.js";

describe("voice-naturalness normalize helpers", () => {
  it("treats emoji-only differences as near-duplicates", () => {
    expect(normalizeForNearDup("היי, טל 🙂")).toBe(normalizeForNearDup("היי, טל"));
  });

  it("extracts a stable opening phrase", () => {
    expect(openingPhrase("היי טל, מה נשמע?")).toBe("היי טל מה");
  });

  it("loads baseline and current VOICE prompts from known commits", () => {
    const baseline = loadSystemMessageFromGitCommit(VOICE_AB_BASELINE_COMMIT);
    const current = loadSystemMessageFromGitCommit(VOICE_AB_CURRENT_COMMIT);
    expect(baseline.sha16).toBe(VOICE_AB_BASELINE_SHA16);
    expect(current.sha16).toBe(VOICE_AB_CURRENT_SHA16);
    expect(baseline.systemMessage.includes("respond to the person and the moment")).toBe(
      false,
    );
    expect(current.systemMessage.includes("respond to the person and the moment")).toBe(
      true,
    );
  });
});
