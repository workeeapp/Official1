/**
 * LIVE_FULL propose → MODEL_APPLY handoff must not re-drop normalized ACTION.
 * In-memory only — no DB / no LIVE.
 */
import { describe, expect, it } from "vitest";
import { parseLlmMetadata, parseReplyMetadata } from "@workee/shared";
import {
  isNormalizedLlmMetadata,
  metadataFromModelApplyPropose,
} from "../src/eval/run-model-apply.js";
import { fillBlankCustomListNameFromSameTurnLinks } from "../src/services/list-item-list-link.service.js";

/** Exact Case 1 raw shape from live-full-last-eval (pre-parse diagnostic). */
const CASE1_REPLY = JSON.stringify({
  responses: [{ text: "תייקתי" }],
  metadata: {
    lists: [
      {
        action: "add",
        list_type: "filing",
        list_name: "",
        items: [
          {
            item_name: "כתובת",
            item_info: "רחוב הרצל 1, תל אביב",
            item_description: "",
          },
        ],
      },
    ],
  },
});

/** Exact Case 2 turn-1 raw shape (named create, no host link). */
const CASE2_RAW_LISTS = {
  lists: [
    {
      action: "add",
      list_type: "custom",
      list_name: "כיבוד",
      title_field: "פריט",
      columns: ["פריט"],
      emoji: "🍽️",
      items: [{ פריט: "עוגה" }, { פריט: "שתיה" }],
    },
  ],
};

describe("MODEL_APPLY metadata handoff (double-parse fix)", () => {
  it("Case 1 filing survives parseReplyMetadata → propose handoff → apply prep", () => {
    const proposed = parseReplyMetadata(CASE1_REPLY);
    expect(proposed.filing).toHaveLength(1);
    expect(isNormalizedLlmMetadata(proposed)).toBe(true);

    const forApply = fillBlankCustomListNameFromSameTurnLinks(
      metadataFromModelApplyPropose(proposed),
    );
    expect(forApply.filing).toHaveLength(1);
    expect(forApply.filing[0]?.itemName).toBe("כתובת");
    expect(forApply.filing[0]?.itemInfo).toMatch(/הרצל/);
    expect(forApply.lists).toEqual([]);
  });

  it("Case 2 custom list_name survives propose handoff to create validation", () => {
    // LIVE path: first parse then hand off normalized object (not raw snake).
    const proposed = parseLlmMetadata(CASE2_RAW_LISTS);
    expect(proposed.lists[0]?.listName).toBe("כיבוד");
    expect(isNormalizedLlmMetadata(proposed)).toBe(true);

    const forApply = fillBlankCustomListNameFromSameTurnLinks(
      metadataFromModelApplyPropose(proposed),
    );
    expect(forApply.lists[0]?.listType).toBe("custom");
    expect(forApply.lists[0]?.listName).toBe("כיבוד");
    expect(forApply.lists[0]?.items).toHaveLength(2);
    // No host linked_lists → sibling fill must not invent a different name.
    expect(forApply.lists[0]?.listName).toBe("כיבוד");
  });

  it("raw snake stubs still parse once (offline propose shape)", () => {
    expect(isNormalizedLlmMetadata(CASE2_RAW_LISTS)).toBe(false);
    const parsed = metadataFromModelApplyPropose(CASE2_RAW_LISTS);
    expect(parsed.lists[0]?.listName).toBe("כיבוד");
  });

  it("sibling fill still requires unambiguous host linked_lists (unchanged)", () => {
    const blankOnly = metadataFromModelApplyPropose({
      lists: [
        {
          action: "add",
          list_type: "custom",
          list_name: "",
          items: [{ שם: "עוגה" }],
        },
      ],
    });
    expect(
      fillBlankCustomListNameFromSameTurnLinks(blankOnly).lists?.[0]?.listName,
    ).toBe("");

    const withLink = metadataFromModelApplyPropose({
      lists: [
        {
          action: "add",
          list_type: "custom",
          list_name: "",
          items: [{ שם: "עוגה" }],
        },
        {
          action: "update",
          list_type: "tasks",
          list_name: "",
          items: [
            {
              item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              linked_lists: [
                {
                  list_type: "custom",
                  list_name: "כיבוד · ערב יום הולדת",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(
      fillBlankCustomListNameFromSameTurnLinks(withLink).lists?.[0]?.listName,
    ).toBe("כיבוד · ערב יום הולדת");
  });
});
