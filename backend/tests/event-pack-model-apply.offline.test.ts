/**
 * Event pack MODEL_APPLY — stub model + production apply + reinject (offline).
 * Proves apply/link/rename paths for COMPLEX EVENTS fixtures — NOT live model NL.
 * No OpenAI / LIVE / Option B.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  defaultEventPackPath,
  loadEventPackSuite,
} from "../src/eval/corpus.js";
import {
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyProposeInput,
} from "../src/eval/run-model-apply.js";

function hostItemId(
  snapshot: {
    lists: Array<{ list_type?: string; items: Array<Record<string, unknown>> }>;
  },
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
  throw new Error(`expected host tasks item containing ${needle}`);
}

function propose(caseId: string, input: ModelApplyProposeInput) {
  switch (caseId) {
    case "E-CLARIFY-THEN-LINK":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [],
            list_ops: [],
            filing: [],
            reminders: [],
            directory: [],
          },
          response: "מה לשים בכיבוד?",
        };
      }
      return {
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "custom",
              list_name: "כיבוד",
              items: [
                { שם: "עוגה" },
                { שם: "שתיה" },
              ],
              targets: [],
            },
            {
              action: "update",
              list_type: "tasks",
              list_name: "",
              items: [
                {
                  item_id: hostItemId(input.snapshot, "ערב יום הולדת"),
                  "שם מטלה": "ערב יום הולדת",
                  linked_lists: [
                    { list_name: "כיבוד", list_type: "custom" },
                  ],
                },
              ],
              targets: [],
            },
          ],
          list_ops: [],
          filing: [],
          reminders: [],
        },
        response: "הוספתי כיבוד וחיברתי לערב יום הולדת",
      };
    case "E-RENAME-SAME-HOST":
      return {
        metadata: {
          lists: [
            {
              action: "update",
              list_type: "tasks",
              list_name: "",
              items: [
                {
                  item_id: hostItemId(input.snapshot, "ערב פוקר"),
                  "שם מטלה": "ערב משחקים",
                },
              ],
              targets: [],
            },
          ],
          list_ops: [],
          filing: [],
          reminders: [],
        },
        response: "שיניתי את השם לערב משחקים",
      };
    default:
      throw new Error(`no stub propose for ${caseId}`);
  }
}

describe("Event pack MODEL_APPLY (offline)", () => {
  beforeAll(() => {
    const db = process.env.DATABASE_URL;
    if (!db?.trim()) {
      throw new Error("DATABASE_URL required for Event pack MODEL_APPLY");
    }
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = db;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["E-CLARIFY-THEN-LINK", "E-RENAME-SAME-HOST"])(
    "%s",
    async (caseId) => {
      const suite = loadEventPackSuite(defaultEventPackPath());
      const row = suite.cases.find((c) => c.id === caseId);
      expect(row, caseId).toBeTruthy();
      expect(row!.track).toBe("MODEL_APPLY");

      const result = await runModelApplyCase(row as ModelApplyCase, (input) =>
        propose(caseId, input),
      );
      expect(result.failures, result.failures.join("; ")).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.turns.length).toBe(row!.turns.length);

      if (caseId === "E-CLARIFY-THEN-LINK") {
        expect(result.turns[0]?.appliedViaProduction).toBe(false);
        expect(result.turns[1]?.appliedViaProduction).toBe(true);
        const final = result.turns[1]!.snapshot;
        const hosts = final.lists
          .filter((l) => l.list_type === "tasks")
          .flatMap((l) => l.items);
        expect(hosts).toHaveLength(1);
        const linked = hosts[0]?.linked_lists;
        expect(Array.isArray(linked)).toBe(true);
        expect(
          (linked as Array<{ list_name?: string }>).some(
            (row) => row.list_name === "כיבוד",
          ),
        ).toBe(true);
      }

      if (caseId === "E-RENAME-SAME-HOST") {
        expect(result.turns[0]?.appliedViaProduction).toBe(true);
        const hosts = result.turns[0]!.snapshot.lists
          .filter((l) => l.list_type === "tasks")
          .flatMap((l) => l.items);
        expect(hosts).toHaveLength(1);
        expect(JSON.stringify(hosts[0])).toContain("ערב משחקים");
        expect(JSON.stringify(hosts[0])).not.toContain("ערב פוקר");
      }
    },
  );
});
