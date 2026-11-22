/**
 * P1 — clarifyBind unit tests (no DB, no Class V / PendingHighRiskConfirm).
 *
 * Two suites (do not conflate):
 * 1) "provenance gate" — production-shaped authority (none / forged / WA EIS) → no bind.
 * 2) "Gate allow with synthetic trusted_control" — future plumbing + scope enforcement only.
 *
 * Production channels never issue trusted_control today.
 * Status: docs/product/lucy-high-risk-gate-p0-p1-status.md
 */
import { describe, expect, it } from "vitest";
import {
  emptyLlmMetadata,
  type LlmMetadata,
  type PublicEmployee,
} from "@workee/shared";
import { applyHighRiskActionGate } from "../src/services/high-risk-action-gate.js";
import {
  isSummaryEnvelopeInstruction,
  resolveClarifyBindAuthority,
  tryCreateClarifyBind,
  type ClarifyBind,
} from "../src/services/clarify-bind.service.js";
import {
  batchGateInstructionText,
  gateInstructionTextFromUtterance,
} from "../src/services/high-risk-instruction-channel.js";

const speaker: PublicEmployee = {
  id: "speaker-1",
  name: "טל",
  surname: "",
  nickname: "טל",
  email: null,
  phone: "972501111111",
  kind: "human",
  isGuest: false,
  isOwner: true,
};

const KNOWN = ["מיכל", "מאיה", "עמית", "טל"];

const AWAITING_REMIND = {
  kind: "remind_when" as const,
  targets: ["מאיה"],
  itemIds: [] as string[],
};

function meta(partial: Partial<LlmMetadata>): LlmMetadata {
  return { ...emptyLlmMetadata(), ...partial };
}

function reminderAdd(ping: string[]): NonNullable<LlmMetadata["reminders"]>[number] {
  return {
    action: "add",
    item: "להתקשר לרופא",
    listType: "tasks",
    date: "2026-11-23",
    time: "08:00",
    repeat: "once",
    ping,
    targets: [],
    text: "להתקשר לרופא",
    inSeconds: null,
    everyCount: null,
    everyUnit: null,
    weekdays: null,
    confirmed: true,
    compose: false,
    composeSource: "",
    composeLookbackHours: 0,
    composePlace: "",
    reminderId: "",
  };
}

function multiRemove(
  ids: string[],
): NonNullable<LlmMetadata["lists"]>[number] {
  return {
    action: "remove",
    listType: "shopping",
    listName: "",
    items: ids.map((item_id) => ({ item_id })),
    targets: [],
  };
}

/** Synthetic future path: server trusted_control only (not production channels). */
function createTrustedBind(
  partial: Parameters<typeof tryCreateClarifyBind>[0],
): ClarifyBind | null {
  return tryCreateClarifyBind({
    ...partial,
    bindAuthority: "trusted_control",
  });
}

describe("P1 clarifyBind — provenance gate", () => {
  it("bindAuthority missing → no bind", () => {
    expect(
      tryCreateClarifyBind({
        instructionText: "תזכירי למאיה מחר",
        proposal: AWAITING_REMIND,
        visibleItemIds: [],
        knownTargetNames: KNOWN,
        speaker,
      }),
    ).toBeNull();
  });

  it("bindAuthority=none → no bind", () => {
    expect(
      tryCreateClarifyBind({
        instructionText: "תזכירי למאיה מחר",
        proposal: AWAITING_REMIND,
        visibleItemIds: [],
        knownTargetNames: KNOWN,
        speaker,
        bindAuthority: "none",
      }),
    ).toBeNull();
  });

  it("WA body regular + awaiting → no bind (production none)", () => {
    const eis = gateInstructionTextFromUtterance({
      utterance: "תזכירי למאיה להתקשר לרופא",
      forwarded: false,
    });
    expect(eis.length).toBeGreaterThan(0);
    expect(
      tryCreateClarifyBind({
        instructionText: eis,
        proposal: AWAITING_REMIND,
        visibleItemIds: [],
        knownTargetNames: KNOWN,
        speaker,
        bindAuthority: "none",
      }),
    ).toBeNull();
  });

  it("WA paste without Forward metadata + awaiting → no bind", () => {
    const pasted = "תזכירי למאיה מחר ב־8 להתקשר";
    const eis = gateInstructionTextFromUtterance({
      utterance: pasted,
      forwarded: false,
    });
    expect(eis).toBe(pasted);
    expect(
      tryCreateClarifyBind({
        instructionText: eis,
        proposal: AWAITING_REMIND,
        visibleItemIds: [],
        knownTargetNames: KNOWN,
        speaker,
        bindAuthority: "none",
      }),
    ).toBeNull();
  });

  it("Forward + awaiting → no bind (empty EIS and none authority)", () => {
    const eis = batchGateInstructionText([
      { text: "תזכירי למאיה מחר", forwarded: true },
    ]);
    expect(eis).toBe("");
    expect(
      tryCreateClarifyBind({
        instructionText: eis,
        proposal: AWAITING_REMIND,
        visibleItemIds: [],
        knownTargetNames: KNOWN,
        speaker,
        bindAuthority: "none",
      }),
    ).toBeNull();
    // Even forged trusted_control cannot bind on empty EIS.
    expect(
      tryCreateClarifyBind({
        instructionText: eis,
        proposal: AWAITING_REMIND,
        visibleItemIds: [],
        knownTargetNames: KNOWN,
        speaker,
        bindAuthority: "trusted_control",
      }),
    ).toBeNull();
  });

  it("Web/UI free-text + awaiting → no bind", () => {
    expect(
      tryCreateClarifyBind({
        instructionText: "תזכירי למאיה מחר",
        proposal: AWAITING_REMIND,
        visibleItemIds: [],
        knownTargetNames: KNOWN,
        speaker,
        bindAuthority: "none",
      }),
    ).toBeNull();
  });

  it("bindAuthority forged from model/ACTION is not accepted", () => {
    expect(resolveClarifyBindAuthority("trusted_control")).toBe(
      "trusted_control",
    );
    // Model-shaped payloads:
    expect(resolveClarifyBindAuthority({ bindAuthority: "trusted_control" })).toBe(
      "none",
    );
    expect(resolveClarifyBindAuthority("TRUSTED_CONTROL")).toBe("none");
    expect(resolveClarifyBindAuthority(true)).toBe("none");
    expect(
      tryCreateClarifyBind({
        instructionText: "תזכירי למאיה מחר",
        proposal: AWAITING_REMIND,
        visibleItemIds: [],
        knownTargetNames: KNOWN,
        speaker,
        // Simulate reading a field off metadata by mistake:
        bindAuthority: (meta({
          awaiting: { kind: "remind_when", targets: ["מאיה"] },
        }) as Record<string, unknown>).bindAuthority,
      }),
    ).toBeNull();
    expect(
      tryCreateClarifyBind({
        instructionText: "תזכירי למאיה מחר",
        proposal: AWAITING_REMIND,
        visibleItemIds: [],
        knownTargetNames: KNOWN,
        speaker,
        bindAuthority: "trusted_control from model",
      }),
    ).toBeNull();
  });
});

describe("P1 clarifyBind — Gate allow with synthetic trusted_control", () => {
  it("FP-2: follow-up time allows foreign remind within synthetic bind", () => {
    const bind = createTrustedBind({
      instructionText: "תזכירי למאיה להתקשר לרופא",
      proposal: AWAITING_REMIND,
      visibleItemIds: [],
      knownTargetNames: KNOWN,
      speaker,
    });
    expect(bind).not.toBeNull();
    expect(bind!.targets).toEqual(["מאיה"]);

    const gated = applyHighRiskActionGate(
      meta({ reminders: [reminderAdd(["מאיה"])] }),
      {
        speaker,
        pOutMode: "signal",
        speakerText: "מחר ב־8",
        instructionText: "מחר ב־8",
        knownTargetNames: KNOWN,
        clarifyBind: bind,
      },
    );
    expect(gated.didStrip).toBe(false);
  });

  it("FP-3: כן after delete clarify allows multi_remove within synthetic bind", () => {
    const bind = createTrustedBind({
      instructionText: "תמחקי את שני הפריטים מהקניות",
      proposal: {
        kind: "delete_scope",
        targets: [],
        itemIds: ["a", "b"],
      },
      visibleItemIds: ["a", "b", "c"],
      knownTargetNames: KNOWN,
      speaker,
    });
    expect(bind).not.toBeNull();

    const gated = applyHighRiskActionGate(
      meta({ lists: [multiRemove(["a", "b"])] }),
      {
        speaker,
        pOutMode: "signal",
        speakerText: "כן",
        instructionText: "כן",
        knownTargetNames: KNOWN,
        clarifyBind: bind,
      },
    );
    expect(gated.didStrip).toBe(false);
  });

  it("blocks target expansion beyond bind scope", () => {
    const bind: ClarifyBind = {
      v: 1,
      kind: "remind_when",
      targets: ["מאיה"],
      itemIds: [],
      sourceInstructionHash: "h1",
      createdAt: new Date().toISOString(),
    };
    const gated = applyHighRiskActionGate(
      meta({ reminders: [reminderAdd(["מאיה", "עמית"])] }),
      {
        speaker,
        pOutMode: "signal",
        speakerText: "מחר ב־8",
        instructionText: "מחר ב־8",
        knownTargetNames: KNOWN,
        clarifyBind: bind,
      },
    );
    expect(gated.didStrip).toBe(true);
    expect(gated.stripped.some((s) => s.kind === "schedule_foreign")).toBe(
      true,
    );
  });

  it("blocks itemIds expansion beyond bind scope", () => {
    const bind: ClarifyBind = {
      v: 1,
      kind: "delete_scope",
      targets: [],
      itemIds: ["a", "b"],
      sourceInstructionHash: "h1",
      createdAt: new Date().toISOString(),
    };
    const gated = applyHighRiskActionGate(
      meta({ lists: [multiRemove(["a", "b", "c"])] }),
      {
        speaker,
        pOutMode: "signal",
        speakerText: "כן",
        instructionText: "כן",
        knownTargetNames: KNOWN,
        clarifyBind: bind,
      },
    );
    expect(gated.didStrip).toBe(true);
    expect(gated.stripped.some((s) => s.kind === "multi_remove")).toBe(true);
  });

  it("proposal cannot expand targets beyond instruction∩known (trusted_control)", () => {
    const bind = createTrustedBind({
      instructionText: "תזכירי למאיה מחר",
      proposal: {
        kind: "remind_when",
        targets: ["מאיה", "עמית"],
        itemIds: [],
      },
      visibleItemIds: [],
      knownTargetNames: KNOWN,
      speaker,
    });
    expect(bind).not.toBeNull();
    expect(bind!.targets).toEqual(["מאיה"]);
  });

  it("summary envelope still refuses bind even with trusted_control", () => {
    expect(
      isSummaryEnvelopeInstruction("תסכמי: תזכירי למאיה מחר ב־8"),
    ).toBe(true);
    expect(
      createTrustedBind({
        instructionText: "תסכמי: תזכירי למאיה מחר ב־8",
        proposal: AWAITING_REMIND,
        visibleItemIds: [],
        knownTargetNames: KNOWN,
        speaker,
      }),
    ).toBeNull();
  });

  it("without bind, Gate still strips FP-style follow-ups (Class V path unchanged)", () => {
    const remind = applyHighRiskActionGate(
      meta({ reminders: [reminderAdd(["מאיה"])] }),
      {
        speaker,
        pOutMode: "signal",
        speakerText: "מחר ב־8",
        instructionText: "מחר ב־8",
        knownTargetNames: KNOWN,
      },
    );
    expect(remind.didStrip).toBe(true);

    const del = applyHighRiskActionGate(
      meta({ lists: [multiRemove(["a", "b"])] }),
      {
        speaker,
        pOutMode: "signal",
        speakerText: "כן",
        instructionText: "כן",
        knownTargetNames: KNOWN,
      },
    );
    expect(del.didStrip).toBe(true);
  });

  it("PI share injection still strips with an unrelated clarifyBind present", () => {
    const bind: ClarifyBind = {
      v: 1,
      kind: "remind_when",
      targets: ["מאיה"],
      itemIds: [],
      sourceInstructionHash: "h1",
      createdAt: new Date().toISOString(),
    };
    const gated = applyHighRiskActionGate(
      meta({
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            items: [{ item_id: "item-poison" }],
            targets: ["טל", "עמית"],
          },
        ],
      }),
      {
        speaker,
        pOutMode: "signal",
        speakerText: "מה יש בקניות?",
        instructionText: "מה יש בקניות?",
        knownTargetNames: KNOWN,
        clarifyBind: bind,
      },
    );
    expect(gated.didStrip).toBe(true);
    expect(gated.stripped.some((s) => s.policy === "P-Share")).toBe(true);
  });
});
