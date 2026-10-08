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

    const jobsItems = (
      format?.schema.properties as {
        metadata?: {
          properties?: {
            jobs?: {
              items?: {
                properties?: Record<string, unknown>;
                required?: string[];
              };
            };
          };
        };
      }
    )?.metadata?.properties?.jobs?.items;
    expect(jobsItems?.required).toEqual(
      expect.arrayContaining(["action", "job_id"]),
    );
    expect(jobsItems?.properties).toMatchObject({
      action: { type: "string" },
      job_id: { type: "string" },
      answer_text: { type: "string" },
      report_text: { type: "string" },
    });
  });

  it("attaches the schema when loading Lucy config", () => {
    const config = loadLlmConfig(repoRoot);

    expect(config.responseFormat?.name).toBe("lucy_metadata_response");
    expect(config.systemMessage).toContain("metadata");
    expect(config.systemMessage).toContain("Do not emit metadata.query");
    expect(config.systemMessage).toContain("STATUS QUESTIONS");
    expect(config.systemMessage).toContain("WORKER_SAVED_DATA");
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
    expect(config.systemMessage).toContain("FULL DUMP");
    expect(config.systemMessage).toContain("כל מה ששמור");
    expect(config.systemMessage).toContain("רשימת קניות משותפת");
    expect(config.systemMessage).toContain("מה יש לי משותף עם X");
    expect(config.systemMessage).toContain("אסור לומר אין/לא מופיעות עם X");
    expect(config.systemMessage).toContain("NEVER ask for quantity");
    expect(config.systemMessage).toContain("NEVER ask for unit");
    expect(config.systemMessage).toContain("From a recipe / ingredient list");
    expect(config.systemMessage).toContain("MUST copy into כמות + יחידת מידה");
    expect(config.systemMessage).toContain("FOLLOW-UP TO YOUR QUESTION");
    expect(config.systemMessage).toContain("היום/מחר/אתמול");
    expect(config.systemMessage).toContain("bare מחר");
    expect(config.systemMessage).toContain("WHEN/TODAY");
    expect(config.systemMessage).toContain("STANDING / recurring (critical)");
    expect(config.systemMessage).toContain("next_occurrences");
    expect(config.systemMessage).toContain(
      "FORBIDDEN: empty «אין לך…» when that date appears in any next_occurrences",
    );
    expect(config.systemMessage).toContain("RECURRING IN A DATE ANSWER");
    expect(config.systemMessage).not.toContain("confirm_share");
    expect(config.systemMessage).not.toContain("PENDING_ACTION_STATE");
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
    expect(config.systemMessage).toContain("EVERY metadata.jobs entry MUST copy job_id");
    expect(config.systemMessage).toContain("נזיז ל־21:00");
    expect(config.systemMessage).toContain("A different clock time is COUNTER only");
    expect(config.systemMessage).toContain(
      "MUST end with all human participants in parentheses",
    );
    expect(config.systemMessage).toContain("פגישה נוספת בנושא פורים (עמית, טל)");
    expect(config.systemMessage).toContain("DELETE BY DAY");
    expect(config.systemMessage).toContain("תמחקי את הפגישה / המטלה ביום חמישי");
    expect(config.systemMessage).toContain("MUTATE BY ID");
    expect(config.systemMessage).toContain("item_id");
    expect(config.systemMessage).toContain("filing_id");
    expect(config.systemMessage).toContain("reminder_id");
  });
});
