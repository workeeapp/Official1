/**
 * Focused LIVE_MODEL attachment-intent eval (model decisions only).
 *
 * Extends the Phase-4 runner shape with fixture injection that production chat
 * provides but runModelEvalCase omitted:
 *   new_attachments, PENDING_ATTACHMENTS, LAST_NUMBERED_DUMP, intervening
 *   assistant memory via appendAssistantMessage.
 *
 * Isolation: createConversation + createResponse (+ optional appendAssistantMessage)
 * only. No Prisma apply, WhatsApp, reminder fire, or Lucy DB sync.
 *
 * Intentional vs production Chat:
 * - Prompt = resolveEvalPrompt / buildLucyModelEvalInstructions (lucy_eval),
 *   not the full attachLucyEngine catalog on every Chat turn.
 * - Attachment/ PENDING / dump map come from corpus fixtures, not DB / ChatMessage.raw.
 * - Vision imageUrls omitted unless a case supplies them (facts-only is enough for intent).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseLlmReply, parseReplyMetadata } from "@workee/shared";
import { loadLlmConfig } from "../config/llm.js";
import {
  formatNewAttachmentsBlock,
  formatPendingAttachmentsContext,
  type AttachmentFact,
} from "../services/attachment.service.js";
import { formatSpeakerContacts } from "../services/contact.service.js";
import { formatEmployeeContext } from "../services/employee-records.service.js";
import { getLlmClient } from "../services/llm-client.js";
import {
  formatLastNumberedDumpContext,
  type LastNumberedDumpLine,
} from "../services/show-button-dump.js";
import { formatSessionClockContext } from "../utils/relative-date.js";
import {
  evaluateConstraints,
  type ModelEvalConstraint,
  type ModelEvalTag,
} from "./constraints.js";
import {
  filterCasesByTags,
  parseModelEvalTags,
  snapshotFromSetup,
  type ModelEvalCorpusCase,
} from "./corpus.js";
import {
  evalPromptProvenance,
  resolveEvalPrompt,
  type ResolvedEvalPrompt,
} from "./eval-prompt-source.js";
import type { ModelEvalRunCaseResult } from "./run-case.js";
import { summarizeModelEvalResults } from "./run-case.js";

export const ATTACHMENT_INTENT_EVAL_PATH =
  "model-output-constraints-only+fixture-attachment-context";

export interface AttachmentIntentTurn {
  utterance: string;
  constraints: ModelEvalConstraint[];
  newAttachments?: AttachmentFact[];
  pendingAttachments?: AttachmentFact[];
  lastNumberedDump?: LastNumberedDumpLine[];
  /**
   * After this turn's model reply, append this text as assistant memory
   * (simulates automated Lucy / reminder without a second model call).
   */
  injectAssistantAfter?: string;
}

export interface AttachmentIntentCase {
  id: string;
  tag: ModelEvalTag;
  tags?: string[];
  description?: string;
  setup: ModelEvalCorpusCase["setup"];
  /** Single-turn shortcut when turns is omitted. */
  utterance?: string;
  constraints?: ModelEvalConstraint[];
  newAttachments?: AttachmentFact[];
  pendingAttachments?: AttachmentFact[];
  lastNumberedDump?: LastNumberedDumpLine[];
  turns?: AttachmentIntentTurn[];
}

export interface AttachmentIntentCorpus {
  version: number;
  passRate: number;
  speaker: string;
  criticalCaseIds?: string[];
  cases: AttachmentIntentCase[];
  /** Documented eval↔production differences for reports. */
  promptNotes?: string[];
}

export interface AttachmentIntentTurnResult {
  index: number;
  utterance: string;
  response: string;
  rawReply: string;
  ok: boolean;
  failures: string[];
  llmMs: number;
  metadata: ReturnType<typeof parseReplyMetadata>;
  injectedAssistantAfter?: string;
}

export interface AttachmentIntentCaseResult {
  id: string;
  tag: string;
  description?: string;
  ok: boolean;
  failures: string[];
  turns: AttachmentIntentTurnResult[];
  llmMs: number;
  prompt?: ReturnType<typeof evalPromptProvenance>;
}

export function defaultAttachmentIntentCorpusPath(
  repoRoot = resolve(import.meta.dirname, "../../.."),
): string {
  return resolve(repoRoot, "docs/qa/attachment-intent-corpus.json");
}

export function loadAttachmentIntentCorpus(
  path = defaultAttachmentIntentCorpusPath(),
): AttachmentIntentCorpus {
  const raw = JSON.parse(readFileSync(path, "utf8")) as AttachmentIntentCorpus;
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`Attachment intent corpus has no cases: ${path}`);
  }
  return raw;
}

function normalizeTurns(row: AttachmentIntentCase): AttachmentIntentTurn[] {
  if (row.turns?.length) {
    return row.turns;
  }
  if (!row.utterance?.trim()) {
    throw new Error(`Attachment intent case ${row.id}: utterance or turns required`);
  }
  return [
    {
      utterance: row.utterance,
      constraints: row.constraints ?? [],
      newAttachments: row.newAttachments,
      pendingAttachments: row.pendingAttachments,
      lastNumberedDump: row.lastNumberedDump,
    },
  ];
}

/** Pure message builder — offline-testable injection parity. */
export function buildAttachmentIntentUserMessage(input: {
  speaker: string;
  utterance: string;
  setup: ModelEvalCorpusCase["setup"];
  newAttachments?: AttachmentFact[];
  pendingAttachments?: AttachmentFact[];
  lastNumberedDump?: LastNumberedDumpLine[];
}): string {
  const snapshot = snapshotFromSetup(input.setup, input.speaker);
  const contacts = (input.setup.contacts ?? []).map((row, index) => ({
    id: `contact-${index}`,
    name: row.name,
    phone: row.phone,
    kind: "person" as const,
  }));
  const pending = (input.pendingAttachments ?? []).filter(
    (fact) =>
      !(input.newAttachments ?? []).some(
        (fresh) => fresh.attachment_id === fact.attachment_id,
      ),
  );
  return [
    formatSessionClockContext(),
    formatEmployeeContext(snapshot),
    formatEmployeeContext(
      { lists: [], filing: [], reminders: [] },
      "WORKER_SAVED_DATA",
    ),
    formatSpeakerContacts(contacts),
    formatLastNumberedDumpContext(input.lastNumberedDump ?? []),
    formatPendingAttachmentsContext(pending),
    `${input.speaker}: ${input.utterance}`,
    formatNewAttachmentsBlock(input.newAttachments ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function runAttachmentIntentCase(
  corpusCase: AttachmentIntentCase,
  options?: { speaker?: string; prompt?: ResolvedEvalPrompt },
): Promise<AttachmentIntentCaseResult> {
  const speaker = options?.speaker ?? "טל";
  const prompt =
    options?.prompt ??
    (await resolveEvalPrompt({ speaker, includeMichal: true }));
  const config = loadLlmConfig();
  const client = getLlmClient();
  const conversationId = await client.createConversation();
  const turns = normalizeTurns(corpusCase);
  const turnResults: AttachmentIntentTurnResult[] = [];
  let totalMs = 0;

  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i]!;
    const message = buildAttachmentIntentUserMessage({
      speaker,
      utterance: turn.utterance,
      setup: corpusCase.setup,
      newAttachments: turn.newAttachments,
      pendingAttachments: turn.pendingAttachments,
      lastNumberedDump: turn.lastNumberedDump,
    });
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
    let injectedAssistantAfter: string | undefined;
    const inject = turn.injectAssistantAfter?.trim();
    if (inject) {
      await client.appendAssistantMessage?.(conversationId, inject);
      injectedAssistantAfter = inject;
    }
    turnResults.push({
      index: i,
      utterance: turn.utterance,
      response: parsed.response,
      rawReply: llmTurn.reply,
      ok: checked.ok,
      failures: checked.failures,
      llmMs,
      metadata,
      ...(injectedAssistantAfter ? { injectedAssistantAfter } : {}),
    });
  }

  const failures = turnResults.flatMap((row) =>
    row.failures.map((f) => `turn ${row.index}: ${f}`),
  );
  return {
    id: corpusCase.id,
    tag: corpusCase.tag,
    description: corpusCase.description,
    ok: failures.length === 0,
    failures,
    turns: turnResults,
    llmMs: totalMs,
    prompt: evalPromptProvenance(prompt),
  };
}

export async function runAttachmentIntentCorpus(
  corpus: AttachmentIntentCorpus = loadAttachmentIntentCorpus(),
  options?: { caseIds?: string[]; tags?: string[] | null },
): Promise<{
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  requiredPassRate: number;
  softOk: boolean;
  criticalOk: boolean;
  criticalFailed: string[];
  ok: boolean;
  results: AttachmentIntentCaseResult[];
  prompt: ReturnType<typeof evalPromptProvenance>;
  evalPath: string;
  productionApply: false;
  promptNotes: string[];
  proofKind: "actual-model";
}> {
  const tags =
    options?.tags !== undefined ? options.tags : parseModelEvalTags();
  let selected = filterCasesByTags(corpus.cases, tags);
  if (options?.caseIds?.length) {
    selected = selected.filter((row) => options.caseIds!.includes(row.id));
  }
  const prompt = await resolveEvalPrompt({
    speaker: corpus.speaker,
    includeMichal: true,
  });
  const results: AttachmentIntentCaseResult[] = [];
  for (const row of selected) {
    results.push(
      await runAttachmentIntentCase(row, {
        speaker: corpus.speaker,
        prompt,
      }),
    );
  }
  const flat: ModelEvalRunCaseResult[] = results.map((row) => ({
    id: row.id,
    tag: row.tag,
    utterance: row.turns.map((t) => t.utterance).join(" || "),
    response: row.turns.map((t) => t.response).join("\n---\n"),
    metadata: row.turns.at(-1)?.metadata ?? parseReplyMetadata("{}"),
    rawReply: row.turns.map((t) => t.rawReply).join("\n"),
    llmMs: row.llmMs,
    ok: row.ok,
    failures: row.failures,
    prompt: row.prompt,
  }));
  const summary = summarizeModelEvalResults(flat, {
    requiredPassRate: corpus.passRate,
    criticalCaseIds: corpus.criticalCaseIds,
  });
  return {
    ...summary,
    results,
    prompt: evalPromptProvenance(prompt),
    evalPath: ATTACHMENT_INTENT_EVAL_PATH,
    productionApply: false,
    proofKind: "actual-model",
    promptNotes: corpus.promptNotes ?? [
      "Prompt = resolveEvalPrompt (lucy_eval / buildLucyModelEvalInstructions), not full Chat attachLucyEngine catalog.",
      "new_attachments / PENDING_ATTACHMENTS / LAST_NUMBERED_DUMP are corpus fixtures (not DB).",
      "Intervening Lucy lines use appendAssistantMessage (no model call for that bubble).",
      "No Prisma apply / WhatsApp / reminder fire / Lucy DB sync.",
    ],
  };
}
