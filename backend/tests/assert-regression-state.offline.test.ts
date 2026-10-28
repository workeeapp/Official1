/**
 * Offline assertRegressionState matrix for create+link evidence (no DB).
 */
import { describe, expect, it } from "vitest";
import { assertRegressionState } from "../src/eval/run-multi-turn.js";
import { buildPostApplyEvidence } from "../src/eval/post-apply-evidence.js";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";

const LIST_NAME = "כיבוד · ערב יום הולדת";
const HOST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function snapshotWith(input: {
  includeShteiya: boolean;
  linkedName: string | null;
}): EmployeeRecordSnapshot {
  const items: Record<string, unknown>[] = [{ שם: "עוגה" }];
  if (input.includeShteiya) {
    items.push({ שם: "שתייה" });
  }
  const hostItem: Record<string, unknown> = {
    item_id: HOST_ID,
    "שם מטלה": "ערב יום הולדת",
  };
  if (input.linkedName) {
    hostItem.linked_lists = [
      { list_id: "list-custom-1", list_type: "custom", list_name: input.linkedName },
    ];
  }
  return {
    lists: [
      {
        list_id: "list-tasks",
        list_type: "tasks",
        list_name: "",
        owner: "טל",
        scope: "personal",
        items: [hostItem],
      },
      {
        list_id: "list-custom-1",
        list_type: "custom",
        list_name: LIST_NAME,
        owner: "טל",
        scope: "personal",
        items,
      },
    ],
    filing: [],
  };
}

function factsFor(snap: EmployeeRecordSnapshot): string {
  const custom = snap.lists.find((l) => l.list_type === "custom");
  const texts = (custom?.items ?? []).map((i) =>
    String((i as { שם?: string }).שם ?? ""),
  );
  return [
    "EMPLOYEE_SAVED_DATA",
    LIST_NAME,
    ...texts,
    "ערב יום הולדת",
  ].join("\n");
}

const fullExpect = {
  itemIdsPresent: [HOST_ID],
  factsInclude: [LIST_NAME, "עוגה", "שתייה", "ערב יום הולדת"],
  linkedListNamesOnItem: {
    itemId: HOST_ID,
    listNames: [LIST_NAME],
  },
};

describe("assertRegressionState create+link evidence", () => {
  it("passes when list title, both items, and exact host link are present", () => {
    const snap = snapshotWith({ includeShteiya: true, linkedName: LIST_NAME });
    const facts = factsFor(snap);
    expect(assertRegressionState(snap, facts, fullExpect)).toEqual([]);

    const evidence = buildPostApplyEvidence({ facts, snapshot: snap });
    expect(evidence.customLists).toEqual([
      { list_name: LIST_NAME, itemTexts: ["עוגה", "שתייה"] },
    ]);
    expect(evidence.hostLinks).toEqual([
      { item_id: HOST_ID, linked_list_names: [LIST_NAME] },
    ]);
  });

  it("fails when שתייה is missing from facts", () => {
    const snap = snapshotWith({ includeShteiya: false, linkedName: LIST_NAME });
    const facts = factsFor(snap);
    const failures = assertRegressionState(snap, facts, fullExpect);
    expect(failures.some((f) => f.includes("שתייה"))).toBe(true);
  });

  it("fails when host linked_lists is absent", () => {
    const snap = snapshotWith({ includeShteiya: true, linkedName: null });
    const facts = factsFor(snap);
    const failures = assertRegressionState(snap, facts, fullExpect);
    expect(
      failures.some((f) => f.includes("missing linked list name")),
    ).toBe(true);
  });

  it("fails when linked list name is wrong", () => {
    const snap = snapshotWith({
      includeShteiya: true,
      linkedName: "מי מגיע · ערב יום הולדת",
    });
    const facts = factsFor(snap);
    const failures = assertRegressionState(snap, facts, fullExpect);
    expect(
      failures.some((f) => f.includes("missing linked list name")),
    ).toBe(true);
  });
});
