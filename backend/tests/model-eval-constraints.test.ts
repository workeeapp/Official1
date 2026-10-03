import { describe, expect, it } from "vitest";
import type { LlmMetadata } from "@workee/shared";
import {
  evaluateConstraints,
  type ModelEvalConstraint,
} from "../src/eval/constraints.js";
import { loadModelEvalCorpus } from "../src/eval/corpus.js";

function meta(partial: Partial<LlmMetadata>): LlmMetadata {
  return {
    lists: [],
    filing: [],
    messages: [],
    reminders: [],
    directory: [],
    jobs: [],
    hold: null,
    confirm: null,
    handoff: null,
    query: null,
    ...partial,
  };
}

describe("Phase 4 constraint checkers", () => {
  it("loads the seeded corpus", () => {
    const corpus = loadModelEvalCorpus();
    expect(corpus.cases.length).toBeGreaterThanOrEqual(10);
    expect(corpus.passRate).toBeGreaterThan(0);
    expect(corpus.cases.map((row) => row.id)).toContain("filing-remove-email-code");
  });

  it("passes filing remove constraints", () => {
    const constraints: ModelEvalConstraint[] = [
      { type: "filing_has_action", action: "remove_filing" },
      { type: "lists_empty" },
    ];
    const result = evaluateConstraints(
      constraints,
      meta({
        filing: [
          {
            action: "remove_filing",
            itemName: "קוד לכניסה לחשבון אימייל",
            itemInfo: "",
            itemDescription: "",
            targets: [],
          },
        ],
      }),
      "נמחק",
    );
    expect(result.ok).toBe(true);
  });

  it("fails when lists.remove is used instead of remove_filing", () => {
    const result = evaluateConstraints(
      [
        { type: "filing_has_action", action: "remove_filing" },
        { type: "lists_empty" },
      ],
      meta({
        lists: [
          {
            action: "remove",
            listType: "tasks",
            listName: "",
            items: [{ "שם מטלה": "קוד" }],
            targets: [],
          },
        ],
      }),
      "נמחק",
    );
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/filing|lists/i);
  });

  it("accepts hold or confirm for bulk delete", () => {
    const constraints: ModelEvalConstraint[] = [
      {
        type: "any",
        constraints: [
          { type: "lists_has_action", action: "remove", listType: "tasks", minCount: 2 },
          { type: "hold_or_confirm" },
        ],
      },
    ];
    expect(
      evaluateConstraints(
        constraints,
        meta({
          hold: {
            kind: "lists",
            need: "confirm",
            directory: [],
            lists: [],
            reminders: [],
            filing: [],
            messages: [],
          },
        }),
        "למחוק את כל המטלות?",
      ).ok,
    ).toBe(true);
  });

  it("rejects silent multi-domain wipe", () => {
    const result = evaluateConstraints(
      [{ type: "no_silent_multi_domain_wipe" }],
      meta({
        lists: [
          {
            action: "remove",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "חלב" }],
            targets: [],
          },
        ],
        filing: [
          {
            action: "remove_filing",
            itemName: "קוד",
            itemInfo: "",
            itemDescription: "",
            targets: [],
          },
        ],
      }),
      "מחקתי הכל",
    );
    expect(result.ok).toBe(false);
  });

  it("rejects invented reminder clocks", () => {
    const result = evaluateConstraints(
      [{ type: "no_invented_reminder_add" }],
      meta({
        reminders: [
          {
            action: "add",
            item: "משהו",
            listType: "tasks",
            date: "",
            time: "09:00",
            repeat: "once",
            ping: ["טל"],
            targets: ["טל"],
            text: "משהו",
            inSeconds: null,
            everyCount: null,
            everyUnit: null,
            weekdays: null,
            confirmed: false,
            compose: false,
            composeSource: "",
            composeLookbackHours: 0,
          },
        ],
      }),
      "אוקיי",
    );
    expect(result.ok).toBe(false);
  });
});
