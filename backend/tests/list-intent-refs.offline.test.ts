/**
 * Stage-2 resolveIntentRefs / thisTurnVisibleRefs — no prompt, no reply-truth.
 */
import { describe, expect, it } from "vitest";
import { parseReplyMetadata, type LlmListAction } from "@workee/shared";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import {
  buildThisTurnVisibleRefs,
  resolveIntentRefs,
} from "../src/services/list-intent-refs.js";
import {
  restrictListMutatesToLastNumberedDump,
  type LastNumberedDumpLine,
} from "../src/services/show-button-dump.js";

const shoppingId = "shop-old-1";
const taskTodayId = "task-today-yes";
const customAId = "custom-a-1";
const customBId = "custom-b-1";
const listAId = "list-shell-a";
const listBId = "list-shell-b";

const speakerSnap: EmployeeRecordSnapshot = {
  lists: [
    {
      list_type: "shopping",
      list_name: "",
      owner: "טל",
      scope: "personal",
      items: [{ item_id: shoppingId, "שם פריט": "חלב" }],
    },
    {
      list_type: "tasks",
      list_name: "",
      owner: "טל",
      scope: "personal",
      items: [{ item_id: taskTodayId, "שם משימה": "דיברתי עם yes" }],
    },
    {
      list_id: listAId,
      list_type: "custom",
      list_name: "רשימה א",
      owner: "טל",
      scope: "personal",
      items: [{ item_id: customAId, שם: "פריט א" }],
    },
    {
      list_id: listBId,
      list_type: "custom",
      list_name: "רשימה ב",
      owner: "טל",
      scope: "personal",
      items: [{ item_id: customBId, שם: "פריט ב" }],
    },
  ],
  filing: [],
};

const customDump: LastNumberedDumpLine[] = [
  {
    n: 1,
    id: customBId,
    kind: "custom",
    title_stem: "פריט ב",
    list_name: "רשימה ב",
  },
];

function removeAction(
  listType: LlmListAction["listType"],
  items: Record<string, unknown>[],
  extra?: Partial<LlmListAction>,
): LlmListAction {
  return {
    action: "remove",
    listType,
    listName: extra?.listName ?? (listType === "custom" ? "רשימה ב" : ""),
    items,
    targets: [],
    ...extra,
  };
}

describe("parse preserves optional listId on row mutates", () => {
  it("keeps lists[].list_id on remove for intent gate", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        responses: [{ text: "אוקיי" }],
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "custom",
              list_name: "רשימה א",
              list_id: listAId,
              items: [{ item_id: customAId, mutate_source: "saved_data" }],
              targets: [],
            },
          ],
        },
      }),
    );
    expect(meta.lists[0]?.listId).toBe(listAId);
    expect(meta.lists[0]?.items[0]).toMatchObject({
      item_id: customAId,
      mutate_source: "saved_data",
    });
  });
});

describe("buildThisTurnVisibleRefs", () => {
  it("indexes item_id / list_id from the injected snapshot only", () => {
    const map = buildThisTurnVisibleRefs(speakerSnap);
    expect(map.get(taskTodayId)).toMatchObject({
      domain: "list",
      listType: "tasks",
    });
    expect(map.get(customAId)).toMatchObject({
      listId: listAId,
      listName: "רשימה א",
    });
    expect(map.has("uuid-not-in-snapshot")).toBe(false);
  });
});

describe("resolveIntentRefs", () => {
  const visibleRefs = buildThisTurnVisibleRefs(speakerSnap);

  it("leaves legacy items without mutate_source untouched (no saved_data inference)", () => {
    const legacy = removeAction("shopping", [{ item_id: shoppingId }]);
    const out = resolveIntentRefs([legacy], {
      dump: customDump,
      visibleRefs,
    });
    expect(out.lists).toEqual([legacy]);
    expect(out.passThroughIds.size).toBe(0);
    expect(out.misses).toEqual([]);
  });

  it("A: saved_data id absent from this-turn facts → miss (even if UUID looks real)", () => {
    const stale = removeAction("shopping", [
      {
        mutate_source: "saved_data",
        item_id: "dead-beef-not-in-esd",
      },
    ]);
    const out = resolveIntentRefs([stale], {
      dump: customDump,
      visibleRefs,
    });
    expect(out.lists).toEqual([]);
    expect(out.misses.map((m) => m.reason)).toContain("not_in_this_turn_facts");
    expect(out.passThroughIds.size).toBe(0);
  });

  it("B′: saved_data task in ESD after custom dump → passThrough (H must not drop)", () => {
    const esd = removeAction("tasks", [
      {
        mutate_source: "saved_data",
        item_id: taskTodayId,
        "שם משימה": "דיברתי עם yes",
      },
    ]);
    const intent = resolveIntentRefs([esd], {
      dump: customDump,
      visibleRefs,
    });
    expect(intent.lists[0]?.items[0]).toMatchObject({
      item_id: taskTodayId,
    });
    expect(intent.passThroughIds.has(taskTodayId)).toBe(true);

    const afterH = restrictListMutatesToLastNumberedDump(
      intent.lists,
      customDump,
      { passThroughIds: intent.passThroughIds },
    );
    expect(afterH.lists[0]?.items.map((i) => i.item_id)).toEqual([taskTodayId]);

    // Without passThrough, legacy H still drops cross-domain (unchanged fallback).
    const legacyH = restrictListMutatesToLastNumberedDump(intent.lists, customDump);
    expect(legacyH.lists).toEqual([]);
  });

  it("C: saved_data item from list A with list_id of list B → list_id_mismatch", () => {
    const bad = removeAction(
      "custom",
      [{ mutate_source: "saved_data", item_id: customAId }],
      { listName: "רשימה א", listId: listBId },
    );
    const out = resolveIntentRefs([bad], {
      dump: customDump,
      visibleRefs,
    });
    expect(out.lists).toEqual([]);
    expect(out.misses.map((m) => m.reason)).toContain("list_id_mismatch");
  });

  it("C′: saved_data item from list A with matching list_id → keep", () => {
    const ok = removeAction(
      "custom",
      [{ mutate_source: "saved_data", item_id: customAId }],
      { listName: "רשימה א", listId: listAId },
    );
    const out = resolveIntentRefs([ok], {
      dump: customDump,
      visibleRefs,
    });
    expect(out.lists[0]?.items[0]).toMatchObject({ item_id: customAId });
    expect(out.passThroughIds.has(customAId)).toBe(true);
  });

  it("dump_line: server stamps dump id and ignores model UUID", () => {
    const forged = removeAction("custom", [
      {
        mutate_source: "dump_line",
        dump_line: 1,
        item_id: shoppingId,
      },
    ]);
    const out = resolveIntentRefs([forged], {
      dump: customDump,
      visibleRefs,
    });
    expect(out.lists[0]?.items[0]?.item_id).toBe(customBId);
    expect(out.passThroughIds.has(customBId)).toBe(true);
  });

  it("dump_line out of range → miss with op", () => {
    const bad = removeAction("custom", [
      { mutate_source: "dump_line", dump_line: 99 },
    ]);
    const out = resolveIntentRefs([bad], {
      dump: customDump,
      visibleRefs,
    });
    expect(out.lists).toEqual([]);
    expect(out.misses).toEqual([
      expect.objectContaining({
        reason: "dump_line_invalid",
        op: "remove",
        dumpLine: 99,
      }),
    ]);
  });

  it("invalid mutate_source → miss with op", () => {
    const bad = removeAction("tasks", [
      { mutate_source: "esd", item_id: taskTodayId },
    ]);
    const out = resolveIntentRefs([bad], {
      dump: customDump,
      visibleRefs,
    });
    expect(out.lists).toEqual([]);
    expect(out.misses).toEqual([
      expect.objectContaining({
        reason: "invalid_source",
        op: "remove",
      }),
    ]);
  });

  it("legacy shopping ids under custom dump still dropped by H", () => {
    const legacy = removeAction("shopping", [
      { item_id: shoppingId },
    ]);
    const intent = resolveIntentRefs([legacy], {
      dump: customDump,
      visibleRefs,
    });
    const afterH = restrictListMutatesToLastNumberedDump(
      intent.lists,
      customDump,
      intent.passThroughIds.size
        ? { passThroughIds: intent.passThroughIds }
        : undefined,
    );
    expect(afterH.droppedOutsideDump).toBe(true);
    expect(afterH.lists).toEqual([]);
  });
});
