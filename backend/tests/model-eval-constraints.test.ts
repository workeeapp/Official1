import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmMetadata } from "@workee/shared";
import { loadLlmConfig } from "../src/config/llm.js";
import {
  evaluateConstraints,
  type ModelEvalConstraint,
} from "../src/eval/constraints.js";
import { loadModelEvalCorpus } from "../src/eval/corpus.js";
import {
  runModelEvalCase,
  summarizeModelEvalResults,
  type ModelEvalRunCaseResult,
} from "../src/eval/run-case.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";

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
