/**
 * Evaluation-only prompt source resolution.
 *
 * Sources (env WORKEE_EVAL_PROMPT_SOURCE):
 * - unset / "config" — current LIVE default (fixture worker instructions=null → file via buildLucyModelEvalInstructions)
 * - "file" — WORKEE_EVAL_INSTRUCTIONS_FILE into an in-memory worker fixture
 * - "employee" — digital row on approved workee_test only
 *
 * Envelope: shouldAttachLucyRuntimeEngine (same rules as Chat). Not inferred from "file".
 * Intentional eval difference when attach=true: uses buildLucyModelEvalInstructions
 * (existing thin Lucy eval stack), not the full Chat attachLucyEngine catalog.
 *
 * Employee path: assertApprovedEvalDatabaseUrl BEFORE any Prisma module import.
 * This module must not statically import chat.service or prisma (both load PrismaClient).
 * WORKEE_EVAL_WORKER_PROTECTED only flips the in-memory fixture; never writes Employees.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PublicEmployee, ReasoningEffort } from "@workee/shared";
import { loadLlmConfig } from "../config/llm.js";
import { assertApprovedEvalDatabaseUrl } from "./studio-db-guard.js";

export type EvalPromptSourceKind = "config" | "file" | "employee";
export type EvalEnvelopeMode = "lucy_eval" | "thin_custom";

export interface ResolvedEvalPrompt {
  kind: EvalPromptSourceKind;
  promptSource: string;
  instructions: string;
  instructionsSha256: string;
  envelopeMode: EvalEnvelopeMode;
  attachLucyRuntimeEngine: boolean;
  model: string;
  temperature: number;
  reasoningEffort: ReasoningEffort | undefined;
  workerName: string;
  workerProtected: boolean;
  employeeId: string | null;
  instructionsFile: string | null;
  worker: PublicEmployee;
  employees: PublicEmployee[];
}

type ChatEvalHelpers = {
  buildLucyModelEvalInstructions: (input: {
    employees: PublicEmployee[];
    speaker: string;
    worker: PublicEmployee;
  }) => string;
  RESPONSES_RULE: string;
  shouldAttachLucyRuntimeEngine: (
    digital: PublicEmployee,
    employees: PublicEmployee[],
    fileSystemMessage: string,
  ) => boolean;
  thinSessionEnvelope: (input: {
    employees: PublicEmployee[];
    speaker: string;
    worker: PublicEmployee;
    speakerIsOwner: boolean;
  }) => string;
};

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function loadChatEvalHelpers(): Promise<ChatEvalHelpers> {
  const mod = await import("../services/chat.service.js");
  return {
    buildLucyModelEvalInstructions: mod.buildLucyModelEvalInstructions,
    RESPONSES_RULE: mod.RESPONSES_RULE,
    shouldAttachLucyRuntimeEngine: mod.shouldAttachLucyRuntimeEngine,
    thinSessionEnvelope: mod.thinSessionEnvelope,
  };
}

/**
 * Fixture set for LIVE_MODEL / LIVE_MODEL_MT (includes מיכל).
 * LIVE_FULL historically omitted מיכל — pass includeMichal: false.
 */
export function buildDefaultEvalFixtures(
  speaker: string,
  options?: { includeMichal?: boolean },
): {
  employees: PublicEmployee[];
  worker: PublicEmployee;
  human: PublicEmployee;
} {
  const includeMichal = options?.includeMichal !== false;
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
  const employees: PublicEmployee[] = [human, worker, coworker];
  if (includeMichal) {
    employees.push({
      id: "eval-human-3",
      kind: "human",
      name: "מיכל",
      surname: "",
      nickname: "מיכל",
      email: null,
      phone: null,
      isOwner: false,
    });
  }
  return { employees, worker, human };
}

function readPromptSourceKind(): EvalPromptSourceKind {
  const raw = (process.env.WORKEE_EVAL_PROMPT_SOURCE ?? "").trim().toLowerCase();
  if (!raw || raw === "config") {
    return "config";
  }
  if (raw === "file" || raw === "employee") {
    return raw;
  }
  throw new Error(
    `WORKEE_EVAL_PROMPT_SOURCE must be unset, config, file, or employee (got ${JSON.stringify(raw)})`,
  );
}

function modelSettingsForWorker(worker: PublicEmployee): {
  model: string;
  temperature: number;
  reasoningEffort: ReasoningEffort | undefined;
} {
  const config = loadLlmConfig();
  return {
    model: worker.model?.trim() || config.model,
    temperature:
      typeof worker.temperature === "number" &&
      Number.isFinite(worker.temperature)
        ? worker.temperature
        : config.temperature,
    reasoningEffort: worker.reasoningEffort ?? config.reasoningEffort,
  };
}

function composeInstructions(
  helpers: ChatEvalHelpers,
  input: {
    employees: PublicEmployee[];
    speaker: string;
    worker: PublicEmployee;
    speakerIsOwner: boolean;
  },
): {
  instructions: string;
  envelopeMode: EvalEnvelopeMode;
  attachLucyRuntimeEngine: boolean;
} {
  const fileSystemMessage = loadLlmConfig().systemMessage;
  const attach = helpers.shouldAttachLucyRuntimeEngine(
    input.worker,
    input.employees,
    fileSystemMessage,
  );
  if (attach) {
    return {
      instructions: helpers.buildLucyModelEvalInstructions({
        employees: input.employees,
        speaker: input.speaker,
        worker: input.worker,
      }),
      envelopeMode: "lucy_eval",
      attachLucyRuntimeEngine: true,
    };
  }
  const systemMessage =
    input.worker.instructions?.trim() || fileSystemMessage;
  const instructions = [
    systemMessage,
    helpers.RESPONSES_RULE,
    helpers.thinSessionEnvelope({
      employees: input.employees,
      speaker: input.speaker,
      worker: input.worker,
      speakerIsOwner: input.speakerIsOwner,
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    instructions,
    envelopeMode: "thin_custom",
    attachLucyRuntimeEngine: false,
  };
}

function finishResolved(
  helpers: ChatEvalHelpers,
  input: {
    kind: EvalPromptSourceKind;
    promptSource: string;
    employees: PublicEmployee[];
    worker: PublicEmployee;
    speaker: string;
    speakerIsOwner: boolean;
    employeeId: string | null;
    instructionsFile: string | null;
  },
): ResolvedEvalPrompt {
  const composed = composeInstructions(helpers, {
    employees: input.employees,
    speaker: input.speaker,
    worker: input.worker,
    speakerIsOwner: input.speakerIsOwner,
  });
  const settings = modelSettingsForWorker(input.worker);
  return {
    kind: input.kind,
    promptSource: input.promptSource,
    instructions: composed.instructions,
    instructionsSha256: sha256Hex(composed.instructions),
    envelopeMode: composed.envelopeMode,
    attachLucyRuntimeEngine: composed.attachLucyRuntimeEngine,
    model: settings.model,
    temperature: settings.temperature,
    reasoningEffort: settings.reasoningEffort,
    workerName: input.worker.nickname?.trim() || input.worker.name,
    workerProtected: input.worker.protected === true,
    employeeId: input.employeeId,
    instructionsFile: input.instructionsFile,
    worker: input.worker,
    employees: input.employees,
  };
}

function loadFileWorker(base: PublicEmployee): {
  worker: PublicEmployee;
  path: string;
} {
  const fileEnv = process.env.WORKEE_EVAL_INSTRUCTIONS_FILE?.trim();
  if (!fileEnv) {
    throw new Error(
      "WORKEE_EVAL_PROMPT_SOURCE=file requires WORKEE_EVAL_INSTRUCTIONS_FILE",
    );
  }
  const path = resolve(fileEnv);
  const text = readFileSync(path, "utf8");
  if (!text.trim()) {
    throw new Error(`instructions file is empty: ${path}`);
  }
  // In-memory fixture only — never writes Employees / protected production rows.
  const protectedFlag = process.env.WORKEE_EVAL_WORKER_PROTECTED === "1";
  const name =
    process.env.WORKEE_EVAL_WORKER_NAME?.trim() || "eval-worker";
  return {
    path,
    worker: {
      ...base,
      id: "eval-file-worker",
      name,
      nickname: name,
      protected: protectedFlag,
      instructions: text.replace(/\r\n/g, "\n"),
      model: null,
      temperature: null,
      reasoningEffort: null,
    },
  };
}

async function loadEmployeeWorker(base: PublicEmployee): Promise<{
  worker: PublicEmployee;
  employeeId: string;
}> {
  const employeeId = process.env.WORKEE_EVAL_DIGITAL_EMPLOYEE_ID?.trim();
  if (!employeeId) {
    throw new Error(
      "WORKEE_EVAL_PROMPT_SOURCE=employee requires WORKEE_EVAL_DIGITAL_EMPLOYEE_ID",
    );
  }

  // Fail closed BEFORE any Prisma module initialization/import.
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);

  const { prisma } = await import("../database/prisma.js");
  const row = await prisma.employee.findFirst({
    where: { id: employeeId, kind: "digital" },
    select: {
      id: true,
      name: true,
      nickname: true,
      isProtected: true,
      model: true,
      temperature: true,
      reasoningEffort: true,
      instructions: true,
    },
  });
  if (!row) {
    throw new Error(
      `eval digital employee not found or not digital: ${employeeId}`,
    );
  }
  const instructions = row.instructions?.trim() ?? "";
  if (!instructions) {
    throw new Error(
      `eval digital employee has empty instructions: ${employeeId}`,
    );
  }
  return {
    employeeId: row.id,
    worker: {
      ...base,
      id: row.id,
      name: row.name,
      nickname: row.nickname?.trim() || row.name,
      protected: row.isProtected === true,
      model: row.model,
      temperature: row.temperature,
      reasoningEffort: (row.reasoningEffort as ReasoningEffort | null) ?? null,
      instructions: instructions.replace(/\r\n/g, "\n"),
    },
  };
}

/**
 * Resolve evaluation instructions + model settings from env.
 * Safe for offline config/file paths (no Prisma import until chat helpers load).
 * Employee path gates DB approval before any Prisma module import.
 */
export async function resolveEvalPrompt(input?: {
  speaker?: string;
  /** LIVE_MODEL default includes מיכל; LIVE_FULL historically did not. */
  includeMichal?: boolean;
}): Promise<ResolvedEvalPrompt> {
  const speaker = input?.speaker ?? "טל";
  const kind = readPromptSourceKind();
  const fixtures = buildDefaultEvalFixtures(speaker, {
    includeMichal: input?.includeMichal,
  });
  const speakerIsOwner = fixtures.human.isOwner === true;

  if (kind === "employee") {
    // Assert + load row before chat.service (which eagerly imports prisma).
    const { worker, employeeId } = await loadEmployeeWorker(fixtures.worker);
    const employees = fixtures.employees.map((row) =>
      row.id === fixtures.worker.id ? worker : row,
    );
    const helpers = await loadChatEvalHelpers();
    return finishResolved(helpers, {
      kind: "employee",
      promptSource: `employee:${employeeId}`,
      employees,
      worker,
      speaker,
      speakerIsOwner,
      employeeId,
      instructionsFile: null,
    });
  }

  const helpers = await loadChatEvalHelpers();

  if (kind === "file") {
    const { worker, path } = loadFileWorker(fixtures.worker);
    const employees = fixtures.employees.map((row) =>
      row.id === fixtures.worker.id ? worker : row,
    );
    return finishResolved(helpers, {
      kind: "file",
      promptSource: `file:${path}`,
      employees,
      worker,
      speaker,
      speakerIsOwner,
      employeeId: null,
      instructionsFile: path,
    });
  }

  return finishResolved(helpers, {
    kind: "config",
    promptSource: "config:LLM.config.json+buildLucyModelEvalInstructions",
    employees: fixtures.employees,
    worker: fixtures.worker,
    speaker,
    speakerIsOwner,
    employeeId: null,
    instructionsFile: null,
  });
}

/** Compact provenance for LIVE JSON / human reports (no full instructions). */
export function evalPromptProvenance(resolved: ResolvedEvalPrompt): {
  promptSource: string;
  instructionsSha256: string;
  envelopeMode: EvalEnvelopeMode;
  attachLucyRuntimeEngine: boolean;
  model: string;
  temperature: number;
  reasoningEffort: ReasoningEffort | undefined;
  workerName: string;
  workerProtected: boolean;
  employeeId: string | null;
  instructionsFile: string | null;
} {
  return {
    promptSource: resolved.promptSource,
    instructionsSha256: resolved.instructionsSha256,
    envelopeMode: resolved.envelopeMode,
    attachLucyRuntimeEngine: resolved.attachLucyRuntimeEngine,
    model: resolved.model,
    temperature: resolved.temperature,
    reasoningEffort: resolved.reasoningEffort,
    workerName: resolved.workerName,
    workerProtected: resolved.workerProtected,
    employeeId: resolved.employeeId,
    instructionsFile: resolved.instructionsFile,
  };
}
