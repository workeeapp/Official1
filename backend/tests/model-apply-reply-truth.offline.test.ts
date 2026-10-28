/**
 * Offline pure tests: MODEL_APPLY / LIVE_FULL spoken-reply correction from
 * apply outcomes (no Prisma / OpenAI).
 */
import { describe, expect, it } from "vitest";
import { emptyLlmMetadata, type LlmMetadata } from "@workee/shared";
import { correctModelApplyTurnResponse } from "../src/eval/run-model-apply.js";
import {
  DURABLE_SAVE_CLAIM_MISS,
  LIST_FIND_MISS,
  type FilingMutation,
  type ListItemMutation,
} from "../src/services/employee-records.service.js";
import { emptyAttachmentOutcome } from "../src/services/attachment.service.js";

function meta(partial: Partial<LlmMetadata> = {}): LlmMetadata {
  return { ...emptyLlmMetadata(), ...partial };
}

const listAddMutation: ListItemMutation = {
  action: "add",
  itemId: "item-1",
  employeeId: "emp-1",
  listType: "shopping",
  itemKey: "חלב",
  itemLabel: "חלב",
  listName: "קניות",
};

const filingAddMutation: FilingMutation = {
  action: "add",
  itemName: "כתובת",
  itemInfo: "רחוב הרצל 1 תל אביב",
  itemDescription: "",
};

describe("correctModelApplyTurnResponse (LIVE_FULL reply truthfulness)", () => {
  it("empty ACTION + תייקתי does not report filing success", () => {
    const out = correctModelApplyTurnResponse({
      response: "תייקתי את הכתובת שלך: רחוב הרצל 1, תל אביב.",
      metadata: meta(),
    });
    expect(out).toBe(DURABLE_SAVE_CLAIM_MISS);
  });

  it("apply-skipped turn must not claim a mutation succeeded", () => {
    const out = correctModelApplyTurnResponse({
      response: "שמרתי את הפרטים.",
      metadata: meta({ lists: [], filing: [] }),
      mutations: [],
      filingMutations: [],
    });
    expect(out).toBe(DURABLE_SAVE_CLAIM_MISS);
  });

  it("unnamed custom add refused (no list add mutation) + הוספתי → add miss", () => {
    const out = correctModelApplyTurnResponse({
      response: "הוספתי עוגה ושתייה לכיבוד של ערב יום ההולדת.",
      metadata: meta({
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "",
            items: [{ שם: "עוגה" }, { שם: "שתייה" }],
            targets: [],
          },
          {
            action: "update",
            listType: "tasks",
            listName: "",
            items: [
              {
                item_id: "host-1",
                linked_lists: [
                  { list_type: "custom", list_name: "כיבוד · ערב יום הולדת" },
                ],
              },
            ],
            targets: [],
          },
        ],
      }),
      // Engine refused unnamed custom create; host update also produced no mutation.
      mutations: [],
      filingMutations: [],
    });
    expect(out).not.toMatch(/הוספתי/);
    // Update was requested and did not apply → list find miss (same as chat order).
    expect(out).toBe(LIST_FIND_MISS);
  });

  it("refused custom add only (update applied) + הוספתי → add miss, keeps update evidence", () => {
    const out = correctModelApplyTurnResponse({
      response: "הוספתי עוגה ושתייה לכיבוד.",
      metadata: meta({
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "",
            items: [{ שם: "עוגה" }],
            targets: [],
          },
          {
            action: "update",
            listType: "tasks",
            listName: "",
            items: [{ item_id: "host-1" }],
            targets: [],
          },
        ],
      }),
      mutations: [
        {
          action: "update",
          itemId: "host-1",
          employeeId: "emp-1",
          listType: "tasks",
          itemKey: "ערב",
          itemLabel: "ערב יום הולדת",
          listName: "מטלות",
        },
      ],
      filingMutations: [],
    });
    expect(out).toContain("לא הצלחתי להוסיף את הפריט.");
    expect(out).not.toBe("הוספתי עוגה ושתייה לכיבוד.");
  });

  it("successful list add keeps success reply", () => {
    const reply = "שמרתי חלב בקניות.";
    const out = correctModelApplyTurnResponse({
      response: reply,
      metadata: meta({
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
      mutations: [listAddMutation],
      filingMutations: [],
    });
    expect(out).toBe(reply);
  });

  it("unshare update applied + parallel remove miss keeps success, appends find miss", () => {
    const spoken = "הסרתי את השיתוף של החלב עם עמית.";
    const out = correctModelApplyTurnResponse({
      response: spoken,
      metadata: meta({
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            items: [{ item_id: "milk-1", unshare_with: ["עמית"] }],
            targets: [],
          },
          {
            action: "remove",
            listType: "shopping",
            listName: "",
            items: [{ item_id: "milk-1" }],
            targets: [],
          },
        ],
      }),
      mutations: [
        {
          action: "update",
          itemId: "milk-1",
          employeeId: "emp-1",
          listType: "shopping",
          itemKey: "חלב",
          itemLabel: "חלב",
          listName: "קניות",
        },
      ],
      filingMutations: [],
    });
    expect(out).toContain("חלב");
    expect(out).toContain(LIST_FIND_MISS);
    expect(out).not.toBe(LIST_FIND_MISS);
  });

  it("הסרתי את השיתוף with only update applied is not wiped to LIST_FIND_MISS", () => {
    const spoken = "הסרתי את השיתוף של החלב עם עמית.";
    const out = correctModelApplyTurnResponse({
      response: spoken,
      metadata: meta({
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            items: [{ item_id: "milk-1", unshare_with: ["עמית"] }],
            targets: [],
          },
        ],
      }),
      mutations: [
        {
          action: "update",
          itemId: "milk-1",
          employeeId: "emp-1",
          listType: "shopping",
          itemKey: "חלב",
          itemLabel: "חלב",
          listName: "קניות",
        },
      ],
      filingMutations: [],
    });
    expect(out).toBe(spoken);
  });

  it("successful filing add keeps תייקתי reply", () => {
    const reply = "תייקתי את הכתובת שלך.";
    const out = correctModelApplyTurnResponse({
      response: reply,
      metadata: meta({
        filing: [
          {
            action: "add_filing",
            itemName: "כתובת",
            itemInfo: "רחוב הרצל 1 תל אביב",
            itemDescription: "",
            targets: [],
          },
        ],
      }),
      mutations: [],
      filingMutations: [filingAddMutation],
    });
    expect(out).toBe(reply);
  });

  it("does not treat appliedViaProduction-style empty mutations as filing success", () => {
    const out = correctModelApplyTurnResponse({
      response: "תייקתי.",
      metadata: meta({
        filing: [
          {
            action: "add_filing",
            itemName: "כתובת",
            itemInfo: "הרצל",
            itemDescription: "",
            targets: [],
          },
        ],
      }),
      mutations: [],
      filingMutations: [],
    });
    expect(out).toBe(DURABLE_SAVE_CLAIM_MISS);
  });

  it("preserves attachment corrector: false attach claim when attachRequested and no link", () => {
    const out = correctModelApplyTurnResponse({
      response: "תייקתי את הקובץ.",
      metadata: meta(),
      attachmentOutcome: {
        linked: 0,
        alreadyLinked: 0,
        detached: 0,
        attachRequested: true,
      },
    });
    expect(out).toBe("לא הצלחתי לצרף את הקובץ.");
  });

  it("preserves attachment corrector: alreadyLinked counts as attach success", () => {
    const reply = "תייקתי את הקובץ.";
    const out = correctModelApplyTurnResponse({
      response: reply,
      metadata: meta(),
      attachmentOutcome: {
        linked: 0,
        alreadyLinked: 1,
        detached: 0,
        attachRequested: true,
      },
    });
    expect(out).toBe(reply);
  });

  it("attachment skip when attach not requested leaves durable תייקתי path alone", () => {
    // Attach wording → durable save corrector does not claim; attach corrector no-ops.
    const reply = "תייקתי את הקובץ.";
    const out = correctModelApplyTurnResponse({
      response: reply,
      metadata: meta(),
      attachmentOutcome: emptyAttachmentOutcome(false),
    });
    expect(out).toBe(reply);
  });
});
