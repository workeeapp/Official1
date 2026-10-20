import {
  parseLlmReply,
  parseReplyMetadata,
  type PublicEmployee,
} from "@workee/shared";
import { loadLlmConfig } from "../config/llm.js";
import { formatSpeakerContacts } from "../services/contact.service.js";
import { buildLucyModelEvalInstructions } from "../services/chat.service.js";
import { formatEmployeeContext } from "../services/employee-records.service.js";
import { getLlmClient } from "../services/llm-client.js";
import { formatSessionClockContext } from "../utils/relative-date.js";
import {
  evaluateConstraints,
  type ModelEvalCaseResult,
} from "./constraints.js";
import {
  loadModelEvalCorpus,
  snapshotFromSetup,
  type ModelEvalCorpus,
  type ModelEvalCorpusCase,
} from "./corpus.js";

export interface ModelEvalRunCaseResult extends ModelEvalCaseResult {
  id: string;
  tag: string;
  utterance: string;
  response: string;
  metadata: ReturnType<typeof parseReplyMetadata>;
  rawReply: string;
  llmMs: number;
}

export interface ModelEvalSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  requiredPassRate: number;
  /** Soft corpus gate only (passRate vs requiredPassRate). */
  softOk: boolean;
  /** All criticalCaseIds passed (true when none configured). */
  criticalOk: boolean;
  criticalFailed: string[];
  /** softOk AND criticalOk — suite fails if any critical case fails. */
  ok: boolean;
  results: ModelEvalRunCaseResult[];
}

/** Pure summary helper (offline-testable; no LLM). */
export function summarizeModelEvalResults(
  results: ModelEvalRunCaseResult[],
  options: { requiredPassRate: number; criticalCaseIds?: string[] },
): Omit<ModelEvalSummary, "results"> & { results: ModelEvalRunCaseResult[] } {
  const passed = results.filter((row) => row.ok).length;
  const total = results.length;
  const passRate = total === 0 ? 0 : passed / total;
  const requiredPassRate = options.requiredPassRate;
  const softOk = passRate + 1e-9 >= requiredPassRate;
  // Only gate critical cases that were actually selected/run. A MODEL_EVAL_CASES
  // subset must not fail solely because other critical ids were omitted.
  // Full-suite runs still require every criticalCaseId (all appear in results).
  const byId = new Map(results.map((row) => [row.id, row]));
  const criticalIds = (options.criticalCaseIds ?? []).filter((id) =>
    byId.has(id),
  );
  const criticalFailed = criticalIds.filter((id) => !byId.get(id)!.ok);
  const criticalOk = criticalFailed.length === 0;
  return {
    total,
    passed,
    failed: total - passed,
    passRate,
    requiredPassRate,
    softOk,
    criticalOk,
    criticalFailed,
    ok: softOk && criticalOk,
    results,
  };
}

function fixtureEmployees(speaker: string): {
  employees: PublicEmployee[];
  worker: PublicEmployee;
  human: PublicEmployee;
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
  return { employees: [human, worker, coworker], worker, human };
}

export async function runModelEvalCase(
  corpusCase: ModelEvalCorpusCase,
  options?: { speaker?: string },
): Promise<ModelEvalRunCaseResult> {
  const speaker = options?.speaker ?? "טל";
  const { employees, worker } = fixtureEmployees(speaker);
  const config = loadLlmConfig();
  const instructions = buildLucyModelEvalInstructions({
    employees,
    speaker,
    worker,
  });
  const snapshot = snapshotFromSetup(corpusCase.setup, speaker);
  const contacts = (corpusCase.setup.contacts ?? []).map((row, index) => ({
    id: `contact-${index}`,
    name: row.name,
    phone: row.phone,
    kind: "person",
  }));
  const message = [
    formatSessionClockContext(),
    formatEmployeeContext(snapshot),
    formatEmployeeContext(
      { lists: [], filing: [], reminders: [] },
      "WORKER_SAVED_DATA",
    ),
    formatSpeakerContacts(contacts),
    `${speaker}: ${corpusCase.utterance}`,
  ].join("\n\n");

  const client = getLlmClient();
  const conversationId = await client.createConversation();
  const llmStarted = Date.now();
  const turn = await client.createResponse({
    conversationId,
    message,
    model: worker.model?.trim() || config.model,
    temperature:
      typeof worker.temperature === "number" && Number.isFinite(worker.temperature)
        ? worker.temperature
        : config.temperature,
    reasoningEffort: config.reasoningEffort,
    instructions,
    textFormat: config.responseFormat,
  });
  const llmMs = Date.now() - llmStarted;
  const parsed = parseLlmReply(turn.reply);
  const metadata = parseReplyMetadata(turn.reply);
  const checked = evaluateConstraints(
    corpusCase.constraints,
    metadata,
    parsed.response,
  );

  return {
    id: corpusCase.id,
    tag: corpusCase.tag,
    utterance: corpusCase.utterance,
    response: parsed.response,
    metadata,
    rawReply: turn.reply,
    llmMs,
    ...checked,
  };
}

export async function runModelEvalCorpus(
  corpus: ModelEvalCorpus = loadModelEvalCorpus(),
  options?: { caseIds?: string[] },
): Promise<ModelEvalSummary> {
  const selected = options?.caseIds?.length
    ? corpus.cases.filter((row) => options.caseIds!.includes(row.id))
    : corpus.cases;
  const results: ModelEvalRunCaseResult[] = [];
  for (const row of selected) {
    results.push(await runModelEvalCase(row, { speaker: corpus.speaker }));
  }
  return summarizeModelEvalResults(results, {
    requiredPassRate: corpus.passRate,
    criticalCaseIds: corpus.criticalCaseIds,
  });
}
