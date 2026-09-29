import { describe, expect, it } from "vitest";
import {
  conversationPendingFromStored,
  formatConversationPendingContext,
  pendingHoldFromLlm,
  pendingToStored,
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
    if (next && next.action !== "delete_reminder") {
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
