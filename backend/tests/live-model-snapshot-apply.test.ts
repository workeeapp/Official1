import { describe, expect, it } from "vitest";
import type { LlmMetadata } from "@workee/shared";
import { applyLiveModelMetadataToSnapshot } from "../src/eval/live-model-snapshot-apply.js";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";

function emptySnap(): EmployeeRecordSnapshot {
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

describe("applyLiveModelMetadataToSnapshot", () => {
  it("adds then removes a shopping item in memory", () => {
    const snap = emptySnap();
    const addMeta = {
      lists: [
        {
          action: "add",
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
    } as unknown as LlmMetadata;
    applyLiveModelMetadataToSnapshot(snap, addMeta, "טל");
    expect(snap.lists[0]!.items).toHaveLength(1);
    expect(JSON.stringify(snap.lists[0]!.items[0])).toContain("יוגורט");

    const remMeta = {
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
    } as unknown as LlmMetadata;
    applyLiveModelMetadataToSnapshot(snap, remMeta, "טל");
    expect(snap.lists[0]!.items).toHaveLength(0);
  });
});
