/**
 * Filing Pack MODEL_APPLY — stub model + production apply (offline).
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

function filingIdByNeedle(
  snapshot: { filing?: Array<{ filing_id?: string; item_name?: string; item_info?: string }> },
  needle: string,
): string {
  for (const row of snapshot.filing ?? []) {
    const blob = `${row.item_name ?? ""} ${row.item_info ?? ""}`;
    if (blob.includes(needle) && row.filing_id?.trim()) {
      return row.filing_id.trim();
    }
  }
  throw new Error(`expected filing ${needle}`);
}

function propose(caseId: string, input: ModelApplyProposeInput) {
  switch (caseId) {
    case "F-ADD-THEN-UPD":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            filing: [
              {
                action: "add_filing",
                item_name: "קוד",
                item_info: "1111",
                item_description: "",
                targets: [],
              },
            ],
          },
          response: "שמרתי",
        };
      }
      return {
        metadata: {
          filing: [
            {
              action: "update_filing",
              filing_id: filingIdByNeedle(input.snapshot, "1111"),
              item_name: "קוד",
              item_info: "2222",
              item_description: "",
              targets: [],
            },
          ],
        },
        response: "עדכנתי",
      };
    case "F-ADD-THEN-RM":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            filing: [
              {
                action: "add_filing",
                item_name: "פין",
                item_info: "4321",
                item_description: "",
                targets: [],
              },
            ],
          },
          response: "שמרתי",
        };
      }
      return {
        metadata: {
          filing: [
            {
              action: "remove_filing",
              filing_id: filingIdByNeedle(input.snapshot, "4321"),
              item_name: "פין",
              item_info: "",
              item_description: "",
              targets: [],
            },
          ],
        },
        response: "מחקתי",
      };
    case "F-CHANGE-MIND":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            filing: [
              {
                action: "add_filing",
                item_name: "סיסמא זמנית",
                item_info: "xyz",
                item_description: "",
                targets: [],
              },
            ],
          },
          response: "שמרתי",
        };
      }
      return {
        metadata: {
          filing: [
            {
              action: "remove_filing",
              filing_id: filingIdByNeedle(input.snapshot, "xyz"),
              item_name: "סיסמא זמנית",
              item_info: "",
              item_description: "",
              targets: [],
            },
          ],
        },
        response: "מחקתי",
      };
    case "F-CRUD-MT":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            filing: [
              {
                action: "add_filing",
                item_name: "טוקן",
                item_info: "aaa",
                item_description: "",
                targets: [],
              },
            ],
          },
          response: "שמרתי",
        };
      }
      if (input.turnIndex === 1) {
        return {
          metadata: {
            filing: [
              {
                action: "update_filing",
                filing_id: filingIdByNeedle(input.snapshot, "aaa"),
                item_name: "טוקן",
                item_info: "bbb",
                item_description: "",
                targets: [],
              },
            ],
          },
          response: "עדכנתי",
        };
      }
      return {
        metadata: {
          filing: [
            {
              action: "remove_filing",
              filing_id: filingIdByNeedle(input.snapshot, "bbb"),
              item_name: "טוקן",
              item_info: "",
              item_description: "",
              targets: [],
            },
          ],
        },
        response: "מחקתי",
      };
    default:
      throw new Error(caseId);
  }
}

describe("Filing Pack MODEL_APPLY (offline)", () => {
  beforeAll(() => {
    const db = process.env.DATABASE_URL;
    if (!db?.trim()) throw new Error("DATABASE_URL required");
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = db;
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["F-ADD-THEN-UPD", "F-ADD-THEN-RM", "F-CHANGE-MIND", "F-CRUD-MT"])(
    "%s",
    async (caseId) => {
      const suite = loadDomainPackSuite(
        defaultDomainPackPath("filing-pack-suite.json"),
        { expectedDomain: "filing", expectedPack: "filing-pack-v1" },
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
