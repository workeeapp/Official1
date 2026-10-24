/**
 * Offline: MT remove turns pin exact eval-live-item-N ids after seq reset.
 * Wrong / missing item_id fails; correct id passes. No Hebrew title required.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LlmMetadata } from "@workee/shared";
import {
  evaluateConstraints,
  type ModelEvalConstraint,
} from "../src/eval/constraints.js";
import {
  applyLiveModelMetadataToSnapshot,
  resetLiveModelItemSeq,
} from "../src/eval/live-model-snapshot-apply.js";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";

const mtCorpusPath = resolve(
  import.meta.dirname,
  "../../docs/qa/phase-4-multi-turn-corpus.json",
);

function loadMtCase(id: string): {
  id: string;
  setup: { lists?: EmployeeRecordSnapshot["lists"] };
  turns: Array<{ utterance: string; constraints: ModelEvalConstraint[] }>;
} {
  const raw = JSON.parse(readFileSync(mtCorpusPath, "utf8")) as {
    cases: Array<{
      id: string;
      setup: { lists?: EmployeeRecordSnapshot["lists"] };
      turns: Array<{ utterance: string; constraints: ModelEvalConstraint[] }>;
    }>;
  };
  const row = raw.cases.find((c) => c.id === id);
  if (!row) throw new Error(`missing case ${id}`);
  return row;
}

function shoppingShell(): EmployeeRecordSnapshot {
  return {
    lists: [
      {
        list_id: "eval-list-shopping-personal",
        list_type: "shopping",
        owner: "טל",
        scope: "personal",
        items: [],
      },
    ],
    filing: [],
    reminders: [],
  };
}

function addMeta(label: string): LlmMetadata {
  return {
    lists: [
      {
        action: "add",
        listType: "shopping",
        listName: "",
        targets: [],
        items: [{ "שם פריט": label }],
      },
    ],
    listOps: [],
    filing: [],
    directory: [],
    reminders: [],
    jobs: [],
    messages: [],
  } as unknown as LlmMetadata;
}

function removeMeta(itemId: string, extra?: Record<string, unknown>): LlmMetadata {
  return {
    lists: [
      {
        action: "remove",
        listType: "shopping",
        listName: "",
        targets: [],
        items: [{ item_id: itemId, ...extra }],
      },
    ],
    listOps: [],
    filing: [],
    directory: [],
    reminders: [],
    jobs: [],
    messages: [],
  } as unknown as LlmMetadata;
}

describe("decision-core remove identity (offline)", () => {
  it("mt-multi-add-then-buy pins eval-live-item-1 (id-only remove)", () => {
    const corpusCase = loadMtCase("mt-multi-add-then-buy");
    const removeTurn = corpusCase.turns[1]!;
    const removeConstraint = removeTurn.constraints.find(
      (c) => c.type === "lists_remove_item_ids",
    );
    expect(removeConstraint).toEqual({
      type: "lists_remove_item_ids",
      listType: "shopping",
      itemIds: ["eval-live-item-1"],
    });
    expect(
      removeTurn.constraints.some(
        (c) =>
          c.type === "lists_has_action" &&
          (c as { action?: string }).action === "remove",
      ),
    ).toBe(false);

    resetLiveModelItemSeq();
    const snap = shoppingShell();
    applyLiveModelMetadataToSnapshot(snap, addMeta("יוגורט"), "טל");
    expect(snap.lists[0]!.items).toHaveLength(1);
    expect(
      (snap.lists[0]!.items[0] as Record<string, unknown>).item_id,
    ).toBe("eval-live-item-1");

    const constraints = removeTurn.constraints;
    expect(
      evaluateConstraints(
        constraints,
        removeMeta("eval-live-item-1"),
        "הסרתי",
      ).ok,
    ).toBe(true);
    expect(
      evaluateConstraints(
        constraints,
        removeMeta(""),
        "הסרתי",
      ).ok,
    ).toBe(false);
    expect(
      evaluateConstraints(
        constraints,
        removeMeta("eval-live-item-99"),
        "הסרתי",
      ).ok,
    ).toBe(false);
    // Title-only remove (no id) must fail under lists_remove_item_ids.
    expect(
      evaluateConstraints(
        constraints,
        {
          lists: [
            {
              action: "remove",
              listType: "shopping",
              listName: "",
              targets: [],
              items: [{ "שם פריט": "יוגורט" }],
            },
          ],
          listOps: [],
          filing: [],
          directory: [],
          reminders: [],
          jobs: [],
          messages: [],
        } as unknown as LlmMetadata,
        "הסרתי יוגורט",
      ).ok,
    ).toBe(false);
  });

  it("core-shopping-crud-mt remove milk pins eval-live-item-1 after two adds", () => {
    const corpusCase = loadMtCase("core-shopping-crud-mt");
    const removeTurn = corpusCase.turns[2]!;
    expect(
      removeTurn.constraints.find((c) => c.type === "lists_remove_item_ids"),
    ).toEqual({
      type: "lists_remove_item_ids",
      listType: "shopping",
      itemIds: ["eval-live-item-1"],
    });

    resetLiveModelItemSeq();
    const snap = shoppingShell();
    applyLiveModelMetadataToSnapshot(snap, addMeta("חלב"), "טל");
    applyLiveModelMetadataToSnapshot(snap, addMeta("לחם"), "טל");
    const ids = snap.lists[0]!.items.map(
      (row) => (row as Record<string, unknown>).item_id,
    );
    expect(ids).toEqual(["eval-live-item-1", "eval-live-item-2"]);

    const constraints = removeTurn.constraints;
    expect(
      evaluateConstraints(
        constraints,
        removeMeta("eval-live-item-1"),
        "נמחק החלב",
      ).ok,
    ).toBe(true);
    // Wrong target (bread) must fail — unrelated item must not score.
    expect(
      evaluateConstraints(
        constraints,
        removeMeta("eval-live-item-2"),
        "נמחק",
      ).ok,
    ).toBe(false);
    expect(
      evaluateConstraints(constraints, removeMeta(""), "נמחק").ok,
    ).toBe(false);
  });

  it("resetLiveModelItemSeq makes mint order case-local", () => {
    resetLiveModelItemSeq();
    const a = shoppingShell();
    applyLiveModelMetadataToSnapshot(a, addMeta("א"), "טל");
    expect(
      (a.lists[0]!.items[0] as Record<string, unknown>).item_id,
    ).toBe("eval-live-item-1");

    // Without reset, next case would continue the counter.
    const bNoReset = shoppingShell();
    applyLiveModelMetadataToSnapshot(bNoReset, addMeta("ב"), "טל");
    expect(
      (bNoReset.lists[0]!.items[0] as Record<string, unknown>).item_id,
    ).toBe("eval-live-item-2");

    resetLiveModelItemSeq();
    const c = shoppingShell();
    applyLiveModelMetadataToSnapshot(c, addMeta("ג"), "טל");
    expect(
      (c.lists[0]!.items[0] as Record<string, unknown>).item_id,
    ).toBe("eval-live-item-1");
  });
});
