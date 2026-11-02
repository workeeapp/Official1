/**
 * Stage 2A — empty response policy (production decision path).
 */
import { describe, expect, it } from "vitest";
import { emptyLlmMetadata, parseLlmReply } from "@workee/shared";
import {
  buildApplyResult,
  captureRequestedFromMetadata,
} from "../src/services/apply-result.js";
import {
  decideReplyFromApplyResult,
  ORDINARY_MUTATION_EMPTY_ACK,
  APPLY_RESULT_UNKNOWN_CAUTION,
} from "../src/services/apply-result-reply.js";
import {
  classifySpokenEmptiness,
  decideEmptySpokenFallback,
  shouldDeferEmptyToEngineDisplay,
} from "../src/services/empty-response-policy.js";
import { combineConfirmAndDump } from "../src/services/apply-result-display.js";
import { applyLiveDomainReply, setEngineResponse } from "../src/services/whatsapp-send.js";
import { EMPTY_REPLY_RETRY, LIST_FIND_MISS } from "../src/services/employee-records.service.js";

const taskId = "task-1";

function draft(responses: unknown, metadata: Record<string, unknown> = {}): string {
  return JSON.stringify({
    responses,
    metadata: { ...emptyLlmMetadata(), ...metadata },
  });
}

function runEmptyPath(input: {
  reply: string;
  applyResult: ReturnType<typeof buildApplyResult>;
  metadata?: Record<string, unknown>;
  pendingShowDump?: { kind: string } | null;
  afterEmpty?: (reply: string) => string;
}): {
  emptiness: string;
  afterPolicy: string;
  spoken: string;
  reason: string;
  deferred: boolean;
} {
  const metadata = {
    ...emptyLlmMetadata(),
    ...(input.metadata ?? {}),
  };
  const decidedB = decideReplyFromApplyResult({
    applyResult: input.applyResult,
    modelDraft: input.reply,
  });
  let reply = input.reply;
  if (!decidedB.keepDraft) {
    reply = setEngineResponse(reply, decidedB.spoken);
  }
  const decision = decideEmptySpokenFallback({
    reply,
    applyResult: input.applyResult,
    metadata: metadata as never,
    pendingShowDump: input.pendingShowDump ?? null,
  });
  if (decision.fallback) {
    reply = setEngineResponse(reply, decision.fallback);
  }
  if (input.afterEmpty) {
    reply = input.afterEmpty(reply);
  }
  return {
    emptiness: decision.emptiness,
    afterPolicy: reply,
    spoken: parseLlmReply(reply).response,
    reason: decision.reason,
    deferred: decision.reason === "defer_engine_display",
  };
}

describe("classifySpokenEmptiness", () => {
  it("distinguishes explicit empty responses vs missing responses vs whitespace", () => {
    expect(classifySpokenEmptiness(draft([]))).toBe("explicit_empty_responses");
    expect(
      classifySpokenEmptiness(
        JSON.stringify({ metadata: emptyLlmMetadata() }),
      ),
    ).toBe("missing_responses");
    expect(classifySpokenEmptiness(draft([{ text: "   " }]))).toBe(
      "whitespace_only",
    );
    expect(classifySpokenEmptiness(draft([{ text: "היי" }]))).toBe("nonempty");
  });
});

describe("Stage 2A empty policy — production path", () => {
  it("empty responses + show_dump defers; dump REPLACE supplies user-facing text", () => {
    const applyResult = buildApplyResult({
      requested: captureRequestedFromMetadata({ lists: [] }),
    });
    const out = runEmptyPath({
      reply: draft([], { showDump: "shopping" }),
      applyResult,
      metadata: { showDump: "shopping" },
      afterEmpty: (reply) =>
        setEngineResponse(reply, "🛒 קניות:\n1. חלב - 1"),
    });
    expect(out.emptiness).toBe("explicit_empty_responses");
    expect(out.deferred).toBe(true);
    expect(out.reason).toBe("defer_engine_display");
    expect(out.spoken).toContain("🛒 קניות:");
  });

  it("empty responses + live domain defers; live fill supplies user-facing text", () => {
    const applyResult = buildApplyResult({
      requested: captureRequestedFromMetadata({ lists: [] }),
    });
    const weatherMeta = {
      weather: {
        place: "תל אביב",
        near: "",
        date: "",
        aspects: ["summary"],
      },
    };
    const out = runEmptyPath({
      reply: draft([], weatherMeta),
      applyResult,
      metadata: weatherMeta,
      afterEmpty: (reply) =>
        applyLiveDomainReply(reply, "מזג האוויר בתל אביב: נעים."),
    });
    expect(out.deferred).toBe(true);
    expect(out.spoken).toContain("מזג האוויר");
  });

  it("empty after successful ordinary mutation → narrow בוצע. not detailed invent", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "remove",
          listType: "tasks",
          listName: "",
          items: [{ item_id: taskId }],
          targets: [],
        },
      ],
    });
    const applyResult = buildApplyResult({
      requested,
      listMutations: [
        {
          action: "remove",
          itemId: taskId,
          employeeId: "e1",
          listType: "tasks",
          itemKey: "k",
          itemLabel: "דיברתי עם yes",
        },
      ],
    });
    expect(applyResult.completeness).toBe("complete");
    const out = runEmptyPath({
      reply: draft([]),
      applyResult,
    });
    expect(out.reason).toBe("apply_result");
    expect(out.spoken).toBe(ORDINARY_MUTATION_EMPTY_ACK);
    expect(out.spoken).not.toContain("דיברתי עם yes");
  });

  it("empty after failed mutation → miss line, no success claim", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "remove",
          listType: "shopping",
          listName: "",
          items: [{ item_id: "missing" }],
          targets: [],
        },
      ],
    });
    const applyResult = buildApplyResult({
      requested,
      dumpGuardDrops: [
        {
          itemId: "missing",
          listType: "shopping",
          op: "remove",
          reason: "outside_dump",
        },
      ],
      listMutations: [],
    });
    const out = runEmptyPath({
      reply: draft([]),
      applyResult,
    });
    expect(out.spoken).toBe(LIST_FIND_MISS);
    expect(out.spoken).not.toMatch(/הסרתי|מחקתי|הוספתי/);
  });

  it("empty with no ACTION stays empty until EMPTY_REPLY_RETRY", () => {
    const applyResult = buildApplyResult({
      requested: captureRequestedFromMetadata({ lists: [] }),
    });
    const out = runEmptyPath({
      reply: draft([]),
      applyResult,
      afterEmpty: (reply) => {
        if (!parseLlmReply(reply).response.trim()) {
          return setEngineResponse(reply, EMPTY_REPLY_RETRY);
        }
        return reply;
      },
    });
    expect(out.reason).toBe("none");
    expect(out.spoken).toBe(EMPTY_REPLY_RETRY);
  });

  it("whitespace-only treated as empty and recovered for complete apply", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "חלב" }],
          targets: [],
        },
      ],
    });
    const applyResult = buildApplyResult({
      requested,
      listMutations: [
        {
          action: "add",
          itemId: "a1",
          employeeId: "e1",
          listType: "shopping",
          itemKey: "k",
          itemLabel: "חלב",
        },
      ],
    });
    const out = runEmptyPath({
      reply: draft([{ text: "  \n  " }]),
      applyResult,
    });
    expect(out.emptiness).toBe("whitespace_only");
    expect(out.spoken).toBe(ORDINARY_MUTATION_EMPTY_ACK);
  });

  it("missing responses key classified and recovered like empty", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "remove",
          listType: "tasks",
          listName: "",
          items: [{ item_id: taskId }],
          targets: [],
        },
      ],
    });
    const applyResult = buildApplyResult({
      requested,
      listMutations: [
        {
          action: "remove",
          itemId: taskId,
          employeeId: "e1",
          listType: "tasks",
          itemKey: "k",
          itemLabel: "x",
        },
      ],
    });
    const reply = JSON.stringify({ metadata: emptyLlmMetadata() });
    expect(classifySpokenEmptiness(reply)).toBe("missing_responses");
    const out = runEmptyPath({ reply, applyResult });
    expect(out.spoken).toBe(ORDINARY_MUTATION_EMPTY_ACK);
  });

  it("non-empty model response unchanged on complete success", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "remove",
          listType: "tasks",
          listName: "",
          items: [{ item_id: taskId }],
          targets: [],
        },
      ],
    });
    const applyResult = buildApplyResult({
      requested,
      listMutations: [
        {
          action: "remove",
          itemId: taskId,
          employeeId: "e1",
          listType: "tasks",
          itemKey: "k",
          itemLabel: "דיברתי עם yes",
        },
      ],
    });
    const out = runEmptyPath({
      reply: draft([{ text: "הסרתי את המשימה מהרשימה." }]),
      applyResult,
    });
    expect(out.reason).toBe("nonempty");
    expect(out.spoken).toBe("הסרתי את המשימה מהרשימה.");
  });

  it("partial ApplyResult empty → no false full success (miss lines present)", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "remove",
          listType: "shopping",
          listName: "",
          items: [{ item_id: "a" }, { item_id: "b" }],
          targets: [],
        },
      ],
    });
    const applyResult = buildApplyResult({
      requested,
      dumpGuardDrops: [
        {
          itemId: "b",
          listType: "shopping",
          op: "remove",
          reason: "outside_dump",
        },
      ],
      listMutations: [
        {
          action: "remove",
          itemId: "a",
          employeeId: "e1",
          listType: "shopping",
          itemKey: "k",
          itemLabel: "חלב",
        },
      ],
    });
    expect(applyResult.completeness).toBe("partial");
    const out = runEmptyPath({
      reply: draft([]),
      applyResult,
    });
    expect(out.spoken).toContain("חלב");
    expect(out.spoken).toContain(LIST_FIND_MISS);
    expect(out.spoken).not.toBe(ORDINARY_MUTATION_EMPTY_ACK);
  });

  it("unknown ApplyResult empty → caution, no unverified success-only text", () => {
    const requested = captureRequestedFromMetadata({
      filing: [
        {
          action: "remove_filing",
          filingId: "f1",
          itemName: "",
          itemInfo: "",
          itemDescription: "",
          targets: [],
        },
      ],
    });
    const applyResult = buildApplyResult({
      requested,
      filingMutations: [],
    });
    expect(applyResult.completeness).toBe("unknown");
    const out = runEmptyPath({
      reply: draft([]),
      applyResult,
    });
    expect(out.spoken).toBe(APPLY_RESULT_UNKNOWN_CAUTION);
  });

  it("mutate+show empty: ApplyResult ack then combine with dump", () => {
    const requested = captureRequestedFromMetadata({
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "אורז" }],
          targets: [],
        },
      ],
    });
    const applyResult = buildApplyResult({
      requested,
      listMutations: [
        {
          action: "add",
          itemId: "n1",
          employeeId: "e1",
          listType: "shopping",
          itemKey: "k",
          itemLabel: "אורז",
        },
      ],
    });
    expect(
      shouldDeferEmptyToEngineDisplay({
        metadata: { ...emptyLlmMetadata(), showDump: undefined },
        pendingShowDump: { kind: "shopping" },
        applyResult,
      }),
    ).toBe(false);

    const out = runEmptyPath({
      reply: draft([]),
      applyResult,
      pendingShowDump: { kind: "shopping" },
      afterEmpty: (reply) => {
        const confirm = parseLlmReply(reply).response;
        return setEngineResponse(
          reply,
          combineConfirmAndDump(confirm, "🛒 קניות:\n1. אורז - 1"),
        );
      },
    });
    expect(out.spoken).toContain(ORDINARY_MUTATION_EMPTY_ACK);
    expect(out.spoken).toContain("🛒 קניות:");
  });
});
