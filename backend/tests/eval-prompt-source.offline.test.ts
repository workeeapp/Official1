/**
 * Offline unit coverage for eval-only prompt-source resolution.
 *
 * Safety: no OpenAI, no WhatsApp, no reminder fire, no employee DB success path.
 * Employee cases are fail-closed only (assert before prisma import).
 * Config/file paths may construct PrismaClient via chat.service import but never query.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicEmployee } from "@workee/shared";
import { loadLlmConfig } from "../src/config/llm.js";
import {
  buildEvalUiReport,
  formatEvalUiReportMarkdown,
} from "../src/eval/human-report.js";

const ENV_KEYS = [
  "WORKEE_EVAL_PROMPT_SOURCE",
  "WORKEE_EVAL_INSTRUCTIONS_FILE",
  "WORKEE_EVAL_WORKER_NAME",
  "WORKEE_EVAL_WORKER_PROTECTED",
  "WORKEE_EVAL_DIGITAL_EMPLOYEE_ID",
  "DATABASE_URL",
  "WORKEE_APPROVED_TEST_DATABASE_URL",
] as const;

/**
 * Independent pre-change LIVE_MODEL fixtures (copy of historical run-case shape).
 * Must NOT import or call buildDefaultEvalFixtures from eval-prompt-source —
 * shared fixture drift must be able to fail the golden.
 */
function independentLiveModelFixtures(speaker: string): {
  employees: PublicEmployee[];
  worker: PublicEmployee;
} {
  const human: PublicEmployee = {
    id: "eval-human-1",
    kind: "human",
    name: speaker,
    surname: "",
    nickname: speaker,
    email: null,
    phone: null,
    isOwner: true,
  };
  const worker: PublicEmployee = {
    id: "eval-lucy-1",
    kind: "digital",
    name: "לוסי",
    surname: "",
    nickname: "לוסי",
    email: null,
    phone: null,
    protected: true,
    model: null,
    temperature: null,
    instructions: null,
  };
  const coworker: PublicEmployee = {
    id: "eval-human-2",
    kind: "human",
    name: "עמית",
    surname: "",
    nickname: "עמית",
    email: null,
    phone: null,
    isOwner: false,
  };
  const michal: PublicEmployee = {
    id: "eval-human-3",
    kind: "human",
    name: "מיכל",
    surname: "",
    nickname: "מיכל",
    email: null,
    phone: null,
    isOwner: false,
  };
  return { employees: [human, worker, coworker, michal], worker };
}

/** Historical LIVE_FULL fixture set (no מיכל). */
function independentLiveFullFixtures(speaker: string): {
  employees: PublicEmployee[];
  worker: PublicEmployee;
} {
  const { employees, worker } = independentLiveModelFixtures(speaker);
  return {
    worker,
    employees: employees.filter((row) => row.name !== "מיכל"),
  };
}

async function independentConfigBaseline(input: {
  speaker: string;
  includeMichal: boolean;
}): Promise<{
  instructions: string;
  instructionsSha256: string;
  model: string;
  temperature: number;
  reasoningEffort: ReturnType<typeof loadLlmConfig>["reasoningEffort"];
}> {
  const fixtures = input.includeMichal
    ? independentLiveModelFixtures(input.speaker)
    : independentLiveFullFixtures(input.speaker);
  const config = loadLlmConfig();
  // Direct chat helper — not resolveEvalPrompt / composeInstructions / buildDefaultEvalFixtures.
  const { buildLucyModelEvalInstructions } = await import(
    "../src/services/chat.service.js"
  );
  const instructions = buildLucyModelEvalInstructions({
    employees: fixtures.employees,
    speaker: input.speaker,
    worker: fixtures.worker,
  });
  return {
    instructions,
    instructionsSha256: sha256Of(instructions),
    model: fixtures.worker.model?.trim() || config.model,
    temperature:
      typeof fixtures.worker.temperature === "number" &&
      Number.isFinite(fixtures.worker.temperature)
        ? fixtures.worker.temperature
        : config.temperature,
    reasoningEffort: config.reasoningEffort,
  };
}

function sha256Of(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

describe("eval-prompt-source (offline)", () => {
  const saved: Record<string, string | undefined> = {};
  let tempDirs: string[] = [];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
    delete process.env.WORKEE_EVAL_PROMPT_SOURCE;
    delete process.env.WORKEE_EVAL_INSTRUCTIONS_FILE;
    delete process.env.WORKEE_EVAL_WORKER_NAME;
    delete process.env.WORKEE_EVAL_WORKER_PROTECTED;
    delete process.env.WORKEE_EVAL_DIGITAL_EMPLOYEE_ID;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const prev = saved[key];
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs = [];
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function writeTempInstructions(text: string): string {
    const dir = mkdtempSync(join(tmpdir(), "workee-eval-prompt-"));
    tempDirs.push(dir);
    const path = join(dir, "instructions.txt");
    writeFileSync(path, text, "utf8");
    return path;
  }

  it("default/config matches independent pre-change golden (not resolver fixtures)", async () => {
    const baseline = await independentConfigBaseline({
      speaker: "טל",
      includeMichal: true,
    });

    const { resolveEvalPrompt } = await import(
      "../src/eval/eval-prompt-source.js"
    );
    delete process.env.WORKEE_EVAL_PROMPT_SOURCE;
    const resolved = await resolveEvalPrompt({
      speaker: "טל",
      includeMichal: true,
    });

    expect(resolved.kind).toBe("config");
    expect(resolved.envelopeMode).toBe("lucy_eval");
    expect(resolved.attachLucyRuntimeEngine).toBe(true);
    expect(resolved.instructions).toBe(baseline.instructions);
    expect(resolved.instructionsSha256).toBe(baseline.instructionsSha256);
    expect(resolved.model).toBe(baseline.model);
    expect(resolved.temperature).toBe(baseline.temperature);
    expect(resolved.reasoningEffort).toBe(baseline.reasoningEffort);
    expect(resolved.workerProtected).toBe(true);
    expect(resolved.employeeId).toBeNull();
  });

  it("explicit WORKEE_EVAL_PROMPT_SOURCE=config matches the same independent golden", async () => {
    const baseline = await independentConfigBaseline({
      speaker: "טל",
      includeMichal: true,
    });
    process.env.WORKEE_EVAL_PROMPT_SOURCE = "config";
    const { resolveEvalPrompt } = await import(
      "../src/eval/eval-prompt-source.js"
    );
    const resolved = await resolveEvalPrompt({
      speaker: "טל",
      includeMichal: true,
    });
    expect(resolved.kind).toBe("config");
    expect(resolved.instructionsSha256).toBe(baseline.instructionsSha256);
  });

  it("includeMichal:false matches independent LIVE_FULL golden", async () => {
    const baseline = await independentConfigBaseline({
      speaker: "טל",
      includeMichal: false,
    });
    const { resolveEvalPrompt } = await import(
      "../src/eval/eval-prompt-source.js"
    );
    const resolved = await resolveEvalPrompt({
      speaker: "טל",
      includeMichal: false,
    });
    expect(resolved.instructionsSha256).toBe(baseline.instructionsSha256);
    expect(resolved.employees.some((e) => e.name === "מיכל")).toBe(false);
  });

  it("custom file → thin_custom (not inferred from file env alone)", async () => {
    const path = writeTempInstructions(
      "CUSTOM_EVAL_ONLY_PROMPT — not Lucy catalog.\n",
    );
    process.env.WORKEE_EVAL_PROMPT_SOURCE = "file";
    process.env.WORKEE_EVAL_INSTRUCTIONS_FILE = path;
    delete process.env.WORKEE_EVAL_WORKER_PROTECTED;

    const { resolveEvalPrompt } = await import(
      "../src/eval/eval-prompt-source.js"
    );
    const resolved = await resolveEvalPrompt({ speaker: "טל" });

    expect(resolved.kind).toBe("file");
    expect(resolved.envelopeMode).toBe("thin_custom");
    expect(resolved.attachLucyRuntimeEngine).toBe(false);
    expect(resolved.instructions).toContain("CUSTOM_EVAL_ONLY_PROMPT");
    expect(resolved.instructions).toContain("OUTPUT: your spoken reply");
    expect(resolved.instructions).toContain("Current speaker: טל");
    expect(resolved.workerProtected).toBe(false);
    expect(resolved.instructionsFile).toBe(path);
    expect(sha256Of(resolved.instructions)).toBe(resolved.instructionsSha256);
  });

  it("file equal to LLM.config systemMessage → lucy_eval", async () => {
    const base = loadLlmConfig().systemMessage;
    const path = writeTempInstructions(base);
    process.env.WORKEE_EVAL_PROMPT_SOURCE = "file";
    process.env.WORKEE_EVAL_INSTRUCTIONS_FILE = path;
    delete process.env.WORKEE_EVAL_WORKER_PROTECTED;

    const { resolveEvalPrompt } = await import(
      "../src/eval/eval-prompt-source.js"
    );
    const resolved = await resolveEvalPrompt({ speaker: "טל" });

    expect(resolved.envelopeMode).toBe("lucy_eval");
    expect(resolved.attachLucyRuntimeEngine).toBe(true);
    expect(resolved.kind).toBe("file");
  });

  it("WORKEE_EVAL_WORKER_PROTECTED=1 forces lucy_eval on custom file (in-memory only)", async () => {
    const path = writeTempInstructions("PROTECTED_CUSTOM_FILE_PROMPT\n");
    process.env.WORKEE_EVAL_PROMPT_SOURCE = "file";
    process.env.WORKEE_EVAL_INSTRUCTIONS_FILE = path;
    process.env.WORKEE_EVAL_WORKER_PROTECTED = "1";
    process.env.WORKEE_EVAL_WORKER_NAME = "eval-protected-worker";

    const { resolveEvalPrompt } = await import(
      "../src/eval/eval-prompt-source.js"
    );
    const resolved = await resolveEvalPrompt({ speaker: "טל" });

    expect(resolved.workerProtected).toBe(true);
    expect(resolved.workerName).toBe("eval-protected-worker");
    expect(resolved.envelopeMode).toBe("lucy_eval");
    expect(resolved.attachLucyRuntimeEngine).toBe(true);
    expect(resolved.worker.id).toBe("eval-file-worker");
    expect(resolved.employeeId).toBeNull();
  });

  it("file source requires WORKEE_EVAL_INSTRUCTIONS_FILE", async () => {
    process.env.WORKEE_EVAL_PROMPT_SOURCE = "file";
    delete process.env.WORKEE_EVAL_INSTRUCTIONS_FILE;
    const { resolveEvalPrompt } = await import(
      "../src/eval/eval-prompt-source.js"
    );
    await expect(resolveEvalPrompt({ speaker: "טל" })).rejects.toThrow(
      /WORKEE_EVAL_INSTRUCTIONS_FILE/,
    );
  });

  it("file source rejects empty instructions file", async () => {
    const path = writeTempInstructions("   \n\t  ");
    process.env.WORKEE_EVAL_PROMPT_SOURCE = "file";
    process.env.WORKEE_EVAL_INSTRUCTIONS_FILE = path;
    const { resolveEvalPrompt } = await import(
      "../src/eval/eval-prompt-source.js"
    );
    await expect(resolveEvalPrompt({ speaker: "טל" })).rejects.toThrow(
      /instructions file is empty/,
    );
  });

  it("rejects invalid WORKEE_EVAL_PROMPT_SOURCE", async () => {
    process.env.WORKEE_EVAL_PROMPT_SOURCE = "lucy2";
    const { resolveEvalPrompt } = await import(
      "../src/eval/eval-prompt-source.js"
    );
    await expect(resolveEvalPrompt({ speaker: "טל" })).rejects.toThrow(
      /WORKEE_EVAL_PROMPT_SOURCE must be unset, config, file, or employee/,
    );
  });

  it("employee source requires WORKEE_EVAL_DIGITAL_EMPLOYEE_ID before DB gate", async () => {
    await vi.resetModules();
    process.env.WORKEE_EVAL_PROMPT_SOURCE = "employee";
    delete process.env.WORKEE_EVAL_DIGITAL_EMPLOYEE_ID;
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL =
      "postgresql://workee:workee@127.0.0.1:5432/workee_eval_isolated";
    process.env.DATABASE_URL =
      "postgresql://workee:workee@127.0.0.1:5432/workee_eval_isolated";

    let prismaModuleLoaded = false;
    vi.doMock("../src/database/prisma.js", () => {
      prismaModuleLoaded = true;
      return { prisma: { employee: { findFirst: vi.fn() } } };
    });

    const { resolveEvalPrompt } = await import(
      "../src/eval/eval-prompt-source.js"
    );
    await expect(resolveEvalPrompt({ speaker: "טל" })).rejects.toThrow(
      /WORKEE_EVAL_DIGITAL_EMPLOYEE_ID/,
    );
    expect(prismaModuleLoaded).toBe(false);
  });

  async function expectEmployeeRefuseBeforePrisma(setup: () => void) {
    await vi.resetModules();
    setup();

    let prismaModuleLoaded = false;
    vi.doMock("../src/database/prisma.js", () => {
      prismaModuleLoaded = true;
      return {
        prisma: {
          employee: {
            findFirst: vi.fn(async () => {
              throw new Error("prisma must not be queried");
            }),
          },
        },
      };
    });

    const { resolveEvalPrompt } = await import(
      "../src/eval/eval-prompt-source.js"
    );
    const { UnapprovedEvalDatabaseError: GuardError } = await import(
      "../src/eval/studio-db-guard.js"
    );
    await expect(resolveEvalPrompt({ speaker: "טל" })).rejects.toBeInstanceOf(
      GuardError,
    );
    expect(prismaModuleLoaded).toBe(false);

    // Prove the mock is wired: a deliberate import trips the factory.
    await import("../src/database/prisma.js");
    expect(prismaModuleLoaded).toBe(true);
  }

  it("employee source refuses missing approval before prisma import", async () => {
    await expectEmployeeRefuseBeforePrisma(() => {
      process.env.WORKEE_EVAL_PROMPT_SOURCE = "employee";
      process.env.WORKEE_EVAL_DIGITAL_EMPLOYEE_ID =
        "00000000-0000-4000-8000-000000000099";
      delete process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
      process.env.DATABASE_URL =
        "postgresql://workee:workee@127.0.0.1:5432/workee_eval_isolated";
    });
  });

  it("employee source refuses product workee name before prisma import", async () => {
    const product = "postgresql://workee:workee@127.0.0.1:5435/workee";
    await expectEmployeeRefuseBeforePrisma(() => {
      process.env.WORKEE_EVAL_PROMPT_SOURCE = "employee";
      process.env.WORKEE_EVAL_DIGITAL_EMPLOYEE_ID =
        "00000000-0000-4000-8000-000000000099";
      process.env.DATABASE_URL = product;
      process.env.WORKEE_APPROVED_TEST_DATABASE_URL = product;
    });
  });

  it("employee source refuses mismatched DATABASE_URL before prisma import", async () => {
    await expectEmployeeRefuseBeforePrisma(() => {
      process.env.WORKEE_EVAL_PROMPT_SOURCE = "employee";
      process.env.WORKEE_EVAL_DIGITAL_EMPLOYEE_ID =
        "00000000-0000-4000-8000-000000000099";
      process.env.WORKEE_APPROVED_TEST_DATABASE_URL =
        "postgresql://workee:workee@127.0.0.1:5432/workee_eval_isolated";
      process.env.DATABASE_URL =
        "postgresql://workee:workee@127.0.0.1:5432/other_db";
    });
  });

  it("eval-prompt-source module graph does not statically import prisma or chat.service", async () => {
    const srcPath = join(
      import.meta.dirname,
      "../src/eval/eval-prompt-source.ts",
    );
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(srcPath, "utf8");
    expect(src).not.toMatch(
      /import\s+\{[^}]*prisma[^}]*\}\s+from\s+["'].*database\/prisma/,
    );
    expect(src).not.toMatch(
      /import\s+.*from\s+["']\.\.\/services\/chat\.service/,
    );
    expect(src).not.toContain("buildLegacyDefaultEvalInstructions");
    const assertIdx = src.indexOf("assertApprovedEvalDatabaseUrl");
    const prismaImportIdx = src.indexOf(
      'await import("../database/prisma.js")',
    );
    expect(assertIdx).toBeGreaterThan(-1);
    expect(prismaImportIdx).toBeGreaterThan(assertIdx);
  });

  it("evalPromptProvenance propagates into UI JSON and Markdown reports", async () => {
    delete process.env.WORKEE_EVAL_PROMPT_SOURCE;
    const { resolveEvalPrompt, evalPromptProvenance } = await import(
      "../src/eval/eval-prompt-source.js"
    );
    const resolved = await resolveEvalPrompt({
      speaker: "טל",
      includeMichal: true,
    });
    const provenance = evalPromptProvenance(resolved);

    const ui = buildEvalUiReport({
      track: "LIVE_MODEL",
      suite: "provenance-offline",
      promptSource: provenance.promptSource,
      promptProvenance: provenance,
      productionApply: false,
      total: 0,
      passed: 0,
      failed: 0,
      passRate: 0,
      requiredPassRate: 0,
      softOk: true,
      criticalOk: true,
      criticalFailed: [],
      ok: true,
      cases: [],
    });

    expect(ui.version).toBe(1);
    expect(ui.promptSource).toBe(provenance.promptSource);
    expect(ui.instructionsSha256).toBe(provenance.instructionsSha256);
    expect(ui.envelopeMode).toBe(provenance.envelopeMode);
    expect(ui.attachLucyRuntimeEngine).toBe(
      provenance.attachLucyRuntimeEngine,
    );
    expect(ui.model).toBe(provenance.model);
    expect(ui.temperature).toBe(provenance.temperature);
    expect(ui.reasoningEffort).toBe(provenance.reasoningEffort);
    expect(ui.workerName).toBe(provenance.workerName);
    expect(ui.workerProtected).toBe(provenance.workerProtected);
    expect(ui.employeeId).toBeNull();
    expect(ui.instructionsFile).toBeNull();

    const md = formatEvalUiReportMarkdown(ui);
    expect(md).toContain(`**Prompt:** ${provenance.promptSource}`);
    expect(md).toContain(
      `**Instructions SHA-256:** ${provenance.instructionsSha256}`,
    );
    expect(md).toContain(`**Envelope:** ${provenance.envelopeMode}`);
    expect(md).toContain(`**Model:** ${provenance.model}`);
    expect(md).toContain(
      `**Worker:** ${provenance.workerName} (protected=${provenance.workerProtected})`,
    );
  });

  it("file provenance includes instructionsFile in UI JSON and Markdown", async () => {
    const path = writeTempInstructions("FILE_PROVENANCE_PROMPT\n");
    process.env.WORKEE_EVAL_PROMPT_SOURCE = "file";
    process.env.WORKEE_EVAL_INSTRUCTIONS_FILE = path;
    const { resolveEvalPrompt, evalPromptProvenance } = await import(
      "../src/eval/eval-prompt-source.js"
    );
    const provenance = evalPromptProvenance(
      await resolveEvalPrompt({ speaker: "טל" }),
    );
    const ui = buildEvalUiReport({
      track: "LIVE_MODEL",
      suite: "file-provenance",
      promptSource: provenance.promptSource,
      promptProvenance: provenance,
      productionApply: false,
      total: 0,
      passed: 0,
      failed: 0,
      passRate: 0,
      requiredPassRate: 0,
      softOk: true,
      criticalOk: true,
      criticalFailed: [],
      ok: true,
      cases: [],
    });
    expect(ui.instructionsFile).toBe(path);
    expect(formatEvalUiReportMarkdown(ui)).toContain(
      `**Instructions file:** ${path}`,
    );
  });
});
