import { describe, expect, it } from "vitest";
import { shouldAttachLucyRuntimeEngine } from "../src/services/chat.service.js";
import type { PublicEmployee } from "@workee/shared";

const lucy: PublicEmployee = {
  id: "lucy-1",
  kind: "digital",
  protected: true,
  name: "לוסי",
  surname: "",
  nickname: "לוסי",
  email: null,
  phone: null,
  model: "gpt-4.1-mini",
  temperature: 0,
  instructions: "Lucy full base prompt",
  isOwner: false,
};

const filePrompt = "Lucy full base prompt";

describe("shouldAttachLucyRuntimeEngine", () => {
  it("attaches Lucy engine for the protected Lucy worker", () => {
    expect(shouldAttachLucyRuntimeEngine(lucy, [lucy], filePrompt)).toBe(true);
  });

  it("attaches Lucy engine when another worker inherited Lucy's prompt text", () => {
    const clone: PublicEmployee = {
      ...lucy,
      id: "lucy-2",
      protected: false,
      name: "לוסי2",
      nickname: "לוסי2",
      instructions: "Lucy full base prompt",
    };
    expect(shouldAttachLucyRuntimeEngine(clone, [lucy, clone], filePrompt)).toBe(
      true,
    );
  });

  it("does not attach Lucy engine for a custom worker prompt", () => {
    const custom: PublicEmployee = {
      ...lucy,
      id: "lucy-2",
      protected: false,
      name: "לוסי2",
      nickname: "לוסי2",
      instructions: "You are a terse travel agent. Never mention shopping lists.",
    };
    expect(
      shouldAttachLucyRuntimeEngine(custom, [lucy, custom], filePrompt),
    ).toBe(false);
  });
});
