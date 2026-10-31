import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmMetadata } from "@workee/shared";
import { loadLlmConfig } from "../src/config/llm.js";
import {
  evaluateConstraints,
  type ModelEvalConstraint,
} from "../src/eval/constraints.js";
import {
  filterCasesByTags,
  loadModelEvalCorpus,
  parseModelEvalTags,
} from "../src/eval/corpus.js";
import {
  evaluateOfflineModelProposal,
  offlineStubForConstraints,
} from "../src/eval/offline-stub.js";
import {
  runModelEvalCase,
  summarizeModelEvalResults,
  type ModelEvalRunCaseResult,
} from "../src/eval/run-case.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { resolveRelativeDateLabel } from "../src/utils/relative-date.js";

const LIVE_DOMAIN_TAGS = [
  "live-weather",
  "live-market",
  "live-jewish",
  "live-flights",
  "live-places",
  "live-routes",
  "live-gtfs",
] as const;

function meta(partial: Partial<LlmMetadata> = {}): LlmMetadata {
  return {
    lists: [],
    listOps: [],
    filing: [],
    messages: [],
    reminders: [],
    directory: [],
    jobs: [],
    confirm: null,
    handoff: null,
    ...partial,
  };
}

function metaWithHold(): LlmMetadata {
  return {
    ...meta(),
    hold: {
      kind: "lists",
      need: "confirm",
      directory: [],
      lists: [],
      reminders: [],
      filing: [],
      messages: [],
    },
  } as LlmMetadata;
}

function stubResult(
  id: string,
  ok: boolean,
): ModelEvalRunCaseResult {
  return {
    id,
    tag: "happy",
    utterance: id,
    response: "",
    metadata: meta({}),
    rawReply: "",
    llmMs: 0,
    ok,
    failures: ok ? [] : ["fail"],
  };
}

describe("Phase 4 constraint checkers", () => {
  it("loads the seeded corpus with critical deletion cases", () => {
    const corpus = loadModelEvalCorpus();
    expect(corpus.cases.length).toBeGreaterThanOrEqual(10);
    expect(corpus.passRate).toBeGreaterThan(0);
    expect(corpus.cases.map((row) => row.id)).toContain("filing-remove-email-code");
    expect(corpus.criticalCaseIds).toEqual(
      expect.arrayContaining([
        "list-buy-milk",
        "list-clear-tasks",
        "list-not-filing",
        "list-named-item-delete",
        "delete-everything",
        "delete-two-named-lists",
        "delete-ambiguous-list-title",
        "delete-unresolved-list",
      ]),
    );
    expect(corpus.cases.map((row) => row.id)).not.toContain(
      "list-ambiguous-name-ask",
    );
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

  it("passes messages_has for coordination to a named target with book", () => {
    const constraints: ModelEvalConstraint[] = [
      {
        type: "messages_has",
        targetIncludes: "עמית",
        requireBook: true,
      },
      { type: "lists_empty" },
    ];
    expect(
      evaluateConstraints(
        constraints,
        meta({
          messages: [
            {
              text: "טל מבקש לתאם פגישה",
              targets: ["עמית"],
              expectsReply: true,
              book: { title: "פגישה", date: "2099-01-02", time: "10:00" },
            },
          ],
        }),
        "שלחתי לעמית",
      ).ok,
    ).toBe(true);
    expect(
      evaluateConstraints(
        constraints,
        meta({
          messages: [
            {
              text: "שלום",
              targets: ["עמית"],
              expectsReply: true,
            },
          ],
        }),
        "שלחתי",
      ).ok,
    ).toBe(false);
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

  it("itemTextIncludes ignores linked_lists names (no text-only false pass)", () => {
    const constraints: ModelEvalConstraint[] = [
      {
        type: "lists_has_action",
        action: "update",
        listType: "tasks",
        itemTextIncludes: "כיבוד",
      },
    ];
    const result = evaluateConstraints(
      constraints,
      meta({
        lists: [
          {
            action: "update",
            listType: "tasks",
            listName: "",
            items: [
              {
                item_id: "eval-item-host-bday",
                "שם מטלה": "ערב יום הולדת",
                linked_lists: [
                  {
                    list_type: "custom",
                    list_name: "כיבוד · ערב יום הולדת",
                  },
                ],
              },
            ],
            targets: [],
          },
        ],
      }),
      "חיברתי",
    );
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/missing item text/);
  });

  describe("lists_custom_create_and_link (full-mt-event-clarify-then-link shape)", () => {
    const createAndLink: ModelEvalConstraint[] = [
      {
        type: "lists_custom_create_and_link",
        listNameIncludes: "כיבוד",
        itemTextIncludes: "עוגה",
        hostListType: "tasks",
      },
    ];
    const listName = "כיבוד · ערב יום הולדת";

    it("rejects empty custom list_name with items while host links by name", () => {
      const result = evaluateConstraints(
        createAndLink,
        meta({
          lists: [
            {
              action: "add",
              listType: "custom",
              listName: "",
              items: [{ שם: "עוגה" }, { שם: "שתיה" }],
              targets: [],
            },
            {
              action: "update",
              listType: "tasks",
              listName: "",
              items: [
                {
                  item_id: "eval-item-host-bday",
                  "שם מטלה": "ערב יום הולדת",
                  linked_lists: [
                    { list_type: "custom", list_name: listName },
                  ],
                },
              ],
              targets: [],
            },
          ],
        }),
        "שמרתי",
      );
      expect(result.ok).toBe(false);
      expect(result.failures.join(" ")).toMatch(/non-empty list_name/);
    });

    it("passes named same-turn create-and-link with matching linked_lists", () => {
      const result = evaluateConstraints(
        createAndLink,
        meta({
          lists: [
            {
              action: "add",
              listType: "custom",
              listName: listName,
              items: [{ שם: "עוגה" }, { שם: "שתיה" }],
              targets: [],
            },
            {
              action: "update",
              listType: "tasks",
              listName: "",
              items: [
                {
                  item_id: "eval-item-host-bday",
                  "שם מטלה": "ערב יום הולדת",
                  linked_lists: [
                    { list_type: "custom", list_name: listName },
                  ],
                },
              ],
              targets: [],
            },
          ],
        }),
        "הוספתי כיבוד וחיברתי",
      );
      expect(result.ok, result.failures.join("; ")).toBe(true);
    });

    it("rejects when link name appears only as item text, not linked_lists", () => {
      const result = evaluateConstraints(
        createAndLink,
        meta({
          lists: [
            {
              action: "add",
              listType: "custom",
              listName: listName,
              items: [{ שם: "עוגה" }],
              targets: [],
            },
            {
              action: "update",
              listType: "tasks",
              listName: "",
              items: [
                {
                  item_id: "eval-item-host-bday",
                  "שם מטלה": `ערב יום הולדת ${listName}`,
                },
              ],
              targets: [],
            },
          ],
        }),
        "שמרתי",
      );
      expect(result.ok).toBe(false);
      expect(result.failures.join(" ")).toMatch(/linked_lists/);
    });
  });

  it("full-filing-add-simple constraints accept filing.add_filing with address info", () => {
    const constraints: ModelEvalConstraint[] = [
      {
        type: "filing_has_action",
        action: "add_filing",
        infoIncludes: "הרצל",
      },
    ];
    expect(
      evaluateConstraints(
        constraints,
        meta({
          filing: [
            {
              action: "add_filing",
              itemName: "כתובת",
              itemInfo: "רחוב הרצל 1 תל אביב",
              itemDescription: "",
              targets: [],
            },
          ],
        }),
        "תייקתי",
      ).ok,
    ).toBe(true);
    expect(
      evaluateConstraints(constraints, meta({ filing: [] }), "תייקתי").ok,
    ).toBe(false);
  });

  describe("LIVE_FULL remove-by-id (no title on remove ACTION)", () => {
    /** Same shape as 2026-10-22 LIVE_FULL failures for yogurt/milk removes. */
    const removeByIdOnly = meta({
      lists: [
        {
          action: "remove",
          listType: "shopping",
          listName: "",
          items: [{ item_id: "94c45c3e-4976-4be7-86d7-19f289d47364" }],
          targets: [],
        },
      ],
    });

    it("fails the old itemTextIncludes remove constraint (harness false negative)", () => {
      const legacy: ModelEvalConstraint[] = [
        {
          type: "lists_has_action",
          action: "remove",
          listType: "shopping",
          itemTextIncludes: "יוגורט",
        },
      ];
      const result = evaluateConstraints(
        legacy,
        removeByIdOnly,
        "הסרתי יוגורט מרשימת הקניות.",
      );
      expect(result.ok).toBe(false);
      expect(result.failures.join(" ")).toMatch(/missing item text/);
    });

    it("passes the Decision-Core-aligned remove constraint (minCount + list_ops_empty)", () => {
      const aligned: ModelEvalConstraint[] = [
        {
          type: "lists_has_action",
          action: "remove",
          listType: "shopping",
          minCount: 1,
        },
        { type: "list_ops_empty" },
      ];
      expect(
        evaluateConstraints(
          aligned,
          removeByIdOnly,
          "הסרתי יוגורט מרשימת הקניות.",
        ).ok,
      ).toBe(true);
    });
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
        metaWithHold(),
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

  it("reminders_empty rejects any reminders action", () => {
    const fail = evaluateConstraints(
      [{ type: "reminders_empty" }],
      meta({
        reminders: [
          {
            action: "add",
            item: "מים",
            listType: "tasks",
            date: "",
            time: "",
            repeat: "once",
            ping: ["טל"],
            targets: ["טל"],
            text: "מים",
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
    expect(fail.ok).toBe(false);
    const pass = evaluateConstraints(
      [{ type: "reminders_empty" }],
      meta({ reminders: [] }),
      "אוקיי",
    );
    expect(pass.ok).toBe(true);
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
    expect(ids).toContain("list-named-item-delete");
    expect(ids).toEqual(
      expect.arrayContaining([
        "list-filtered-multi-delete",
        "self-nudge-contact-topic-no-whatsapp",
        "self-nudge-recurring-until-done",
        "reminder-stop-nudge-keep-item",
        "delete-two-named-lists",
        "delete-ambiguous-list-title",
        "delete-unresolved-list",
        "self-nudge-daily-dog-0800",
        "occurrence-skip-one-day",
      ]),
    );
  });

  it("reminder-stop-nudge-keep-item requires cancel + empty lists; shopping ask wording OK", () => {
    const row = loadModelEvalCorpus().cases.find(
      (c) => c.id === "reminder-stop-nudge-keep-item",
    );
    expect(row).toBeDefined();
    const constraints = row!.constraints;
    expect(constraints.some((c) => c.type === "response_forbids_any")).toBe(
      false,
    );
    const removeMeta = meta({
      reminders: [
        {
          action: "remove",
          item: "",
          listType: "shopping",
          date: "",
          time: "",
          repeat: "once",
          ping: [],
          targets: [],
          text: "",
          inSeconds: null,
          everyCount: null,
          everyUnit: null,
          weekdays: null,
          confirmed: false,
          compose: false,
          composeSource: "",
          composeLookbackHours: 0,
          reminderId: "eval-reminder-milk-nudge",
        },
      ],
    });
    expect(
      evaluateConstraints(
        constraints,
        removeMeta,
        "עצרתי את התזכורת. למחוק גם את החלב מהקניות?",
      ).ok,
    ).toBe(true);
    expect(
      evaluateConstraints(
        constraints,
        meta({}),
        "מה תרצה שאפסיק — את התזכורת לקנות חלב או משהו אחר?",
      ).ok,
    ).toBe(false);
  });

  describe("exact deletion ID sets", () => {
    it("passes when lists.remove item_ids match exactly", () => {
      const constraints: ModelEvalConstraint[] = [
        {
          type: "lists_remove_item_ids",
          listType: "tasks",
          itemIds: ["a", "b"],
        },
      ];
      expect(
        evaluateConstraints(
          constraints,
          meta({
            lists: [
              {
                action: "remove",
                listType: "tasks",
                listName: "",
                items: [{ item_id: "b" }, { item_id: "a" }],
                targets: [],
              },
            ],
          }),
          "נמחקו",
        ).ok,
      ).toBe(true);
    });

    it("rejects missing, extra, duplicate, or wrong-type removes", () => {
      const constraints: ModelEvalConstraint[] = [
        {
          type: "lists_remove_item_ids",
          listType: "tasks",
          itemIds: ["a", "b"],
        },
      ];
      expect(
        evaluateConstraints(
          constraints,
          meta({
            lists: [
              {
                action: "remove",
                listType: "tasks",
                listName: "",
                items: [{ item_id: "a" }],
                targets: [],
              },
            ],
          }),
          "נמחק",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            lists: [
              {
                action: "remove",
                listType: "tasks",
                listName: "",
                items: [{ item_id: "a" }, { item_id: "b" }, { item_id: "c" }],
                targets: [],
              },
            ],
          }),
          "נמחק",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            lists: [
              {
                action: "remove",
                listType: "tasks",
                listName: "",
                items: [{ item_id: "a" }, { item_id: "a" }],
                targets: [],
              },
            ],
          }),
          "נמחק",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            lists: [
              {
                action: "remove",
                listType: "shopping",
                listName: "",
                items: [{ item_id: "a" }, { item_id: "b" }],
                targets: [],
              },
            ],
          }),
          "נמחק",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            lists: [
              {
                action: "add",
                listType: "tasks",
                listName: "",
                items: [{ item_id: "a" }],
                targets: [],
              },
            ],
          }),
          "נמחק",
        ).ok,
      ).toBe(false);
    });

    it("list_ops_empty accepts empty ops and rejects alter_list and delete_list", () => {
      const constraints: ModelEvalConstraint[] = [
        {
          type: "lists_remove_item_ids",
          listType: "shopping",
          itemIds: ["milk"],
        },
        { type: "list_ops_empty" },
      ];
      const removeMeta = meta({
        lists: [
          {
            action: "remove",
            listType: "shopping",
            listName: "",
            items: [{ item_id: "milk" }],
            targets: [],
          },
        ],
      });
      expect(evaluateConstraints(constraints, removeMeta, "נמחק").ok).toBe(
        true,
      );
      expect(
        evaluateConstraints(
          constraints,
          {
            ...removeMeta,
            listOps: [
              {
                action: "alter_list",
                listId: "L1",
                newName: "x",
                addColumns: [],
                removeColumns: [],
                renameColumns: [],
                addParticipants: [],
                removeParticipants: [],
              },
            ],
          },
          "נמחק",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(
          constraints,
          {
            ...removeMeta,
            listOps: [
              {
                action: "delete_list",
                listId: "L1",
                newName: "",
                addColumns: [],
                removeColumns: [],
                renameColumns: [],
                addParticipants: [],
                removeParticipants: [],
              },
            ],
          },
          "נמחק",
        ).ok,
      ).toBe(false);
    });

    it("passes exact delete_list list_ids and rejects extras/duplicates/alter", () => {
      const constraints: ModelEvalConstraint[] = [
        {
          type: "list_ops_delete_list_ids",
          listIds: ["L1", "L2"],
        },
        { type: "lists_empty" },
      ];
      expect(
        evaluateConstraints(
          constraints,
          meta({
            listOps: [
              {
                action: "delete_list",
                listId: "L2",
                newName: "",
                addColumns: [],
                removeColumns: [],
                renameColumns: [],
                addParticipants: [],
                removeParticipants: [],
              },
              {
                action: "delete_list",
                listId: "L1",
                newName: "",
                addColumns: [],
                removeColumns: [],
                renameColumns: [],
                addParticipants: [],
                removeParticipants: [],
              },
            ],
          }),
          "נמחקו",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            listOps: [
              {
                action: "delete_list",
                listId: "L1",
                newName: "",
                addColumns: [],
                removeColumns: [],
                renameColumns: [],
                addParticipants: [],
                removeParticipants: [],
              },
              {
                action: "delete_list",
                listId: "L2",
                newName: "",
                addColumns: [],
                removeColumns: [],
                renameColumns: [],
                addParticipants: [],
                removeParticipants: [],
              },
              {
                action: "delete_list",
                listId: "L3",
                newName: "",
                addColumns: [],
                removeColumns: [],
                renameColumns: [],
                addParticipants: [],
                removeParticipants: [],
              },
            ],
          }),
          "נמחקו",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            listOps: [
              {
                action: "delete_list",
                listId: "L1",
                newName: "",
                addColumns: [],
                removeColumns: [],
                renameColumns: [],
                addParticipants: [],
                removeParticipants: [],
              },
              {
                action: "delete_list",
                listId: "L1",
                newName: "",
                addColumns: [],
                removeColumns: [],
                renameColumns: [],
                addParticipants: [],
                removeParticipants: [],
              },
            ],
          }),
          "נמחקו",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            listOps: [
              {
                action: "alter_list",
                listId: "L1",
                newName: "x",
                addColumns: [],
                removeColumns: [],
                renameColumns: [],
                addParticipants: [],
                removeParticipants: [],
              },
              {
                action: "delete_list",
                listId: "L2",
                newName: "",
                addColumns: [],
                removeColumns: [],
                renameColumns: [],
                addParticipants: [],
                removeParticipants: [],
              },
            ],
          }),
          "נמחקו",
        ).ok,
      ).toBe(false);
    });
  });

  describe("show_dump and exact domain ids", () => {
    it("show_dump_ids_includes / excludes score opaque dump ids", () => {
      const constraints: ModelEvalConstraint[] = [
        { type: "show_dump", value: "full" },
        {
          type: "show_dump_ids_includes",
          ids: ["eval-topic-shop-paste", "eval-topic-custom-brush"],
        },
        {
          type: "show_dump_ids_excludes",
          ids: ["eval-topic-custom-towel"],
        },
      ];
      expect(
        evaluateConstraints(
          constraints,
          meta({
            showDump: "full",
            showDumpIds: [
              "eval-topic-shop-paste",
              "eval-topic-custom-brush",
              "eval-topic-fil-clinic",
            ],
          }),
          "הנה",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            showDump: "full",
            showDumpIds: [
              "eval-topic-shop-paste",
              "eval-topic-custom-brush",
              "eval-topic-custom-towel",
            ],
          }),
          "הנה",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            showDump: "full",
            showDumpIds: ["eval-topic-custom-brush"],
          }),
          "הנה",
        ).ok,
      ).toBe(false);
    });

    it("topic_no_match_dump rejects bare full and selected distractors", () => {
      const constraints: ModelEvalConstraint[] = [
        { type: "topic_no_match_dump" },
      ];
      expect(evaluateConstraints(constraints, meta({}), "לא מצאתי").ok).toBe(
        true,
      );
      expect(
        evaluateConstraints(
          constraints,
          meta({ showDump: "full", showDumpIds: [] }),
          "לא מצאתי",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          constraints,
          meta({ showDump: "full" }),
          "הנה הכל",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(
          constraints,
          meta({ showDump: "tasks", showDumpIds: ["eval-nomatch-task-pkg"] }),
          "הנה",
        ).ok,
      ).toBe(false);
    });

    it("requires show_dump full and rejects placeholder filing ids", () => {
      expect(
        evaluateConstraints(
          [{ type: "show_dump", value: "full" }, { type: "mutations_empty_or_read_only" }],
          meta({ showDump: "full" }),
          "",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          [{ type: "show_dump", value: "full" }],
          meta({}),
          "חלב וקוד 4455",
        ).ok,
      ).toBe(false);

      const filingConstraints: ModelEvalConstraint[] = [
        {
          type: "filing_has_action",
          action: "remove_filing",
          filingId: "eval-filing-email-code",
        },
      ];
      expect(
        evaluateConstraints(
          filingConstraints,
          meta({
            filing: [
              {
                action: "remove_filing",
                itemName: "קוד",
                itemInfo: "",
                itemDescription: "",
                targets: [],
                filingId: "eval-filing-email-code",
              },
            ],
          }),
          "נמחק",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          filingConstraints,
          meta({
            filing: [
              {
                action: "remove_filing",
                itemName: "קוד",
                itemInfo: "",
                itemDescription: "",
                targets: [],
                filingId: "file",
              },
            ],
          }),
          "נמחק",
        ).ok,
      ).toBe(false);
    });

    it("accepts recurrence-shaped recurring reminders and exact reminder/contact ids", () => {
      expect(
        evaluateConstraints(
          [{ type: "reminders_has_action", action: "add", recurring: true }],
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
                inSeconds: null,
                everyCount: null,
                everyUnit: null,
                weekdays: null,
                recurrence: { freq: "interval", interval: 1, unit: "hours" },
                confirmed: false,
                compose: false,
                composeSource: "",
                composeLookbackHours: 0,
                reminderId: "",
              },
            ],
          }),
          "כל שעה",
        ).ok,
      ).toBe(true);

      expect(
        evaluateConstraints(
          [
            {
              type: "reminders_remove_ids",
              reminderIds: ["eval-reminder-milk"],
            },
          ],
          meta({
            reminders: [
              {
                action: "remove",
                item: "",
                listType: "shopping",
                date: "",
                time: "",
                repeat: "once",
                ping: [],
                targets: [],
                text: "",
                inSeconds: null,
                everyCount: null,
                everyUnit: null,
                weekdays: null,
                confirmed: false,
                compose: false,
                composeSource: "",
                composeLookbackHours: 0,
                reminderId: "eval-reminder-milk",
              },
            ],
          }),
          "בוטל",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          [
            {
              type: "reminders_remove_ids",
              reminderIds: ["eval-reminder-milk"],
            },
          ],
          meta({
            reminders: [
              {
                action: "remove",
                item: "",
                listType: "shopping",
                date: "",
                time: "",
                repeat: "once",
                ping: [],
                targets: [],
                text: "",
                inSeconds: null,
                everyCount: null,
                everyUnit: null,
                weekdays: null,
                confirmed: false,
                compose: false,
                composeSource: "",
                composeLookbackHours: 0,
                reminderId: "invented",
              },
            ],
          }),
          "בוטל",
        ).ok,
      ).toBe(false);

      expect(
        evaluateConstraints(
          [
            {
              type: "directory_remove_contact_ids",
              contactIds: ["contact-0"],
            },
          ],
          meta({
            directory: [
              {
                action: "remove",
                name: "מיכל",
                phone: "",
                contactId: "contact-0",
                targets: [],
              },
            ],
          }),
          "נמחק",
        ).ok,
      ).toBe(true);
    });

    it("allows non-exclusive remove+add for shop-move style turns", () => {
      const constraints: ModelEvalConstraint[] = [
        {
          type: "lists_remove_item_ids",
          listType: "shopping",
          itemIds: ["shared-milk"],
          exclusive: false,
        },
        {
          type: "lists_has_action",
          action: "add",
          listType: "shopping",
          minCount: 1,
          itemTextIncludes: "חלב",
        },
      ];
      expect(
        evaluateConstraints(
          constraints,
          meta({
            lists: [
              {
                action: "remove",
                listType: "shopping",
                listName: "",
                items: [{ item_id: "shared-milk" }],
                targets: [],
              },
              {
                action: "add",
                listType: "shopping",
                listName: "",
                items: [{ "שם פריט": "חלב" }],
                targets: [],
              },
            ],
          }),
          "העברתי",
        ).ok,
      ).toBe(true);
    });
  });

  describe("response_mentions_all", () => {
    it("requires every needle and fails when only one of two is present", () => {
      const constraints: ModelEvalConstraint[] = [
        { type: "response_mentions_all", needles: ["בעיות", "באגים"] },
      ];
      expect(
        evaluateConstraints(
          constraints,
          meta({}),
          "התכוונת לבעיות או לבאגים?",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(constraints, meta({}), "התכוונת לבעיות?").ok,
      ).toBe(false);
      expect(
        evaluateConstraints(constraints, meta({}), "התכוונת לבאגים?").ok,
      ).toBe(false);
    });
  });

  describe("critical corpus Step A safety", () => {
    function collectConstraintTypes(
      rows: ModelEvalConstraint[],
    ): string[] {
      const out: string[] = [];
      for (const row of rows) {
        out.push(row.type);
        if (row.type === "any") {
          out.push(...collectConstraintTypes(row.constraints));
        }
      }
      return out;
    }

    it("critical deletion cases do not reward hold_or_confirm", () => {
      const corpus = loadModelEvalCorpus();
      const banned = new Set([
        "hold_or_confirm",
        "hold_or_confirm_or_ask",
        "hold_present",
      ]);
      const critical = new Set(corpus.criticalCaseIds ?? []);
      const offenders: string[] = [];
      for (const row of corpus.cases) {
        if (!critical.has(row.id)) {
          continue;
        }
        const types = collectConstraintTypes(row.constraints);
        const hit = types.filter((t) => banned.has(t));
        if (hit.length > 0) {
          offenders.push(`${row.id}:${hit.join(",")}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it("critical item-deletion cases require list_ops_empty", () => {
      const corpus = loadModelEvalCorpus();
      const itemDeleteIds = [
        "list-buy-milk",
        "list-clear-tasks",
        "list-clear-personal-shopping",
        "list-filtered-multi-delete",
        "list-named-item-delete",
      ];
      for (const id of itemDeleteIds) {
        const row = corpus.cases.find((c) => c.id === id);
        expect(row, id).toBeTruthy();
        const types = collectConstraintTypes(row!.constraints);
        expect(types, id).toContain("lists_remove_item_ids");
        expect(types, id).toContain("list_ops_empty");
      }
    });

    it("dump-what-saved scores show_dump full not spoken dump text", () => {
      const row = loadModelEvalCorpus().cases.find(
        (c) => c.id === "dump-what-saved",
      );
      expect(row).toBeTruthy();
      const types = collectConstraintTypes(row!.constraints);
      expect(types).toContain("show_dump");
      expect(types).not.toContain("response_mentions_any");
    });
  });

  describe("ambiguity safety", () => {
    it("requires empty lists and list_ops separately from ask phrasing", () => {
      const constraints: ModelEvalConstraint[] = [
        { type: "lists_empty" },
        { type: "list_ops_empty" },
        { type: "response_looks_like_ask" },
      ];
      expect(
        evaluateConstraints(constraints, meta({}), "איזו רשימה? בעיות או באגים?").ok,
      ).toBe(true);
      // Ask alone must not mask a mutation.
      expect(
        evaluateConstraints(
          constraints,
          meta({
            lists: [
              {
                action: "remove",
                listType: "custom",
                listName: "בעיות",
                items: [{ item_id: "x" }],
                targets: [],
              },
            ],
          }),
          "איזו רשימה?",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            listOps: [
              {
                action: "delete_list",
                listId: "L1",
                newName: "",
                addColumns: [],
                removeColumns: [],
                renameColumns: [],
                addParticipants: [],
                removeParticipants: [],
              },
            ],
          }),
          "איזו רשימה?",
        ).ok,
      ).toBe(false);
    });

    it("counts list_ops as mutations for read-only turns", () => {
      const constraints: ModelEvalConstraint[] = [
        { type: "mutations_empty_or_read_only" },
        { type: "response_looks_like_ask" },
      ];
      expect(
        evaluateConstraints(
          constraints,
          meta({
            listOps: [
              {
                action: "delete_list",
                listId: "L1",
                newName: "",
                addColumns: [],
                removeColumns: [],
                renameColumns: [],
                addParticipants: [],
                removeParticipants: [],
              },
            ],
          }),
          "למחוק הכל?",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(constraints, meta({}), "למחוק הכל?").ok,
      ).toBe(true);
    });
  });

  describe("critical gate", () => {
    it("fails the suite when any critical case fails even if soft passRate is met", () => {
      const results = [
        stubResult("crit-a", true),
        stubResult("crit-b", false),
        stubResult("soft-1", true),
        stubResult("soft-2", true),
        stubResult("soft-3", true),
        stubResult("soft-4", true),
        stubResult("soft-5", true),
        stubResult("soft-6", true),
        stubResult("soft-7", true),
        stubResult("soft-8", true),
      ];
      const summary = summarizeModelEvalResults(results, {
        requiredPassRate: 0.7,
        criticalCaseIds: ["crit-a", "crit-b"],
      });
      expect(summary.softOk).toBe(true);
      expect(summary.criticalOk).toBe(false);
      expect(summary.criticalFailed).toEqual(["crit-b"]);
      expect(summary.ok).toBe(false);
    });

    it("passes only when soft rate and all critical cases pass", () => {
      const results = [
        stubResult("crit-a", true),
        stubResult("crit-b", true),
        stubResult("soft-1", true),
        stubResult("soft-2", false),
        stubResult("soft-3", true),
        stubResult("soft-4", true),
        stubResult("soft-5", true),
        stubResult("soft-6", true),
        stubResult("soft-7", true),
        stubResult("soft-8", true),
      ];
      const summary = summarizeModelEvalResults(results, {
        requiredPassRate: 0.7,
        criticalCaseIds: ["crit-a", "crit-b"],
      });
      expect(summary.softOk).toBe(true);
      expect(summary.criticalOk).toBe(true);
      expect(summary.criticalFailed).toEqual([]);
      expect(summary.ok).toBe(true);
    });

    it("fails softOk independently of criticalOk", () => {
      const results = [
        stubResult("crit-a", true),
        stubResult("soft-1", false),
        stubResult("soft-2", false),
        stubResult("soft-3", false),
        stubResult("soft-4", true),
      ];
      const summary = summarizeModelEvalResults(results, {
        requiredPassRate: 0.7,
        criticalCaseIds: ["crit-a"],
      });
      expect(summary.criticalOk).toBe(true);
      expect(summary.softOk).toBe(false);
      expect(summary.ok).toBe(false);
    });

    it("ignores critical ids that were not selected in this run", () => {
      const results = [
        stubResult("crit-a", true),
        stubResult("soft-1", true),
      ];
      const summary = summarizeModelEvalResults(results, {
        requiredPassRate: 0.7,
        criticalCaseIds: ["crit-a", "crit-b", "crit-c"],
      });
      expect(summary.criticalOk).toBe(true);
      expect(summary.criticalFailed).toEqual([]);
      expect(summary.ok).toBe(true);
    });

    it("still fails when a selected critical case fails under a subset run", () => {
      const results = [
        stubResult("crit-a", false),
        stubResult("soft-1", true),
      ];
      const summary = summarizeModelEvalResults(results, {
        requiredPassRate: 0.5,
        criticalCaseIds: ["crit-a", "crit-b"],
      });
      expect(summary.softOk).toBe(true);
      expect(summary.criticalOk).toBe(false);
      expect(summary.criticalFailed).toEqual(["crit-a"]);
      expect(summary.ok).toBe(false);
    });
  });

  describe("live-domain ACTION constraints (parse*Action)", () => {
    it("weather_action dateEqualsRelative matches SESSION_CLOCK מחר (no hardcoded YMD)", () => {
      const want = resolveRelativeDateLabel("מחר");
      expect(want).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const constraints: ModelEvalConstraint[] = [
        {
          type: "weather_action",
          placeIncludes: "תל אביב",
          aspectsIncludes: ["summary"],
          dateEqualsRelative: "מחר",
        },
      ];
      expect(
        evaluateConstraints(
          constraints,
          meta({
            weather: {
              place: "תל אביב",
              date: want,
              aspects: ["summary"],
            },
          }),
          "",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            weather: {
              place: "תל אביב",
              date: "",
              aspects: ["summary"],
            },
          }),
          "",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            weather: {
              place: "תל אביב",
              date: resolveRelativeDateLabel("היום"),
              aspects: ["summary"],
            },
          }),
          "",
        ).ok,
      ).toBe(false);
    });

    it("live_domains_empty passes only when no live board ACTION is present", () => {
      const constraints: ModelEvalConstraint[] = [
        { type: "live_domains_empty" },
        { type: "mutations_empty_or_read_only" },
      ];
      expect(evaluateConstraints(constraints, meta({}), "איפה?").ok).toBe(
        true,
      );
      expect(
        evaluateConstraints(
          constraints,
          meta({
            weather: {
              place: "תל אביב",
              date: "",
              aspects: ["summary"],
            },
          }),
          "איפה?",
        ).ok,
      ).toBe(false);
    });

    it("routes_action destinationEmpty rejects a filled destination", () => {
      const constraints: ModelEvalConstraint[] = [
        {
          type: "routes_action",
          originIncludes: "שלום דורני",
          destinationEmpty: true,
          aspectsIncludes: ["lines"],
        },
      ];
      expect(
        evaluateConstraints(
          constraints,
          meta({
            routes: {
              origin: "שלום דורני פתח תקווה",
              destination: "",
              departure: "",
              arrival: "",
              line: "",
              headsign: "",
              stopCode: "",
              agency: "",
              serviceDate: "",
              windowEnd: "",
              aspects: ["lines"],
            },
          }),
          "",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            routes: {
              origin: "שלום דורני פתח תקווה",
              destination: "תל אביב",
              departure: "",
              arrival: "",
              line: "",
              headsign: "",
              stopCode: "",
              agency: "",
              serviceDate: "",
              windowEnd: "",
              aspects: ["lines"],
            },
          }),
          "",
        ).ok,
      ).toBe(false);
    });

    it("weather_action passes for correct place/aspects and fails otherwise", () => {
      const constraints: ModelEvalConstraint[] = [
        { type: "live_domain_only", domain: "weather" },
        {
          type: "weather_action",
          placeIncludes: "תל אביב",
          aspectsIncludes: ["waves"],
          requireDate: true,
        },
        { type: "mutations_empty_or_read_only" },
      ];
      expect(
        evaluateConstraints(
          constraints,
          meta({
            weather: {
              place: "תל אביב",
              date: "2099-06-15",
              aspects: ["waves"],
            },
          }),
          "גלים",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            weather: {
              place: "חיפה",
              date: "2099-06-15",
              aspects: ["waves"],
            },
          }),
          "",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            weather: {
              place: "תל אביב",
              date: "",
              aspects: ["summary"],
            },
          }),
          "",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            market: { queries: ["AAPL"], aspects: ["summary"] },
          }),
          "",
        ).ok,
      ).toBe(false);
    });

    it("market_action requires query match and rejects other live domains", () => {
      const constraints: ModelEvalConstraint[] = [
        { type: "live_domain_only", domain: "market" },
        {
          type: "market_action",
          queryIncludesAny: ["AAPL", "אפל"],
          aspectsIncludes: ["summary"],
        },
      ];
      expect(
        evaluateConstraints(
          constraints,
          meta({ market: { queries: ["AAPL"], aspects: ["summary"] } }),
          "",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          constraints,
          meta({ market: { queries: ["BTC-USD"], aspects: ["summary"] } }),
          "",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            market: { queries: ["AAPL"], aspects: ["summary"] },
            weather: {
              place: "תל אביב",
              date: "",
              aspects: ["summary"],
            },
          }),
          "",
        ).ok,
      ).toBe(false);
    });

    it("jewish_action allows empty place for parasha and requires place for candles", () => {
      expect(
        evaluateConstraints(
          [
            { type: "live_domain_only", domain: "jewish" },
            {
              type: "jewish_action",
              allowEmptyPlace: true,
              aspectsIncludes: ["parasha"],
            },
          ],
          meta({
            jewish: { place: "", date: "", aspects: ["parasha"] },
          }),
          "",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          [
            { type: "live_domain_only", domain: "jewish" },
            {
              type: "jewish_action",
              placeIncludes: "פתח תקווה",
              aspectsIncludes: ["candles"],
            },
          ],
          meta({
            jewish: {
              place: "פתח תקווה",
              date: "",
              aspects: ["candles"],
            },
          }),
          "",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          [
            {
              type: "jewish_action",
              placeIncludes: "פתח תקווה",
              aspectsIncludes: ["candles"],
            },
          ],
          meta({
            jewish: { place: "", date: "", aspects: ["parasha"] },
          }),
          "",
        ).ok,
      ).toBe(false);
    });

    it("places_action distinguishes parking intent and open_now/min_rating filters", () => {
      expect(
        evaluateConstraints(
          [
            { type: "live_domain_only", domain: "places" },
            {
              type: "places_action",
              queryIncludes: "מסעדה",
              placeIncludes: "פתח תקווה",
              intent: "business",
              openNow: true,
              minRatingAtLeast: 4,
            },
          ],
          meta({
            places: {
              query: "מסעדה",
              place: "פתח תקווה",
              near: "",
              lat: null,
              lng: null,
              aspects: ["summary"],
              intent: "business",
              openNow: true,
              minRating: 4,
              includedType: "restaurant",
              radiusMeters: null,
              parkingCost: null,
              requireLiveSelect: false,
            },
          }),
          "",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          [
            {
              type: "places_action",
              intent: "parking",
              queryIncludes: "חניון",
            },
          ],
          meta({
            places: {
              query: "חניון",
              place: "הקניון",
              near: "",
              lat: null,
              lng: null,
              aspects: ["summary"],
              intent: "business",
              openNow: null,
              minRating: null,
              includedType: null,
              radiusMeters: null,
              parkingCost: null,
              requireLiveSelect: false,
            },
          }),
          "",
        ).ok,
      ).toBe(false);
    });

    it("places_action geoMode + nearEmpty after parse normalize (harness only — not live Lucy)", () => {
      const galilConstraints: ModelEvalConstraint[] = [
        { type: "live_domain_only", domain: "places" },
        {
          type: "places_action",
          queryIncludes: "מסעד",
          placeIncludes: "גליל",
          geoMode: "area_restrict",
          nearEmpty: true,
          intent: "business",
        },
      ];
      // Raw ACTION: near=speaker must be cleared by parsePlacesAction before nearEmpty.
      expect(
        evaluateConstraints(
          galilConstraints,
          meta({
            places: {
              query: "מסעדות",
              place: "הגליל",
              near: "speaker",
              geo_mode: "area_restrict",
              aspects: ["summary"],
              intent: "business",
            } as unknown as LlmMetadata["places"],
          }),
          "",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          galilConstraints,
          meta({
            places: {
              query: "מסעדות",
              place: "הגליל",
              near: "",
              geo_mode: "soft_place",
              aspects: ["summary"],
              intent: "business",
            } as unknown as LlmMetadata["places"],
          }),
          "",
        ).ok,
      ).toBe(false);
      // Stub emits geo_mode from constraint — proves infrastructure wiring only.
      const stub = offlineStubForConstraints(galilConstraints);
      expect(
        evaluateConstraints(galilConstraints, stub.metadata, stub.response).ok,
      ).toBe(true);
    });

    it("routes_action separates Google transit from GTFS schedule/nearest_stop", () => {
      const transit: ModelEvalConstraint[] = [
        { type: "live_domain_only", domain: "routes" },
        {
          type: "routes_action",
          originIncludes: "פתח תקווה",
          destinationIncludes: "תל אביב",
          aspectsExcludes: ["schedule", "nearest_stop", "live_arrivals"],
        },
      ];
      expect(
        evaluateConstraints(
          transit,
          meta({
            routes: {
              origin: "פתח תקווה",
              destination: "תל אביב",
              departure: "",
              arrival: "",
              line: "",
              headsign: "",
              stopCode: "",
              agency: "",
              serviceDate: "",
              windowEnd: "",
              aspects: ["summary"],
            },
          }),
          "",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          transit,
          meta({
            routes: {
              origin: "פתח תקווה",
              destination: "תל אביב",
              departure: "",
              arrival: "",
              line: "1",
              headsign: "",
              stopCode: "21224",
              agency: "",
              serviceDate: "",
              windowEnd: "",
              aspects: ["schedule"],
            },
          }),
          "",
        ).ok,
      ).toBe(false);

      const schedule: ModelEvalConstraint[] = [
        { type: "live_domain_only", domain: "routes" },
        {
          type: "routes_action",
          aspectsIncludes: ["schedule"],
          lineIncludes: "1",
          requireStopCode: true,
          aspectsExcludes: ["nearest_stop", "live_arrivals"],
        },
      ];
      expect(
        evaluateConstraints(
          schedule,
          meta({
            routes: {
              origin: "",
              destination: "",
              departure: "",
              arrival: "",
              line: "1",
              headsign: "",
              stopCode: "21224",
              agency: "",
              serviceDate: "",
              windowEnd: "",
              aspects: ["schedule"],
            },
          }),
          "",
        ).ok,
      ).toBe(true);

      const nearest: ModelEvalConstraint[] = [
        {
          type: "routes_action",
          aspectsIncludes: ["nearest_stop"],
          lineIncludes: "51",
          originIncludes: "speaker",
          aspectsExcludes: ["schedule", "live_arrivals"],
        },
      ];
      expect(
        evaluateConstraints(
          nearest,
          meta({
            routes: {
              origin: "speaker",
              destination: "",
              departure: "",
              arrival: "",
              line: "51",
              headsign: "",
              stopCode: "",
              agency: "",
              serviceDate: "",
              windowEnd: "",
              aspects: ["nearest_stop"],
            },
          }),
          "",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          nearest,
          meta({
            routes: {
              origin: "speaker",
              destination: "",
              departure: "",
              arrival: "",
              line: "51",
              headsign: "",
              stopCode: "",
              agency: "",
              serviceDate: "",
              windowEnd: "",
              aspects: ["schedule"],
            },
          }),
          "",
        ).ok,
      ).toBe(false);
    });

    it("flights_action checks direction/city and fails when missing", () => {
      const constraints: ModelEvalConstraint[] = [
        { type: "live_domain_only", domain: "flights" },
        {
          type: "flights_action",
          direction: "departures",
          cityIncludes: "פריז",
        },
      ];
      expect(
        evaluateConstraints(
          constraints,
          meta({
            flights: {
              airport: "TLV",
              direction: "departures",
              airline: "",
              airlines: [],
              city: "פריז",
              flight: "",
              date: "",
              withinMinutes: 0,
              timeFrom: "",
              timeTo: "",
              aspects: ["summary"],
              requireLiveSelect: false,
            },
          }),
          "",
        ).ok,
      ).toBe(true);
      expect(
        evaluateConstraints(
          constraints,
          meta({
            flights: {
              airport: "TLV",
              direction: "arrivals",
              airline: "",
              airlines: [],
              city: "פריז",
              flight: "",
              date: "",
              withinMinutes: 0,
              timeFrom: "",
              timeTo: "",
              aspects: ["summary"],
              requireLiveSelect: false,
            },
          }),
          "",
        ).ok,
      ).toBe(false);
      expect(
        evaluateConstraints(constraints, meta({}), "").ok,
      ).toBe(false);
    });

    it("live-domain corpus tags select only the tagged subset", () => {
      const corpus = loadModelEvalCorpus();
      const tags = parseModelEvalTags(LIVE_DOMAIN_TAGS.join(","));
      const selected = filterCasesByTags(corpus.cases, tags);
      expect(selected.length).toBeGreaterThanOrEqual(7);
      expect(selected.length).toBeLessThan(corpus.cases.length);
      for (const row of selected) {
        expect(
          (row.tags ?? []).some((t) =>
            (LIVE_DOMAIN_TAGS as readonly string[]).includes(t),
          ),
          row.id,
        ).toBe(true);
      }
      const unrelated = filterCasesByTags(corpus.cases, ["shopping"]);
      expect(
        unrelated.every(
          (row) =>
            !(row.tags ?? []).some((t) =>
              (LIVE_DOMAIN_TAGS as readonly string[]).includes(t),
            ),
        ),
      ).toBe(true);
    });

    it("offline stub satisfies every live-domain corpus case", () => {
      const corpus = loadModelEvalCorpus();
      const selected = filterCasesByTags(corpus.cases, [...LIVE_DOMAIN_TAGS]);
      const failures: string[] = [];
      for (const row of selected) {
        const stub = offlineStubForConstraints(row.constraints);
        const checked = evaluateOfflineModelProposal({
          constraints: row.constraints,
          metadata: stub.metadata,
          response: stub.response,
        });
        if (!checked.ok) {
          failures.push(`${row.id}: ${checked.failures.join("; ")}`);
        }
      }
      expect(failures).toEqual([]);
    });
  });

  describe("eval createResponse config", () => {
    afterEach(() => {
      setLlmClientForTests(null);
    });

    it("passes loadLlmConfig().reasoningEffort into createResponse", async () => {
      const createResponse = vi.fn().mockResolvedValue({
        reply: JSON.stringify({
          responses: ["אוקיי"],
          metadata: { lists: [], filing: [] },
        }),
        raw: {},
        usage: null,
      });
      setLlmClientForTests({
        createConversation: vi.fn().mockResolvedValue("conv_eval_1"),
        createResponse,
      });

      const expected = loadLlmConfig().reasoningEffort;
      await runModelEvalCase({
        id: "eval-reasoning-effort-smoke",
        tag: "happy",
        utterance: "בדיקה",
        setup: {},
        constraints: [],
      });

      expect(createResponse).toHaveBeenCalledOnce();
      expect(createResponse.mock.calls[0][0].reasoningEffort).toBe(expected);
    });
  });
});
