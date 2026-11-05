/**
 * Reply contract — side failures (share / attach / unshare). Overrides fire
 * only from apply evidence; the model's text is never an input.
 */
import { describe, expect, it } from "vitest";
import { parseLlmReply } from "@workee/shared";
import {
  ATTACH_APPLY_MISS,
  applyResultHasFailure,
  applySideFailureOverrides,
  sideFailureLines,
} from "../src/services/apply-failure-overrides.js";
import {
  buildApplyResult,
  captureRequestedFromMetadata,
} from "../src/services/apply-result.js";
import {
  LIST_FIND_MISS,
  SHARE_CLAIM_MISS,
  type ListItemMutation,
} from "../src/services/employee-records.service.js";
import { emptyAttachmentOutcome } from "../src/services/attachment.service.js";
import { setEngineResponse } from "../src/services/whatsapp-send.js";

const noAttach = emptyAttachmentOutcome(false);

function draft(text: string): string {
  return JSON.stringify({ responses: [{ text }], metadata: { lists: [] } });
}

function sharedUpdate(newly: number, already: number): ListItemMutation {
  return {
    action: "update",
    itemId: `i-${newly}-${already}`,
    employeeId: "e1",
    listType: "shopping",
    itemKey: "חלב",
    itemLabel: "חלב",
    shareOutcome: { newlySharedCount: newly, alreadySharedCount: already },
  };
}

describe("applyResultHasFailure", () => {
  it("no requested ops → no failure", () => {
    expect(
      applyResultHasFailure(
        buildApplyResult({ requested: captureRequestedFromMetadata({}) }),
      ),
    ).toBe(false);
  });

  it("complete apply → no failure", () => {
    const result = buildApplyResult({
      requested: captureRequestedFromMetadata({
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "חלב" }],
            targets: [],
          },
        ],
      }),
      listMutations: [
        {
          action: "add",
          itemId: "m1",
          employeeId: "e1",
          listType: "shopping",
          itemKey: "חלב",
          itemLabel: "חלב",
        },
      ],
    });
    expect(applyResultHasFailure(result)).toBe(false);
  });

  it("requested reminder skipped (no_time) → failure", () => {
    const result = buildApplyResult({
      requested: captureRequestedFromMetadata({
        reminders: [
          {
            action: "add",
            item: "להוריד את הזבל",
            listType: "tasks",
            date: "",
            time: "",
            repeat: "once",
            ping: [],
            targets: [],
            text: "",
            inSeconds: null,
            everyCount: null,
            everyUnit: null,
            weekdays: null,
            confirmed: true,
            compose: false,
            composeSource: "",
            composeLookbackHours: 0,
            composePlace: "",
            reminderId: "",
          } as never,
        ],
      }),
      reminderResult: {
        saved: [],
        skipped: [{ item: "להוריד את הזבל", reason: "no_time" }],
      },
    });
    expect(applyResultHasFailure(result)).toBe(true);
  });
});

describe("sideFailureLines", () => {
  it("nothing failed → no lines", () => {
    expect(
      sideFailureLines({
        listMutations: [sharedUpdate(1, 0)],
        shareMisses: [],
        attachmentOutcome: noAttach,
      }),
    ).toEqual([]);
  });

  it("already shared (no new partners, no miss) is not a failure", () => {
    expect(
      sideFailureLines({
        listMutations: [sharedUpdate(0, 1)],
        shareMisses: [],
        attachmentOutcome: noAttach,
      }),
    ).toEqual([]);
  });

  it("share forbidden → permission line", () => {
    expect(
      sideFailureLines({
        listMutations: [],
        shareMisses: [{ itemId: "x", reason: "forbidden" }],
        attachmentOutcome: noAttach,
      }),
    ).toEqual(["אין הרשאה לשתף את הפריטים האלה."]);
  });

  it("share missing → find-miss line", () => {
    expect(
      sideFailureLines({
        listMutations: [],
        shareMisses: [{ itemId: "x", reason: "missing" }],
        attachmentOutcome: noAttach,
      }),
    ).toEqual([LIST_FIND_MISS]);
  });

  it("partial share (some new, some missing) reports both", () => {
    const [line] = sideFailureLines({
      listMutations: [sharedUpdate(1, 0), sharedUpdate(1, 0)],
      shareMisses: [{ itemId: "x", reason: "missing" }],
      attachmentOutcome: noAttach,
    });
    expect(line).toMatch(/שיתפתי 2 פריטים/);
    expect(line).toMatch(/1 לא נמצאו/);
  });

  it("mixed misses without new shares → combined line (never empty)", () => {
    const [line] = sideFailureLines({
      listMutations: [],
      shareMisses: [
        { itemId: "x", reason: "missing" },
        { itemId: "y", reason: "forbidden" },
      ],
      attachmentOutcome: noAttach,
    });
    expect(line).toBeTruthy();
    expect(line).not.toBe(SHARE_CLAIM_MISS);
  });

  it("attach requested, nothing linked → attach miss; detach alone does not count", () => {
    for (const detached of [0, 1]) {
      expect(
        sideFailureLines({
          listMutations: [],
          shareMisses: [],
          attachmentOutcome: {
            linked: 0,
            alreadyLinked: 0,
            detached,
            attachRequested: true,
          },
        }),
      ).toEqual([ATTACH_APPLY_MISS]);
    }
  });

  it("attach linked or already linked → no line", () => {
    for (const outcome of [
      { linked: 1, alreadyLinked: 0, detached: 0, attachRequested: true },
      { linked: 0, alreadyLinked: 1, detached: 0, attachRequested: true },
    ]) {
      expect(
        sideFailureLines({
          listMutations: [],
          shareMisses: [],
          attachmentOutcome: outcome,
        }),
      ).toEqual([]);
    }
  });

  it("unshare with items still shared → engine line", () => {
    const lines = sideFailureLines({
      listMutations: [],
      shareMisses: [],
      attachmentOutcome: noAttach,
      unshareSummary: {
        appliedUnshareCount: 1,
        remainingSharedCount: 2,
        partnerLabels: ["מיכל"],
      },
    });
    expect(lines).toEqual([
      "הסרתי את השיתוף מ-1 פריטים; 2 עדיין משותפים עם מיכל.",
    ]);
  });

  it("complete unshare (none remaining) → no line", () => {
    expect(
      sideFailureLines({
        listMutations: [],
        shareMisses: [],
        attachmentOutcome: noAttach,
        unshareSummary: {
          appliedUnshareCount: 2,
          remainingSharedCount: 0,
          partnerLabels: ["מיכל"],
        },
      }),
    ).toEqual([]);
  });
});

describe("applySideFailureOverrides", () => {
  it("no lines → reply untouched (byte-identical, buttons kept)", () => {
    const reply = JSON.stringify({
      responses: [{ text: "רוצה שאזכיר?", buttons: [{ label: "כן", command: "כן" }] }],
      metadata: { lists: [] },
    });
    expect(
      applySideFailureOverrides({
        reply,
        resultBReplaced: false,
        lines: [],
        setResponse: setEngineResponse,
      }),
    ).toBe(reply);
  });

  it("lines replace the model reply when Result-B kept it", () => {
    const out = applySideFailureOverrides({
      reply: draft("צרפתי את הקובץ."),
      resultBReplaced: false,
      lines: [ATTACH_APPLY_MISS],
      setResponse: setEngineResponse,
    });
    expect(parseLlmReply(out).response).toBe(ATTACH_APPLY_MISS);
  });

  it("lines append to Result-B engine text when it already replaced", () => {
    const out = applySideFailureOverrides({
      reply: draft(LIST_FIND_MISS),
      resultBReplaced: true,
      lines: [ATTACH_APPLY_MISS],
      setResponse: setEngineResponse,
    });
    expect(parseLlmReply(out).response).toBe(
      `${LIST_FIND_MISS}\n${ATTACH_APPLY_MISS}`,
    );
  });

  // Regression (eval-db show-dump 7 / qa-e control, 2026-11-04): a remove of a
  // missing item_id is a shareMiss «missing» AND an ApplyResult apply_miss —
  // Result-B wrote LIST_FIND_MISS and the share line repeated it.
  it("never repeats a failure line Result-B already wrote", () => {
    const out = applySideFailureOverrides({
      reply: draft(LIST_FIND_MISS),
      resultBReplaced: true,
      lines: [LIST_FIND_MISS],
      setResponse: setEngineResponse,
    });
    expect(parseLlmReply(out).response).toBe(LIST_FIND_MISS);
  });

  it("missing-item share miss + Result-B → exactly one miss line end to end", () => {
    const lines = sideFailureLines({
      listMutations: [],
      shareMisses: [{ itemId: "gone", reason: "missing" }],
      attachmentOutcome: emptyAttachmentOutcome(false),
    });
    expect(lines).toEqual([LIST_FIND_MISS]);
    const out = applySideFailureOverrides({
      reply: draft(LIST_FIND_MISS),
      resultBReplaced: true,
      lines,
      setResponse: setEngineResponse,
    });
    expect(parseLlmReply(out).responses).toEqual([LIST_FIND_MISS]);
  });
});
