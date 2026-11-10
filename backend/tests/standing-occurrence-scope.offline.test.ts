/**
 * STANDING TASK — one date vs the whole series (prompt contract, offline).
 * LIVE `p3-one-occurrence-or-series-asks` (2026-11-10): «תזיזי את החוג של נועה
 * של יום שלישי ל־18:00» changed every Tuesday on a guess. A new time / day on the
 * series' own weekday with no date and no scope word is unclear → ask.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chat = readFileSync(resolve(process.cwd(), "src/services/chat.service.ts"), "utf8");

describe("standing task: one date vs every week", () => {
  it("the ask stays: name both alternatives, lists empty", () => {
    expect(chat).toContain("ask whether the change is only for that date or for every <weekday>, naming both, with lists empty");
  });

  it("weekday / task + new time, no date, no scope word → unclear; no guess either way", () => {
    expect(chat).toContain("It IS unclear when they name the series' own weekday or the task itself with a new time or day but no date and no scope word");
    expect(chat).toContain("FORBIDDEN changing the whole series or one date on a guess");
  });

  it("clear cases act: a date / «הקרוב» → one date; «מעכשיו / תמיד» → the series", () => {
    expect(chat).toContain("It is clear only with a date or «הקרוב / השבוע / רק הפעם» (one date)");
    expect(chat).toContain("«מעכשיו / מהשבוע הבא / תמיד / מעכשיו והלאה / בקביעות» (the series)");
  });
});
