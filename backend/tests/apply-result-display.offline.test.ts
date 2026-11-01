/**
 * Result-C: pending show after strip → restore → post-apply dump from DB truth.
 */
import { describe, expect, it } from "vitest";
import { emptyLlmMetadata, type LlmMetadata } from "@workee/shared";
import {
  buildApplyResult,
  captureRequestedFromMetadata,
  collectShowTurnStripDrops,
} from "../src/services/apply-result.js";
import {
  capturePendingShowDump,
  combineConfirmAndDump,
  restorePendingShowDump,
  stripInventedListContentForShowDump,
  withApplyResultDisplay,
} from "../src/services/apply-result-display.js";
import { decideReplyFromApplyResult } from "../src/services/apply-result-reply.js";
import { stripShowTurnMutates } from "../src/services/show-turn-guard.js";

function metaWith(
  patch: Partial<LlmMetadata> & {
    lists?: LlmMetadata["lists"];
    showDump?: string;
  },
): LlmMetadata {
  return { ...emptyLlmMetadata(), ...patch };
}

describe("capturePendingShowDump / restorePendingShowDump", () => {
  it("captures show when strip drops it for mutate+show", () => {
    const before = metaWith({
      showDump: "קניות",
      showDumpSection: "shared",
      showDumpPartner: "דני",
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "חלב" }],
          targets: [],
        },
      ],
    });
    const afterStrip = stripShowTurnMutates(before);
    expect(afterStrip.showDump).toBeUndefined();
    expect(afterStrip.lists?.length).toBe(1);

    const pending = capturePendingShowDump({
      showDumpBefore: before.showDump,
      before,
      afterStrip,
    });
    expect(pending).toEqual({
      kind: "קניות",
      section: "shared",
      partner: "דני",
      assignee: null,
      about: null,
      from: null,
      to: null,
      urgency: null,
      ids: null,
    });

    const restored = restorePendingShowDump(afterStrip, pending);
    expect(restored.showDump).toBe("קניות");
    expect(restored.showDumpSection).toBe("shared");
    expect(restored.showDumpPartner).toBe("דני");
    expect(restored.lists?.length).toBe(1);
  });

  it("does not capture when show-only (mutates stripped)", () => {
    const before = metaWith({
      showDump: "קניות",
      lists: [
        {
          action: "remove",
          listType: "shopping",
          listName: "",
          items: [{ item_id: "x" }],
          targets: [],
        },
      ],
    });
    // show alone → strip clears mutates, keeps show
    const showOnly = metaWith({ showDump: "קניות" });
    const afterStrip = stripShowTurnMutates(showOnly);
    expect(afterStrip.showDump).toBe("קניות");
    expect(
      capturePendingShowDump({
        showDumpBefore: showOnly.showDump,
        before: showOnly,
        afterStrip,
      }),
    ).toBeNull();
    void before;
  });

  it("does not capture mutate-only (no show)", () => {
    const before = metaWith({
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "לחם" }],
          targets: [],
        },
      ],
    });
    const afterStrip = stripShowTurnMutates(before);
    expect(
      capturePendingShowDump({
        showDumpBefore: before.showDump,
        before,
        afterStrip,
      }),
    ).toBeNull();
  });
});

describe("combineConfirmAndDump", () => {
  it("prepends confirm before dump for mutate+show same turn", () => {
    expect(
      combineConfirmAndDump("הוספתי חלב.", "רשימת קניות:\n1. חלב"),
    ).toBe("הוספתי חלב.\n\nרשימת קניות:\n1. חלב");
  });

  it("does not duplicate when dump already starts with confirm", () => {
    const text = "הוספתי.\n\nרשימה";
    expect(combineConfirmAndDump("הוספתי.", text)).toBe(text);
  });

  it("1. strips a single invented numbered line beside engine dump (QA F)", () => {
    const dump = "🛒 קניות:\n1. לחם - 1";
    const out = combineConfirmAndDump(
      "הוספתי ללחם. הנה הרשימה המלאה שהמצאתי: 1. פריט-בדוי-xyz",
      dump,
    );
    expect(out).toContain(dump);
    expect(out).toContain("הוספתי ללחם");
    expect(out).not.toContain("פריט-בדוי-xyz");
    expect(out).not.toContain("המצאתי");
  });

  it("2. strips multiple invented numbered lines beside engine dump", () => {
    const dump = "🛒 קניות:\n1. חלב - 1";
    const out = combineConfirmAndDump(
      "הוספתי חלב.\n1. פריט-בדוי-א\n2. פריט-בדוי-ב",
      dump,
    );
    expect(out).toBe(`הוספתי חלב.\n\n${dump}`);
    expect(out).not.toContain("פריט-בדוי");
  });

  it("3. keeps a clean conversational confirm + SHOW_DUMP", () => {
    const dump = "🛒 קניות:\n1. חלב - 1";
    expect(combineConfirmAndDump("הוספתי חלב, הנה הרשימה.", dump)).toBe(
      `הוספתי חלב, הנה הרשימה.\n\n${dump}`,
    );
  });

  it("4. keeps conversational numbers (does not strip הוספתי 3 / ב־14:30)", () => {
    const dump = "🛒 קניות:\n1. חלב - 1";
    const confirm = "הוספתי 3 פריטים. נזכיר ב־14:30.";
    const out = combineConfirmAndDump(confirm, dump);
    expect(out.startsWith(confirm)).toBe(true);
    expect(out).toContain(dump);
    expect(out).toContain("3 פריטים");
    expect(out).toContain("14:30");
  });

  it("5. successful mutation item appears only in engine dump body", () => {
    const dump = "🛒 קניות:\n1. חלב-QA - 1";
    const out = combineConfirmAndDump(
      "הוספתי חלב-QA. 1. פריט-בדוי",
      dump,
    );
    expect(out).toContain("1. חלב-QA - 1");
    expect(out).not.toContain("פריט-בדוי");
    // Numbered dump line comes from engine dump, not model invent.
    expect(out.indexOf("חלב-QA")).toBeLessThan(out.indexOf("1. חלב-QA - 1"));
  });

  it("6. without dump text, confirm is unchanged (no SHOW_DUMP combine)", () => {
    const confirm = "הוספתי חלב.\n1. לא-למחוק-בלי-dump";
    expect(combineConfirmAndDump(confirm, "")).toBe(confirm);
  });

  it("uses engineConfirmFallback when confirm is only invented inventory", () => {
    const dump = "🛒 קניות:\n1. חלב - 1";
    const out = combineConfirmAndDump("1. פריט-בדוי\n2. עוד-בדוי", dump, {
      engineConfirmFallback: "בוצע.",
    });
    expect(out).toBe(`בוצע.\n\n${dump}`);
    expect(out).not.toContain("בדוי");
  });
});

describe("stripInventedListContentForShowDump", () => {
  it("returns empty for pure inventory so dump-only is safe", () => {
    expect(stripInventedListContentForShowDump("1. א\n2. ב")).toBe("");
  });
});

describe("SHOW_DUMP sanitizer — conversational keep vs invent strip", () => {
  const dump = "🛒 קניות:\n1. חלב - 1\n2. לחם - 1\n3. גרסה 1.2 - 1";

  it('keeps «נשארו לי 2 דברים לקנות: חלב ולחם.»', () => {
    const confirm = "נשארו לי 2 דברים לקנות: חלב ולחם.";
    const out = combineConfirmAndDump(confirm, dump);
    expect(out.startsWith(confirm)).toBe(true);
    expect(out).toContain(dump);
  });

  it('keeps «הוספתי 3 פריטים, הנה הרשימה.»', () => {
    const confirm = "הוספתי 3 פריטים, הנה הרשימה.";
    const out = combineConfirmAndDump(confirm, dump);
    expect(out.startsWith(confirm)).toBe(true);
    expect(out).toContain("3 פריטים");
    expect(out).toContain(dump);
  });

  it('keeps «הפגישה ב־14:30, הנה הרשימה.»', () => {
    const confirm = "הפגישה ב־14:30, הנה הרשימה.";
    const out = combineConfirmAndDump(confirm, dump);
    expect(out.startsWith(confirm)).toBe(true);
    expect(out).toContain("14:30");
    expect(out).toContain(dump);
  });

  it("keeps dump rows whose item names contain digits or dots", () => {
    const out = combineConfirmAndDump("הוספתי גרסה 1.2.", dump);
    // Dump line index may be 3.; item name itself has digits/dots.
    expect(out).toContain("גרסה 1.2 - 1");
    expect(out).toContain("הוספתי גרסה 1.2.");
    // Confirm was not treated as inventory because «1.2» is not «1. item».
    expect(out.startsWith("הוספתי גרסה 1.2.")).toBe(true);
  });

  it("strips one invented numbered line; keeps confirm; dump is sole list body", () => {
    const out = combineConfirmAndDump(
      "הוספתי חלב. 1. מומצא-xyz",
      dump,
    );
    expect(out).toContain("הוספתי חלב");
    expect(out).not.toContain("מומצא-xyz");
    expect(out).toContain(dump);
  });

  it("strips multiple invented numbered lines; keeps confirm", () => {
    const out = combineConfirmAndDump(
      "הוספתי חלב.\n1. מומצא-א\n2. מומצא-ב\n3. מומצא-ג",
      dump,
    );
    expect(out).toContain("הוספתי חלב");
    expect(out).not.toMatch(/מומצא/);
    expect(out).toContain(dump);
  });
});

describe("post-apply display accounting", () => {
  it("records display from post-apply snapshot text, not model inventory draft", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "חלב" }],
          targets: [],
        },
      ],
    });
    let result = buildApplyResult({
      requested,
      intentMisses: [],
      dumpGuardDrops: [],
      stripMisses: [],
      unclassifiedStripDrops: [],
      listMutations: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          itemId: "new-1",
          itemKey: "חלב",
          itemLabel: "חלב",
          employeeId: "e1",
        },
      ],
      filingMutations: [],
      shareMisses: [],
      listOpResults: [],
      reminderResult: {
        saved: [],
        removed: [],
        missed: [],
        skipped: [],
        changes: [],
      },
      directoryResult: { saved: [], removed: [] },
    });
    expect(result.display).toBeUndefined();

    const engineDump = "רשימת הקניות שלך:\n1. חלב\n2. לחם";
    result = withApplyResultDisplay(result, {
      kind: "קניות",
      snapshot_text: engineDump,
      lines: [
        {
          n: 1,
          id: "new-1",
          kind: "shopping",
          title_stem: "חלב",
        },
        {
          n: 2,
          id: "old-2",
          kind: "shopping",
          title_stem: "לחם",
        },
      ],
    });
    expect(result.display?.kind).toBe("קניות");
    expect(result.display?.snapshot_text).toBe(engineDump);
    expect(result.display?.lines?.map((l) => l.id)).toEqual([
      "new-1",
      "old-2",
    ]);
    // requested / applied / misses preserved (Result-A contract)
    expect(result.domains.lists?.requested).toHaveLength(1);
    expect(result.domains.lists?.applied).toHaveLength(1);
    expect(result.domains.lists?.applied[0]?.id).toBe("new-1");
  });

  it("failed apply: Result-B blocks success claim; dump may still attach real DB state", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "remove",
          listType: "shopping",
          listName: "",
          items: [{ item_id: "missing" }],
          targets: [],
        },
      ],
    });
    const result = buildApplyResult({
      requested,
      intentMisses: [
        {
          reason: "not_in_this_turn_facts",
          itemId: "missing",
          listType: "shopping",
        },
      ],
      dumpGuardDrops: [],
      stripMisses: [],
      unclassifiedStripDrops: [],
      listMutations: [],
      filingMutations: [],
      shareMisses: [],
      listOpResults: [],
      reminderResult: {
        saved: [],
        removed: [],
        missed: [],
        skipped: [],
        changes: [],
      },
      directoryResult: { saved: [], removed: [] },
    });
    const decided = decideReplyFromApplyResult({
      applyResult: result,
      modelDraft: JSON.stringify({
        response: "מחקתי את הפריט.",
        metadata: {},
      }),
    });
    expect(decided.keepDraft).toBe(false);
    expect(decided.spoken).not.toMatch(/מחקתי/);

    // Failed apply still may dump real DB state; success claim already blocked.
    const withDump = withApplyResultDisplay(result, {
      kind: "קניות",
      snapshot_text: "רשימת הקניות שלך:\n1. לחם",
    });
    expect(withDump.display?.snapshot_text).toContain("לחם");
    expect(withDump.domains.lists?.applied).toHaveLength(0);
  });

  it("mutate+show strip accounting still records show_turn_strip when mutates dropped", () => {
    // When show wins, strip drops mutates — pending is null; strip accounting stays.
    const before = metaWith({
      showDump: "קניות",
      lists: [
        {
          action: "remove",
          listType: "shopping",
          listName: "",
          items: [{ item_id: "x1" }],
          targets: [],
        },
      ],
    });
    // Force show-only path: strip keeps show, clears lists via clearMutating when
    // wait — hasMutates+show → withoutShowDump. So mutate+show keeps lists.
    // For show-only with empty lists after clear: use show without mutates after strip.
    const showOnly = metaWith({ showDump: "מטלות" });
    const after = stripShowTurnMutates(showOnly);
    const pending = capturePendingShowDump({
      showDumpBefore: showOnly.showDump,
      before: showOnly,
      afterStrip: after,
    });
    expect(pending).toBeNull();

    const requested = captureRequestedFromMetadata({
      lists: before.lists,
    });
    const mutateShow = stripShowTurnMutates(before);
    const account = collectShowTurnStripDrops({
      requested,
      showDumpBefore: before.showDump,
      afterStrip: {
        lists: mutateShow.lists,
        listOps: mutateShow.listOps,
        filing: mutateShow.filing,
        reminders: mutateShow.reminders,
        directory: mutateShow.directory,
      },
    });
    // mutate wins → lists kept → no strip misses for those ops
    expect(account.misses).toHaveLength(0);
    expect(mutateShow.lists?.length).toBe(1);
    expect(
      capturePendingShowDump({
        showDumpBefore: before.showDump,
        before,
        afterStrip: mutateShow,
      })?.kind,
    ).toBe("קניות");
  });
});

describe("mutate+show same-turn flow (unit)", () => {
  it("strip → apply accounting → Result-B confirm → restore → combine dump", () => {
    const before = metaWith({
      showDump: "קניות",
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "חלב" }],
          targets: [],
        },
      ],
    });
    const afterStrip = stripShowTurnMutates(before);
    const pending = capturePendingShowDump({
      showDumpBefore: before.showDump,
      before,
      afterStrip,
    });
    expect(pending?.kind).toBe("קניות");
    expect(afterStrip.showDump).toBeUndefined();

    const applyResult = buildApplyResult({
      requested: captureRequestedFromMetadata(before),
      listMutations: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          itemId: "id-milk",
          itemKey: "חלב",
          itemLabel: "חלב",
          employeeId: "e1",
        },
      ],
    });
    expect(applyResult.domains.lists?.applied[0]?.id).toBe("id-milk");

    const modelWithStaleInventory = JSON.stringify({
      response: "הוספתי חלב.\n1. לחם\n2. ביצים",
      metadata: {},
    });
    const decided = decideReplyFromApplyResult({
      applyResult,
      modelDraft: modelWithStaleInventory,
    });
    // Engine dump (post-apply DB), not model numbered inventory:
    const freshDbDump = "רשימת הקניות שלך:\n1. לחם\n2. ביצים\n3. חלב";
    const restored = restorePendingShowDump(afterStrip, pending);
    expect(restored.showDump).toBe("קניות");
    const spoken = combineConfirmAndDump(decided.spoken, freshDbDump);
    expect(spoken).toContain("חלב");
    expect(spoken).toContain(freshDbDump);
    // Stale-only model lines without the new item must not be the sole display:
    expect(spoken.endsWith(freshDbDump)).toBe(true);

    const final = withApplyResultDisplay(applyResult, {
      kind: restored.showDump!,
      snapshot_text: spoken,
    });
    expect(final.display?.snapshot_text).toBe(spoken);
    expect(final.display?.snapshot_text).not.toBe(
      "הוספתי חלב.\n1. לחם\n2. ביצים",
    );
  });
});

describe("stale snapshot prevention (contract)", () => {
  it("display.snapshot_text is only set via withApplyResultDisplay after dump", () => {
    const empty = buildApplyResult({
      requested: captureRequestedFromMetadata({}),
      intentMisses: [],
      dumpGuardDrops: [],
      stripMisses: [],
      unclassifiedStripDrops: [],
      listMutations: [],
      filingMutations: [],
      shareMisses: [],
      listOpResults: [],
      reminderResult: {
        saved: [],
        removed: [],
        missed: [],
        skipped: [],
        changes: [],
      },
      directoryResult: { saved: [], removed: [] },
    });
    expect(empty.display).toBeUndefined();
    const after = withApplyResultDisplay(empty, {
      kind: "קניות",
      snapshot_text: "fresh-from-db",
    });
    expect(after.display?.snapshot_text).toBe("fresh-from-db");
    expect(empty.display).toBeUndefined();
  });
});
