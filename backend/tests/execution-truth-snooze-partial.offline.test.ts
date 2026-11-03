/**
 * Option B snooze: REMINDER_ONLY_PARTIAL only when a speaker-book list add
 * was requested and missed — not when only worker tracking failed.
 */
import { describe, expect, it } from "vitest";
import {
  REMINDER_ONLY_PARTIAL,
  correctExecutionTruthReply,
} from "../src/services/employee-records.service.js";

function setResponse(_reply: string, response: string): string {
  return JSON.stringify({
    responses: [{ text: response }],
    metadata: { lists: [], reminders: [], messages: [] },
  });
}

function spokenOf(reply: string): string {
  return JSON.parse(reply).responses[0].text as string;
}

const draftClaimBoth = JSON.stringify({
  responses: [{ text: "שמרתי תזכורת והוספתי משימה" }],
  metadata: { lists: [], reminders: [], messages: [] },
});

describe("correctExecutionTruthReply — snooze Option B vs speaker PARTIAL", () => {
  it("worker add missed + reminder ok + no speaker add requested → reminder success", () => {
    const out = correctExecutionTruthReply({
      reply: draftClaimBoth,
      spoken: "שמרתי תזכורת והוספתי משימה",
      appliedListAdd: false,
      appliedSpeakerListAdd: false,
      requestedSpeakerListAdd: false,
      appliedReminderAdd: true,
      reminderAddFallback: "שמרתי תזכורת «להוריד את סקאזי לטיול ערב».",
      setResponse,
    });
    expect(spokenOf(out)).toBe("שמרתי תזכורת «להוריד את סקאזי לטיול ערב».");
    expect(spokenOf(out)).not.toBe(REMINDER_ONLY_PARTIAL);
  });

  it("speaker add requested + missed + reminder ok → PARTIAL stays", () => {
    const out = correctExecutionTruthReply({
      reply: draftClaimBoth,
      spoken: "שמרתי תזכורת והוספתי משימה",
      appliedListAdd: false,
      appliedSpeakerListAdd: false,
      requestedSpeakerListAdd: true,
      appliedReminderAdd: true,
      reminderAddFallback: "שמרתי תזכורת «לקנות חלב».",
      setResponse,
    });
    expect(spokenOf(out)).toBe(REMINDER_ONLY_PARTIAL);
  });
});
