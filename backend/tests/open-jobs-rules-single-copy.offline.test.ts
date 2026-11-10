/**
 * Open-job rules: ONE authoritative copy (OPEN JOBS RULES in the session
 * instructions). LLM.config only points to it; the per-turn OPEN_JOBS header
 * describes the rows (+ per-viewer phrasing) and points to it. Behavior is
 * pinned by the LIVE `open-jobs` cases (7, production path).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDefaultEvalFixtures } from "../src/eval/eval-prompt-source.js";
import { buildLucyInstructions } from "../src/services/chat.service.js";

const config = (JSON.parse(readFileSync(resolve(process.cwd(), "..", "LLM.config.json"), "utf8")) as {
  systemMessage: string[];
}).systemMessage.join("\n");
const { employees, worker } = buildDefaultEvalFixtures("טל", { includeMichal: false });
const instructions = buildLucyInstructions({
  digital: worker,
  employees,
  speaker: "טל",
  speakerIsOwner: true,
  guestSpeaker: false,
  pendingInvite: null,
  consultFrom: "",
});
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("open-job rules: one authoritative copy", () => {
  it("LLM.config no longer carries its own copy — it points to OPEN JOBS RULES", () => {
    expect(config).toContain("the full rules are OPEN JOBS RULES (session instructions; the only copy)");
    expect(config).not.toContain("OPEN_JOBS (complete for thin path");
    expect(config).not.toContain("• COUNTER (subject names a DIFFERENT slot)");
    expect(config).not.toContain("• RAISE (raisable=true and viewer_is=subject)");
  });

  it("the production instructions carry each rule exactly once", () => {
    expect(count(instructions, "OPEN JOBS RULES — the only copy")).toBe(1);
    for (const head of [
      "COUNTER: the subject names a DIFFERENT slot",
      "RAISING (mandatory when raisable=true and viewer_is=subject)",
      "BOOK A MEETING when the job's ask",
      "RANGE BOOKINGS:",
      "SNOOZE: «תזכירי לי בעוד 10 דקות»",
      "CANCEL / STOP THE CHECK:",
      "URGENCY FOLLOW-UP (critical)",
      "OVERDUE TASKS (overdue_tasks=true",
      "STALE UNDATED (stale_undated=true)",
    ]) {
      expect(count(instructions, head), head).toBe(1);
    }
  });

  it("nothing unique was lost in the merge", () => {
    expect(instructions).toContain("product Hebrew only — never say job, job_id, expects_reply or OPEN_JOBS");
    expect(instructions).toContain("Never open a second task row for the same job.");
    expect(instructions).toContain("After that meeting save, apply POST-SAVE REMINDER OFFER unless they already asked for a ping.");
    expect(instructions).toContain("an unanswered reminder-schedule / PING AFTER CHORE ask (a soft post-save reminder offer alone does not block a raise)");
    expect(instructions).toContain("Urgent and «לא כרגע» with no time → offer a short snooze once.");
    expect(instructions).toContain("follow_ups_left=0 → say they still have not answered");
    expect(instructions).toContain("show_dump=tasks + show_dump_about=YOUR display name");
    expect(instructions).toContain("אין לי משימות");
    // Overdue / stale flows (moved out of the per-turn header).
    expect(instructions).toContain("buttons סגירה / עדכן מועד להיום (and הצג את המשימות when raise omits some overdue_titles)");
    expect(instructions).toContain("buttons סגירה + להוסיף תאריך");
  });

  it("the OPEN_JOBS header describes rows + per-viewer phrasing and points to the rules (no rule copies)", () => {
    const source = readFileSync(resolve(process.cwd(), "src/services/jobs.service.ts"), "utf8");
    expect(source).toContain("How to raise, answer, counter, book, snooze, decline and close these rows: OPEN JOBS RULES");
    expect(source).toContain("viewer_is=subject → this speaker owes the answer");
    expect(source).not.toContain("book_on_yes=true: the person who must answer is approving");
    expect(source).not.toContain("overdue_tasks=true: engine-opened self-job for speaker tasks whose last day passed. Raise ONLY");
  });
});
