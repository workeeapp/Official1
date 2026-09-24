import { describe, expect, it } from "vitest";
import {
  planOutboundSends,
  resetOutboundHolds,
  spokenReplyLooksLikeQuestion,
} from "../src/services/outbound-hold.js";

describe("spokenReplyLooksLikeQuestion", () => {
  it("treats a wording check as still asking", () => {
    expect(
      spokenReplyLooksLikeQuestion(
        "אני שולחת הודעה. האם זה הנוסח שתרצה לשלוח?",
      ),
    ).toBe(true);
    expect(spokenReplyLooksLikeQuestion("שלחתי למיכל")).toBe(false);
  });
});

describe("planOutboundSends", () => {
  it("holds a send while the spoken reply is still a question", () => {
    resetOutboundHolds();
    const first = planOutboundSends({
      conversationId: "c1",
      relays: [],
      phones: [{ phone: "0502222222", text: "היי" }],
      spokenAsk: true,
      confirm: null,
      reminderAsk: false,
      reminderRemoved: false,
      reminderCancelled: false,
    });
    expect(first).toEqual({ relays: [], phones: [], held: true });

    const yes = planOutboundSends({
      conversationId: "c1",
      relays: [],
      phones: [],
      spokenAsk: false,
      confirm: true,
      reminderAsk: false,
      reminderRemoved: false,
      reminderCancelled: false,
    });
    expect(yes.held).toBe(false);
    expect(yes.phones).toEqual([{ phone: "0502222222", text: "היי" }]);
  });

  it("does not release a held send when כן is a reminder delete", () => {
    resetOutboundHolds();
    planOutboundSends({
      conversationId: "c2",
      relays: [],
      phones: [{ phone: "1", text: "x" }],
      spokenAsk: true,
      confirm: null,
      reminderAsk: false,
      reminderRemoved: false,
      reminderCancelled: false,
    });
    const afterDelete = planOutboundSends({
      conversationId: "c2",
      relays: [],
      phones: [],
      spokenAsk: false,
      confirm: true,
      reminderAsk: false,
      reminderRemoved: true,
      reminderCancelled: false,
    });
    expect(afterDelete.phones).toEqual([]);
  });
});
