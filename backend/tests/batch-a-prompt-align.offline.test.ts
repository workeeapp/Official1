/**
 * Batch A default instructions ↔ LIVE_FULL fixture parity (offline).
 * No OpenAI, Prisma queries, WhatsApp, or reminder fire.
 * Scoring path (stubs) is unchanged; this covers fingerprints / instructions only.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLucyModelEvalInstructions } from "../src/services/chat.service.js";
import {
  buildDefaultEvalFixtures,
  resolveEvalPrompt,
} from "../src/eval/eval-prompt-source.js";
import {
  buildBatchAFingerprint,
  buildBatchAThinInstructions,
} from "../src/eval/run-batch-a.js";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

const ENV_KEYS = [
  "WORKEE_EVAL_PROMPT_SOURCE",
  "WORKEE_EVAL_INSTRUCTIONS_FILE",
  "WORKEE_EVAL_DIGITAL_EMPLOYEE_ID",
  "WORKEE_EVAL_WORKER_PROTECTED",
] as const;

describe("Batch A prompt align to LIVE_FULL fixtures (offline)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const prev = saved[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  it("fixtures exclude מיכל employee (LIVE_FULL shape, not LIVE_MODEL)", () => {
    const fixtures = buildDefaultEvalFixtures("טל", { includeMichal: false });
    expect(fixtures.employees.map((e) => e.name)).toEqual([
      "טל",
      "לוסי",
      "עמית",
    ]);
    // Known-employees line must not list מיכל (config prose may still mention her).
    const instructions = buildBatchAThinInstructions("טל");
    const knownLine = instructions
      .split("\n")
      .find((line) => line.startsWith("Known employees:"));
    expect(knownLine).toBeTruthy();
    expect(knownLine).not.toMatch(/מיכל/);
    expect(knownLine).toMatch(/טל/);
    expect(knownLine).toMatch(/עמית/);
  });

  it("matches shared LIVE_FULL default instructions byte-for-byte", () => {
    const speaker = "טל";
    const batch = buildBatchAThinInstructions(speaker);
    const { employees, worker } = buildDefaultEvalFixtures(speaker, {
      includeMichal: false,
    });
    const liveFullStyle = buildLucyModelEvalInstructions({
      employees,
      speaker,
      worker,
    });
    expect(batch).toBe(liveFullStyle);
    expect(sha256Hex(batch)).toBe(sha256Hex(liveFullStyle));
  });

  it("matches resolveEvalPrompt config path with includeMichal:false", async () => {
    delete process.env.WORKEE_EVAL_PROMPT_SOURCE;
    const batch = buildBatchAThinInstructions("טל");
    const resolved = await resolveEvalPrompt({
      speaker: "טל",
      includeMichal: false,
    });
    expect(resolved.kind).toBe("config");
    expect(resolved.instructions).toBe(batch);
    expect(resolved.instructionsSha256).toBe(sha256Hex(batch));
  });

  it("differs from LIVE_MODEL default (includeMichal:true)", async () => {
    delete process.env.WORKEE_EVAL_PROMPT_SOURCE;
    const batch = buildBatchAThinInstructions("טל");
    const liveModel = await resolveEvalPrompt({
      speaker: "טל",
      includeMichal: true,
    });
    expect(liveModel.instructions).not.toBe(batch);
    const knownLive = liveModel.instructions
      .split("\n")
      .find((line) => line.startsWith("Known employees:"));
    expect(knownLive).toMatch(/מיכל/);
  });

  it("WORKEE_EVAL_PROMPT_SOURCE=file does not change Batch A instructions", () => {
    const before = buildBatchAThinInstructions("טל");
    process.env.WORKEE_EVAL_PROMPT_SOURCE = "file";
    process.env.WORKEE_EVAL_INSTRUCTIONS_FILE =
      "C:\\nonexistent\\batch-a-must-ignore.txt";
    const after = buildBatchAThinInstructions("טל");
    expect(after).toBe(before);
    expect(sha256Hex(after)).toBe(sha256Hex(before));
  });

  it("WORKEE_EVAL_PROMPT_SOURCE=employee does not change Batch A instructions", () => {
    const before = buildBatchAThinInstructions("טל");
    process.env.WORKEE_EVAL_PROMPT_SOURCE = "employee";
    process.env.WORKEE_EVAL_DIGITAL_EMPLOYEE_ID =
      "00000000-0000-4000-8000-000000000099";
    const after = buildBatchAThinInstructions("טל");
    expect(after).toBe(before);
  });

  it("fingerprint instructionsSha256 stays tied to thin Batch A string", () => {
    const instructions = buildBatchAThinInstructions("טל");
    const fp = buildBatchAFingerprint({
      now: new Date("2026-10-22T00:00:00.000Z"),
    });
    expect(fp.evalPath).toBe("thin");
    expect(fp.productionParity).toBe(false);
    expect(fp.instructionsSha256).toBe(sha256Hex(instructions));
  });
});
