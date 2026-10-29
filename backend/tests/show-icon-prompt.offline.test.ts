/**
 * Offline prompt alignment: generic SHOW_ICON commitment rule
 * (mutate OR live capability ACTION; emit ≠ apply success).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "..");
const actionPath = resolve(root, "LLM.action.json");
const configPath = resolve(root, "LLM.config.json");

describe("SHOW_ICON generic commitment prompt", () => {
  const action = readFileSync(actionPath, "utf8");
  const config = readFileSync(configPath, "utf8");

  it("LLM.action.json SHOW_ICON is commitment-based (mutate or live ACTION)", () => {
    expect(action).toMatch(
      /SHOW_ICON:[\s\S]*?ACTION\/commitment[\s\S]*?never treat emitting an ACTION as proof that a mutation already succeeded/,
    );
    expect(action).toMatch(
      /SHOW_ICON:[\s\S]*?lists \/ filing \/ directory \/ reminders \/ jobs \/ messages mutate/,
    );
    expect(action).toMatch(
      /SHOW_ICON:[\s\S]*?weather \/ market \/ mashov \/ smartschool \/ places \/ jewish \/ routes \/ flights/,
    );
    expect(action).toMatch(
      /SHOW_ICON:[\s\S]*?acknowledgement-only responses before the server appends live facts/,
    );
    expect(action).toMatch(
      /SHOW_ICON:[\s\S]*?Leave null only for pure clarify \/ refuse \/ informational/,
    );
    expect(action).toMatch(
      /SHOW_ICON:[\s\S]*?Never mention the icon in responses/,
    );
    // Must not keep the old "successful mutate" framing as the sole trigger.
    expect(action).not.toMatch(
      /SHOW_ICON:[\s\S]*?Use 👍 when this turn successfully adds\/updates\/deletes/,
    );
  });

  it("LLM.config.json show_icon blurb matches the same commitment rule", () => {
    expect(config).toMatch(
      /--- show_icon ---[\s\S]*?commitment ACTION[\s\S]*?ack-only live turns/,
    );
    expect(config).toMatch(
      /--- show_icon ---[\s\S]*?Never claim apply success from emit alone/,
    );
    expect(config).toMatch(
      /--- show_icon ---[\s\S]*?never mention the icon in responses/,
    );
  });
});
