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
  getContactBookShare,
  listContactsForEmployee,
} from "../services/contact.service.js";
import { listPendingAttachments } from "../services/attachment.service.js";
import {
  getEmployeeRecordSnapshot,
  getTeamSchedules,
} from "../services/employee-records.service.js";
import { listOpenJobsForViewer } from "../services/jobs.service.js";
import { getPendingLocation } from "../services/pending-location.js";
import { prisma } from "../database/prisma.js";
import type { LastNumberedDumpLine } from "../services/show-button-dump.js";
import { getLlmClient } from "../services/llm-client.js";
import { formatSessionClockContext } from "../utils/relative-date.js";
import {
  type EvalAddressGender,
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
import {
  formatRecentOutboundContext,
  listRecentReminderOutbounds,
} from "../services/recent-outbound.service.js";
import { assertLiveFullDbRoleIsolation } from "./studio-db-role-isolation.js";
import { assertLiveFullCliAllowed } from "./studio-safety.js";

/**
 * MODEL_EVAL_LEGACY_CONTEXT=1 → pre-G8 message (facts inside the stored user
 * message; clock + EMPLOYEE_SAVED_DATA + contacts + RECENT_OUTBOUND only).
 * Kept for A/B attribution only — the default mirrors production.
 */
export function useLegacyEvalContext(): boolean {
  return process.env.MODEL_EVAL_LEGACY_CONTEXT === "1";
}

/** Setup ids in a seeded LAST_NUMBERED_DUMP → the rows actually seeded. */
export function mapSeededDumpLines(
  lines: LastNumberedDumpLine[] | undefined,
  idMap: ReadonlyMap<string, string>,
): LastNumberedDumpLine[] {
  return (lines ?? []).map((line) => ({
    ...line,
    id: idMap.get(line.id) ?? line.id,
  }));
}

/**
 * Production live facts for one harness turn: same loaders + the shared
 * composeTurnContext. Not available in the harness (documented in the report):
 * LAST_LIVE_LOCATION (needs a DB chat conversation), tips (side-effecting tip
 * ladder), PENDING_INVITE (guest only), dumps the model shows mid-case.
 */
async function buildProductionLiveFacts(input: {
  account: ModelApplyProposeInput["account"];
  snapshot: ModelApplyProposeInput["snapshot"];
  addressGender: EvalAddressGender;
  lastNumberedDump: LastNumberedDumpLine[];
}): Promise<string> {
  const chat = await import("../services/chat.service.js");
  const { account } = input;
  const digitalId = account.digitalEmployeeId;
  const workerSnapshot = digitalId
    ? await chat.withAttachmentRefsSafe(
        await getEmployeeRecordSnapshot(digitalId, {
          scopeItemsToViewerId: account.employeeId,
        }),
      )
    : null;
  const employeeRow = await prisma.employee.findUnique({
    where: { id: account.employeeId },
    select: { addressGender: true },
  });
  return chat.composeTurnContext({
    guestSpeaker: false,
    consultFrom: false,
    viewerId: account.employeeId,
    addressGender: (employeeRow?.addressGender ?? input.addressGender) as Parameters<
      typeof chat.composeTurnContext
    >[0]["addressGender"],
    speakerSnapshot: input.snapshot,
    workerSnapshot,
    speakerContacts: await listContactsForEmployee(account.employeeId),
    contactBookShare: await getContactBookShare(account.employeeId),
    teamSchedules: await getTeamSchedules(account.employeeId),
    recentOutbound: await listRecentReminderOutbounds({
      userId: account.userId,
      employeeId: account.employeeId,
    }),
    openJobs: digitalId
      ? await listOpenJobsForViewer({
          digitalEmployeeId: digitalId,
          viewerId: account.employeeId,
        })
      : [],
    lastNumberedDump: input.lastNumberedDump,
    pendingAttachments: await listPendingAttachments(account.employeeId),
    pendingLocation: getPendingLocation(account.employeeId),
    lastLiveLocation: null,
    pendingInvite: null,
    tipsContext: "",
  });
}

export type LiveFullCaseResult = Omit<ModelApplyCaseResult, "track"> & {
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
  options?: {
    speaker?: string;
    prompt?: ResolvedEvalPrompt;
    /** Corpus default SPEAKER_ADDRESS gender. */
    speakerAddressGender?: EvalAddressGender;
  },
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
  let conversationId = await client.createConversation();
  const legacy = useLegacyEvalContext();
  const addressGender: EvalAddressGender =
    suiteCase.context?.speakerAddressGender !== undefined
      ? suiteCase.context.speakerAddressGender
      : (options?.speakerAddressGender ?? null);
  let dumpActive = true;

  const applyCase = toModelApplyCase(suiteCase);
  const result = await runModelApplyCase(
    applyCase,
    async (input: ModelApplyProposeInput) => {
      // Idle rotation: fresh conversation (no prior history); facts below are
      // rebuilt from the DB like every turn.
      if (
        input.turnIndex > 0 &&
        suiteCase.turns[input.turnIndex]?.newConversationBefore
      ) {
        conversationId = await client.createConversation();
        // A seeded dump belongs to the old conversation (production loads it per conversation).
        dumpActive = false;
      }
      let liveFacts: string | undefined;
      let message: string;
      if (legacy) {
        // Pre-G8 composition (A/B only): facts persisted inside the user message.
        const contacts = await listContactsForEmployee(input.account.employeeId);
        const recentOutbound = formatRecentOutboundContext(
          await listRecentReminderOutbounds({
            userId: input.account.userId,
            employeeId: input.account.employeeId,
          }),
        );
        message = [
          formatSessionClockContext(),
          input.facts,
          formatSpeakerContacts(contacts),
          ...(recentOutbound ? [recentOutbound] : []),
          `${speaker}: ${input.utterance}`,
        ].join("\n\n");
      } else {
        // Production shape: live facts ride ahead of THIS turn only (never stored
        // in the model conversation); the stored message is «speaker: text».
        liveFacts = await buildProductionLiveFacts({
          account: input.account,
          snapshot: input.snapshot,
          addressGender,
          lastNumberedDump: dumpActive
            ? mapSeededDumpLines(suiteCase.context?.lastNumberedDump, input.idMap)
            : [],
        });
        message = `${speaker}: ${input.utterance}`;
      }

      const turn = await client.createResponse({
        conversationId,
        message,
        ...(liveFacts ? { liveFacts } : {}),
        model: prompt.model,
        temperature: prompt.temperature,
        reasoningEffort: prompt.reasoningEffort,
        instructions: prompt.instructions,
        textFormat: config.responseFormat,
      });
      const inject =
        suiteCase.turns[input.turnIndex]?.injectAssistantAfter?.trim();
      if (inject) {
        await client.appendAssistantMessage?.(conversationId, inject);
      }
      // Capture raw lists/filing BEFORE parse/normalize (eval diagnostic only).
      const rawActionDiagnostic = extractEvalRawActionDiagnostic(turn.reply);
      const parsed = parseLlmReply(turn.reply);
      return {
        // evalShowIcon: eval-only carrier for show_icon constraints.
        metadata: Object.assign(parseReplyMetadata(turn.reply), {
          evalShowIcon: parsed.showIcon ?? null,
          // Eval-only diagnostics (G7): bubbles + buttons the speaker would see.
          evalBubbleCount: parsed.responses.length,
          evalButtons: (parsed.buttons ?? []).map((b) => ({
            label: b.label,
            command: b.command,
          })),
        }),
        response: parsed.response,
        rawActionDiagnostic,
      };
    },
    {
      speaker,
      harness: legacy
        ? undefined
        : { addressGender, digitalWorker: true },
    },
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
      await runLiveFullCase(row, {
        speaker: corpus.speaker,
        prompt,
        speakerAddressGender: corpus.speakerAddressGender ?? null,
      }),
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
