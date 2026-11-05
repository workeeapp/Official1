/**
 * Live facts per turn (2026-11-04): facts used to sit inside the stored user
 * message, so every turn re-sent one stale snapshot per earlier turn (+~28k
 * input tokens/turn). Moving them to instructions fixed growth but broke the
 * prompt cache (instructions changed every turn → 0 cached tokens).
 * Contract now: instructions stay constant, history replays only what was
 * said, facts ride on THIS turn's input, and only message + reply are stored.
 */
import { describe, expect, it, vi } from "vitest";
import {
  conversationItemToInput,
  createLiveFactsResponse,
  toResponsesCreateBody,
  toStatelessResponsesBody,
  turnInputText,
  type LlmResponseInput,
} from "../src/services/llm-client.js";

const base: LlmResponseInput = {
  conversationId: "conv_1",
  message: "טל: שעה לפני",
  liveFacts: "SESSION_CLOCK:\nnow\n\nEMPLOYEE_SAVED_DATA:\n{}",
  model: "gpt-6-luna",
  temperature: 0.2,
  reasoningEffort: "none",
  instructions: "You are לוסי.",
};

function fakeOpenAi(stored: unknown[]) {
  const created: unknown[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    conversations: {
      items: {
        list: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield* stored;
          },
        })),
        create: vi.fn(async (_id: string, body: { items: unknown[] }) => {
          created.push(...body.items);
          stored.push(...body.items.map((row) => ({ ...(row as object) })));
          return {};
        }),
      },
    },
    responses: {
      create: vi.fn(async (body: Record<string, unknown>) => {
        requests.push(body);
        return { output_text: '{"response":"בסדר","metadata":{}}', usage: {} };
      }),
    },
  };
  return { client, created, requests };
}

describe("live facts turn", () => {
  it("model reads facts then message; stored debug body shows the same text", () => {
    expect(turnInputText(base)).toBe(`${base.liveFacts}\n\n${base.message}`);
    expect(toResponsesCreateBody(base).input).toBe(turnInputText(base));
  });

  it("stateless body: constant instructions, history first, facts only in the last item, not stored", () => {
    const history = [
      { role: "user", content: "טל: תוסיפי תור" },
      { role: "assistant", content: '{"response":"באיזו שעה?"}' },
    ];
    const body = toStatelessResponsesBody(base, history);
    expect(body.instructions).toBe(base.instructions);
    expect(body.conversation).toBeUndefined();
    expect(body.store).toBe(false);
    const input = body.input as Array<{ role: string; content: string }>;
    expect(input.slice(0, 2)).toEqual(history);
    expect(input.at(-1)).toEqual({ role: "user", content: turnInputText(base) });
  });

  it("stores ONLY the message + reply — never the facts", async () => {
    const stored: unknown[] = [];
    const { client, created } = fakeOpenAi(stored);
    const turn = await createLiveFactsResponse(client as never, base);
    expect(turn.reply).toContain("בסדר");
    expect(JSON.stringify(created)).not.toContain("EMPLOYEE_SAVED_DATA");
    expect(created).toEqual([
      { type: "message", role: "user", content: base.message },
      { type: "message", role: "assistant", content: '{"response":"בסדר","metadata":{}}' },
    ]);
  });

  it("second turn replays turn 1 as an identical prefix (cacheable) with no stale facts", async () => {
    const stored: unknown[] = [];
    const { client, requests } = fakeOpenAi(stored);
    await createLiveFactsResponse(client as never, base);
    // What the API returns when listing: content parts with text.
    stored.splice(0, stored.length, ...[
      { type: "message", role: "user", content: [{ type: "input_text", text: base.message }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"response":"בסדר","metadata":{}}' }] },
    ]);
    await createLiveFactsResponse(client as never, {
      ...base,
      message: "טל: מה יש לי?",
      liveFacts: "SESSION_CLOCK:\nlater",
    });
    const second = requests[1]!.input as Array<{ role: string; content: string }>;
    expect(second[0]).toEqual({ role: "user", content: base.message });
    expect(second[1]?.role).toBe("assistant");
    expect(JSON.stringify(second.slice(0, -1))).not.toContain("SESSION_CLOCK");
    expect(second.at(-1)?.content).toBe("SESSION_CLOCK:\nlater\n\nטל: מה יש לי?");
    expect(requests[1]!.instructions).toBe(requests[0]!.instructions);
  });

  it("maps stored items deterministically; skips non-message items", () => {
    expect(
      conversationItemToInput({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "שלום" }],
      }),
    ).toEqual({ role: "assistant", content: "שלום" });
    expect(conversationItemToInput({ type: "reasoning", content: [] })).toBeNull();
    expect(
      conversationItemToInput({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "תראי" },
          { type: "input_image", image_url: "https://x/y.png" },
        ],
      }),
    ).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "תראי" },
        { type: "input_image", image_url: "https://x/y.png", detail: "auto" },
      ],
    });
  });
});
