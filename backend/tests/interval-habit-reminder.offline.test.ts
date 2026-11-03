/**
 * Offline contracts for interval-habit Done + Option-B snooze
 * (no LIVE; no DB apply — prompt/gate proofs).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLlmConfig } from "../src/config/llm.js";
import { reminderFireButtons } from "../src/services/outbound-text.js";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("interval habit reminder contracts (offline)", () => {
  it("prompt: interval Done is ack-only; snooze is Option B one-shot", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("INTERVAL HABIT OCCURRENCE DONE");
    expect(config.systemMessage).toContain("שתיתי");
    expect(config.systemMessage).toContain(
      "FORBIDDEN lists.remove / reminders.remove (series stays",
    );
    expect(config.systemMessage).toContain("Option B — separate one-shot");
    expect(config.systemMessage).toContain(
      "NEVER reminders.update / change fireAt or recurrence on the source interval",
    );
    expect(config.systemMessage).toContain("reschedule in place");
    expect(config.systemMessage).toContain(
      "within 2 minutes of the next fireAt",
    );
  });

  it("runtime extras teach interval Done ack-only (chat.service source)", () => {
    const src = readFileSync(
      resolve(repoRoot, "backend/src/services/chat.service.ts"),
      "utf8",
    );
    expect(src).toContain("Finished chore / past-tense Done");
    expect(src).toContain("שתיתי");
    expect(src).toContain("interval-habit clock");
    expect(src).toContain(
      "FORBIDDEN lists.remove / reminders.remove (series stays)",
    );
  });

  it("prompt + extras teach STOP SERIES CLOCK CANCEL vs Done vs blanket", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("STOP SERIES CLOCK CANCEL");
    expect(config.systemMessage).toContain("תפסיקי להזכיר לי");
    expect(config.systemMessage).toContain("אל תזכירי לי יותר");
    expect(config.systemMessage).toContain("אל תשלחי לי יותר הודעות תזכורת");
    expect(config.systemMessage).toContain(
      "FORBIDDEN reminders.remove of even one clock",
    );
    expect(config.systemMessage).toContain("MUST EMIT ACTION");
    expect(config.systemMessage).toContain("אל תזכירי לי יותר לשתות מים");
    expect(config.systemMessage).toContain("RIGHT AFTER A REMINDER PING");
    expect(config.systemMessage).toContain("RECENT_OUTBOUND.reminder_id");
    expect(config.systemMessage).toContain(
      "תפסיקי להזכיר לי את זה",
    );
    const src = readFileSync(
      resolve(repoRoot, "backend/src/services/chat.service.ts"),
      "utf8",
    );
    expect(src).toContain("STOP SERIES CLOCK CANCEL");
    expect(src).toContain("אל תשלחי לי יותר הודעות תזכורת");
    expect(src).toContain("FORBIDDEN treating Done as STOP SERIES");
    expect(src).toContain("RIGHT AFTER PING");
    expect(src).toContain("RECENT_OUTBOUND.reminder_id");
  });

  it("series fire and snooze one-shot both get נדנד + סמן כבוצע when plain ping", () => {
    const seriesFire = reminderFireButtons({
      item: "לשתות מים",
      text: "תזכורת: לשתות מים",
      composeAtFire: false,
    });
    expect(seriesFire.map((b) => b.label)).toEqual(["נדנד", "סמן כבוצע"]);

    // Option B snooze fires as its own plain ping (worker text ≈ item).
    const snoozeFire = reminderFireButtons({
      item: "לשתות מים",
      text: "לשתות מים",
      composeAtFire: false,
    });
    expect(snoozeFire).toEqual(seriesFire);
  });

  it("Option B contract: snooze must not be taught as series fireAt update", () => {
    const config = loadLlmConfig(repoRoot);
    // Explicit forbid — proves we did not choose Option A (update series).
    expect(config.systemMessage).toMatch(
      /NEVER reminders\.update \/ change fireAt or recurrence on the source interval/,
    );
    expect(config.systemMessage).toContain("ONE new one-shot reminders add");
    expect(config.systemMessage).toContain("No speaker-book wrapper for the snooze");
    expect(config.systemMessage).toContain(
      "FORBIDDEN emitting only the worker task without the one-shot clock",
    );
    expect(config.systemMessage).toContain(
      "נדנדי לי להוריד את סקאזי לטיול ערב בעוד 10 דקות",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN putting «לשלוח נדנוד» into reminders.add item/text/itemLabel",
    );
    expect(config.systemMessage).toContain(
      "item/text = the ORIGINAL chore only",
    );
  });

  it("prompt + extras: Mark-done is Done path — FORBIDDEN Option B snooze", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain(
      "FORBIDDEN converting Mark-done / «סמן כבוצע» into Option B snooze",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN treating Done as Option B snooze",
    );
    expect(config.systemMessage).toContain(
      "appointment/תור/פגישה already on tasks",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN a standalone «להזכיר ל…» clock instead of linking that item_id",
    );
    const src = readFileSync(
      resolve(repoRoot, "backend/src/services/chat.service.ts"),
      "utf8",
    );
    expect(src).toContain(
      "Option B ONLY: YOUR «לשלוח נדנוד…» task + ONE new one-shot reminders.add",
    );
    expect(src).toContain(
      "CRITICAL EXCLUSION: «סמן כבוצע» / «סמן כבוצע: <title>» after that outbound is Done",
    );
    expect(src).toContain(
      "FORBIDDEN treating Mark-done as Option B snooze",
    );
    expect(src).toContain(
      "FORBIDDEN orphan «להזכיר ל…» clock instead of that item_id link",
    );
  });

  it("whatsapp: fire-button commands skip reply-context wrap", () => {
    const src = readFileSync(
      resolve(repoRoot, "backend/src/services/whatsapp.service.ts"),
      "utf8",
    );
    expect(src).toContain("isReminderFireButtonCommand");
    expect(src).toContain("!isReminderFireButtonCommand(spoken)");
    expect(src).toContain('t.startsWith("סמן כבוצע:")');
    expect(src).toContain('t.startsWith("נדנדי לי ")');
  });
});
