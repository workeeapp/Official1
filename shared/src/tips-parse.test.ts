import { describe, expect, it } from "vitest";
import { parseLlmMetadata, parseTipKeys } from "./llm-message.js";

describe("parseTipKeys", () => {
  it("reads tip keys from metadata.tips", () => {
    expect(parseTipKeys({ tips: ["guest_terms", "guest_terms", ""] })).toEqual([
      "guest_terms",
    ]);
  });

  it("parses tips on full metadata", () => {
    const meta = parseLlmMetadata({
      lists: [],
      filing: [],
      tips: ["guest_terms"],
    });
    expect(meta.tips).toEqual(["guest_terms"]);
  });
});
