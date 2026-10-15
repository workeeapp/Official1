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

  it("strips mutates on show turns but keeps showDump", () => {
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

    const kept = stripShowTurnMutates("מחקי 1", {
      ...meta,
      showDump: undefined,
    });
    expect(kept.reminders).toHaveLength(1);
  });
});
