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
    expect(config.systemMessage).toContain("SCHEDULED SAVED-DATA STATUS");
    expect(config.systemMessage).toContain("saved_data");
    expect(config.systemMessage).toContain("תוסיפי לי בעוד שעה מטלה");
    expect(config.systemMessage).toContain("SEND-ME STATUS vs SEND-TO-PERSON");
    expect(config.systemMessage).toContain("רשימת הקניות המשותפת");
    expect(config.systemMessage).toContain("facts plugin");
    expect(config.systemMessage).toContain("כל יום ב־9 שלחי למיכל ברכת בוקר");
    expect(config.systemMessage).toContain("Do NOT add a tasks row on the speaker");
    expect(config.systemMessage).toContain("EXAMPLE NAMES ARE NOT REAL");
    expect(config.systemMessage).toContain("SNOOZE / REMIND AGAIN");
    expect(config.systemMessage).toContain("JOB vs PLAIN REMIND");
    expect(config.systemMessage).toContain("SNOOZE (vs plain self-nudge)");
    expect(config.systemMessage).toContain("FULL DUMP");
    expect(config.systemMessage).toContain("כל מה ששמור");
    expect(config.systemMessage).toContain("רשימת קניות משותפת");
    expect(config.systemMessage).toContain("confirm_share");
    expect(config.systemMessage).toContain("FORBIDDEN: «לרשימת הקניות שלך»");
    expect(config.systemMessage).toContain("TELL vs ASSIGN");
    expect(config.systemMessage).toContain("תגידי לטל לקנות");
    expect(config.systemMessage).toContain("TIMED TASK WITHOUT CLOCK");
    expect(config.systemMessage).toContain("רוצה שאשלח לך תזכורת");
    expect(config.systemMessage).toContain("PERSONAL TASK DEFAULT");
    expect(config.systemMessage).toContain("PERSONAL TASK vs SHARED CUSTOM");
    expect(config.systemMessage).toContain("משימות לעבודה");
    expect(config.systemMessage).toContain("AFTER ASSIGN");
    expect(config.systemMessage).toContain("גם אליך");
    expect(config.systemMessage).toContain("ping Michal only");
    expect(config.systemMessage).toContain("REMIND CLOCK vs APPOINTMENT CONTEXT");
    expect(config.systemMessage).toContain("NO META / BUG / CHAT CRITIQUE ON LISTS");
    expect(config.systemMessage).toContain("הרשימה המשותפת עם עמית");
    expect(config.systemMessage).toContain("FULL DUMP TRIGGERS");
    expect(config.systemMessage).toContain("FULL DUMP — NOT these");
    expect(config.systemMessage).toContain("סכמי לי");
    expect(config.systemMessage).toContain("קניות משותפות — עם");
    expect(config.systemMessage).toContain("SHOPPING BOTH PERSONAL AND SHARED");
    expect(config.systemMessage).toContain("רשימות אישיות");
    expect(config.systemMessage).toContain("יש לך קוטג׳ לקנות");
    expect(config.systemMessage).toContain("SHARED WITH A NAMED PERSON");
    expect(config.systemMessage).toContain("שיעורי הנהיגה של מאיה");
    expect(config.systemMessage).toContain("APPLY FEEDBACK (layout)");
    expect(config.systemMessage).toContain("נמחקו מהמטלות");
    expect(config.systemMessage).toContain("SINGLE NAMED/SHARED LIST REMOVE");
    expect(config.systemMessage).toContain("DELETE ALL EXCEPT KEEP");
  });
});
