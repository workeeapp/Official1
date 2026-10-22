import { describe, expect, it } from "vitest";
import {
  applyLiveMessage,
  buildTurnReplies,
  mergeMessages,
  placeTurnReply,
  type ChatMessage,
} from "./useChat";

describe("buildTurnReplies", () => {
  it("makes one bubble per response; legacy turn buttons go to first (הצג) / last (choices)", () => {
    const replies = buildTurnReplies({
      reply: JSON.stringify({
        responses: ["הוספתי חלב", "אגב, ביקשת שאבדוק אם קנית שוקו?"],
        metadata: { buttons: [{ label: "הצג", command: "הצג רשימת קניות" }] },
      }),
      messageIds: { user: "u1", assistant: "a1", assistants: ["a1", "a2"] },
      speaker: "לוסי",
      timing: { llmMs: 900, afterLlmMs: 40 },
    });

    expect(replies.map((reply) => [reply.id, reply.text])).toEqual([
      ["a1", "הוספתי חלב"],
      ["a2", "אגב, ביקשת שאבדוק אם קנית שוקו?"],
    ]);
    expect(replies[0].buttons).toEqual([
      { label: "הצג", command: "הצג רשימת קניות" },
    ]);
    expect(replies[0].llmMs).toBe(900);
    expect(replies[1].buttons).toBeUndefined();
    expect(replies[1].llmMs).toBeUndefined();
  });

  it("keeps per-bubble buttons and Waze on the declared entries", () => {
    const replies = buildTurnReplies({
      reply: JSON.stringify({
        responses: [
          {
            text: "הוספתי לשלוח מייל למטלות.",
            buttons: [{ label: "הצג", command: "הצג רשימת מטלות" }],
          },
          {
            text: "רוצה שאוסיף גם תזכורת?",
            buttons: [
              { label: "כן", command: "כן" },
              { label: "לא", command: "לא" },
            ],
          },
          { text: "באפשרותי לשמור פגישה קבועה.", buttons: [] },
        ],
        metadata: { buttons: [] },
      }),
      messageIds: {
        user: "u1",
        assistant: "a1",
        assistants: ["a1", "a2", "a3"],
      },
      speaker: "לוסי",
    });

    expect(replies[0].buttons).toEqual([
      { label: "הצג", command: "הצג רשימת מטלות" },
    ]);
    expect(replies[1].buttons).toEqual([
      { label: "כן", command: "כן" },
      { label: "לא", command: "לא" },
    ]);
    expect(replies[2].buttons).toBeUndefined();
  });

  it("puts legacy turn navigate on the first bubble; per-bubble Waze stays put", () => {
    const legacy = buildTurnReplies({
      reply: JSON.stringify({
        responses: ["הכתובת שלך היא הרצל 12, תל אביב", "עוד משהו?"],
        metadata: { navigate_address: "הרצל 12, תל אביב" },
      }),
      messageIds: { user: "u1", assistant: "a1", assistants: ["a1", "a2"] },
      speaker: "לוסי",
    });
    expect(legacy[0].navigateAddress).toBe("הרצל 12, תל אביב");
    expect(legacy[1].navigateAddress).toBeUndefined();

    const bound = buildTurnReplies({
      reply: JSON.stringify({
        responses: [
          { text: "מצאתי את המקום." },
          {
            text: "הכתובת: הרצל 12, תל אביב",
            navigate_address: "הרצל 12, תל אביב",
          },
        ],
        metadata: {},
      }),
      messageIds: { user: "u1", assistant: "a1", assistants: ["a1", "a2"] },
      speaker: "לוסי",
    });
    expect(bound[0].navigateAddress).toBeUndefined();
    expect(bound[1].navigateAddress).toBe("הרצל 12, תל אביב");
  });
});

const saved = (id: string, text: string, createdAt: string): ChatMessage => ({
  id,
  author: "you",
  speaker: "עמית",
  text,
  createdAt,
});

describe("chat thread merge", () => {
  const earlier = saved("srv-1", "מה את צריכה לעשות", "2026-10-06T14:00:00.000Z");
  const pending = saved("local-1", "מה את צריכה לעשות", "2026-10-06T14:40:00.000Z");

  it("keeps a pending message that repeats an earlier saved text", () => {
    const merged = mergeMessages([earlier, pending], [earlier], new Set(["local-1"]));
    expect(merged.map((message) => message.id)).toEqual(["srv-1", "local-1"]);
  });

  it("replaces the pending message once the server saves it", () => {
    const savedCopy = saved("srv-2", "מה את צריכה לעשות", "2026-10-06T14:40:05.000Z");
    const merged = mergeMessages(
      [earlier, pending],
      [earlier, savedCopy],
      new Set(["local-1"]),
    );
    expect(merged.map((message) => message.id)).toEqual(["srv-1", "srv-2"]);
  });

  it("live event appends a repeated text and replaces only a pending copy", () => {
    const fired = { ...earlier, id: "srv-3", createdAt: "2026-10-06T14:41:00.000Z" };
    expect(applyLiveMessage([earlier], fired, new Set()).map((m) => m.id)).toEqual([
      "srv-1",
      "srv-3",
    ]);
    expect(
      applyLiveMessage([earlier, pending], fired, new Set(["local-1"])).map((m) => m.id),
    ).toEqual(["srv-1", "srv-3"]);
  });
});

describe("placing the POST reply", () => {
  const ask = "תזכירי לטל לבדוק את התזכורת בעוד רבע שעה";
  const spoken = "אזכיר לטל לבדוק את התזכורת בעוד רבע שעה.";
  const withNotice = `${spoken}\n\nנשמרה התזכורת «לבדוק את התזכורת» ל-2026-10-09 20:29 (אל טל).`;
  const pendingUser = saved("local-u", ask, "2026-10-09T17:14:51.000Z");
  const reply: ChatMessage = {
    id: "srv-a",
    author: "assistant",
    speaker: "לוסי",
    text: withNotice,
    createdAt: "2026-10-09T17:14:57.400Z",
    llmMs: 4400,
    afterLlmMs: 1200,
  };

  it("does not duplicate a reply the history poll showed mid-turn", () => {
    const savedUser = saved("srv-u", ask, "2026-10-09T17:14:56.084Z");
    const polledReply: ChatMessage = {
      id: "srv-a",
      author: "assistant",
      speaker: "לוסי",
      text: spoken,
      createdAt: "2026-10-09T17:14:56.085Z",
    };
    const placed = placeTurnReply([savedUser, polledReply], {
      pendingUserId: "local-u",
      savedUserId: "srv-u",
      reply,
    });
    expect(placed.map((message) => message.id)).toEqual(["srv-u", "srv-a"]);
    expect(placed[1]).toMatchObject({
      text: withNotice,
      llmMs: 4400,
      afterLlmMs: 1200,
      createdAt: "2026-10-09T17:14:56.085Z",
    });

    const repolled = mergeMessages(
      placed,
      [savedUser, { ...polledReply, text: withNotice }],
      new Set(["local-u"]),
    );
    expect(repolled.map((message) => message.id)).toEqual(["srv-u", "srv-a"]);
    expect(repolled[1].llmMs).toBe(4400);
  });

  it("gives the pending bubbles the saved ids before the next poll", () => {
    const placed = placeTurnReply([pendingUser], {
      pendingUserId: "local-u",
      savedUserId: "srv-u",
      reply,
    });
    expect(placed.map((message) => message.id)).toEqual(["srv-u", "srv-a"]);

    const savedUser = saved("srv-u", ask, "2026-10-09T17:14:56.084Z");
    const polled = mergeMessages(
      placed,
      [savedUser, { ...reply, createdAt: "2026-10-09T17:14:56.085Z", llmMs: undefined }],
      new Set(["local-u"]),
    );
    expect(polled.map((message) => message.id)).toEqual(["srv-u", "srv-a"]);
  });
});
