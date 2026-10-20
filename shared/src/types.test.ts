import { describe, expect, it } from "vitest";
import {
  GUEST_LUCY_NAME,
  isGuestEmployee,
  isGuestLucy,
  workspaceDigitals,
  workspaceHumans,
} from "./types.js";

describe("guest employees", () => {
  it("detects WhatsApp guest shells", () => {
    expect(
      isGuestEmployee({
        kind: "human",
        name: "אורח",
        nickname: "אורח …1495",
      }),
    ).toBe(true);
    expect(
      isGuestEmployee({
        kind: "human",
        name: "טל",
        nickname: "טל",
      }),
    ).toBe(false);
    expect(
      isGuestEmployee({
        kind: "digital",
        name: "אורח",
        nickname: "אורח",
      }),
    ).toBe(false);
  });

  it("hides guests from workspace humans", () => {
    const rows = workspaceHumans([
      { kind: "human" as const, name: "טל", nickname: "טל" },
      { kind: "human" as const, name: "אורח", nickname: "אורח …1495" },
      { kind: "digital" as const, name: "לוסי", nickname: "לוסי" },
    ]);
    expect(rows.map((row) => row.name)).toEqual(["טל"]);
  });

  it("detects לוסי-אורח and hides her from Chat-with digitals", () => {
    expect(
      isGuestLucy({
        kind: "digital",
        name: GUEST_LUCY_NAME,
        nickname: GUEST_LUCY_NAME,
      }),
    ).toBe(true);
    expect(
      isGuestLucy({
        kind: "digital",
        name: "לוסי",
        nickname: "לוסי",
      }),
    ).toBe(false);
    const digitals = workspaceDigitals([
      { kind: "digital" as const, name: "לוסי", nickname: "לוסי" },
      {
        kind: "digital" as const,
        name: GUEST_LUCY_NAME,
        nickname: GUEST_LUCY_NAME,
      },
      { kind: "human" as const, name: "טל", nickname: "טל" },
    ]);
    expect(digitals.map((row) => row.name)).toEqual(["לוסי"]);
  });
});
