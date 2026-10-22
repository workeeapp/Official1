import {
  parseLlmReply,
  parseReplyMetadata,
} from "@workee/shared";
import { loadLlmConfig } from "../config/llm.js";
import { formatSpeakerContacts } from "../services/contact.service.js";
import { formatEmployeeContext } from "../services/employee-records.service.js";
import { getLlmClient } from "../services/llm-client.js";
import { formatSessionClockContext } from "../utils/relative-date.js";
import {
  evaluateConstraints,
  type ModelEvalCaseResult,
} from "./constraints.js";
import {
  filterCasesByTags,
  loadModelEvalCorpus,
  loadModelEvalMultiTurnCorpus,
  parseModelEvalTags,
  snapshotFromSetup,
  type ModelEvalCorpus,
  type ModelEvalCorpusCase,
  type ModelEvalMultiTurnCase,
  type ModelEvalMultiTurnCorpus,
} from "./corpus.js";
import {
  evalPromptProvenance,
  resolveEvalPrompt,
  type ResolvedEvalPrompt,
} from "./eval-prompt-source.js";
import { applyLiveModelMetadataToSnapshot } from "./live-model-snapshot-apply.js";
import type { EmployeeRecordSnapshot } from "../services/employee-records.service.js";

export interface ModelEvalRunCaseResult extends ModelEvalCaseResult {
  id: string;
  tag: string;
  utterance: string;
  response: string;
  metadata: ReturnType<typeof parseReplyMetadata>;
  rawReply: string;
  llmMs: number;
  /** Prompt provenance for the createResponse call (same object as hashed). */
  prompt?: ReturnType<typeof evalPromptProvenance>;
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

export async function runModelEvalCase(
  corpusCase: ModelEvalCorpusCase,
  options?: { speaker?: string; prompt?: ResolvedEvalPrompt },
): Promise<ModelEvalRunCaseResult> {
  const speaker = options?.speaker ?? "טל";
  const prompt =
    options?.prompt ??
    (await resolveEvalPrompt({ speaker, includeMichal: true }));
  const config = loadLlmConfig();
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
    model: prompt.model,
    temperature: prompt.temperature,
    reasoningEffort: prompt.reasoningEffort,
    instructions: prompt.instructions,
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
    prompt: evalPromptProvenance(prompt),
    ...checked,
  };
}

export async function runModelEvalCorpus(
  corpus: ModelEvalCorpus = loadModelEvalCorpus(),
  options?: { caseIds?: string[]; tags?: string[] | null },
): Promise<ModelEvalSummary & { prompt: ReturnType<typeof evalPromptProvenance> }> {
  let selected = corpus.cases;
  const tags =
    options?.tags !== undefined ? options.tags : parseModelEvalTags();
  selected = filterCasesByTags(selected, tags);
  if (options?.caseIds?.length) {
    selected = selected.filter((row) => options.caseIds!.includes(row.id));
  }
  const prompt = await resolveEvalPrompt({
    speaker: corpus.speaker,
    includeMichal: true,
  });
  const results: ModelEvalRunCaseResult[] = [];
  for (const row of selected) {
    results.push(
      await runModelEvalCase(row, { speaker: corpus.speaker, prompt }),
    );
  }
  return {
    ...summarizeModelEvalResults(results, {
      requiredPassRate: corpus.passRate,
      criticalCaseIds: corpus.criticalCaseIds,
    }),
    prompt: evalPromptProvenance(prompt),
  };
}

export interface ModelEvalMultiTurnRunResult {
  id: string;
  tag: string;
  ok: boolean;
  failures: string[];
  turns: Array<{
    index: number;
    utterance: string;
    response: string;
    ok: boolean;
    failures: string[];
    llmMs: number;
    metadata: ReturnType<typeof parseReplyMetadata>;
  }>;
  llmMs: number;
  prompt?: ReturnType<typeof evalPromptProvenance>;
}

/**
 * LIVE multi-turn (metadata scoring; no Prisma / WA / clocks).
 * Same conversationId across turns. After each turn, proposed lists/reminders
 * mutate an in-memory snapshot so later turns see prior ACTION effects
 * (still not product DB / LIVE_FULL parity).
 */
export async function runModelEvalMultiTurnCase(
  corpusCase: ModelEvalMultiTurnCase,
  options?: { speaker?: string; prompt?: ResolvedEvalPrompt },
): Promise<ModelEvalMultiTurnRunResult> {
  const speaker = options?.speaker ?? "טל";
  const prompt =
    options?.prompt ??
    (await resolveEvalPrompt({ speaker, includeMichal: true }));
  const config = loadLlmConfig();
  const snapshot: EmployeeRecordSnapshot = structuredClone(
    snapshotFromSetup(corpusCase.setup, speaker),
  );
  const contacts = (corpusCase.setup.contacts ?? []).map((row, index) => ({
    id: `contact-${index}`,
    name: row.name,
    phone: row.phone,
    kind: "person",
  }));

  const client = getLlmClient();
  const conversationId = await client.createConversation();
  const turnResults: ModelEvalMultiTurnRunResult["turns"] = [];
  let totalMs = 0;

  for (let i = 0; i < corpusCase.turns.length; i += 1) {
    const turn = corpusCase.turns[i]!;
    const factsBlock = [
      formatSessionClockContext(),
      formatEmployeeContext(snapshot),
      formatEmployeeContext(
        { lists: [], filing: [], reminders: [] },
        "WORKER_SAVED_DATA",
      ),
      formatSpeakerContacts(contacts),
    ].join("\n\n");
    const message = `${factsBlock}\n\n${speaker}: ${turn.utterance}`;
    const llmStarted = Date.now();
    const llmTurn = await client.createResponse({
      conversationId,
      message,
      model: prompt.model,
      temperature: prompt.temperature,
      reasoningEffort: prompt.reasoningEffort,
      instructions: prompt.instructions,
      textFormat: config.responseFormat,
    });
    const llmMs = Date.now() - llmStarted;
    totalMs += llmMs;
    const parsed = parseLlmReply(llmTurn.reply);
    const metadata = parseReplyMetadata(llmTurn.reply);
    const checked = evaluateConstraints(
      turn.constraints,
      metadata,
      parsed.response,
    );
    // Evolve in-memory facts for the next turn only (eval harness, not product DB).
    applyLiveModelMetadataToSnapshot(snapshot, metadata, speaker);
    turnResults.push({
      index: i,
      utterance: turn.utterance,
      response: parsed.response,
      ok: checked.ok,
      failures: checked.failures,
      llmMs,
      metadata,
    });
  }

  const failures = turnResults.flatMap((row) =>
    row.failures.map((f) => `turn ${row.index}: ${f}`),
  );
  return {
    id: corpusCase.id,
    tag: corpusCase.tag,
    ok: failures.length === 0,
    failures,
    turns: turnResults,
    llmMs: totalMs,
    prompt: evalPromptProvenance(prompt),
  };
}

export async function runModelEvalMultiTurnCorpus(
  corpus: ModelEvalMultiTurnCorpus = loadModelEvalMultiTurnCorpus(),
  options?: { caseIds?: string[]; tags?: string[] | null },
): Promise<
  ModelEvalSummary & {
    multiTurnResults: ModelEvalMultiTurnRunResult[];
    prompt: ReturnType<typeof evalPromptProvenance>;
  }
> {
  let selected = corpus.cases;
  const tags =
    options?.tags !== undefined ? options.tags : parseModelEvalTags();
  selected = filterCasesByTags(selected, tags);
  if (options?.caseIds?.length) {
    selected = selected.filter((row) => options.caseIds!.includes(row.id));
  }
  const prompt = await resolveEvalPrompt({
    speaker: corpus.speaker,
    includeMichal: true,
  });
  const multiTurnResults: ModelEvalMultiTurnRunResult[] = [];
  for (const row of selected) {
    multiTurnResults.push(
      await runModelEvalMultiTurnCase(row, {
        speaker: corpus.speaker,
        prompt,
      }),
    );
  }
  const results: ModelEvalRunCaseResult[] = multiTurnResults.map((row) => {
    const last = row.turns[row.turns.length - 1]!;
    return {
      id: row.id,
      tag: row.tag as ModelEvalRunCaseResult["tag"],
      ok: row.ok,
      failures: row.failures,
      utterance: row.turns.map((t) => t.utterance).join(" → "),
      response: last.response,
      metadata: last.metadata,
      rawReply: "",
      llmMs: row.llmMs,
      prompt: row.prompt,
    };
  });
  return {
    ...summarizeModelEvalResults(results, {
      requiredPassRate: corpus.passRate,
      criticalCaseIds: corpus.criticalCaseIds,
    }),
    multiTurnResults,
    prompt: evalPromptProvenance(prompt),
  };
}
