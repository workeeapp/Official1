import { describe, expect, it } from "vitest";
import { emptyLlmMetadata } from "@workee/shared";
import {
  isReadOnlyShowTurn,
  stripShowTurnMutates,
} from "../src/services/show-turn-guard.js";

describe("show-turn-guard", () => {
  it("treats exact הצג commands and show_dump as read-only", () => {
    expect(isReadOnlyShowTurn("הצג תזכורות")).toBe(true);
    expect(isReadOnlyShowTurn("הצג רשימת מטלות")).toBe(true);
    expect(isReadOnlyShowTurn("מה התזכורות שלי")).toBe(false);
    expect(isReadOnlyShowTurn("מה התזכורות שלי", "reminders")).toBe(true);
  });

  it("strips mutates on exact הצג even when lists/reminders are present", () => {
    const meta = {
      ...emptyLlmMetadata(),
      showDump: "reminders",
      lists: [
        {
          action: "remove" as const,
          listType: "tasks" as const,
          listName: "",
          targets: [],
          items: [{ item_id: "x" }],
        },
      ],
      reminders: [
        {
          action: "remove" as const,
          item: "",
          listType: "tasks" as const,
          time: "",
          inSeconds: null,
          ping: [],
          targets: [],
          reminderId: "44689d29-42f8-4137-8859-7cf8b1352171",
        },
      ],
      directory: [],
      filing: [],
      listOps: [],
    };
    const stripped = stripShowTurnMutates("הצג תזכורות", meta);
    expect(stripped.lists).toEqual([]);
    expect(stripped.reminders).toEqual([]);
    expect(stripped.showDump).toBe("reminders");
  });

  it("keeps mutates when showDump is absent", () => {
    const meta = {
      ...emptyLlmMetadata(),
      showDump: undefined,
      reminders: [
        {
          action: "remove" as const,
          item: "",
          listType: "tasks" as const,
          time: "",
          inSeconds: null,
          ping: [],
          targets: [],
          reminderId: "44689d29-42f8-4137-8859-7cf8b1352171",
        },
      ],
    };
    const kept = stripShowTurnMutates("מחקי 1", meta);
    expect(kept.reminders).toHaveLength(1);
  });

  it("prefers mutates over show_dump on delete-by-number turns", () => {
    const meta = {
      ...emptyLlmMetadata(),
      showDump: "tasks",
      lists: [
        {
          action: "remove" as const,
          listType: "tasks" as const,
          listName: "",
          targets: [],
          items: [{ item_id: "a" }, { item_id: "b" }],
        },
      ],
      reminders: [],
      directory: [],
      filing: [],
      listOps: [],
    };
    const result = stripShowTurnMutates("תמחק את 3,4", meta);
    expect(result.lists).toHaveLength(1);
    expect(result.lists[0]?.items).toHaveLength(2);
    expect(result.showDump).toBeUndefined();
  });

  it("strips mutates when show_dump alone with no mutates", () => {
    const meta = {
      ...emptyLlmMetadata(),
      showDump: "shopping",
      lists: [],
      reminders: [],
    };
    const result = stripShowTurnMutates("מה יש לי לקנות", meta);
    expect(result.lists).toEqual([]);
    expect(result.showDump).toBe("shopping");
  });
});
