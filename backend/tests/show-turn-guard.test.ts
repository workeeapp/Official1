import { describe, expect, it } from "vitest";
import { emptyLlmMetadata } from "@workee/shared";
import {
  clearMutatingMetadata,
  isReadOnlyShowTurn,
  stripShowTurnMutates,
} from "../src/services/show-turn-guard.js";

describe("show-turn-guard", () => {
  it("treats show_dump as read-only — not user utterance text", () => {
    expect(isReadOnlyShowTurn()).toBe(false);
    expect(isReadOnlyShowTurn("")).toBe(false);
    expect(isReadOnlyShowTurn("reminders")).toBe(true);
    expect(isReadOnlyShowTurn("shopping")).toBe(true);
  });

  it("clearMutatingMetadata empties ACTION mutate arrays and keeps the rest", () => {
    const meta = {
      ...emptyLlmMetadata(),
      showDump: "shopping",
      response: "שלום",
      lists: [
        {
          action: "add" as const,
          listType: "shopping" as const,
          listName: "",
          targets: [],
          items: [{ name: "אורז" }],
        },
      ],
      reminders: [
        {
          action: "add" as const,
          item: "ping",
          listType: "tasks" as const,
          time: "מחר",
          inSeconds: null,
          ping: [],
          targets: [],
          reminderId: "",
        },
      ],
      directory: [
        {
          action: "add" as const,
          name: "דן",
          phone: "050",
          contactId: "",
          targets: [],
        },
      ],
      filing: [{ action: "add" as const, itemDescription: "עובדה" }],
      listOps: [],
    };
    const cleared = clearMutatingMetadata(meta);
    expect(cleared.lists).toEqual([]);
    expect(cleared.listOps).toEqual([]);
    expect(cleared.filing).toEqual([]);
    expect(cleared.reminders).toEqual([]);
    expect(cleared.directory).toEqual([]);
    expect(cleared.showDump).toBe("shopping");
    expect(cleared.response).toBe("שלום");
  });

  it("strips mutates when show_dump alone", () => {
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
    // With mutates + showDump → mutates win, showDump dropped
    const withBoth = stripShowTurnMutates(meta);
    expect(withBoth.lists).toHaveLength(1);
    expect(withBoth.showDump).toBeUndefined();

    const showOnly = stripShowTurnMutates({
      ...meta,
      lists: [],
      reminders: [],
    });
    expect(showOnly.lists).toEqual([]);
    expect(showOnly.showDump).toBe("reminders");
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
    const kept = stripShowTurnMutates(meta);
    expect(kept.reminders).toHaveLength(1);
  });

  it("prefers mutates over show_dump on delete-by-number turns", () => {
    const meta = {
      ...emptyLlmMetadata(),
      showDump: "tasks",
      showDumpSection: "personal" as const,
      showDumpPartner: "מיכל",
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
    const result = stripShowTurnMutates(meta);
    expect(result.lists).toHaveLength(1);
    expect(result.lists[0]?.items).toHaveLength(2);
    expect(result.showDump).toBeUndefined();
    expect(result.showDumpSection).toBeUndefined();
    expect(result.showDumpPartner).toBeUndefined();
  });

  it("strips mutates when show_dump alone with no mutates", () => {
    const meta = {
      ...emptyLlmMetadata(),
      showDump: "shopping",
      lists: [],
      reminders: [],
    };
    const result = stripShowTurnMutates(meta);
    expect(result.lists).toEqual([]);
    expect(result.showDump).toBe("shopping");
  });
});
