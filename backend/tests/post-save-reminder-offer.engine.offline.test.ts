/**
 * Engine safety-net for post-save reminder offer — idempotent injection.
 */
import { describe, expect, it } from "vitest";
import { emptyLlmMetadata, type LlmSpokenBubble } from "@workee/shared";
import {
  applyPostSaveReminderOfferSafetyNet,
  bubblesHaveSoftYesNoOffer,
  metadataRequestsReminderThisTurn,
  POST_SAVE_REMINDER_OFFER_TEXT,
  shouldInjectPostSaveReminderOffer,
} from "../src/services/post-save-reminder-offer.js";

function timedAddMetadata() {
  return {
    ...emptyLlmMetadata(),
    lists: [
      {
        action: "add" as const,
        listType: "tasks" as const,
        listName: "",
        items: [
          {
            "שם משימה": "X",
            "תאריך לביצוע": "2027-02-17",
            "שעה לביצוע": "13:30",
          },
        ],
        targets: [],
      },
    ],
  };
}

describe("post-save reminder offer engine safety-net", () => {
  const mutations = [
    {
      action: "add",
      listType: "tasks",
      calendarYmd: "2027-02-17",
    },
  ];

  it("injects soft offer after timed tasks add when model omitted it", () => {
    const bubbles: LlmSpokenBubble[] = [
      { text: "שמרתי.", buttons: [{ label: "הצג משימות", command: "הצג משימות" }] },
    ];
    const next = applyPostSaveReminderOfferSafetyNet({
      metadata: timedAddMetadata(),
      listMutations: mutations,
      reminderSavedCount: 0,
      bubbles,
    });
    expect(next).toHaveLength(2);
    expect(next[1]?.text).toBe(POST_SAVE_REMINDER_OFFER_TEXT);
    expect(bubblesHaveSoftYesNoOffer(next)).toBe(true);
  });

  it("is idempotent when model already emitted כן/לא offer", () => {
    const bubbles: LlmSpokenBubble[] = [
      { text: "שמרתי." },
      {
        text: "רוצה תזכורת?",
        buttons: [
          { label: "כן", command: "כן" },
          { label: "לא", command: "לא" },
        ],
      },
    ];
    expect(
      shouldInjectPostSaveReminderOffer({
        metadata: timedAddMetadata(),
        listMutations: mutations,
        reminderSavedCount: 0,
        bubbles,
      }),
    ).toBe(false);
    const next = applyPostSaveReminderOfferSafetyNet({
      metadata: timedAddMetadata(),
      listMutations: mutations,
      reminderSavedCount: 0,
      bubbles,
    });
    expect(next).toEqual(bubbles);
  });

  it("skips when a reminder was already requested or saved", () => {
    const withNested = timedAddMetadata();
    (withNested.lists[0]!.items[0] as Record<string, unknown>).remind = {
      date: "2027-02-17",
      time: "12:00",
    };
    expect(metadataRequestsReminderThisTurn(withNested)).toBe(true);
    expect(
      shouldInjectPostSaveReminderOffer({
        metadata: withNested,
        listMutations: mutations,
        reminderSavedCount: 0,
        bubbles: [{ text: "ok" }],
      }),
    ).toBe(false);

    expect(
      shouldInjectPostSaveReminderOffer({
        metadata: timedAddMetadata(),
        listMutations: mutations,
        reminderSavedCount: 1,
        bubbles: [{ text: "ok" }],
      }),
    ).toBe(false);
  });

  it("skips when apply did not prove a timed tasks add", () => {
    expect(
      shouldInjectPostSaveReminderOffer({
        metadata: timedAddMetadata(),
        listMutations: [],
        reminderSavedCount: 0,
        bubbles: [{ text: "ok" }],
      }),
    ).toBe(false);
  });
});
