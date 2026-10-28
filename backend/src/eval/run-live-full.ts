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
import { getLlmClient } from "../services/llm-client.js";
import { formatSessionClockContext } from "../utils/relative-date.js";
import {
  filterCasesByTags,
  parseModelEvalTags,
  type LiveFullCorpus,
  type LiveFullCorpusCase,
} from "./corpus.js";
import {
  evalPromptProvenance,
  resolveEvalPrompt,
  type ResolvedEvalPrompt,
} from "./eval-prompt-source.js";
import { extractEvalRawActionDiagnostic } from "./raw-action-diagnostic.js";
import {
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyCaseResult,
  type ModelApplyProposeInput,
} from "./run-model-apply.js";
import { assertLiveFullDbRoleIsolation } from "./studio-db-role-isolation.js";
import { assertLiveFullCliAllowed } from "./studio-safety.js";

export type LiveFullCaseResult = ModelApplyCaseResult & {
  track: "LIVE_FULL";
  prompt?: ReturnType<typeof evalPromptProvenance>;
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
  options?: { speaker?: string; prompt?: ResolvedEvalPrompt },
): Promise<LiveFullCaseResult> {
  // Fail closed: approved test DB + WA/reminder kill switches in this process.
  assertLiveFullCliAllowed();
  // Fail closed: connected role must not be able to CONNECT to product `workee`.
  await assertLiveFullDbRoleIsolation();

  const speaker = options?.speaker ?? "טל";
  // LIVE_FULL historically omitted מיכל from Known employees — keep byte-identical.
  const prompt =
    options?.prompt ??
    (await resolveEvalPrompt({ speaker, includeMichal: false }));
  const config = loadLlmConfig();
  const client = getLlmClient();
  const conversationId = await client.createConversation();

  const applyCase = toModelApplyCase(suiteCase);
  const result = await runModelApplyCase(
    applyCase,
    async (input: ModelApplyProposeInput) => {
      // Always inject live Contacts rows (real UUIDs). Never fall back to
      // symbolic contact-N ids — those are not valid Contacts.id and break apply.
      const contacts = await listContactsForEmployee(input.account.employeeId);
      const message = [
        formatSessionClockContext(),
        input.facts,
        formatSpeakerContacts(contacts),
        `${speaker}: ${input.utterance}`,
      ].join("\n\n");

      const turn = await client.createResponse({
        conversationId,
        message,
        model: prompt.model,
        temperature: prompt.temperature,
        reasoningEffort: prompt.reasoningEffort,
        instructions: prompt.instructions,
        textFormat: config.responseFormat,
      });
      // Capture raw lists/filing BEFORE parse/normalize (eval diagnostic only).
      const rawActionDiagnostic = extractEvalRawActionDiagnostic(turn.reply);
      const parsed = parseLlmReply(turn.reply);
      return {
        metadata: parseReplyMetadata(turn.reply),
        response: parsed.response,
        rawActionDiagnostic,
      };
    },
    { speaker },
  );

  return {
    ...result,
    track: "LIVE_FULL",
    prompt: evalPromptProvenance(prompt),
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
  prompt: ReturnType<typeof evalPromptProvenance>;
}> {
  let selected = corpus.cases;
  const tags =
    options?.tags !== undefined ? options.tags : parseModelEvalTags();
  selected = filterCasesByTags(selected, tags);
  if (options?.caseIds?.length) {
    selected = selected.filter((row) => options.caseIds!.includes(row.id));
  }

  // Once before any OpenAI / apply — same gate as runLiveFullCase.
  assertLiveFullCliAllowed();
  await assertLiveFullDbRoleIsolation();

  const prompt = await resolveEvalPrompt({
    speaker: corpus.speaker,
    includeMichal: false,
  });
  const results: LiveFullCaseResult[] = [];
  for (const row of selected) {
    results.push(
      await runLiveFullCase(row, { speaker: corpus.speaker, prompt }),
    );
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
    prompt: evalPromptProvenance(prompt),
  };
}
