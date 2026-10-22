/**
 * Workflow Pack MODEL_APPLY — stub model + production apply + reinject (offline).
 * W1 shop→filing, W3 multi-action one turn, W4 clarify→multi. No W2 / LIVE / OpenAI.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  defaultWorkflowPackPath,
  loadWorkflowPackSuite,
} from "../src/eval/corpus.js";
import {
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyProposeInput,
} from "../src/eval/run-model-apply.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";

function countShoppingContaining(
  snapshot: {
    lists: Array<{ list_type?: string; items: Array<Record<string, unknown>> }>;
  },
  needle: string,
): number {
  return snapshot.lists
    .filter((l) => l.list_type === "shopping")
    .flatMap((l) => l.items)
    .filter((item) => JSON.stringify(item).includes(needle)).length;
}

function countFilingContaining(
  snapshot: {
    filing: Array<{ item_name?: string; item_info?: string }>;
  },
  needle: string,
): number {
  return snapshot.filing.filter((f) =>
    `${f.item_name ?? ""}${f.item_info ?? ""}`.includes(needle),
  ).length;
}

function propose(caseId: string, input: ModelApplyProposeInput) {
  switch (caseId) {
    case "W1-SHOP-THEN-FILING-MA":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "shopping",
                list_name: "",
                items: [{ "שם פריט": "חלב" }],
                targets: [],
              },
            ],
            list_ops: [],
            filing: [],
            reminders: [],
            directory: [],
          },
          response: "הוספתי חלב לקניות",
        };
      }
      // Reinjection: prior shop item must already be visible in facts.
      expect(input.facts).toContain("חלב");
      expect(input.facts).toContain("EMPLOYEE_SAVED_DATA");
      return {
        metadata: {
          lists: [],
          list_ops: [],
          filing: [
            {
              action: "add_filing",
              item_name: "חלב",
              item_info: "רק 3%",
              item_description: "",
              targets: [],
            },
          ],
          reminders: [],
          directory: [],
        },
        response: "תייקתי שחלב רק 3%",
      };

    case "W3-MULTI-ACTION-ONE-TURN-MA":
      return {
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              list_name: "",
              items: [{ "שם פריט": "יין" }],
              targets: [],
            },
          ],
          list_ops: [],
          filing: [
            {
              action: "add_filing",
              item_name: "יין",
              item_info: "רק אדום",
              item_description: "",
              targets: [],
            },
          ],
          reminders: [],
          directory: [],
        },
        response: "הוספתי יין לקניות ותייקתי שרק אדום",
      };

    case "W4-CLARIFY-THEN-MULTI-MA":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [],
            list_ops: [],
            filing: [],
            reminders: [],
            directory: [],
          },
          response: "מה להוסיף לקניות ומה לתיוק?",
        };
      }
      // Clarify must not have left shopping/filing rows in reinjected context.
      expect(input.facts).not.toContain("לחם");
      expect(input.facts).not.toContain("רק מלא");
      expect(countShoppingContaining(input.snapshot, "לחם")).toBe(0);
      expect(countFilingContaining(input.snapshot, "לחם")).toBe(0);
      return {
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              list_name: "",
              items: [{ "שם פריט": "לחם" }],
              targets: [],
            },
          ],
          list_ops: [],
          filing: [
            {
              action: "add_filing",
              item_name: "לחם",
              item_info: "רק מלא",
              item_description: "",
              targets: [],
            },
          ],
          reminders: [],
          directory: [],
        },
        response: "הוספתי לחם ותייקתי שרק מלא",
      };

    default:
      throw new Error(`no stub propose for ${caseId}`);
  }
}

const MA_CASES = [
  "W1-SHOP-THEN-FILING-MA",
  "W3-MULTI-ACTION-ONE-TURN-MA",
  "W4-CLARIFY-THEN-MULTI-MA",
] as const;

describe("Workflow pack MODEL_APPLY (offline)", () => {
  beforeAll(() => {
    const db = process.env.DATABASE_URL;
    if (!db?.trim()) {
      throw new Error("DATABASE_URL required for Workflow pack MODEL_APPLY");
    }
    // Fail closed: never self-approve DATABASE_URL (could be product `workee`).
    assertApprovedEvalDatabaseUrl(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(MA_CASES)("%s", async (caseId) => {
    const suite = loadWorkflowPackSuite(defaultWorkflowPackPath());
    const row = suite.cases.find((c) => c.id === caseId);
    expect(row, caseId).toBeTruthy();
    expect(row!.track).toBe("MODEL_APPLY");

    const result = await runModelApplyCase(row as ModelApplyCase, (input) =>
      propose(caseId, input),
    );
    expect(result.failures, result.failures.join("; ")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.turns.length).toBe(row!.turns.length);

    if (caseId === "W1-SHOP-THEN-FILING-MA") {
      expect(result.turns[0]?.appliedViaProduction).toBe(true);
      expect(result.turns[0]?.constraintOk).toBe(true);
      expect(countShoppingContaining(result.turns[0]!.snapshot, "חלב")).toBe(1);
      expect(countFilingContaining(result.turns[0]!.snapshot, "3%")).toBe(0);

      expect(result.turns[1]?.appliedViaProduction).toBe(true);
      expect(result.turns[1]?.constraintOk).toBe(true);
      expect(result.turns[1]!.facts).toContain("חלב");
      expect(result.turns[1]!.facts).toContain("רק 3%");
      expect(countShoppingContaining(result.turns[1]!.snapshot, "חלב")).toBe(1);
      expect(countFilingContaining(result.turns[1]!.snapshot, "חלב")).toBe(1);
    }

    if (caseId === "W3-MULTI-ACTION-ONE-TURN-MA") {
      expect(result.turns.length).toBe(1);
      expect(result.turns[0]?.appliedViaProduction).toBe(true);
      expect(result.turns[0]?.constraintOk).toBe(true);
      expect(result.turns[0]!.metadata.lists).toHaveLength(1);
      expect(result.turns[0]!.metadata.filing).toHaveLength(1);
      expect(countShoppingContaining(result.turns[0]!.snapshot, "יין")).toBe(1);
      expect(countFilingContaining(result.turns[0]!.snapshot, "יין")).toBe(1);
      expect(countFilingContaining(result.turns[0]!.snapshot, "אדום")).toBe(1);
      expect(result.turns[0]!.facts).toContain("יין");
      expect(result.turns[0]!.facts).toContain("רק אדום");
      expect(result.turns[0]!.facts).toContain("EMPLOYEE_SAVED_DATA");
    }

    if (caseId === "W4-CLARIFY-THEN-MULTI-MA") {
      expect(result.turns[0]?.appliedViaProduction).toBe(false);
      expect(result.turns[0]?.constraintOk).toBe(true);
      expect(countShoppingContaining(result.turns[0]!.snapshot, "לחם")).toBe(0);
      expect(result.turns[0]!.snapshot.filing.length).toBe(0);

      expect(result.turns[1]?.appliedViaProduction).toBe(true);
      expect(result.turns[1]?.constraintOk).toBe(true);
      expect(countShoppingContaining(result.turns[1]!.snapshot, "לחם")).toBe(1);
      expect(countFilingContaining(result.turns[1]!.snapshot, "לחם")).toBe(1);
    }
  });
});
