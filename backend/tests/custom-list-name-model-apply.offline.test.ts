/**
 * P1 unnamed custom refuse + same-turn named custom+link (offline MODEL_APPLY).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyProposeInput,
} from "../src/eval/run-model-apply.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";

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

const emptyCustomCase: ModelApplyCase = {
  id: "P1-REFUSE-EMPTY-CUSTOM-NAME",
  track: "MODEL_APPLY",
  description: "Custom add with empty list_name must not create a shell or items",
  setup: {
    lists: [
      {
        list_id: "eval-list-tasks",
        list_type: "tasks",
        owner: "טל",
        scope: "personal",
        items: [
          {
            item_id: "eval-host-birthday",
            "שם מטלה": "ערב יום הולדת",
          },
        ],
      },
    ],
  },
  turns: [
    {
      utterance: "תוסיפי לכיבוד עוגה ושתיה",
      constraints: [{ type: "list_ops_empty" }],
      stateAfter: {
        factsInclude: ["ערב יום הולדת"],
        factsExclude: ["עוגה", "שתיה"],
      },
    },
  ],
};

const namedLinkCase: ModelApplyCase = {
  id: "P1-NAMED-CUSTOM-SAME-TURN-LINK",
  track: "MODEL_APPLY",
  description:
    "Named custom list_name matching linked_lists resolves; facts include כיבוד",
  setup: {
    lists: [
      {
        list_id: "eval-list-tasks",
        list_type: "tasks",
        owner: "טל",
        scope: "personal",
        items: [
          {
            item_id: "eval-host-birthday",
            "שם מטלה": "ערב יום הולדת",
          },
        ],
      },
    ],
  },
  turns: [
    {
      utterance: "תוסיפי לכיבוד עוגה ושתיה וחברי לרשימה",
      constraints: [
        { type: "lists_has_action", action: "add", listType: "custom" },
      ],
      stateAfter: {
        factsInclude: ["כיבוד", "עוגה", "שתיה"],
      },
    },
  ],
};

function proposeEmptyCustom(_input: ModelApplyProposeInput) {
  return {
    metadata: {
      lists: [
        {
          action: "add",
          list_type: "custom",
          list_name: "",
          items: [{ שם: "עוגה" }, { שם: "שתיה" }],
          targets: [],
        },
        {
          action: "update",
          list_type: "tasks",
          list_name: "",
          items: [
            {
              item_id: hostItemId(_input.snapshot, "ערב יום הולדת"),
              "שם מטלה": "ערב יום הולדת",
              linked_lists: [
                {
                  list_name: "כיבוד · ערב יום הולדת",
                  list_type: "custom",
                },
              ],
            },
          ],
          targets: [],
        },
      ],
    },
    response: "שמרתי",
  };
}

function proposeNamedLink(input: ModelApplyProposeInput) {
  const listName = "כיבוד · ערב יום הולדת";
  return {
    metadata: {
      lists: [
        {
          action: "add",
          list_type: "custom",
          list_name: listName,
          items: [{ שם: "עוגה" }, { שם: "שתיה" }],
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
              linked_lists: [{ list_name: listName, list_type: "custom" }],
            },
          ],
          targets: [],
        },
      ],
    },
    response: "הוספתי כיבוד וחיברתי לערב יום הולדת",
  };
}

describe("P1 custom list_name MODEL_APPLY (offline)", () => {
  beforeAll(() => {
    const db = process.env.DATABASE_URL;
    if (!db?.trim()) throw new Error("DATABASE_URL required");
    assertApprovedEvalDatabaseUrl(db);
  });

  afterEach(() => vi.restoreAllMocks());

  it("skips unnamed custom create and leaves no orphaned items", async () => {
    const result = await runModelApplyCase(emptyCustomCase, proposeEmptyCustom);
    expect(result.failures, result.failures.join("; ")).toEqual([]);
    expect(result.ok).toBe(true);
    const custom = result.turns[0]!.snapshot.lists.filter(
      (l) => l.list_type === "custom",
    );
    expect(custom.every((l) => (l.list_name ?? "").trim() !== "")).toBe(true);
    expect(
      custom.flatMap((l) => l.items).some((i) => JSON.stringify(i).includes("עוגה")),
    ).toBe(false);
  });

  it("creates named custom and links host; facts include כיבוד", async () => {
    const result = await runModelApplyCase(namedLinkCase, proposeNamedLink);
    expect(result.failures, result.failures.join("; ")).toEqual([]);
    expect(result.ok).toBe(true);
    const snap = result.turns[0]!.snapshot;
    const custom = snap.lists.find(
      (l) =>
        l.list_type === "custom" &&
        String(l.list_name ?? "").includes("כיבוד"),
    );
    expect(custom).toBeTruthy();
    expect(custom!.items.length).toBeGreaterThanOrEqual(2);
    const hosts = snap.lists
      .filter((l) => l.list_type === "tasks")
      .flatMap((l) => l.items);
    const linked = hosts[0]?.linked_lists as
      | Array<{ list_name?: string }>
      | undefined;
    expect(
      linked?.some((row) => String(row.list_name ?? "").includes("כיבוד")),
    ).toBe(true);
  });
});
