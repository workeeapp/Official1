/**
 * Share-by-index («שתף 4 עם עמית») MODEL_APPLY — stub model + production apply.
 *
 * Verifies engine path after dump-line id is known:
 * - Nested items[].targets lift → persisted co-share on the exact item_id
 * - Wrong / missing dump id → no share on unrelated rows
 *
 * Layers included: eval-db harness, planTargetedActions, applyEmployeeRecords.
 * Layers skipped: real LLM, show_dump REPLACE, WhatsApp, product DB.
 *
 * Run: npm run test:eval-db -- tests/share-by-index-model-apply.offline.test.ts
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyProposeInput,
} from "../src/eval/run-model-apply.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { resolveDumpLineId } from "../src/services/show-button-dump.js";

const DUMP_LINES = [
  {
    n: 1,
    id: "eval-task-bit",
    kind: "tasks" as const,
    title_stem: "לבדוק ביט",
  },
  {
    n: 4,
    id: "eval-task-bday",
    kind: "tasks" as const,
    title_stem: "יום ההולדת של עמית",
  },
  {
    n: 5,
    id: "eval-task-meeting",
    kind: "tasks" as const,
    title_stem: "פגישה",
  },
];

function taskId(
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
  throw new Error(`expected tasks item ${needle}`);
}

function sharedWithIncludes(
  snapshot: {
    lists: Array<{ list_type?: string; items: Array<Record<string, unknown>> }>;
  },
  needle: string,
  partner: string,
): boolean {
  for (const list of snapshot.lists) {
    if (list.list_type !== "tasks") continue;
    for (const item of list.items) {
      if (!JSON.stringify(item).includes(needle)) continue;
      const shared = item.shared_with;
      if (Array.isArray(shared) && shared.includes(partner)) return true;
    }
  }
  return false;
}

const setupTasks = {
  lists: [
    {
      list_id: "eval-list-tasks",
      list_type: "tasks",
      owner: "טל",
      scope: "personal",
      items: [
        { item_id: "eval-task-bit", "שם מטלה": "לבדוק ביט" },
        { item_id: "eval-task-bday", "שם מטלה": "יום ההולדת של עמית" },
        { item_id: "eval-task-meeting", "שם מטלה": "פגישה" },
      ],
    },
  ],
};

const shareLine4NestedTargets: ModelApplyCase = {
  id: "SH-INDEX-4-NESTED-TARGETS",
  track: "MODEL_APPLY",
  description:
    "שתף 4 עם עמית — dump line 4 id + item-nested targets persist co-share",
  setup: setupTasks,
  turns: [
    {
      utterance: "שתף 4 עם עמית",
      constraints: [{ type: "lists_has_action", action: "update", listType: "tasks" }],
      stateAfter: {
        factsInclude: ["יום ההולדת של עמית"],
      },
    },
  ],
};

const shareLine4ListTargets: ModelApplyCase = {
  id: "SH-INDEX-4-LIST-TARGETS",
  track: "MODEL_APPLY",
  description: "Canonical list-level targets for dump line 4",
  setup: setupTasks,
  turns: [
    {
      utterance: "שתף 4 עם עמית",
      constraints: [{ type: "lists_has_action", action: "update", listType: "tasks" }],
      stateAfter: {
        factsInclude: ["יום ההולדת של עמית"],
      },
    },
  ],
};

const missingLineAsk: ModelApplyCase = {
  id: "SH-INDEX-MISSING-ASK",
  track: "MODEL_APPLY",
  description: "Invalid dump index → empty mutates; no wrong item shared",
  setup: setupTasks,
  turns: [
    {
      utterance: "שתף 99 עם עמית",
      constraints: [{ type: "list_ops_empty" }],
      stateAfter: {
        factsInclude: ["לבדוק ביט", "יום ההולדת של עמית", "פגישה"],
      },
    },
  ],
};

describe("share-by-index dump contract (pure)", () => {
  it("maps שתף 4 to birthday id only", () => {
    expect(resolveDumpLineId(DUMP_LINES, 4)).toBe("eval-task-bday");
    expect(resolveDumpLineId(DUMP_LINES, 4)).not.toBe("eval-task-meeting");
    expect(resolveDumpLineId(DUMP_LINES, 99)).toBeNull();
  });
});

describe("share-by-index MODEL_APPLY (eval-db)", () => {
  beforeAll(() => {
    const db = process.env.DATABASE_URL;
    if (!db?.trim()) throw new Error("DATABASE_URL required");
    assertApprovedEvalDatabaseUrl(db);
  });

  afterEach(() => vi.restoreAllMocks());

  it("persists co-share on dump line 4 via nested item targets", async () => {
    const dumpId = resolveDumpLineId(DUMP_LINES, 4)!;
    const result = await runModelApplyCase(
      shareLine4NestedTargets,
      (input: ModelApplyProposeInput) => {
        const realId = taskId(input.snapshot, "יום ההולדת של עמית");
        expect(realId).toBeTruthy();
        // Stub uses dump-map id alias rewritten by harness → real UUID.
        return {
          metadata: {
            lists: [
              {
                action: "update",
                list_type: "tasks",
                list_name: "",
                targets: [],
                items: [
                  {
                    item_id: dumpId,
                    targets: ["טל", "עמית"],
                  },
                ],
              },
            ],
          },
          response: "שיתפתי את יום ההולדת של עמית עם עמית",
        };
      },
      { partners: ["עמית"] },
    );
    expect(result.ok, result.failures.join("\n")).toBe(true);
    expect(result.turns.some((t) => t.appliedViaProduction === true)).toBe(true);
    const snap = result.turns.at(-1)?.snapshot;
    expect(snap).toBeTruthy();
    expect(sharedWithIncludes(snap!, "יום ההולדת של עמית", "עמית")).toBe(true);
    expect(sharedWithIncludes(snap!, "פגישה", "עמית")).toBe(false);
    expect(sharedWithIncludes(snap!, "לבדוק ביט", "עמית")).toBe(false);
  });

  it("persists co-share on dump line 4 via canonical list-level targets", async () => {
    const dumpId = resolveDumpLineId(DUMP_LINES, 4)!;
    const result = await runModelApplyCase(
      shareLine4ListTargets,
      () => ({
        metadata: {
          lists: [
            {
              action: "update",
              list_type: "tasks",
              list_name: "",
              targets: ["טל", "עמית"],
              items: [{ item_id: dumpId }],
            },
          ],
        },
        response: "שיתפתי",
      }),
      { partners: ["עמית"] },
    );
    expect(result.ok, result.failures.join("\n")).toBe(true);
    const snap = result.turns.at(-1)?.snapshot;
    expect(sharedWithIncludes(snap!, "יום ההולדת של עמית", "עמית")).toBe(true);
    expect(sharedWithIncludes(snap!, "פגישה", "עמית")).toBe(false);
  });

  it("missing dump index with empty ACTION does not share any task", async () => {
    expect(resolveDumpLineId(DUMP_LINES, 99)).toBeNull();
    const result = await runModelApplyCase(
      missingLineAsk,
      () => ({
        metadata: { lists: [] },
        response:
          "לא מופיע פריט 99 בתצוגה האחרונה. איזה פריט תרצה לשתף עם עמית?",
      }),
      { partners: ["עמית"] },
    );
    expect(result.ok, result.failures.join("\n")).toBe(true);
    const snap = result.turns.at(-1)?.snapshot;
    expect(sharedWithIncludes(snap!, "יום ההולדת של עמית", "עמית")).toBe(false);
    expect(sharedWithIncludes(snap!, "פגישה", "עמית")).toBe(false);
    expect(sharedWithIncludes(snap!, "לבדוק ביט", "עמית")).toBe(false);
  });
});
