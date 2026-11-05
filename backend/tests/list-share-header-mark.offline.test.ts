/**
 * Shared list indication (request 2026-11-05): a whole-list share shows WITH
 * WHOM on the list header («· משותפת עם X»), visibly different from a single
 * co-shared item, which keeps its «(A, B)» line mark.
 */
import { describe, expect, it } from "vitest";
import { formatShowDumpFromKind } from "../src/services/show-button-dump.js";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";

type List = EmployeeRecordSnapshot["lists"][number];

function snap(lists: List[]): EmployeeRecordSnapshot {
  return { lists, filing: [] };
}

describe("list header share mark", () => {
  it("shared custom list → «רשימת «X» · משותפת עם עמית:», rows unmarked", () => {
    const text = formatShowDumpFromKind(
      "בעיות",
      snap([
        {
          list_type: "custom",
          list_name: "בעיות",
          owner: "טל",
          scope: "shared",
          shared_with: ["טל", "עמית"],
          items: [
            { item_id: "a", שם: "דליפה" },
            { item_id: "b", שם: "נורה" },
          ],
        } as List,
      ]),
      { viewerName: "טל" },
    )!;
    expect(text).toMatch(/רשימת «בעיות» · משותפת עם עמית:/);
    expect(text).toMatch(/^1\. דליפה$/m);
    expect(text).toMatch(/^2\. נורה$/m);
  });

  it("personal list → plain header", () => {
    const text = formatShowDumpFromKind(
      "shopping",
      snap([
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [{ item_id: "m", "שם פריט": "חלב" }],
        } as List,
      ]),
      { viewerName: "טל" },
    )!;
    expect(text).toMatch(/^🛒 קניות:/m);
    expect(text).not.toContain("משותפת");
  });

  it("personal + shared shell → two headers; item co-share keeps «(A, B)»; numbering continues", () => {
    const text = formatShowDumpFromKind(
      "shopping",
      snap([
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "m", "שם פריט": "חלב" },
            { item_id: "c", "שם פריט": "לחם", shared_with: ["טל", "מיכל"] },
          ],
        } as List,
        {
          list_type: "shopping",
          list_name: "",
          owner: "מיכל",
          scope: "shared",
          shared_with: ["טל", "מיכל"],
          items: [{ item_id: "s", "שם פריט": "יין" }],
        } as List,
      ]),
      { viewerName: "טל" },
    )!;
    const [personal, shared] = text.split("\n\n");
    expect(personal).toMatch(/^🛒 קניות:/);
    expect(personal).toMatch(/^1\. חלב/m);
    expect(personal).toMatch(/^2\. לחם.*\(מיכל, טל\)/m);
    expect(shared).toMatch(/^🛒 קניות · משותפת עם מיכל:/);
    expect(shared).toMatch(/^3\. יין/m);
    expect(shared).not.toMatch(/יין.*\(/);
  });

  it("shared shell with only the viewer → no share header", () => {
    const text = formatShowDumpFromKind(
      "בעיות",
      snap([
        {
          list_type: "custom",
          list_name: "בעיות",
          owner: "טל",
          scope: "shared",
          shared_with: ["טל"],
          items: [{ item_id: "a", שם: "דליפה" }],
        } as List,
      ]),
      { viewerName: "טל" },
    )!;
    expect(text).toMatch(/רשימת «בעיות»:/);
  });

  it("empty shared custom list sentence names the partners too", () => {
    const text = formatShowDumpFromKind(
      "בעיות",
      snap([
        {
          list_type: "custom",
          list_name: "בעיות",
          owner: "טל",
          scope: "shared",
          shared_with: ["טל", "עמית"],
          items: [],
        } as List,
      ]),
      { viewerName: "טל" },
    )!;
    expect(text).toContain("רשימת «בעיות» · משותפת עם עמית ריקה.");
  });
});
