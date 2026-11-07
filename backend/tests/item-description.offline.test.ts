/**
 * Optional item description (shopping + custom-list rows): the full list stays
 * compact and shows only 📝 when real text exists; opening the item shows the
 * text; items without a description look exactly as before; 📎 unchanged; a
 * user column named «description» keeps its own meaning.
 */
import { describe, expect, it } from "vitest";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import {
  customItemGeneralDescription,
  formatShowDumpFromKind,
  listDetailOverflowMark,
  shoppingItemDescription,
  shoppingRowsWithDetail,
} from "../src/services/show-button-dump.js";
import { collectAttachmentIdsForDumpRows } from "../src/services/attachment.service.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const attach = [{ attachment_id: "att-1", kind: "image", file_name: "milk.jpg" }];

function snap(items: Array<Record<string, unknown>>): EmployeeRecordSnapshot {
  return {
    lists: [
      {
        list_type: "shopping",
        list_name: "",
        owner: "טל",
        scope: "personal",
        items,
      } as EmployeeRecordSnapshot["lists"][number],
    ],
    filing: [],
  };
}

const opts = { viewerName: "טל", omitEmptySentence: true as const };

describe("shopping item description", () => {
  const items = [
    { item_id: "s1", "שם פריט": "חלב", כמות: 2, description: "של תנובה 3%" },
    { item_id: "s2", "שם פריט": "לחם", כמות: 1 },
    { item_id: "s3", "שם פריט": "ביצים", כמות: 1, description: "   " },
    { item_id: "s4", "שם פריט": "גבינה", כמות: 1, תיאור: "צפתית" },
    { item_id: "s5", "שם פריט": "קפה", כמות: 1, description: "שחור", attachments: attach },
  ];

  it("full list: 📝 only for real text, never the text itself", () => {
    const list = formatShowDumpFromKind("shopping", snap(items), opts)!;
    expect(list).toMatch(/חלב - 2 📝/);
    expect(list).toMatch(/גבינה - 1 📝/);
    expect(list).not.toContain("של תנובה");
    expect(list).not.toContain("צפתית");
    expect(list).toMatch(/לחם - 1$/m);
    expect(list).toMatch(/ביצים - 1$/m);
    expect(list).toMatch(/קפה - 1 📎 📝/);
  });

  it("items without a description render exactly as before (no 📝)", () => {
    const plain = formatShowDumpFromKind("shopping", snap([items[1]!]), opts)!;
    expect(plain).not.toContain("📝");
    expect(plain).not.toContain(" · ");
  });

  it("opening one item shows name, quantity and the description", () => {
    const one = formatShowDumpFromKind("shopping", snap(items), {
      ...opts,
      itemIds: new Set(["s1"]),
    })!;
    expect(one).toContain("חלב - 2 · של תנובה 3%");
    expect(one).not.toContain("📝");
    const empty = formatShowDumpFromKind("shopping", snap(items), {
      ...opts,
      itemIds: new Set(["s3"]),
    })!;
    expect(empty).toMatch(/ביצים - 1$/m);
    expect(empty).not.toContain(" · ");
  });

  it("opening an item with a file keeps 📎 and still sends the file", () => {
    const one = formatShowDumpFromKind("shopping", snap(items), {
      ...opts,
      itemIds: new Set(["s5"]),
    })!;
    expect(one).toContain("קפה - 1 · שחור 📎");
    expect(collectAttachmentIdsForDumpRows(snap(items), new Set(["s5"]))).toEqual(["att-1"]);
  });

  it("only shopping rows with a description or a file earn a direct tap", () => {
    expect([...shoppingRowsWithDetail(snap(items))].sort()).toEqual(["s1", "s4", "s5"]);
    const fileOnly = snap([{ item_id: "f1", "שם פריט": "סבון", כמות: 1, attachments: attach }]);
    expect([...shoppingRowsWithDetail(fileOnly)]).toEqual(["f1"]);
  });

  it("canonical key is `description`; legacy «תיאור» is still read, never preferred over it", () => {
    expect(shoppingItemDescription({ description: "חדש", תיאור: "ישן" })).toBe("חדש");
    expect(shoppingItemDescription({ תיאור: "ישן" })).toBe("ישן");
  });

  it("whitespace-only description is no description", () => {
    expect(shoppingItemDescription({ description: "  \n " })).toBe("");
    expect(shoppingItemDescription({ תיאור: " צפתית " })).toBe("צפתית");
  });

  it("the shared additional-text indicator is 📝 (custom / filing / shopping)", () => {
    expect(listDetailOverflowMark(true)).toBe(" 📝");
    expect(listDetailOverflowMark(false)).toBe("");
  });

  it("the model's shopping field definitions include the optional description", () => {
    const config = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../LLM.config.json"), "utf8"),
    ) as { systemMessage: string[] };
    const line = config.systemMessage.find((row) => row.trim().startsWith("shopping: שם פריט"));
    expect(line).toContain("description (optional");
  });
});

function custom(columns: string[] | undefined, items: Array<Record<string, unknown>>): EmployeeRecordSnapshot {
  return {
    lists: [
      {
        list_type: "custom",
        list_name: "ספקים",
        title_field: "שם",
        ...(columns ? { columns } : {}),
        owner: "טל",
        scope: "personal",
        items,
      } as EmployeeRecordSnapshot["lists"][number],
    ],
    filing: [],
  };
}

describe("custom-list item general description", () => {
  const rows = [
    { item_id: "c1", שם: "דני", טלפון: "050", description: "אינסטלטור טוב" },
    { item_id: "c2", שם: "רון", טלפון: "052" },
    { item_id: "c3", שם: "גל", טלפון: "053", description: "  ", attachments: attach },
    { item_id: "c4", שם: "נועה", טלפון: "054", description: "חשמלאית", attachments: attach },
  ];

  it("list view: column preview unchanged, 📝 only for a real description, text never shown", () => {
    const list = formatShowDumpFromKind("ספקים", custom(["שם", "טלפון"], rows), opts)!;
    expect(list).toBe(
      "📋 רשימת «ספקים»:\n1. דני 📝\nטלפון: 050\n2. רון\nטלפון: 052\n3. גל 📎\nטלפון: 053\n4. נועה 📎 📝\nטלפון: 054",
    );
  });

  it("opening the row shows its columns and the description", () => {
    expect(
      formatShowDumpFromKind("ספקים", custom(["שם", "טלפון"], rows), { ...opts, itemIds: new Set(["c1"]) }),
    ).toBe("📋 רשימת «ספקים»:\n1. שם: דני · טלפון: 050 · אינסטלטור טוב");
    expect(
      formatShowDumpFromKind("ספקים", custom(["שם", "טלפון"], rows), { ...opts, itemIds: new Set(["c2"]) }),
    ).toBe("📋 רשימת «ספקים»:\n1. שם: רון · טלפון: 052");
  });

  it("a user column named «description» keeps its meaning (no 📝, no reinterpretation)", () => {
    const own = custom(["שם", "description"], [{ item_id: "d1", שם: "דני", description: "עמודה של המשתמש" }]);
    expect(customItemGeneralDescription(own.lists[0]!.items[0]!, own.lists[0]!.columns)).toBe("");
    expect(formatShowDumpFromKind("ספקים", own, opts)).toBe(
      "📋 רשימת «ספקים»:\n1. דני\ndescription: עמודה של המשתמש",
    );
    expect(formatShowDumpFromKind("ספקים", own, { ...opts, itemIds: new Set(["d1"]) })).toBe(
      "📋 רשימת «ספקים»:\n1. שם: דני · description: עמודה של המשתמש",
    );
    expect(customItemGeneralDescription({ description: "x" }, [" Description "])).toBe("");
  });

  it("a list without declared columns treats every key as a column, as today", () => {
    expect(customItemGeneralDescription({ שם: "דני", description: "x" }, undefined)).toBe("");
    const legacy = formatShowDumpFromKind(
      "ספקים",
      custom(undefined, [{ item_id: "l1", שם: "דני", description: "ישן" }]),
      opts,
    )!;
    expect(legacy).not.toContain("📝");
    expect(legacy).toContain("description: ישן");
  });

  it("a truncated column preview still gets 📝 (existing behaviour)", () => {
    const long = "א".repeat(400);
    const list = formatShowDumpFromKind(
      "ספקים",
      custom(["שם", "הערות"], [{ item_id: "t1", שם: "דני", הערות: long }]),
      opts,
    )!;
    expect(list).toMatch(/^1\. דני 📝$/m);
  });
});
