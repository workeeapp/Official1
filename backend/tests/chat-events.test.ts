import { describe, expect, it } from "vitest";
import {
  applyRemoteChatEventNotify,
  chatEventsInstanceId,
  decodeChatEventNotify,
  encodeChatEventNotify,
  publishChatEvent,
  resetChatEventsForTests,
  subscribeChatEvents,
} from "../src/services/chat-events.service.js";

describe("chat live events", () => {
  it("writes a published event to every subscriber of that employee", () => {
    resetChatEventsForTests();
    const chunks: string[] = [];
    const res = { write: (chunk: string) => chunks.push(chunk) };
    const unsubscribe = subscribeChatEvents(
      "user-1",
      "employee-tal",
      "employee-lucy",
      res as never,
    );

    publishChatEvent("user-1", "employee-tal", "employee-lucy", {
      employeeId: "employee-tal",
      digitalEmployeeId: "employee-lucy",
      message: {
        id: "n1",
        author: "assistant",
        speaker: "לוסי",
        text: "עמית הוסיף חלב לרשימת הקניות שלך",
      },
    });
    publishChatEvent("user-1", "employee-amit", "employee-lucy", {
      employeeId: "employee-amit",
      digitalEmployeeId: "employee-lucy",
      message: {
        id: "n2",
        author: "assistant",
        speaker: "לוסי",
        text: "should not arrive",
      },
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("עמית הוסיף חלב לרשימת הקניות שלך");
    unsubscribe();
  });

  it("encodes and decodes a fan-out payload", () => {
    const event = {
      employeeId: "employee-tal",
      digitalEmployeeId: "employee-lucy",
      message: {
        id: "n1",
        author: "assistant" as const,
        speaker: "לוסי",
        text: "hi",
      },
    };
    const raw = encodeChatEventNotify({
      origin: "other-instance",
      userId: "user-1",
      employeeId: "employee-tal",
      digitalEmployeeId: "employee-lucy",
      event,
    });
    expect(decodeChatEventNotify(raw)).toEqual({
      origin: "other-instance",
      userId: "user-1",
      employeeId: "employee-tal",
      digitalEmployeeId: "employee-lucy",
      event,
    });
    expect(decodeChatEventNotify("not-json")).toBeNull();
  });

  it("applies remote notifies and skips this instance's echo", () => {
    resetChatEventsForTests();
    const chunks: string[] = [];
    const res = { write: (chunk: string) => chunks.push(chunk) };
    subscribeChatEvents(
      "user-1",
      "employee-tal",
      "employee-lucy",
      res as never,
    );

    const event = {
      employeeId: "employee-tal",
      digitalEmployeeId: "employee-lucy",
      message: {
        id: "n1",
        author: "assistant" as const,
        speaker: "לוסי",
        text: "from other server",
      },
    };

    expect(
      applyRemoteChatEventNotify(
        encodeChatEventNotify({
          origin: chatEventsInstanceId,
          userId: "user-1",
          employeeId: "employee-tal",
          digitalEmployeeId: "employee-lucy",
          event,
        }),
      ),
    ).toBe(false);
    expect(chunks).toHaveLength(0);

    expect(
      applyRemoteChatEventNotify(
        encodeChatEventNotify({
          origin: "other-instance",
          userId: "user-1",
          employeeId: "employee-tal",
          digitalEmployeeId: "employee-lucy",
          event,
        }),
      ),
    ).toBe(true);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("from other server");
  });
});
