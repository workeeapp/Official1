import { describe, expect, it } from "vitest";
import { applyLiveMessage, mergeMessages, type ChatMessage } from "./useChat";

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
