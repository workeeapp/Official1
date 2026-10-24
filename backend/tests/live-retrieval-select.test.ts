/**
 * Offline proof for live post-retrieval selection envelope (Phase A).
 * Levels: parse_shape (shared) + engine_apply here. Not live-model accuracy.
 */
import { describe, expect, it, vi } from "vitest";
import {
  filterIdsByLiveSelect,
  filterRecordsByIds,
  formatLiveSelectFailureReply,
  LIVE_SELECT_FAILURE_HE,
  LIVE_SELECT_NO_MATCH_HE,
  LIVE_SELECT_UNFILTERED_LABEL_HE,
  resolveLiveSelectOutcome,
  runLivePostSelect,
  type LiveRetrievalRecord,
} from "../src/services/live-retrieval-select.js";

const board: LiveRetrievalRecord[] = [
  { id: "f1", label: "LY1 Paris", fields: { airline: "LY" } },
  { id: "f2", label: "AF2 Paris", fields: { airline: "AF" } },
  { id: "f3", label: "UA3 NYC", fields: { airline: "UA" } },
];
const retrievalIds = board.map((row) => row.id);

describe("live-retrieval-select engine_apply", () => {
  it("structured_only: require false keeps all ids without treating as select", () => {
    const out = resolveLiveSelectOutcome({
      requireLiveSelect: false,
      parse: { status: "absent" },
      retrievalIds,
    });
    expect(out.kind).toBe("structured_only");
    expect(out.keptIds).toEqual(retrievalIds);
    expect(out.mayShowUnfilteredLabeled).toBe(false);
  });

  it("required + absent/malformed → failure, never silent keep-all", () => {
    for (const parse of [
      { status: "absent" as const },
      { status: "malformed" as const },
    ]) {
      const out = resolveLiveSelectOutcome({
        requireLiveSelect: true,
        parse,
        retrievalIds,
      });
      expect(out.kind).toBe("failure");
      expect(out.keptIds).toEqual([]);
      expect(out.messageHe).toBe(LIVE_SELECT_FAILURE_HE);
      expect(out.mayShowUnfilteredLabeled).toBe(true);
      expect(out.keptIds).not.toEqual(retrievalIds);
    }
  });

  it("required select + null/keep_all → failure (not silent full-board success)", () => {
    const out = resolveLiveSelectOutcome({
      requireLiveSelect: true,
      parse: { status: "keep_all" },
      retrievalIds,
    });
    expect(out.kind).toBe("failure");
    expect(out.keptIds).toEqual([]);
    expect(out.mayShowUnfilteredLabeled).toBe(true);
    expect(out.messageHe).toBe(LIVE_SELECT_FAILURE_HE);
  });

  it("required select + explicit all ids → subset (legitimate all-match)", () => {
    const out = resolveLiveSelectOutcome({
      requireLiveSelect: true,
      parse: { status: "ids", domain: "flights", ids: [...retrievalIds] },
      retrievalIds,
      expectedDomain: "flights",
    });
    expect(out.kind).toBe("subset");
    expect(out.keptIds).toEqual(retrievalIds);
    expect(out.mayShowUnfilteredLabeled).toBe(false);
  });

  it("requireLiveSelect=false ignores keep_all parse → structured_only", () => {
    const out = resolveLiveSelectOutcome({
      requireLiveSelect: false,
      parse: { status: "keep_all" },
      retrievalIds,
    });
    expect(out.kind).toBe("structured_only");
    expect(out.keptIds).toEqual(retrievalIds);
    expect(out.mayShowUnfilteredLabeled).toBe(false);
  });

  it("empty ids → no_match (not full board)", () => {
    const out = resolveLiveSelectOutcome({
      requireLiveSelect: true,
      parse: { status: "ids", domain: "flights", ids: [] },
      retrievalIds,
      expectedDomain: "flights",
    });
    expect(out.kind).toBe("no_match");
    expect(out.keptIds).toEqual([]);
    expect(out.messageHe).toBe(LIVE_SELECT_NO_MATCH_HE);
  });

  it("subset preserves retrieval order; drops unknown / cross-stash ids", () => {
    const { kept, unknown } = filterIdsByLiveSelect(retrievalIds, [
      "f3",
      "other-stash",
      "f1",
      "f3",
    ]);
    expect(kept).toEqual(["f1", "f3"]);
    expect(unknown).toEqual(["other-stash"]);

    const out = resolveLiveSelectOutcome({
      requireLiveSelect: true,
      parse: {
        status: "ids",
        domain: "flights",
        ids: ["f3", "ghost", "f1"],
      },
      retrievalIds,
      expectedDomain: "flights",
    });
    expect(out.kind).toBe("subset");
    expect(out.keptIds).toEqual(["f1", "f3"]);
    expect(filterRecordsByIds(board, out.keptIds).map((r) => r.id)).toEqual([
      "f1",
      "f3",
    ]);
  });

  it("all unknown ids → no_match", () => {
    const out = resolveLiveSelectOutcome({
      requireLiveSelect: true,
      parse: {
        status: "ids",
        domain: "flights",
        ids: ["stash-b-1", "stash-b-2"],
      },
      retrievalIds,
      expectedDomain: "flights",
    });
    expect(out.kind).toBe("no_match");
    expect(out.keptIds).toEqual([]);
  });

  it("domain mismatch when expected → failure", () => {
    const out = resolveLiveSelectOutcome({
      requireLiveSelect: true,
      parse: { status: "ids", domain: "places", ids: ["f1"] },
      retrievalIds,
      expectedDomain: "flights",
    });
    expect(out.kind).toBe("failure");
  });

  it("one-row required select can no_match (does not force show singleton)", () => {
    const out = resolveLiveSelectOutcome({
      requireLiveSelect: true,
      parse: { status: "ids", domain: "flights", ids: [] },
      retrievalIds: ["only"],
      expectedDomain: "flights",
    });
    expect(out.kind).toBe("no_match");
    expect(out.keptIds).toEqual([]);
  });

  it("failure reply labels unfiltered board and does not imply success", () => {
    const text = formatLiveSelectFailureReply("1. LY1\n2. AF2");
    expect(text.startsWith(LIVE_SELECT_FAILURE_HE)).toBe(true);
    expect(text).toContain(LIVE_SELECT_UNFILTERED_LABEL_HE);
    expect(text).toContain("1. LY1");
    expect(text).not.toMatch(/סונן|סוננו|filtered successfully/i);
  });
});

describe("runLivePostSelect engine_apply (mocked LLM)", () => {
  const billing = {
    conversationId: "c1",
    employeeId: "e1",
    digitalEmployeeId: "d1",
  };

  it("records purpose=live_select on success", async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const createResponse = vi.fn().mockResolvedValue({
      reply: JSON.stringify({
        responses: [],
        metadata: {
          live_select: { domain: "flights", live_record_ids: ["f2"] },
        },
      }),
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
        model: "gpt-test",
      },
      raw: {},
    });
    const out = await runLivePostSelect({
      domain: "flights",
      records: board,
      speakerAsk: "אירופאיות",
      billing,
      deps: {
        createConversation: async () => "openai-sel",
        createResponse,
        model: "gpt-test",
        recordUsage,
      },
    });
    expect(out.kind).toBe("subset");
    expect(out.keptIds).toEqual(["f2"]);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "live_select",
        openaiConversationId: "openai-sel",
        conversationId: billing.conversationId,
      }),
    );
  });

  it("LLM throw → failure, not keep-all; still no silent full board", async () => {
    const out = await runLivePostSelect({
      domain: "flights",
      records: board,
      speakerAsk: "אירופאיות",
      deps: {
        createConversation: async () => "openai-sel",
        createResponse: async () => {
          throw new Error("timeout");
        },
      },
    });
    expect(out.kind).toBe("failure");
    expect(out.keptIds).toEqual([]);
    expect(out.messageHe).toBe(LIVE_SELECT_FAILURE_HE);
  });

  it("malformed select JSON → failure (not keep-all)", async () => {
    const out = await runLivePostSelect({
      domain: "flights",
      records: board,
      speakerAsk: "אירופאיות",
      deps: {
        createConversation: async () => "openai-sel",
        createResponse: async () => ({
          reply: "not json at all",
          raw: {},
        }),
      },
    });
    expect(out.kind).toBe("failure");
    expect(out.keptIds).toEqual([]);
  });

  it("explicit null from select LLM → failure (required filter incomplete)", async () => {
    const out = await runLivePostSelect({
      domain: "flights",
      records: board,
      speakerAsk: "הצג הכל",
      deps: {
        createConversation: async () => "openai-sel",
        createResponse: async () => ({
          reply: JSON.stringify({
            responses: [],
            metadata: { live_select: null },
          }),
          raw: {},
        }),
      },
    });
    expect(out.kind).toBe("failure");
    expect(out.keptIds).toEqual([]);
    expect(out.mayShowUnfilteredLabeled).toBe(true);
  });

  it("select LLM listing every id → subset all rows (completed selection)", async () => {
    const out = await runLivePostSelect({
      domain: "flights",
      records: board,
      speakerAsk: "הכל תואם",
      deps: {
        createConversation: async () => "openai-sel",
        createResponse: async () => ({
          reply: JSON.stringify({
            responses: [],
            metadata: {
              live_select: {
                domain: "flights",
                live_record_ids: retrievalIds,
              },
            },
          }),
          raw: {},
        }),
      },
    });
    expect(out.kind).toBe("subset");
    expect(out.keptIds).toEqual(retrievalIds);
  });

  it("skips usage when billing omitted", async () => {
    const recordUsage = vi.fn();
    await runLivePostSelect({
      domain: "flights",
      records: board,
      speakerAsk: "x",
      deps: {
        createConversation: async () => "openai-sel",
        createResponse: async () => ({
          reply: JSON.stringify({
            responses: [],
            metadata: { live_select: null },
          }),
          raw: {},
        }),
        recordUsage,
      },
    });
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
