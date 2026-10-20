import { describe, expect, it } from "vitest";
import {
  compileLiveAuthorDraft,
  draftFromTemplate,
  LiveAuthorCompileError,
} from "../src/eval/live-author-compile.js";

describe("live-author-compile", () => {
  it("compiles ask intent to no-mutations + ask constraints", () => {
    const { track, case: row } = compileLiveAuthorDraft({
      id: "demo-ask",
      track: "model",
      turns: [
        {
          utterance: "תוסיפי מטלה",
          intent: { type: "ask" },
        },
      ],
    });
    expect(track).toBe("model");
    if (!("constraints" in row)) throw new Error("expected model case");
    expect(row.constraints.map((c) => c.type)).toEqual([
      "mutations_empty_or_read_only",
      "response_looks_like_ask",
    ]);
    expect(row.utterance).toBe("תוסיפי מטלה");
  });

  it("compiles remove_item with listType shopping", () => {
    const { track, case: row } = compileLiveAuthorDraft({
      id: "demo-remove",
      track: "model",
      setup: {
        shoppingItems: [{ id: "eval-item-milk", label: "חלב" }],
      },
      turns: [
        {
          utterance: "קניתי חלב",
          intent: {
            type: "remove_item",
            listType: "shopping",
            itemId: "eval-item-milk",
          },
        },
      ],
    });
    expect(track).toBe("model");
    if (!("constraints" in row)) throw new Error("expected model case");
    const remove = row.constraints.find(
      (c) => c.type === "lists_remove_item_ids",
    );
    expect(remove).toMatchObject({
      type: "lists_remove_item_ids",
      listType: "shopping",
      itemIds: ["eval-item-milk"],
    });
    expect(row.setup.lists?.[0]?.items?.[0]).toMatchObject({
      item_id: "eval-item-milk",
    });
  });

  it("auto-routes multi-turn model drafts to mt corpus", () => {
    const { track, case: row } = compileLiveAuthorDraft({
      id: "demo-mt",
      track: "model",
      setup: {
        shoppingItems: [{ id: "eval-item-milk", label: "חלב" }],
      },
      turns: [
        { utterance: "תמחק את זה", intent: { type: "ask" } },
        {
          utterance: "את החלב",
          intent: {
            type: "remove_item",
            listType: "shopping",
            itemId: "eval-item-milk",
          },
        },
      ],
    });
    expect(track).toBe("mt");
    if (!("turns" in row)) throw new Error("expected mt case");
    expect(row.turns).toHaveLength(2);
    expect(row.turns[0]!.constraints.map((c) => c.type)).toContain(
      "response_looks_like_ask",
    );
    expect(row.turns[1]!.constraints[0]).toMatchObject({
      type: "lists_remove_item_ids",
      itemIds: ["eval-item-milk"],
    });
  });

  it("synthesizes stateAfter for full remove when outcome omitted", () => {
    const { track, case: row } = compileLiveAuthorDraft({
      id: "demo-full-remove",
      track: "full",
      setup: {
        shoppingItems: [{ id: "eval-item-eggs", label: "ביצים" }],
      },
      turns: [
        {
          utterance: "קניתי ביצים",
          intent: {
            type: "remove_item",
            listType: "shopping",
            itemId: "eval-item-eggs",
          },
        },
      ],
    });
    expect(track).toBe("full");
    if (!("turns" in row)) throw new Error("expected full case");
    expect(row.turns[0]!.stateAfter).toEqual({
      itemIdsAbsent: ["eval-item-eggs"],
    });
  });

  it("honors explicit outcome on full track", () => {
    const { case: row } = compileLiveAuthorDraft({
      id: "demo-full-outcome",
      track: "full",
      turns: [
        {
          utterance: "תוסיפי לחם לקניות",
          intent: { type: "add_shopping", itemText: "לחם" },
          outcome: { factsInclude: ["לחם", "קניות"] },
        },
      ],
    });
    if (!("turns" in row)) throw new Error("expected full case");
    expect(row.turns[0]!.stateAfter).toEqual({
      factsInclude: ["לחם", "קניות"],
    });
  });

  it("draftFromTemplate clarify-act builds ask then remove", () => {
    const draft = draftFromTemplate({
      track: "model",
      template: "clarify-act",
      id: "mt-from-template",
      itemId: "eval-item-bread",
      itemLabel: "לחם",
    });
    expect(draft.track).toBe("mt");
    expect(draft.turns).toHaveLength(2);
    const compiled = compileLiveAuthorDraft(draft);
    expect(compiled.track).toBe("mt");
  });

  it("rejects empty turns", () => {
    expect(() =>
      compileLiveAuthorDraft({
        id: "bad",
        track: "model",
        turns: [],
      }),
    ).toThrow(LiveAuthorCompileError);
  });

  it("compiles add_task, filing, share, and show intents", () => {
    const task = compileLiveAuthorDraft({
      id: "t",
      track: "model",
      turns: [
        {
          utterance: "מטלה",
          intent: { type: "add_task", itemText: "רופא" },
        },
      ],
    });
    expect(
      (task.case as { constraints: Array<{ type: string }> }).constraints[0],
    ).toMatchObject({ type: "lists_has_action", action: "add" });

    const share = compileLiveAuthorDraft({
      id: "s",
      track: "model",
      turns: [
        {
          utterance: "שתפי",
          intent: { type: "share_update", listType: "shopping" },
        },
      ],
    });
    expect((share.case as { tags?: string[] }).tags).toContain("share");

    const show = compileLiveAuthorDraft({
      id: "d",
      track: "model",
      turns: [
        {
          utterance: "מה שמור",
          intent: { type: "show_dump", value: "full" },
        },
      ],
    });
    expect(
      (show.case as { constraints: Array<{ type: string }> }).constraints.some(
        (c) => c.type === "show_dump",
      ),
    ).toBe(true);
  });
});
