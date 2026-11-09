/**
 * Lucy's internal tasks are never offered for viewing (owner decision 2026-11-10)
 * — prompt contract (offline). Server enforcement is covered by
 * employee-targets.test.ts, result-navigation.offline.test.ts and
 * lucy-internal-tasks-not-offered.eval-db.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const config = (JSON.parse(readFileSync(resolve(process.cwd(), "..", "LLM.config.json"), "utf8")) as {
  systemMessage: string[];
}).systemMessage.join("\n");

describe("prompt: Lucy's internal tasks are never offered", () => {
  it("POST-MUTATE SHOW forbids any button / view of YOUR internal tasks; explicit ask = inventory dump", () => {
    expect(config).toContain("YOUR internal tasks (WATCH / להזכיר / לשלוח הודעה / לשלוח נדנוד — targets:[YOUR display name]) never get a show button");
    expect(config).toContain("YOUR tasks are shown only when the speaker explicitly asks (INVENTORY: show_dump=tasks + show_dump_about)");
  });

  it("reminder confirm buttons: the reminder + the speaker's content, never YOUR book", () => {
    expect(config).toContain("FORBIDDEN any button to YOUR book");
    expect(config).not.toContain('{label:"יום ג׳ אצלך", command:"מה יש לך ביום שלישי"}');
    expect(config).toContain('buttons:[{label:"מה לקנות", command:"מה יש לי לקנות"}]');
  });

  it("WATCH ack: no show button for YOUR watch task", () => {
    expect(config).toContain("no show button for YOUR watch task");
    expect(config).not.toContain("POST-MUTATE SHOW on that ack → «המשימות שלך»");
  });
});
