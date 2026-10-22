/**
 * P0 MULTI-SHELL CLEAR — stub model + production apply (offline).
 * Documents the product contract: ambiguous clear asks; scoped follow-up
 * mutates only the chosen shell; single shell clears immediately.
 * Does not change corpus / sharing semantics.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  emptyModelMetadata,
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyProposeInput,
} from "../src/eval/run-model-apply.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { buildLucyModelEvalInstructions } from "../src/services/chat.service.js";
import { buildDefaultEvalFixtures } from "../src/eval/eval-prompt-source.js";

function shoppingItemId(
  snapshot: {
    lists: Array<{ list_type?: string; items: Array<Record<string, unknown>> }>;
  },
  needle: string,
): string {
  for (const list of snapshot.lists) {
    if (list.list_type !== "shopping") continue;
    for (const item of list.items) {
      if (!JSON.stringify(item).includes(needle)) continue;
      for (const key of ["item_id", "itemId", "id"]) {
        const raw = item[key];
        if (typeof raw === "string" && raw.trim()) return raw.trim();
      }
    }
  }
  throw new Error(`expected shopping item containing ${needle}`);
}

function shoppingLabels(snapshot: {
  lists: Array<{ list_type?: string; items: Array<Record<string, unknown>> }>;
}): string[] {
  const out: string[] = [];
  for (const list of snapshot.lists) {
    if (list.list_type !== "shopping") continue;
    for (const item of list.items) {
      const label = String(item["שם פריט"] ?? item.item_key ?? "");
      if (label) out.push(label);
    }
  }
  return out;
}

const ambiguousClearCase: ModelApplyCase = {
  id: "P0-MULTI-SHELL-CLEAR-ASK-THEN-PERSONAL",
  track: "MODEL_APPLY",
  description: "Ambiguous clear asks; follow-up clears personal only",
  setup: {
    lists: [
      {
        list_id: "eval-list-shopping-personal",
        list_type: "shopping",
        owner: "טל",
        scope: "personal",
        items: [{ item_id: "eval-item-shop-milk", "שם פריט": "חלב" }],
      },
      {
        list_id: "eval-list-shopping-shared",
        list_type: "shopping",
        list_name: "קניות משותפת",
        owner: "טל",
        scope: "shared",
        shared_with: ["עמית"],
        items: [{ item_id: "eval-item-shop-shared-bread", "שם פריט": "לחם" }],
      },
    ],
  },
  turns: [
    {
      utterance: "נקה את הקניות",
      constraints: [
        { type: "mutations_empty_or_read_only" },
        { type: "response_looks_like_ask" },
      ],
      stateAfter: { factsInclude: ["חלב", "לחם"] },
    },
    {
      utterance: "רק את האישית שלי",
      constraints: [
        {
          type: "lists_remove_item_ids",
          listType: "shopping",
          itemIds: ["eval-item-shop-milk"],
        },
        { type: "list_ops_empty" },
      ],
      stateAfter: {
        itemIdsAbsent: ["eval-item-shop-milk"],
        factsInclude: ["לחם"],
      },
    },
  ],
};

const singleShellClearCase: ModelApplyCase = {
  id: "P0-SINGLE-SHELL-CLEAR-NOW",
  track: "MODEL_APPLY",
  description: "One shopping shell → clear immediately",
  setup: {
    lists: [
      {
        list_id: "eval-list-shopping-personal",
        list_type: "shopping",
        owner: "טל",
        scope: "personal",
        items: [
          { item_id: "eval-item-milk", "שם פריט": "חלב" },
          { item_id: "eval-item-eggs", "שם פריט": "ביצים" },
        ],
      },
    ],
  },
  turns: [
    {
      utterance: "נקה את הקניות",
      constraints: [
        {
          type: "lists_remove_item_ids",
          listType: "shopping",
          itemIds: ["eval-item-milk", "eval-item-eggs"],
        },
        { type: "list_ops_empty" },
      ],
      stateAfter: {
        itemIdsAbsent: ["eval-item-milk", "eval-item-eggs"],
      },
    },
  ],
};

function proposeAmbiguous(input: ModelApplyProposeInput) {
  if (input.turnIndex === 0) {
    return {
      metadata: emptyModelMetadata(),
      response: "לאיזו רשימת קניות התכוונת — האישית שלך או קניות משותפת?",
    };
  }
  return {
    metadata: {
      lists: [
        {
          action: "remove",
          list_type: "shopping",
          list_name: "",
          items: [{ item_id: shoppingItemId(input.snapshot, "חלב") }],
          targets: [],
        },
      ],
    },
    response: "ניקיתי את הקניות האישיות",
  };
}

function proposeSingleShell(input: ModelApplyProposeInput) {
  const milk = shoppingItemId(input.snapshot, "חלב");
  const eggs = shoppingItemId(input.snapshot, "ביצים");
  return {
    metadata: {
      lists: [
        {
          action: "remove",
          list_type: "shopping",
          list_name: "",
          items: [{ item_id: milk }, { item_id: eggs }],
          targets: [],
        },
      ],
    },
    response: "ניקיתי את הקניות",
  };
}

describe("P0 multi-shell clear prompt (offline)", () => {
  it("runtime Lucy instructions require ASK when ≥2 shopping/tasks shells match", () => {
    const { employees, worker } = buildDefaultEvalFixtures("טל", {
      includeMichal: false,
    });
    const text = buildLucyModelEvalInstructions({
      employees,
      speaker: "טל",
      worker,
    });
    expect(text).toContain("נקה את הקניות");
    expect(text).toContain("≥2 shells");
    expect(text).toContain("ASK which shell");
    expect(text).toContain("Exactly ONE unambiguous shell");
  });
});

describe("P0 multi-shell clear MODEL_APPLY (offline)", () => {
  beforeAll(() => {
    const db = process.env.DATABASE_URL;
    if (!db?.trim()) throw new Error("DATABASE_URL required");
    assertApprovedEvalDatabaseUrl(db);
  });

  afterEach(() => vi.restoreAllMocks());

  it("asks on ambiguous clear then removes only personal milk", async () => {
    const result = await runModelApplyCase(ambiguousClearCase, proposeAmbiguous);
    expect(result.failures, result.failures.join("; ")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.turns[0]?.appliedViaProduction).toBe(false);
    expect(shoppingLabels(result.turns[0]!.snapshot).sort()).toEqual([
      "חלב",
      "לחם",
    ]);
    expect(result.turns[1]?.appliedViaProduction).toBe(true);
    expect(shoppingLabels(result.turns[1]!.snapshot)).toEqual(["לחם"]);
  });

  it("clears immediately when exactly one shopping shell matches", async () => {
    const result = await runModelApplyCase(
      singleShellClearCase,
      proposeSingleShell,
    );
    expect(result.failures, result.failures.join("; ")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.turns[0]?.appliedViaProduction).toBe(true);
    expect(shoppingLabels(result.turns[0]!.snapshot)).toEqual([]);
  });
});
