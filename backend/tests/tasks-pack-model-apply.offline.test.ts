/**
 * Tasks Pack MODEL_APPLY — stub model + production apply (offline).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  defaultDomainPackPath,
  loadDomainPackSuite,
} from "../src/eval/corpus.js";
import {
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyProposeInput,
} from "../src/eval/run-model-apply.js";

function itemIdByLabel(
  snapshot: { lists: Array<{ list_type?: string; items: Array<Record<string, unknown>> }> },
  needle: string,
): string {
  for (const list of snapshot.lists) {
    if (list.list_type !== "tasks") continue;
    for (const item of list.items) {
      if (!JSON.stringify(item).includes(needle)) continue;
      for (const key of ["item_id", "itemId", "id"]) {
        const raw = item[key];
        if (typeof raw === "string" && raw.trim()) return raw.trim();
      }
    }
  }
  throw new Error(`expected tasks item ${needle}`);
}

function propose(caseId: string, input: ModelApplyProposeInput) {
  switch (caseId) {
    case "T-ADD-THEN-DONE":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                items: [{ "שם מטלה": "לשלוח מייל" }],
                targets: [],
              },
            ],
          },
          response: "הוספתי",
        };
      }
      return {
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "tasks",
              items: [{ item_id: itemIdByLabel(input.snapshot, "מייל") }],
              targets: [],
            },
          ],
        },
        response: "סיימתי",
      };
    case "T-CHANGE-MIND":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                items: [{ "שם מטלה": "לקנות מתנה" }],
                targets: [],
              },
            ],
          },
          response: "הוספתי",
        };
      }
      return {
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "tasks",
              items: [{ item_id: itemIdByLabel(input.snapshot, "מתנה") }],
              targets: [],
            },
          ],
        },
        response: "ביטלתי",
      };
    case "T-UPDATE-MT":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                items: [{ "שם מטלה": "להתקשר לעורך דין" }],
                targets: [],
              },
            ],
          },
          response: "הוספתי",
        };
      }
      return {
        metadata: {
          lists: [
            {
              action: "update",
              list_type: "tasks",
              items: [
                {
                  item_id: itemIdByLabel(input.snapshot, "עורך"),
                  "שם מטלה": 'להתקשר לעו"ד ראובן',
                },
              ],
              targets: [],
            },
          ],
        },
        response: "עדכנתי",
      };
    case "T-CRUD-MT":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                items: [{ "שם מטלה": "לסגור חשבון" }],
                targets: [],
              },
            ],
          },
          response: "הוספתי",
        };
      }
      if (input.turnIndex === 1) {
        return {
          metadata: {
            lists: [
              {
                action: "update",
                list_type: "tasks",
                items: [
                  {
                    item_id: itemIdByLabel(input.snapshot, "חשבון"),
                    "שם מטלה": "לסגור חשבון בנק",
                  },
                ],
                targets: [],
              },
            ],
          },
          response: "עדכנתי",
        };
      }
      return {
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "tasks",
              items: [{ item_id: itemIdByLabel(input.snapshot, "בנק") }],
              targets: [],
            },
          ],
        },
        response: "סיימתי",
      };
    default:
      throw new Error(caseId);
  }
}

describe("Tasks Pack MODEL_APPLY (offline)", () => {
  beforeAll(() => {
    const db = process.env.DATABASE_URL;
    if (!db?.trim()) throw new Error("DATABASE_URL required");
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = db;
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["T-ADD-THEN-DONE", "T-CHANGE-MIND", "T-UPDATE-MT", "T-CRUD-MT"])(
    "%s",
    async (caseId) => {
      const suite = loadDomainPackSuite(
        defaultDomainPackPath("tasks-pack-suite.json"),
        { expectedDomain: "tasks", expectedPack: "tasks-pack-v1" },
      );
      const row = suite.cases.find((c) => c.id === caseId)!;
      const result = await runModelApplyCase(row as ModelApplyCase, (input) =>
        propose(caseId, input),
      );
      expect(result.failures, result.failures.join("; ")).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );
});
