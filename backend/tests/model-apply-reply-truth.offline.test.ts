/**
 * Offline pure tests: MODEL_APPLY / LIVE_FULL spoken-reply correction from
 * apply outcomes (no Prisma / OpenAI).
 */
import { describe, expect, it } from "vitest";
import { emptyLlmMetadata, type LlmMetadata } from "@workee/shared";
import { correctModelApplyTurnResponse } from "../src/eval/run-model-apply.js";
import {
  DURABLE_SAVE_CLAIM_MISS,
  LIST_ADD_MISS,
  LIST_FIND_MISS,
  REMINDER_ONLY_PARTIAL,
  REMINDER_SAVE_CLAIM_MISS,
  correctExecutionTruthReply,
  correctUnshareClaimReply,
  looksLikeListAddClaim,
  looksLikeListDeleteClaim,
  looksLikeReminderSaveClaim,
  looksLikeUnshareClaim,
  summarizeUnshareApply,
  type EmployeeRecordSnapshot,
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
          listName: "משימות",
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
      snapshotAfter: {
        lists: [
          {
            list_type: "shopping",
            owner: "טל",
            scope: "personal",
            items: [{ item_id: "milk-1", "שם פריט": "חלב" }],
          },
        ],
        filing: [],
        reminders: [],
      },
    });
    expect(out).toBe(spoken);
  });

  it("partial shopping unshare does not claim full list success", () => {
    const spoken = "הסרתי את השיתוף של רשימת הקניות עם מיכל.";
    const snapshotAfter: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "a", "שם פריט": "גלידה" },
            {
              item_id: "b",
              "שם פריט": "יוגורט",
              shared_with: ["מיכל", "טל"],
            },
            {
              item_id: "c",
              "שם פריט": "לחם",
              shared_with: ["מיכל", "טל"],
            },
          ],
        },
      ],
      filing: [],
      reminders: [],
    };
    const out = correctModelApplyTurnResponse({
      response: spoken,
      metadata: meta({
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            items: [
              { item_id: "a", unshare_with: ["מיכל"] },
              { item_id: "d", unshare_with: ["מיכל"] },
              { item_id: "e", unshare_with: ["מיכל"] },
            ],
            targets: [],
          },
        ],
      }),
      mutations: [
        {
          action: "update",
          itemId: "a",
          employeeId: "emp-1",
          listType: "shopping",
          itemKey: "גלידה",
          itemLabel: "גלידה",
          listName: "קניות",
        },
        {
          action: "update",
          itemId: "d",
          employeeId: "emp-1",
          listType: "shopping",
          itemKey: "חטיף",
          itemLabel: "חטיף",
          listName: "קניות",
        },
        {
          action: "update",
          itemId: "e",
          employeeId: "emp-1",
          listType: "shopping",
          itemKey: "ביצים",
          itemLabel: "ביצים",
          listName: "קניות",
        },
      ],
      filingMutations: [],
      snapshotAfter,
    });
    expect(out).toMatch(/הסרתי את השיתוף מ-3 פריטים/);
    expect(out).toMatch(/2 עדיין משותפים עם מיכל/);
    expect(out).not.toBe(spoken);
  });

  it("complete shopping unshare keeps model confirm when none remain shared", () => {
    const spoken = "הסרתי את השיתוף של רשימת הקניות עם מיכל.";
    const out = correctModelApplyTurnResponse({
      response: spoken,
      metadata: meta({
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            items: [
              { item_id: "a", unshare_with: ["מיכל"] },
              { item_id: "b", unshare_with: ["מיכל"] },
            ],
            targets: [],
          },
        ],
      }),
      mutations: [
        {
          action: "update",
          itemId: "a",
          employeeId: "emp-1",
          listType: "shopping",
          itemKey: "גלידה",
          itemLabel: "גלידה",
          listName: "קניות",
        },
        {
          action: "update",
          itemId: "b",
          employeeId: "emp-1",
          listType: "shopping",
          itemKey: "לחם",
          itemLabel: "לחם",
          listName: "קניות",
        },
      ],
      filingMutations: [],
      snapshotAfter: {
        lists: [
          {
            list_type: "shopping",
            owner: "טל",
            scope: "personal",
            items: [
              { item_id: "a", "שם פריט": "גלידה" },
              { item_id: "b", "שם פריט": "לחם", shared_with: ["טל", "עמית"] },
            ],
          },
        ],
        filing: [],
        reminders: [],
      },
    });
    expect(out).toBe(spoken);
  });

  it("unshare claim is not treated as a list delete claim", () => {
    expect(looksLikeUnshareClaim("הסרתי את השיתוף של הקניות עם מיכל.")).toBe(
      true,
    );
    expect(
      looksLikeListDeleteClaim("הסרתי את השיתוף של הקניות עם מיכל."),
    ).toBe(false);
  });

  it("one unshare miss with remaining shares reports partial, not full success", () => {
    const spoken = "הסרתי את השיתוף של הקניות עם מיכל.";
    const out = correctModelApplyTurnResponse({
      response: spoken,
      metadata: meta({
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            items: [
              { item_id: "ok-1", unshare_with: ["מיכל"] },
              { item_id: "miss-1", unshare_with: ["מיכל"] },
            ],
            targets: [],
          },
        ],
      }),
      mutations: [
        {
          action: "update",
          itemId: "ok-1",
          employeeId: "emp-1",
          listType: "shopping",
          itemKey: "חלב",
          itemLabel: "חלב",
          listName: "קניות",
        },
      ],
      shareMisses: [{ itemId: "miss-1", reason: "missing" }],
      filingMutations: [],
      snapshotAfter: {
        lists: [
          {
            list_type: "shopping",
            owner: "טל",
            scope: "personal",
            items: [
              { item_id: "ok-1", "שם פריט": "חלב" },
              {
                item_id: "still-1",
                "שם פריט": "לחם",
                shared_with: ["מיכל", "טל"],
              },
            ],
          },
        ],
        filing: [],
        reminders: [],
      },
    });
    expect(out).toMatch(/הסרתי את השיתוף מ-1 פריטים/);
    expect(out).toMatch(/1 עדיין משותפים עם מיכל/);
    expect(out).not.toBe(spoken);
  });

  it("ambiguous empty ACTION does not invent unshare mutations", () => {
    const spoken = "עם מי להפסיק לשתף, ועל איזו רשימה?";
    const summary = summarizeUnshareApply({
      metadata: meta({ lists: [] }),
      mutations: [],
      snapshotAfter: {
        lists: [
          {
            list_type: "shopping",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "a",
                "שם פריט": "חלב",
                shared_with: ["מיכל", "טל"],
              },
            ],
          },
        ],
        filing: [],
        reminders: [],
      },
    });
    expect(summary.partnerLabels).toEqual([]);
    expect(summary.appliedUnshareCount).toBe(0);
    const out = correctUnshareClaimReply({
      reply: spoken,
      spoken,
      summary,
      setResponse: (_r, next) => next,
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

  it("omitted lists.add + הוספתי למשימות + reminder applied → reminder-only partial", () => {
    const out = correctModelApplyTurnResponse({
      response:
        "הוספתי למשימות להביא 2 בקבוקי מיץ לבית הספר עבור יואב, ואזכיר לך מחר ב־8 תזכורת.",
      metadata: meta({ reminders: [] }),
      mutations: [],
      appliedReminderAdd: true,
      reminderAddFallback: "שמרתי תזכורת «להביא 2 בקבוקי מיץ».",
      speakerEmployeeId: "emp-1",
    });
    expect(out).toBe(REMINDER_ONLY_PARTIAL);
  });

  it("worker-only להזכיר add + reminder does not keep speaker task claim", () => {
    const out = correctModelApplyTurnResponse({
      response:
        "הוספתי את המשימה להוסיף קבצי זיפ. קבעתי תזכורת למחר ב־10:00: תזכורת: להוסיף קבצי זיפ.",
      metadata: meta(),
      mutations: [
        {
          action: "add",
          itemId: "w1",
          employeeId: "lucy-1",
          listType: "tasks",
          itemKey: "להזכיר לטל",
          itemLabel: "להזכיר לטל",
          listName: "משימות",
        },
      ],
      appliedReminderAdd: true,
      reminderAddFallback: "שמרתי תזכורת «להוסיף קבצי זיפ».",
      speakerEmployeeId: "emp-1",
    });
    expect(out).toBe(REMINDER_ONLY_PARTIAL);
  });

  it("omitted lists.add + הוספתי with no reminder → LIST_ADD_MISS", () => {
    const out = correctModelApplyTurnResponse({
      response: "הוספתי למשימות לקנות חלב.",
      metadata: meta(),
      mutations: [],
      appliedReminderAdd: false,
    });
    expect(out).toBe(LIST_ADD_MISS);
  });

  it("list add + reminder both applied keeps dual success claim", () => {
    const reply =
      "הוספתי למשימות לקנות חלב ואזכיר לך מחר ב־9 תזכורת.";
    const out = correctModelApplyTurnResponse({
      response: reply,
      metadata: meta({
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ שם: "לקנות חלב" }],
            targets: [],
          },
        ],
      }),
      mutations: [
        {
          action: "add",
          itemId: "t1",
          employeeId: "emp-1",
          listType: "tasks",
          itemKey: "לקנות חלב",
          itemLabel: "לקנות חלב",
          listName: "משימות",
        },
      ],
      appliedReminderAdd: true,
      speakerEmployeeId: "emp-1",
    });
    expect(out).toBe(reply);
  });
});

describe("correctExecutionTruthReply (structured apply evidence)", () => {
  const setResponse = (_reply: string, next: string) => next;

  it("detects list-add and reminder-save claims", () => {
    expect(looksLikeListAddClaim("הוספתי למשימות מיץ")).toBe(true);
    expect(looksLikeListAddClaim("בסדר")).toBe(false);
    expect(looksLikeReminderSaveClaim("קבעתי תזכורת למחר")).toBe(true);
    expect(looksLikeReminderSaveClaim("אזכיר לך מחר ב־8 תזכורת")).toBe(true);
    expect(looksLikeReminderSaveClaim("שלום")).toBe(false);
  });

  it("reminder-only when task claim false and reminder applied", () => {
    const out = correctExecutionTruthReply({
      reply: "הוספתי למשימות מיץ",
      spoken: "הוספתי למשימות מיץ",
      appliedListAdd: false,
      appliedSpeakerListAdd: false,
      appliedReminderAdd: true,
      reminderAddFallback: "שמרתי תזכורת «מיץ».",
      setResponse,
    });
    expect(out).toBe(REMINDER_ONLY_PARTIAL);
  });

  it("worker add alone is not speaker evidence for dual claim", () => {
    const out = correctExecutionTruthReply({
      reply:
        "הוספתי את המשימה. קבעתי תזכורת למחר ב־10:00: תזכורת: זיפ.",
      spoken:
        "הוספתי את המשימה. קבעתי תזכורת למחר ב־10:00: תזכורת: זיפ.",
      appliedListAdd: true,
      appliedSpeakerListAdd: false,
      appliedReminderAdd: true,
      reminderAddFallback: "שמרתי תזכורת «זיפ».",
      setResponse,
    });
    expect(out).toBe(REMINDER_ONLY_PARTIAL);
  });

  it("speaker add + reminder keeps dual claim", () => {
    const reply =
      "הוספתי את המשימה. קבעתי תזכורת למחר ב־10:00: תזכורת: זיפ.";
    const out = correctExecutionTruthReply({
      reply,
      spoken: reply,
      appliedListAdd: true,
      appliedSpeakerListAdd: true,
      appliedReminderAdd: true,
      setResponse,
    });
    expect(out).toBe(reply);
  });

  it("reminder claim without applied reminder → miss", () => {
    const out = correctExecutionTruthReply({
      reply: "קבעתי תזכורת למחר ב־8",
      spoken: "קבעתי תזכורת למחר ב־8",
      appliedListAdd: false,
      appliedSpeakerListAdd: false,
      appliedReminderAdd: false,
      setResponse,
    });
    expect(out).toBe(REMINDER_SAVE_CLAIM_MISS);
  });
});
