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

  it("requires list item text when itemTextIncludes is set", () => {
    const constraints: ModelEvalConstraint[] = [
      {
        type: "lists_has_action",
        action: "add",
        listType: "tasks",
        itemTextIncludes: "0534455366",
      },
    ];
    expect(
      evaluateConstraints(
        constraints,
        meta({
          lists: [
            {
              action: "add",
              listType: "tasks",
              listName: "",
              items: [{ "שם מטלה": "לדבר עם אורי בטלפון 0534455366" }],
              targets: [],
            },
          ],
        }),
        "שמרתי",
      ).ok,
    ).toBe(true);
    expect(
      evaluateConstraints(
        constraints,
        meta({
          lists: [
            {
              action: "add",
              listType: "tasks",
              listName: "",
              items: [{ "שם מטלה": "לדבר עם אורי" }],
              targets: [],
            },
          ],
        }),
        "שמרתי",
      ).ok,
    ).toBe(false);
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

  it("requires recurring every_count on reminders.add when asked", () => {
    const constraints: ModelEvalConstraint[] = [
      { type: "reminders_has_action", action: "add", recurring: true },
    ];
    expect(
      evaluateConstraints(
        constraints,
        meta({
          reminders: [
            {
              action: "add",
              item: "לקנות חלב",
              listType: "shopping",
              date: "",
              time: "",
              repeat: "hourly",
              ping: ["טל"],
              targets: ["טל"],
              text: "לקנות חלב",
              inSeconds: 3600,
              everyCount: 1,
              everyUnit: "hours",
              weekdays: null,
              confirmed: false,
              compose: false,
              composeSource: "",
              composeLookbackHours: 0,
            },
          ],
        }),
        "אזכיר כל שעה",
      ).ok,
    ).toBe(true);
    expect(
      evaluateConstraints(
        constraints,
        meta({
          reminders: [
            {
              action: "add",
              item: "לקנות חלב",
              listType: "shopping",
              date: "",
              time: "08:00",
              repeat: "once",
              ping: ["טל"],
              targets: ["טל"],
              text: "לקנות חלב",
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
        "שמרתי",
      ).ok,
    ).toBe(false);
  });

  it("forbids banned response phrases", () => {
    const constraints: ModelEvalConstraint[] = [
      { type: "response_forbids_any", needles: ["לאיזו", "ווטסאפ"] },
    ];
    expect(
      evaluateConstraints(constraints, meta({}), "מוחקת את שתיהן").ok,
    ).toBe(true);
    expect(
      evaluateConstraints(
        constraints,
        meta({}),
        "לאיזו מ־2 המטלות התכוונת?",
      ).ok,
    ).toBe(false);
  });

  it("requires jobs.open with answer_text for until-done", () => {
    const constraints: ModelEvalConstraint[] = [
      { type: "jobs_has_action", action: "open", requireAsk: true },
    ];
    expect(
      evaluateConstraints(
        constraints,
        meta({
          jobs: [
            {
              action: "open",
              jobId: "",
              answerText: "לקנות חלב",
              reportText: "",
              time: "",
              in: 3600,
              date: "",
            },
          ],
        }),
        "אנדנד עד שתקנה",
      ).ok,
    ).toBe(true);
    expect(
      evaluateConstraints(
        constraints,
        meta({
          jobs: [
            {
              action: "open",
              jobId: "",
              answerText: "",
              reportText: "",
              time: "",
              in: null,
              date: "",
            },
          ],
        }),
        "שמרתי",
      ).ok,
    ).toBe(false);
  });

  it("includes exact-list-or-ask and Lucy nudge/delete journeys in the corpus", () => {
    const ids = loadModelEvalCorpus().cases.map((row) => row.id);
    expect(ids).toContain("list-ambiguous-name-ask");
    expect(ids).toEqual(
      expect.arrayContaining([
        "list-filtered-multi-delete",
        "self-nudge-contact-topic-no-whatsapp",
        "self-nudge-recurring-until-done",
        "reminder-stop-nudge-keep-item",
      ]),
    );
  });
});
