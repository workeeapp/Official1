/**
 * Regression (2026-11-05): showing a list with images on the list itself
 * stopped showing them — since 176e745 show_dump turns strip model buttons,
 * so the model's «📎 קבצים מצורפים» tap vanished. The engine now renders a
 * «📎 קבצי הרשימה (N)» tap on the dump; the tap goes to the model.
 */
import { describe, expect, it } from "vitest";
import {
  collectListLevelAttachmentIdsForDump,
  listFilesTapButton,
} from "../src/services/attachment.service.js";
import { builtinListHebrew, isBuiltinListType } from "../src/services/builtin-lists.js";

const hebrew = (listType: string) =>
  isBuiltinListType(listType) ? builtinListHebrew(listType) : null;

const snapshot = {
  lists: [
    {
      list_type: "custom",
      list_name: "שיפוץ",
      has_attachments: true,
      attachments: [{ attachment_id: "img-1" }, { attachment_id: "img-2" }],
      items: [{ item_id: "r1", שם: "צבע", attachments: [{ attachment_id: "item-img" }] }],
    },
    {
      list_type: "custom",
      list_name: "אחרת",
      has_attachments: true,
      attachments: [{ attachment_id: "other" }],
      items: [],
    },
    {
      list_type: "shopping",
      list_name: "",
      has_attachments: true,
      attachments: [{ attachment_id: "shop-1" }],
      items: [],
    },
    {
      list_type: "tasks",
      list_name: "",
      items: [{ item_id: "t1", attachments: [{ attachment_id: "task-img" }] }],
    },
  ],
};

describe("collectListLevelAttachmentIdsForDump", () => {
  it("custom list dump → only that list's own files (not its items', not other lists')", () => {
    expect(collectListLevelAttachmentIdsForDump(snapshot, "שיפוץ", hebrew)).toEqual([
      "img-1",
      "img-2",
    ]);
  });

  it("builtin dump resolves by Hebrew name («קניות»)", () => {
    expect(
      collectListLevelAttachmentIdsForDump(snapshot, builtinListHebrew("shopping"), hebrew),
    ).toEqual(["shop-1"]);
  });

  it("list with item files only → nothing (item files stay with ITEM DUMP)", () => {
    expect(
      collectListLevelAttachmentIdsForDump(snapshot, builtinListHebrew("tasks"), hebrew),
    ).toEqual([]);
  });

  it("respects the max and unknown names", () => {
    expect(collectListLevelAttachmentIdsForDump(snapshot, "שיפוץ", hebrew, 1)).toEqual(["img-1"]);
    expect(collectListLevelAttachmentIdsForDump(snapshot, "לא קיימת", hebrew)).toEqual([]);
  });
});

describe("listFilesTapButton", () => {
  it("label carries the count; command names the list", () => {
    expect(listFilesTapButton("שיפוץ", 2)).toEqual({
      label: "📎 קבצי הרשימה (2)",
      command: "שלחי את הקבצים של רשימת שיפוץ",
    });
    expect(listFilesTapButton("קניות", 1)?.command).toBe("שלחי את הקבצים של רשימת קניות");
  });

  it("no list-level files → no tap", () => {
    expect(listFilesTapButton("שיפוץ", 0)).toBeNull();
    expect(listFilesTapButton("", 3)).toBeNull();
  });

  it("label fits a WhatsApp button (≤20)", () => {
    expect(listFilesTapButton("x", 10)!.label.length).toBeLessThanOrEqual(20);
  });
});
