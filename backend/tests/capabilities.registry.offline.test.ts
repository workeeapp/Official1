import { describe, expect, it } from "vitest";
import {
  formatCapabilityRegistryPromptBlock,
  formatMemberCapabilityCatalogHe,
  formatMemberCapabilityPromptRule,
} from "../src/services/capabilities.registry.js";

describe("capabilities.registry — VALUE DISCOVERY default", () => {
  it("member prompt defaults to VALUE DISCOVERY, not FULL catalog dump", () => {
    const rule = formatMemberCapabilityPromptRule();
    expect(rule).toContain("VALUE DISCOVERY");
    expect(rule).toContain("FORBIDDEN on these asks: FULL catalog");
    expect(rule).toMatch(/2–3|2-3/);
    expect(rule).toContain("ONE natural question");
    // Full list remains available only on explicit ask.
    expect(rule).toContain("Only on that explicit full-list ask");
    expect(rule).toContain(formatMemberCapabilityCatalogHe());
  });

  it("member block still grounds supported surfaces (no invent)", () => {
    const block = formatCapabilityRegistryPromptBlock("member");
    expect(block).toContain("חיפוש מאומת");
    expect(block).toContain("קולנוע");
    expect(block).toContain("VALUE DISCOVERY");
  });

  it("guest block stays guest-scoped", () => {
    const guest = formatCapabilityRegistryPromptBlock("guest");
    expect(guest).toContain("לוסי-אורח");
    expect(guest).not.toContain("חיפוש מאומת");
  });
});
