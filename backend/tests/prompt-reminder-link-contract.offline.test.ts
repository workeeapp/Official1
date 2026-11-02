/**
 * Stage 1 — Prompt contract for user-task ↔ reminder linking (offline).
 * Reads LLM.config.json / LLM.action.json only. No Prisma / OpenAI / WhatsApp.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const configText = readFileSync(resolve(root, "LLM.config.json"), "utf8");
const actionText = readFileSync(resolve(root, "LLM.action.json"), "utf8");

describe("Prompt reminder link contract (Stage 1)", () => {
  it("NEW path requires items[].remind; forbids mint UUID", () => {
    expect(configText).toMatch(/items\[\]\.remind/);
    expect(configText).toMatch(/FORBIDDEN minting UUID/);
    expect(configText).not.toMatch(/mint a fresh UUID/);
    expect(actionText).not.toMatch(/mint a fresh UUID/);
    expect(actionText).toMatch(/Preferred\/required nested clock/);
  });

  it("EXISTING path requires ESD item_id; forbids title-only", () => {
    expect(configText).toMatch(/EMPLOYEE_SAVED_DATA/);
    expect(configText).toMatch(/FORBIDDEN title-only/);
    expect(actionText).toMatch(/EXISTING shopping\/tasks row/);
    expect(actionText).toMatch(/FORBIDDEN title-only linking/);
  });

  it("until-done stays jobs / expects_reply; not recurrence clocks", () => {
    expect(configText).toMatch(/UNTIL-DONE NUDGE/);
    expect(configText).toMatch(/expects_reply:true/);
    expect(configText).toMatch(
      /FORBIDDEN converting this to list_type reminders recurrence/,
    );
  });

  it("worker is not the user-task↔clock link contract", () => {
    expect(configText).toMatch(/LINK CONTRACT/);
    expect(configText).toMatch(/NOT part of that link contract/);
    expect(configText).toMatch(
      /FORBIDDEN treating worker emit\/omit as what links/,
    );
    expect(configText).toMatch(/not required for the join/);
    expect(configText).toMatch(
      /YOUR \u05dc\u05d4\u05d6\u05db\u05d9\u05e8 is separate product tracking|separate product tracking/,
    );
  });

  it("NEW/EXISTING link paths remain remind / ESD item_id", () => {
    expect(configText).toMatch(/NEW: items\[\]\.remind|items\[\]\.remind on the add/);
    expect(configText).toMatch(/EXISTING: list_type reminders \+ ESD item_id|ESD item_id/);
  });
});
