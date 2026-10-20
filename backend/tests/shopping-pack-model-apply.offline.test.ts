/**
 * Shopping Pack MODEL_APPLY — stub model + production apply (offline).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  defaultDomainPackPath,
  loadDomainPackSuite,
} from "../src/eval/corpus.js";
import {
  emptyModelMetadata,
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyProposeInput,
} from "../src/eval/run-model-apply.js";

function itemIdByLabel(
  snapshot: { lists: Array<{ list_type?: string; items: Array<Record<string, unknown>> }> },
  needle: string,
  listType = "shopping",
): string {
  for (const list of snapshot.lists) {
    if (list.list_type !== listType) continue;
    for (const item of list.items) {
      if (!JSON.stringify(item).includes(needle)) continue;
      for (const key of ["item_id", "itemId", "id"]) {
        const raw = item[key];
        if (typeof raw === "string" && raw.trim()) return raw.trim();
      }
    }
  }
  throw new Error(`expected shopping item ${needle}`);
}

function propose(caseId: string, input: ModelApplyProposeInput) {
  switch (caseId) {
    case "S-ADD-THEN-BOUGHT":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "shopping",
                list_name: "",
                items: [{ "שם פריט": "יוגורט" }],
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
              list_type: "shopping",
              list_name: "",
              items: [{ item_id: itemIdByLabel(input.snapshot, "יוגורט") }],
              targets: [],
            },
          ],
        },
        response: "הסרתי",
      };
    case "S-IDEMPOTENT":
      return {
        metadata: emptyModelMetadata(),
        response: "כבר יש חלב",
      };
    case "S-CHANGE-MIND":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "shopping",
                items: [{ "שם פריט": "קוטג" }],
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
              list_type: "shopping",
              items: [{ item_id: itemIdByLabel(input.snapshot, "קוטג") }],
              targets: [],
            },
          ],
        },
        response: "הסרתי",
      };
    case "S-CRUD-MT":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "shopping",
                items: [{ "שם פריט": "בננה" }],
                targets: [],
              },
            ],
          },
          response: "הוספתי",
        };
      }
      if (input.turnIndex === 1) {
        const id = itemIdByLabel(input.snapshot, "בננה");
        return {
          metadata: {
            lists: [
              {
                action: "update",
                list_type: "shopping",
                items: [{ item_id: id, "שם פריט": "בננות" }],
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
              list_type: "shopping",
              items: [{ item_id: itemIdByLabel(input.snapshot, "בננ") }],
              targets: [],
            },
          ],
        },
        response: "הסרתי",
      };
    default:
      throw new Error(caseId);
  }
}

describe("Shopping Pack MODEL_APPLY (offline)", () => {
  beforeAll(() => {
    const db = process.env.DATABASE_URL;
    if (!db?.trim()) throw new Error("DATABASE_URL required");
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = db;
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    "S-ADD-THEN-BOUGHT",
    "S-IDEMPOTENT",
    "S-CHANGE-MIND",
    "S-CRUD-MT",
  ])("%s", async (caseId) => {
    const suite = loadDomainPackSuite(
      defaultDomainPackPath("shopping-pack-suite.json"),
      { expectedDomain: "shopping", expectedPack: "shopping-pack-v1" },
    );
    const row = suite.cases.find((c) => c.id === caseId)!;
    const result = await runModelApplyCase(row as ModelApplyCase, (input) =>
      propose(caseId, input),
    );
    expect(result.failures, result.failures.join("; ")).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
