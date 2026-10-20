/**
 * Phase 1 — shared Studio scenario schema + track-aware validation.
 * Pure unit tests; no DB, no LLM, no published-suite writes.
 */
import { describe, expect, it } from "vitest";
import {
  phase4CaseToStudioScenario,
  type StudioScenario,
} from "../src/eval/corpus.js";
import { validateStudioScenario } from "../src/eval/studio-validate.js";

const engineFixture = { lists: [], list_ops: [], filing: [] };

describe("Phase 1 Studio scenario validation", () => {
  it("accepts a valid single-turn ENGINE scenario", () => {
    expect(() =>
      validateStudioScenario({
        id: "eng-1",
        track: "ENGINE",
        turns: [
          {
            utterance: "תוסיפי חלב",
            fixtureMetadata: {
              lists: [
                {
                  action: "add",
                  list_type: "shopping",
                  items: [{ "שם פריט": "חלב" }],
                },
              ],
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("accepts a valid multi-turn ENGINE scenario", () => {
    expect(() =>
      validateStudioScenario({
        id: "eng-mt",
        track: "ENGINE",
        turns: [
          {
            utterance: "תוסיפי חלב",
            fixtureMetadata: engineFixture,
          },
          {
            utterance: "קניתי",
            fixtureMetadata: {
              lists: [{ action: "remove", list_type: "shopping", items: [] }],
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects ENGINE with empty turns", () => {
    expect(() =>
      validateStudioScenario({
        id: "eng-empty",
        track: "ENGINE",
        turns: [],
      }),
    ).toThrow(/turn/i);
  });

  it("rejects ENGINE turn missing fixtureMetadata", () => {
    expect(() =>
      validateStudioScenario({
        id: "eng-nofix",
        track: "ENGINE",
        turns: [{ utterance: "תמחק חלב", fixtureMetadata: null }],
      }),
    ).toThrow(/fixtureMetadata/i);
  });

  it("rejects ENGINE multi-turn when a later turn lacks fixtureMetadata", () => {
    expect(() =>
      validateStudioScenario({
        id: "eng-mid-missing",
        track: "ENGINE",
        turns: [
          { utterance: "a", fixtureMetadata: engineFixture },
          { utterance: "b" },
        ],
      }),
    ).toThrow(/fixtureMetadata/i);
  });

  it("accepts a valid single-turn MODEL scenario without gold ACTION fixture", () => {
    expect(() =>
      validateStudioScenario({
        id: "mod-1",
        track: "MODEL",
        turns: [
          {
            utterance: "תוסיפי חלב לקניות",
            setup: { lists: [] },
            constraints: [{ type: "lists_has_action", action: "add", listType: "shopping" }],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("accepts a valid multi-turn MODEL scenario without fixtureMetadata", () => {
    expect(() =>
      validateStudioScenario({
        id: "mod-mt",
        track: "MODEL",
        setup: {
          lists: [
            {
              list_type: "tasks",
              items: [
                { item_id: "t1", "שם מטלה": "א" },
                { item_id: "t2", "שם מטלה": "ב" },
              ],
            },
          ],
        },
        turns: [
          {
            utterance: "תמחק מטלה",
            constraints: [
              { type: "lists_empty" },
              { type: "response_looks_like_ask" },
            ],
          },
          {
            utterance: "1",
            setup: {
              lists: [
                {
                  list_type: "tasks",
                  items: [
                    { item_id: "t1", "שם מטלה": "א" },
                    { item_id: "t2", "שם מטלה": "ב" },
                  ],
                },
              ],
            },
            constraints: [
              {
                type: "lists_remove_item_ids",
                listType: "tasks",
                itemIds: ["t1"],
              },
            ],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects MODEL turn without constraints", () => {
    expect(() =>
      validateStudioScenario({
        id: "mod-noconstraint",
        track: "MODEL",
        turns: [{ utterance: "שלום" }],
      }),
    ).toThrow(/constraint/i);
  });

  it("rejects MODEL turn that uses fixtureMetadata as a decision fixture", () => {
    expect(() =>
      validateStudioScenario({
        id: "mod-with-fixture",
        track: "MODEL",
        turns: [
          {
            utterance: "תוסיפי חלב",
            fixtureMetadata: engineFixture,
            constraints: [{ type: "lists_empty" }],
          },
        ],
      }),
    ).toThrow(/fixtureMetadata/i);
  });

  it("rejects unknown track", () => {
    expect(() =>
      validateStudioScenario({
        id: "bad",
        track: "E2E",
        turns: [{ utterance: "x", fixtureMetadata: engineFixture }],
      }),
    ).toThrow(/track/i);
  });

  it("adapts a Phase-4 flat MODEL case into a single-turn StudioScenario", () => {
    const adapted = phase4CaseToStudioScenario({
      id: "p4-sample",
      tag: "happy",
      utterance: "קניתי חלב",
      setup: { lists: [] },
      constraints: [
        {
          type: "lists_remove_item_ids",
          listType: "shopping",
          itemIds: ["x"],
        },
      ],
    });
    const expected: StudioScenario = {
      id: "p4-sample",
      track: "MODEL",
      tag: "happy",
      setup: { lists: [] },
      turns: [
        {
          utterance: "קניתי חלב",
          setup: { lists: [] },
          constraints: [
            {
              type: "lists_remove_item_ids",
              listType: "shopping",
              itemIds: ["x"],
            },
          ],
        },
      ],
    };
    expect(adapted).toEqual(expected);
    expect(() => validateStudioScenario(adapted)).not.toThrow();
  });
});
