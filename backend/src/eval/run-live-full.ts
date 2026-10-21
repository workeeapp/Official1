/**
 * LIVE-full: real Lucy → production apply on workee_test → reinject facts.
 *
 * Same apply path as MODEL_APPLY offline; decision source is the live LLM
 * (shared conversationId across turns). Opt-in only — never default CI.
 */
import { parseLlmReply, parseReplyMetadata } from "@workee/shared";
import { loadLlmConfig } from "../config/llm.js";
import {
  formatSpeakerContacts,
  listContactsForEmployee,
} from "../services/contact.service.js";
import { buildLucyModelEvalInstructions } from "../services/chat.service.js";
import { getLlmClient } from "../services/llm-client.js";
import { formatSessionClockContext } from "../utils/relative-date.js";
import {
  filterCasesByTags,
  parseModelEvalTags,
  type LiveFullCorpus,
  type LiveFullCorpusCase,
} from "./corpus.js";
import {
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyCaseResult,
  type ModelApplyProposeInput,
} from "./run-model-apply.js";
import { assertApprovedEvalDatabaseUrl } from "./studio-db-guard.js";

export type LiveFullCaseResult = ModelApplyCaseResult & {
  track: "LIVE_FULL";
};

function toModelApplyCase(row: LiveFullCorpusCase): ModelApplyCase {
  return {
    id: row.id,
    track: "MODEL_APPLY",
    tag: typeof row.tag === "string" ? row.tag : row.tag,
    description: row.description,
    setup: row.setup,
    turns: row.turns.map((t) => ({
      utterance: t.utterance,
      constraints: t.constraints,
      stateAfter: t.stateAfter,
    })),
  };
}

/**
 * One LIVE-full case: OpenAI conversation + production apply per mutating turn.
 */
export async function runLiveFullCase(
  suiteCase: LiveFullCorpusCase,
  options?: { speaker?: string },
): Promise<LiveFullCaseResult> {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);

  const speaker = options?.speaker ?? "טל";
  const config = loadLlmConfig();
  const client = getLlmClient();
  const conversationId = await client.createConversation();

  // Minimal employee fixtures for instructions (same as Phase 4 LIVE model).
  const human = {
    id: "eval-human-1",
    kind: "human" as const,
    name: speaker,
    surname: "",
    nickname: speaker,
    email: null,
    phone: null,
    isOwner: true,
  };
  const worker = {
    id: "eval-lucy-1",
    kind: "digital" as const,
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
  const coworker = {
    id: "eval-human-2",
    kind: "human" as const,
    name: "עמית",
    surname: "",
    nickname: "עמית",
    email: null,
    phone: null,
    isOwner: false,
  };
  const instructions = buildLucyModelEvalInstructions({
    employees: [human, worker, coworker],
    speaker,
    worker,
  });

  const applyCase = toModelApplyCase(suiteCase);
  const result = await runModelApplyCase(
    applyCase,
    async (input: ModelApplyProposeInput) => {
      // Prefer live Contacts rows (real UUIDs) so directory.remove can apply.
      const liveContacts = await listContactsForEmployee(
        input.account.employeeId,
      );
      const contacts =
        liveContacts.length > 0
          ? liveContacts
          : (suiteCase.setup?.contacts ?? []).map((row, index) => ({
              id: `contact-${index}`,
              name: row.name,
              phone: row.phone,
              kind: "person" as const,
            }));
      const message = [
        formatSessionClockContext(),
        input.facts,
        formatSpeakerContacts(contacts),
        `${speaker}: ${input.utterance}`,
      ].join("\n\n");

      const turn = await client.createResponse({
        conversationId,
        message,
        model: worker.model?.trim() || config.model,
        temperature:
          typeof worker.temperature === "number" &&
          Number.isFinite(worker.temperature)
            ? worker.temperature
            : config.temperature,
        reasoningEffort: config.reasoningEffort,
        instructions,
        textFormat: config.responseFormat,
      });
      const parsed = parseLlmReply(turn.reply);
      return {
        metadata: parseReplyMetadata(turn.reply),
        response: parsed.response,
      };
    },
    { speaker },
  );

  return {
    ...result,
    track: "LIVE_FULL",
  };
}

export async function runLiveFullCorpus(
  corpus: LiveFullCorpus,
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
  results: LiveFullCaseResult[];
}> {
  let selected = corpus.cases;
  const tags =
    options?.tags !== undefined ? options.tags : parseModelEvalTags();
  selected = filterCasesByTags(selected, tags);
  if (options?.caseIds?.length) {
    selected = selected.filter((row) => options.caseIds!.includes(row.id));
  }

  const results: LiveFullCaseResult[] = [];
  for (const row of selected) {
    results.push(await runLiveFullCase(row, { speaker: corpus.speaker }));
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const passRate = total === 0 ? 0 : passed / total;
  const requiredPassRate = corpus.passRate;
  const softOk = passRate + 1e-9 >= requiredPassRate;
  const byId = new Map(results.map((r) => [r.id, r]));
  const criticalIds = (corpus.criticalCaseIds ?? []).filter((id) =>
    byId.has(id),
  );
  const criticalFailed = criticalIds.filter((id) => !byId.get(id)!.ok);
  return {
    total,
    passed,
    failed: total - passed,
    passRate,
    requiredPassRate,
    softOk,
    criticalOk: criticalFailed.length === 0,
    criticalFailed,
    ok: softOk && criticalFailed.length === 0,
    results,
  };
}
