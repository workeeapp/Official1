/**
 * Offline unit tests for Studio ↔ eval-prompt provenance merge.
 * No OpenAI, Prisma, WhatsApp, reminders, or startStudioRun.
 */
import { describe, expect, it } from "vitest";
import {
  mergeStudioEvalPromptProvenance,
  type StudioEvalPromptProvenanceFields,
  type StudioRunProvenance,
} from "../src/services/studio.service.js";

function baseProvenance(
  overrides?: Partial<StudioRunProvenance>,
): StudioRunProvenance {
  return {
    productionApply: false,
    promptSource: "LLM.config.json (worktree via loadLlmConfig)",
    promptHash: "deadbeefcafebabe",
    speakerIdentity: {
      kind: "fixture",
      employeeId: "eval-human-1",
      name: "טל",
      note: "Fixture only",
    },
    digitalEmployee: {
      kind: "fixture",
      id: "eval-lucy-1",
      name: "לוסי",
      instructionsSource: "fixture instructions=null → file systemMessage",
      note: "Chat UI selection does not change eval prompt",
    },
    userId: null,
    userIdKind: "none",
    databaseTarget: {
      classification: "none",
      detail: "LIVE_MODEL does not open Prisma for apply",
    },
    safetyGate: { allowed: true, blockers: [] },
    ...overrides,
  };
}

function samplePrompt(
  overrides?: Partial<StudioEvalPromptProvenanceFields>,
): StudioEvalPromptProvenanceFields {
  return {
    promptSource: "config:LLM.config.json+buildLucyModelEvalInstructions",
    instructionsSha256: "a".repeat(64),
    envelopeMode: "lucy_eval",
    attachLucyRuntimeEngine: true,
    model: "gpt-test",
    temperature: 0.2,
    reasoningEffort: "low",
    workerName: "לוסי",
    workerProtected: true,
    employeeId: null,
    instructionsFile: null,
    ...overrides,
  };
}

describe("mergeStudioEvalPromptProvenance (offline)", () => {
  it("copies runner prompt fields and preserves legacy promptHash", () => {
    const base = baseProvenance();
    const prompt = samplePrompt();
    const merged = mergeStudioEvalPromptProvenance(base, prompt);

    expect(merged.promptHash).toBe("deadbeefcafebabe");
    expect(merged.promptSource).toBe(prompt.promptSource);
    expect(merged.instructionsSha256).toBe(prompt.instructionsSha256);
    expect(merged.envelopeMode).toBe("lucy_eval");
    expect(merged.attachLucyRuntimeEngine).toBe(true);
    expect(merged.model).toBe("gpt-test");
    expect(merged.temperature).toBe(0.2);
    expect(merged.reasoningEffort).toBe("low");
    expect(merged.workerName).toBe("לוסי");
    expect(merged.workerProtected).toBe(true);
    expect(merged.employeeId).toBeNull();
    expect(merged.instructionsFile).toBeNull();
    expect(merged.digitalEmployee.name).toBe("לוסי");
    expect(merged.digitalEmployee.instructionsSource).toBe(prompt.promptSource);
    expect(merged.digitalEmployee.id).toBe("eval-lucy-1");
    expect(merged.digitalEmployee.kind).toBe("fixture");
    expect(merged.productionApply).toBe(false);
    expect(merged.speakerIdentity.employeeId).toBe("eval-human-1");
  });

  it("does not treat promptHash as final-instructions identity", () => {
    const merged = mergeStudioEvalPromptProvenance(
      baseProvenance({ promptHash: "legacyonly123456" }),
      samplePrompt({ instructionsSha256: "f".repeat(64) }),
    );
    expect(merged.promptHash).toBe("legacyonly123456");
    expect(merged.instructionsSha256).toBe("f".repeat(64));
    expect(merged.promptHash).not.toBe(merged.instructionsSha256.slice(0, 16));
  });

  it("round-trips employeeId and instructionsFile when provided", () => {
    const merged = mergeStudioEvalPromptProvenance(
      baseProvenance(),
      samplePrompt({
        promptSource: "employee:00000000-0000-4000-8000-000000000001",
        employeeId: "00000000-0000-4000-8000-000000000001",
        workerName: "Lucy2",
        workerProtected: false,
        envelopeMode: "thin_custom",
        attachLucyRuntimeEngine: false,
        instructionsFile: null,
      }),
    );
    expect(merged.employeeId).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(merged.digitalEmployee.kind).toBe("product");
    expect(merged.digitalEmployee.id).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(merged.workerProtected).toBe(false);
    expect(merged.envelopeMode).toBe("thin_custom");

    const withFile = mergeStudioEvalPromptProvenance(
      baseProvenance(),
      samplePrompt({
        promptSource: "file:/tmp/custom.txt",
        instructionsFile: "/tmp/custom.txt",
        employeeId: null,
      }),
    );
    expect(withFile.instructionsFile).toBe("/tmp/custom.txt");
    expect(withFile.employeeId).toBeNull();
    expect(withFile.digitalEmployee.kind).toBe("fixture");
  });

  it("omits reasoningEffort key when undefined on prompt", () => {
    const prompt = samplePrompt();
    delete (prompt as { reasoningEffort?: string }).reasoningEffort;
    const merged = mergeStudioEvalPromptProvenance(baseProvenance(), prompt);
    expect("reasoningEffort" in merged).toBe(false);
  });

  it("JSON serialization keeps new fields (writeRun disk shape)", () => {
    const merged = mergeStudioEvalPromptProvenance(
      baseProvenance(),
      samplePrompt(),
    );
    const roundTrip = JSON.parse(JSON.stringify(merged)) as StudioRunProvenance;
    expect(roundTrip.promptHash).toBe("deadbeefcafebabe");
    expect(roundTrip.instructionsSha256).toBe("a".repeat(64));
    expect(roundTrip.envelopeMode).toBe("lucy_eval");
    expect(roundTrip.model).toBe("gpt-test");
    expect(roundTrip.workerProtected).toBe(true);
    expect(roundTrip.employeeId).toBeNull();
  });

  it("old records without instructionsSha256 remain valid shapes", () => {
    const old = baseProvenance();
    expect(old.instructionsSha256).toBeUndefined();
    const serialized = JSON.parse(JSON.stringify(old)) as StudioRunProvenance;
    expect(serialized.promptSource).toBeTruthy();
    expect(serialized.promptHash).toBe("deadbeefcafebabe");
    expect(serialized.instructionsSha256).toBeUndefined();
  });
});
