import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLlmConfig, loadLlmResponseFormat } from "../src/config/llm.js";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("LLM action schema", () => {
  it("loads Lucy json_schema from LLM.action.json", () => {
    const format = loadLlmResponseFormat(repoRoot);

    expect(format).toMatchObject({
      type: "json_schema",
      name: "lucy_metadata_response",
      strict: false,
    });
    expect(format?.schema.required).toEqual(["response", "metadata"]);
    expect(format?.schema.properties).toMatchObject({
      response: { type: "string" },
      metadata: { type: "object" },
    });
  });

  it("attaches the schema when loading Lucy config", () => {
    const config = loadLlmConfig(repoRoot);

    expect(config.responseFormat?.name).toBe("lucy_metadata_response");
    expect(config.systemMessage).toContain("metadata");
    expect(config.systemMessage).toContain("metadata.query");
    expect(config.systemMessage).toContain("never emit query report");
    expect(config.systemMessage).toContain("USER-FACING LANGUAGE");
    expect(config.systemMessage).toContain("compose_source");
    expect(config.systemMessage).toContain("git_log");
    expect(config.systemMessage).toContain("PLATFORM INTERNAL");
    expect(config.systemMessage).toContain("since the last report");
    expect(config.systemMessage).toContain("compose_lookback_hours");
    expect(config.systemMessage).toContain("last_report_sha");
    expect(config.systemMessage).toContain("RECENT_OUTBOUND");
    expect(config.systemMessage).toContain("AFTER A CODE DIGEST");
    expect(config.systemMessage).toContain("GIT DIGEST CLOCK REQUIRED");
    expect(config.systemMessage).toContain("EXAMPLE NAMES ARE NOT REAL");
    expect(config.systemMessage).toContain("SNOOZE / REMIND AGAIN");
    expect(config.systemMessage).toContain("FULL DUMP");
    expect(config.systemMessage).toContain("כל מה ששמור");
    expect(config.systemMessage).toContain("רשימת קניות משותפת");
    expect(config.systemMessage).toContain("confirm_share");
    expect(config.systemMessage).toContain("FORBIDDEN: «לרשימת הקניות שלך»");
    expect(config.systemMessage).toContain("TELL vs ASSIGN");
    expect(config.systemMessage).toContain("תגידי לטל לקנות");
    expect(config.systemMessage).toContain("TIMED TASK WITHOUT CLOCK");
    expect(config.systemMessage).toContain("רוצה שאשלח לך תזכורת");
  });
});
