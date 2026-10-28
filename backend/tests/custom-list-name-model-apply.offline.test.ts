/**
 * P1 unnamed custom refuse + same-turn named custom+link (offline MODEL_APPLY).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyProposeInput,
} from "../src/eval/run-model-apply.js";
import { assertRegressionState } from "../src/eval/run-multi-turn.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";

const EXACT_LIST_NAME = "כיבוד · ערב יום הולדת";

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

const blankCreateLinkCase: ModelApplyCase = {
  id: "P1-BLANK-CREATE-UNAMBIGUOUS-LINK",
  track: "MODEL_APPLY",
  description:
    "Blank custom list_name + sole linked_lists name: create+link persist",
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
      utterance: "תוסיפי לכיבוד עוגה ושתייה וחברי",
      constraints: [
        { type: "lists_has_action", action: "add", listType: "custom" },
      ],
      stateAfter: {
        factsInclude: [EXACT_LIST_NAME, "עוגה", "שתייה"],
        linkedListNamesOnItem: {
          itemId: "eval-host-birthday",
          listNames: [EXACT_LIST_NAME],
        },
      },
    },
  ],
};

/** Standalone blank custom create — no host link name to copy. */
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
      ],
    },
    response: "שמרתי",
  };
}

/**
 * Exact LIVE_FULL turn-1 shape from full-mt-event-clarify-then-link:
 * blank custom list_name + items עוגה/שתייה + host update linking by name only.
 * Sibling fill copies the sole linked_lists name onto the create.
 */
function proposeLiveExactBlankCreateAndLink(input: ModelApplyProposeInput) {
  return {
    metadata: {
      lists: [
        {
          action: "add",
          list_type: "custom",
          list_name: "",
          columns: ["שם"],
          emoji: "🍰",
          items: [{ שם: "עוגה" }, { שם: "שתייה" }],
          targets: [],
        },
        {
          action: "update",
          list_type: "tasks",
          list_name: "",
          items: [
            {
              item_id: hostItemId(input.snapshot, "ערב יום הולדת"),
              linked_lists: [
                {
                  list_type: "custom",
                  list_name: EXACT_LIST_NAME,
                },
              ],
            },
          ],
          targets: [],
        },
      ],
    },
    response: "הוספתי כיבוד וחיברתי לערב יום הולדת",
  };
}

/** Named custom create with items but no host lists.update — link must be absent. */
function proposeNamedCreateNoHostLink(_input: ModelApplyProposeInput) {
  return {
    metadata: {
      lists: [
        {
          action: "add",
          list_type: "custom",
          list_name: EXACT_LIST_NAME,
          items: [{ שם: "עוגה" }, { שם: "שתייה" }],
          targets: [],
        },
      ],
    },
    response: "הוספתי כיבוד",
  };
}

/** Ambiguous: two distinct linked_lists names — create stays refused. */
function proposeAmbiguousLinkNames(input: ModelApplyProposeInput) {
  return {
    metadata: {
      lists: [
        {
          action: "add",
          list_type: "custom",
          list_name: "",
          items: [{ שם: "עוגה" }, { שם: "שתייה" }],
          targets: [],
        },
        {
          action: "update",
          list_type: "tasks",
          list_name: "",
          items: [
            {
              item_id: hostItemId(input.snapshot, "ערב יום הולדת"),
              linked_lists: [
                {
                  list_type: "custom",
                  list_name: "כיבוד · ערב יום הולדת",
                },
                {
                  list_type: "custom",
                  list_name: "מי מגיע · ערב יום הולדת",
                },
              ],
            },
          ],
          targets: [],
        },
      ],
    },
    response: "הוספתי כיבוד וחיברתי",
  };
}

function proposeNamedLink(input: ModelApplyProposeInput) {
  return {
    metadata: {
      lists: [
        {
          action: "add",
          list_type: "custom",
          list_name: EXACT_LIST_NAME,
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
              linked_lists: [
                { list_name: EXACT_LIST_NAME, list_type: "custom" },
              ],
            },
          ],
          targets: [],
        },
      ],
    },
    response: "הוספתי כיבוד וחיברתי לערב יום הולדת",
  };
}

/** Built-in shopping add must keep blank list_name (not filled from link). */
function proposeShoppingWithHostLink(input: ModelApplyProposeInput) {
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
        {
          action: "update",
          list_type: "tasks",
          list_name: "",
          items: [
            {
              item_id: hostItemId(input.snapshot, "ערב יום הולדת"),
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
    },
    response: "הוספתי חלב",
  };
}

describe("P1 custom list_name MODEL_APPLY (offline)", () => {
  beforeAll(() => {
    const db = process.env.DATABASE_URL;
    if (!db?.trim()) throw new Error("DATABASE_URL required");
    assertApprovedEvalDatabaseUrl(db);
  });

  afterEach(() => vi.restoreAllMocks());

  it("skips standalone unnamed custom create and leaves no orphaned items", async () => {
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
      (l) => l.list_type === "custom" && l.list_name === EXACT_LIST_NAME,
    );
    expect(custom).toBeTruthy();
    const itemBlob = JSON.stringify(custom!.items);
    expect(itemBlob).toMatch(/עוגה/);
    expect(itemBlob).toMatch(/שתיה/);
    const hosts = snap.lists
      .filter((l) => l.list_type === "tasks")
      .flatMap((l) => l.items);
    const linked = hosts[0]?.linked_lists as
      | Array<{ list_name?: string }>
      | undefined;
    expect(linked?.some((row) => row.list_name === EXACT_LIST_NAME)).toBe(true);
  });

  it("LIVE blank list_name + sole link name: create עוגה/שתייה and host link persist", async () => {
    const result = await runModelApplyCase(
      blankCreateLinkCase,
      proposeLiveExactBlankCreateAndLink,
    );
    expect(result.failures, result.failures.join("; ")).toEqual([]);
    expect(result.ok).toBe(true);
    const turn = result.turns[0]!;
    expect(turn.metadata.lists?.[0]?.listName).toBe(EXACT_LIST_NAME);
    const custom = turn.snapshot.lists.find(
      (l) => l.list_type === "custom" && l.list_name === EXACT_LIST_NAME,
    );
    expect(custom).toBeTruthy();
    const itemTexts = custom!.items.map((i) => JSON.stringify(i)).join("|");
    expect(itemTexts).toMatch(/עוגה/);
    expect(itemTexts).toMatch(/שתייה/);
    const hosts = turn.snapshot.lists
      .filter((l) => l.list_type === "tasks")
      .flatMap((l) => l.items);
    const linked = hosts[0]?.linked_lists as
      | Array<{ list_name?: string }>
      | undefined;
    expect(linked?.some((row) => row.list_name === EXACT_LIST_NAME)).toBe(true);
  });

  it("named create without host update: items on list, host link absent", async () => {
    const result = await runModelApplyCase(
      {
        ...namedLinkCase,
        id: "P1-CREATE-NO-HOST-LINK",
        turns: [
          {
            utterance: "תוסיפי לכיבוד עוגה ושתייה",
            constraints: [
              { type: "lists_has_action", action: "add", listType: "custom" },
            ],
            stateAfter: {
              factsInclude: [EXACT_LIST_NAME, "עוגה", "שתייה"],
            },
          },
        ],
      },
      proposeNamedCreateNoHostLink,
    );
    expect(result.failures, result.failures.join("; ")).toEqual([]);
    expect(result.ok).toBe(true);
    const turn = result.turns[0]!;
    const custom = turn.snapshot.lists.find(
      (l) => l.list_type === "custom" && l.list_name === EXACT_LIST_NAME,
    );
    expect(custom).toBeTruthy();
    const itemTexts = custom!.items.map((i) => JSON.stringify(i)).join("|");
    expect(itemTexts).toMatch(/עוגה/);
    expect(itemTexts).toMatch(/שתייה/);
    const host = turn.snapshot.lists
      .filter((l) => l.list_type === "tasks")
      .flatMap((l) => l.items)[0] as Record<string, unknown> | undefined;
    expect(host).toBeTruthy();
    const linked = host!.linked_lists;
    expect(!linked || (Array.isArray(linked) && linked.length === 0)).toBe(
      true,
    );
    const hostId = String(host!.item_id ?? "");
    const linkFailures = assertRegressionState(turn.snapshot, turn.facts, {
      linkedListNamesOnItem: {
        itemId: hostId,
        listNames: [EXACT_LIST_NAME],
      },
    });
    expect(
      linkFailures.some((f) => f.includes("missing linked list name")),
    ).toBe(true);
  });

  it("ambiguous linked_lists names: create remains refused; no false success claim", async () => {
    const result = await runModelApplyCase(
      emptyCustomCase,
      proposeAmbiguousLinkNames,
    );
    expect(result.ok).toBe(true);
    const turn = result.turns[0]!;
    const custom = turn.snapshot.lists.filter((l) => l.list_type === "custom");
    expect(
      custom.flatMap((l) => l.items).some((i) => JSON.stringify(i).includes("עוגה")),
    ).toBe(false);
    expect(turn.facts).not.toMatch(/כיבוד/);
    expect(turn.response).not.toMatch(/עדכנתי/);
  });

  it("built-in shopping add keeps blank list_name; does not invent custom from link", async () => {
    const result = await runModelApplyCase(
      {
        ...emptyCustomCase,
        id: "P1-SHOPPING-UNCHANGED",
        turns: [
          {
            utterance: "תוסיפי חלב לקניות",
            constraints: [
              { type: "lists_has_action", action: "add", listType: "shopping" },
            ],
            stateAfter: {
              factsInclude: ["חלב"],
              factsExclude: ["כיבוד"],
            },
          },
        ],
      },
      proposeShoppingWithHostLink,
    );
    expect(result.failures, result.failures.join("; ")).toEqual([]);
    expect(result.ok).toBe(true);
    const turn = result.turns[0]!;
    expect(turn.metadata.lists?.[0]?.listType).toBe("shopping");
    expect(turn.metadata.lists?.[0]?.listName).toBe("");
    expect(
      turn.snapshot.lists.some(
        (l) =>
          l.list_type === "custom" &&
          String(l.list_name ?? "").includes("כיבוד"),
      ),
    ).toBe(false);
  });
});
