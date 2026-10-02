import { describe, expect, it } from "vitest";
import {
  conversationPendingFromStored,
  fillMessagesFromPendingHold,
  fillListsFromPendingHold,
  alignListTargetsWithMessageRecipients,
  formatCancelledHoldReply,
  formatConversationPendingContext,
  formatListDeleteConfirmNotice,
  isConfirmHoldNeed,
  isPendingHoldAcceptText,
  isPendingHoldCancelText,
  metadataAfterHoldCancel,
  pendingHoldFromLlm,
  pendingHoldFromMissingMessages,
  pendingToStored,
  planListDeletes,
  resolveNextPending,
} from "../src/services/pending-action.service.js";

describe("pending action hold", () => {
  it("stores a directory hold and reinjects context for the missing field", () => {
    const hold = pendingHoldFromLlm({
      kind: "directory",
      need: "שם משפחה",
      directory: [
        { action: "add", name: "יואב", phone: "0515520802" },
        { action: "add", name: "מאיה", phone: "0537234448" },
      ],
      lists: [],
      reminders: [],
      filing: [],
    });
    expect(hold?.action).toBe("complete_directory");
    expect(hold?.need).toBe("שם משפחה");

    const stored = pendingToStored(hold);
    const roundTrip = conversationPendingFromStored({
      pendingAction: stored.pendingAction,
      pendingTargets: stored.pendingTargets,
      pendingStep: stored.pendingStep,
      pendingAt: stored.pendingAt,
    });
    expect(roundTrip).toMatchObject({
      action: "complete_directory",
      step: "awaiting_fields",
      need: "שם משפחה",
    });

    const context = formatConversationPendingContext(roundTrip);
    expect(context).toContain("PENDING_ACTION_STATE");
    expect(context).toContain("שם משפחה");
    expect(context).toContain("יואב");
    expect(context).toContain("Never reply לא הבנתי");
  });

  it("holds a missing WhatsApp body and fills it from the short reply", () => {
    const hold = pendingHoldFromMissingMessages([
      { targets: ["מאיה"], text: "" },
    ]);
    expect(hold?.action).toBe("complete_messages");
    expect(hold?.draft.messages).toEqual([{ targets: ["מאיה"], text: "" }]);

    const context = formatConversationPendingContext(hold);
    expect(context).toContain("complete_messages");
    expect(context).toContain("מאיה");
    expect(context).toContain("CANCEL");
    expect(context).toContain("empty directory/lists/reminders/filing/messages");

    expect(
      fillMessagesFromPendingHold(hold, [], "היי"),
    ).toEqual([{ targets: ["מאיה"], text: "היי" }]);
    expect(
      fillMessagesFromPendingHold(hold, [{ targets: ["מאיה"], text: "היי" }], "היי"),
    ).toBeNull();
    expect(fillMessagesFromPendingHold(hold, [], "בטל")).toBeNull();
    expect(fillMessagesFromPendingHold(hold, [], "אל תשלחי")).toBeNull();
    expect(fillMessagesFromPendingHold(hold, [], "בעצם לא")).toBeNull();

    const completed = resolveNextPending({
      stored: hold,
      hold: null,
      reminderNext: null,
      directory: [],
      lists: [],
      reminders: [],
      filing: [],
      messages: [{ targets: ["מאיה"], text: "היי" }],
      confirm: null,
    });
    expect(completed).toBeNull();
  });

  it("applies confirm_share list drafts on yes even if the model emits private shopping", () => {
    const hold = pendingHoldFromLlm({
      kind: "lists",
      need: "confirm_share",
      directory: [],
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "ביצים" }],
          targets: ["מיכל", "טל"],
        },
      ],
      reminders: [],
      filing: [],
      messages: [],
    });
    expect(hold?.action).toBe("complete_lists");
    expect(isConfirmHoldNeed("confirm_share")).toBe(true);
    expect(isPendingHoldAcceptText("כן")).toBe(true);

    expect(
      fillListsFromPendingHold(
        hold,
        [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "ביצים" }],
            targets: [],
          },
        ],
        "כן",
        null,
      ),
    ).toEqual([
      {
        action: "add",
        listType: "shopping",
        listName: "",
        items: [{ "שם פריט": "ביצים" }],
        targets: ["מיכל", "טל"],
      },
    ]);

    expect(
      fillListsFromPendingHold(hold, [], "בטל", null),
    ).toBeNull();
  });

  it("aligns empty shopping targets with same-turn message recipients", () => {
    expect(
      alignListTargetsWithMessageRecipients({
        speakerName: "מיכל",
        messages: [{ targets: ["טל"], text: "תקני ביצים" }],
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "ביצים" }],
            targets: [],
          },
        ],
      }),
    ).toEqual([
      {
        action: "add",
        listType: "shopping",
        listName: "",
        items: [{ "שם פריט": "ביצים" }],
        targets: ["מיכל", "טל"],
      },
    ]);
  });

  it("recognizes cancel phrases for awaiting message holds", () => {
    expect(isPendingHoldCancelText("בטל")).toBe(true);
    expect(isPendingHoldCancelText("אל תשלחי")).toBe(true);
    expect(isPendingHoldCancelText("אל תשלחי למאיה")).toBe(true);
    expect(isPendingHoldCancelText("היי")).toBe(false);
    expect(isPendingHoldCancelText("לא יודע מה לכתוב")).toBe(false);
  });

  it("clears all draft domains and picks a cancel reply per hold kind", () => {
    const hold = pendingHoldFromMissingMessages([
      { targets: ["מאיה"], text: "" },
    ]);
    expect(hold).not.toBeNull();
    if (!hold) {
      return;
    }
    expect(
      metadataAfterHoldCancel({
        directory: [{ action: "add", name: "x", phone: "1" }],
        lists: [{ action: "add", listType: "shopping", items: ["חלב"] }],
        reminders: [],
        filing: [],
        messages: [{ targets: ["מאיה"], text: "בטל" }],
        hold: { kind: "messages", need: "text", messages: [] },
      }),
    ).toEqual({
      directory: [],
      lists: [],
      reminders: [],
      filing: [],
      messages: [],
      hold: null,
    });
    expect(formatCancelledHoldReply(hold)).toBe("ביטלתי את השליחה.");
    expect(
      formatCancelledHoldReply({
        ...hold,
        action: "complete_filing",
        need: "description",
        draft: { filing: [] },
      }),
    ).toBe("ביטלתי את התיוק.");
  });

  it("keeps the hold until the directory add is completed", () => {
    const stored = pendingHoldFromLlm({
      kind: "directory",
      need: "שם משפחה",
      directory: [{ action: "add", name: "יואב", phone: "0515520802" }],
      lists: [],
      reminders: [],
      filing: [],
    });

    const stillWaiting = resolveNextPending({
      stored,
      hold: null,
      reminderNext: null,
      directory: [],
      lists: [],
      reminders: [],
      filing: [],
      messages: [],
      confirm: null,
    });
    expect(stillWaiting?.action).toBe("complete_directory");

    const completed = resolveNextPending({
      stored,
      hold: null,
      reminderNext: null,
      directory: [{ action: "add", name: "יואב דור", phone: "0515520802" }],
      lists: [],
      reminders: [],
      filing: [],
      messages: [],
      confirm: null,
    });
    expect(completed).toBeNull();
  });

  it("lets a fresh hold replace a previous incomplete draft", () => {
    const previous = pendingHoldFromLlm({
      kind: "directory",
      need: "שם משפחה",
      directory: [{ action: "add", name: "יואב", phone: "0515520802" }],
      lists: [],
      reminders: [],
      filing: [],
    });
    const next = resolveNextPending({
      stored: previous,
      hold: {
        kind: "directory",
        need: "שם משפחה",
        directory: [
          { action: "add", name: "יואב דור", phone: "0515520802" },
          { action: "add", name: "מאיה דור", phone: "0537234448" },
        ],
        lists: [],
        reminders: [],
        filing: [],
      },
      reminderNext: null,
      directory: [],
      lists: [],
      reminders: [],
      filing: [],
      messages: [],
      confirm: null,
    });
    expect(next?.action).toBe("complete_directory");
    if (next && next.action === "complete_directory") {
      expect(next.draft.directory).toHaveLength(2);
      expect(next.draft.directory?.[0]?.name).toBe("יואב דור");
    }
  });

  it("lets reminder delete confirm win over a hold", () => {
    const hold = pendingHoldFromLlm({
      kind: "lists",
      need: "כמות",
      directory: [],
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "חלב" }],
          targets: [],
        },
      ],
      reminders: [],
      filing: [],
    });
    const next = resolveNextPending({
      stored: hold,
      hold: null,
      reminderNext: {
        action: "delete_reminder",
        step: "confirm",
        targets: ["לשתות מים"],
        at: new Date(),
      },
      directory: [],
      lists: [],
      reminders: [],
      filing: [],
      messages: [],
      confirm: null,
    });
    expect(next).toMatchObject({
      action: "delete_reminder",
      targets: ["לשתות מים"],
    });
  });
});

describe("planListDeletes", () => {
  const twoTaskRemoves = [
    {
      action: "remove" as const,
      listType: "tasks" as const,
      listName: "",
      targets: [] as string[],
      items: [
        { "שם מטלה": "להוריד את הכלב" },
        { "שם מטלה": "לטפל בתקלות" },
      ],
    },
  ];

  it("holds two or more list removes until confirm", () => {
    const planned = planListDeletes({
      lists: twoTaskRemoves,
      confirm: null,
      stored: null,
    });
    expect(planned.applyLists).toEqual([]);
    expect(planned.askLabels).toEqual(["להוריד את הכלב", "לטפל בתקלות"]);
    expect(planned.nextPending).toMatchObject({
      action: "delete_lists",
      step: "confirm",
      targets: ["להוריד את הכלב", "לטפל בתקלות"],
    });
    expect(formatListDeleteConfirmNotice(planned.askLabels, false)).toContain(
      "לאשר מחיקה",
    );
  });

  it("applies held list removes after confirm=true", () => {
    const held = planListDeletes({
      lists: twoTaskRemoves,
      confirm: null,
      stored: null,
    });
    const confirmed = planListDeletes({
      lists: [],
      confirm: true,
      stored: held.nextPending,
    });
    expect(confirmed.applyLists).toEqual(twoTaskRemoves);
    expect(confirmed.askLabels).toEqual([]);
    expect(confirmed.nextPending).toBeNull();
  });

  it("cancels held list deletes on confirm=false", () => {
    const held = planListDeletes({
      lists: twoTaskRemoves,
      confirm: null,
      stored: null,
    });
    const cancelled = planListDeletes({
      lists: [],
      confirm: false,
      stored: held.nextPending,
    });
    expect(cancelled.applyLists).toEqual([]);
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.nextPending).toBeNull();
    expect(formatListDeleteConfirmNotice([], true)).toBe("ביטלתי את המחיקה.");
  });

  it("applies a single list remove immediately", () => {
    const planned = planListDeletes({
      lists: [
        {
          action: "remove",
          listType: "shopping",
          listName: "",
          targets: [],
          items: [{ "שם פריט": "חלב" }],
        },
      ],
      confirm: null,
      stored: null,
    });
    expect(planned.applyLists).toHaveLength(1);
    expect(planned.askLabels).toEqual([]);
    expect(planned.nextPending).toBeNull();
  });

  it("round-trips delete_lists through pending storage", () => {
    const held = planListDeletes({
      lists: twoTaskRemoves,
      confirm: null,
      stored: null,
    });
    const stored = pendingToStored(held.nextPending);
    const roundTrip = conversationPendingFromStored({
      pendingAction: stored.pendingAction,
      pendingTargets: stored.pendingTargets,
      pendingStep: stored.pendingStep,
      pendingAt: stored.pendingAt,
    });
    expect(roundTrip).toMatchObject({
      action: "delete_lists",
      step: "confirm",
      targets: ["להוריד את הכלב", "לטפל בתקלות"],
    });
    expect(formatConversationPendingContext(roundTrip)).toContain(
      "confirm=true and empty lists",
    );

    const next = resolveNextPending({
      stored: roundTrip,
      hold: null,
      reminderNext: null,
      listDeleteNext: held.nextPending,
      directory: [],
      lists: [],
      reminders: [],
      filing: [],
      messages: [],
      confirm: null,
    });
    expect(next?.action).toBe("delete_lists");
  });
});
