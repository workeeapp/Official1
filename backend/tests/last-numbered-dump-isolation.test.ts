/**
 * Regression: shopping dump → custom-list show → delete 1,2 must not hit shopping.
 * Root cause was free-written custom inventory leaving a stale shopping LAST_NUMBERED_DUMP.
 */
import { describe, expect, it } from "vitest";
import {
  packAssistantLlmRawForTests,
  pickLastNumberedDumpFromAssistantRaws,
} from "../src/services/chat.service.js";
import type { LlmListAction } from "@workee/shared";
import {
  formatShowDumpWithLineMap,
  looksLikeFreeWrittenNumberedInventory,
  mapShowButtonCommandToDump,
  restrictListMutatesToLastNumberedDump,
} from "../src/services/show-button-dump.js";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";

const shoppingId1 = "shop-glida";
const shoppingId2 = "shop-skazi";
const customId1 = "custom-vcard";
const customId2 = "custom-share-bug";
const customId3 = "custom-geo";

const snap: EmployeeRecordSnapshot = {
  lists: [
    {
      list_type: "shopping",
      list_name: "",
      owner: "טל",
      scope: "personal",
      items: [
        { item_id: shoppingId1, "שם פריט": "גלידה", כמות: "1" },
        { item_id: shoppingId2, "שם פריט": "חטיף לסקאזי", כמות: "1" },
      ],
    },
    {
      list_type: "custom",
      list_name: "משימות לטל",
      owner: "טל",
      scope: "personal",
      title_field: "שם",
      columns: ["שם"],
      items: [
        { item_id: customId1, שם: "תמיכה מלאה באנשי קשר בהתאם לvcard" },
        { item_id: customId2, שם: "באג לא ניתן לעדכן מטלה משותפת" },
        { item_id: customId3, שם: "תמיכה בזיהוי כתובת/עיר לפי קואורדינטות" },
      ],
    },
  ],
  filing: [],
};

describe("LAST_NUMBERED_DUMP isolation after intervening custom dump", () => {
  it("allowlists free-typed «הצג משימות לטל» to the custom list", () => {
    expect(mapShowButtonCommandToDump("הצג משימות לטל", snap)).toBe(
      "משימות לטל",
    );
  });

  it("custom show_dump line map uses custom item_ids (not shopping)", () => {
    const shopping = formatShowDumpWithLineMap("shopping", snap);
    expect(shopping.lines.map((row) => row.id)).toEqual([
      shoppingId1,
      shoppingId2,
    ]);
    expect(shopping.lines.every((row) => row.kind === "shopping")).toBe(true);

    const custom = formatShowDumpWithLineMap("משימות לטל", snap);
    expect(custom.text).toContain("משימות לטל");
    expect(custom.text).toContain("«");
    expect(custom.lines.map((row) => row.id)).toEqual([
      customId1,
      customId2,
      customId3,
    ]);
    expect(custom.lines.every((row) => row.kind === "custom")).toBe(true);
  });

  it("newest custom dump map wins over older shopping map", () => {
    const shoppingRaw = packAssistantLlmRawForTests({
      lastNumberedDump: [
        {
          n: 1,
          id: shoppingId1,
          kind: "shopping",
          title_stem: "גלידה",
        },
        {
          n: 2,
          id: shoppingId2,
          kind: "shopping",
          title_stem: "חטיף לסקאזי",
        },
      ],
    });
    const customRaw = packAssistantLlmRawForTests({
      lastNumberedDump: [
        {
          n: 1,
          id: customId1,
          kind: "custom",
          title_stem: "תמיכה מלאה באנשי קשר בהתאם לvcard",
        },
        {
          n: 2,
          id: customId2,
          kind: "custom",
          title_stem: "באג לא ניתן לעדכן מטלה משותפת",
        },
      ],
    });
    const picked = pickLastNumberedDumpFromAssistantRaws([
      customRaw,
      shoppingRaw,
    ]);
    expect(picked.map((row) => row.id)).toEqual([customId1, customId2]);
    expect(picked.map((row) => row.id)).not.toContain(shoppingId1);
  });

  it("detects model-written custom inventory without server guillemets", () => {
    const freeWritten = [
      "📋 רשימת משימות לטל:",
      "1. תמיכה מלאה באנשי קשר בהתאם לvcard",
      "2. באג לא ניתן לעדכן מטלה משותפת",
      "3. תמיכה בזיהוי כתובת/עיר לפי קואורדינטות",
    ].join("\n");
    expect(looksLikeFreeWrittenNumberedInventory(freeWritten)).toBe(true);
    expect(
      looksLikeFreeWrittenNumberedInventory("מחקתי את הגלידה מרשימת הקניות."),
    ).toBe(false);
  });

  it("free-written inventory tombstone clears stale shopping LAST_NUMBERED_DUMP", () => {
    const shoppingRaw = packAssistantLlmRawForTests({
      lastNumberedDump: [
        {
          n: 1,
          id: shoppingId1,
          kind: "shopping",
          title_stem: "גלידה",
        },
        {
          n: 2,
          id: shoppingId2,
          kind: "shopping",
          title_stem: "חטיף לסקאזי",
        },
      ],
    });
    const freeWrittenRaw = packAssistantLlmRawForTests({
      response: {
        responses: [
          {
            text: [
              "📋 רשימת משימות לטל:",
              "1. תמיכה מלאה באנשי קשר בהתאם לvcard",
              "2. באג לא ניתן לעדכן מטלה משותפת",
            ].join("\n"),
          },
        ],
      },
      lastNumberedDumpCleared: true,
    });
    // Newest-first: cleared tombstone must NOT fall through to shopping.
    expect(
      pickLastNumberedDumpFromAssistantRaws([freeWrittenRaw, shoppingRaw]),
    ).toEqual([]);
  });

  it("delete-by-index after custom dump must copy custom ids 1,2 only", () => {
    const custom = formatShowDumpWithLineMap("משימות לטל", snap);
    const removeIds = custom.lines
      .filter((row) => row.n === 1 || row.n === 2)
      .map((row) => row.id);
    expect(removeIds).toEqual([customId1, customId2]);
    expect(removeIds).not.toContain(shoppingId1);
    expect(removeIds).not.toContain(shoppingId2);
  });

  it("SERVER GUARD: drops shopping remove ids when active dump is custom", () => {
    const customDump = formatShowDumpWithLineMap("משימות לטל", snap).lines;
    const staleShoppingRemove: LlmListAction = {
      action: "remove",
      listType: "shopping",
      listName: "",
      items: [
        { item_id: shoppingId1, "שם פריט": "גלידה" },
        { item_id: shoppingId2, "שם פריט": "חטיף לסקאזי" },
      ],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [staleShoppingRemove],
      customDump,
    );
    expect(guarded.droppedOutsideDump).toBe(true);
    expect(guarded.lists).toEqual([]);
  });

  it("SERVER GUARD: keeps custom remove ids that match the active dump", () => {
    const customDump = formatShowDumpWithLineMap("משימות לטל", snap).lines;
    const correctRemove: LlmListAction = {
      action: "remove",
      listType: "custom",
      listName: "משימות לטל",
      items: [
        { item_id: customId1 },
        { item_id: customId2 },
      ],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [correctRemove],
      customDump,
    );
    expect(guarded.droppedOutsideDump).toBe(false);
    expect(guarded.lists).toHaveLength(1);
    expect(guarded.lists[0]?.items).toHaveLength(2);
  });

  it("SERVER GUARD: no dump → does not filter (title mutates still apply)", () => {
    const remove: LlmListAction = {
      action: "remove",
      listType: "shopping",
      listName: "",
      items: [{ item_id: shoppingId1 }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump([remove], []);
    expect(guarded.droppedOutsideDump).toBe(false);
    expect(guarded.lists).toEqual([remove]);
  });

  it("SERVER GUARD: mixed ids keeps only those in the dump", () => {
    const customDump = formatShowDumpWithLineMap("משימות לטל", snap).lines;
    const mixed: LlmListAction = {
      action: "remove",
      listType: "custom",
      listName: "משימות לטל",
      items: [
        { item_id: shoppingId1 },
        { item_id: customId1 },
      ],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump([mixed], customDump);
    expect(guarded.droppedOutsideDump).toBe(true);
    expect(guarded.lists).toHaveLength(1);
    expect(guarded.lists[0]?.items).toEqual([{ item_id: customId1 }]);
  });

  it("SERVER GUARD: drops shopping add while custom dump is active", () => {
    const customDump = formatShowDumpWithLineMap("משימות לטל", snap).lines;
    expect(customDump.every((row) => row.list_name === "משימות לטל")).toBe(
      true,
    );
    const shoppingAdd: LlmListAction = {
      action: "add",
      listType: "shopping",
      listName: "",
      items: [{ "שם פריט": "חלב", כמות: "1" }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [shoppingAdd],
      customDump,
    );
    expect(guarded.droppedOutsideDump).toBe(true);
    expect(guarded.lists).toEqual([]);
  });

  it("SERVER GUARD: allows add to the same custom list as the dump", () => {
    const customDump = formatShowDumpWithLineMap("משימות לטל", snap).lines;
    const customAdd: LlmListAction = {
      action: "add",
      listType: "custom",
      listName: "משימות לטל",
      items: [{ שם: "פריט חדש" }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [customAdd],
      customDump,
    );
    expect(guarded.droppedOutsideDump).toBe(false);
    expect(guarded.lists).toEqual([customAdd]);
  });

  it("SERVER GUARD: drops add to a different custom list than the dump", () => {
    const customDump = formatShowDumpWithLineMap("משימות לטל", snap).lines;
    const otherAdd: LlmListAction = {
      action: "add",
      listType: "custom",
      listName: "באגים",
      items: [{ שם: "משהו אחר" }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump([otherAdd], customDump);
    expect(guarded.droppedOutsideDump).toBe(true);
    expect(guarded.lists).toEqual([]);
  });
});
