/**
 * Q2 — LIVE_FULL through the real production path.
 *
 * Every turn is `sendChatMessage` on the approved workee_test harness account:
 * production instructions (buildLucyInstructions), production live facts,
 * production apply / overrides / dump replacement / buttons, final reply.
 * The model client is the real one, wrapped only to RECORD what was sent and
 * the raw model reply (ACTION constraints still score the model's decision).
 *
 * Idle rotation = aging the stored conversation past CONVERSATION_IDLE_MS (the
 * server rotates by itself); automated messages = pushRelayMessage (stored +
 * remembered, like any server-sent thread message); a seeded numbered dump =
 * an assistant row carrying the packed dump map, exactly how a dump turn is
 * stored. No harness apply, no harness context building.
 */
import { createHash } from "node:crypto";
import { parseLlmReply, parseReplyMetadata } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import {
  getLlmClient,
  setLlmClientForTests,
  type LlmClient,
  type LlmResponseInput,
  type LlmTurn,
} from "../services/llm-client.js";
import { listEmployeesForUser } from "../services/employee.service.js";
import type { LastNumberedDumpLine } from "../services/show-button-dump.js";
import type { EvalAddressGender, LiveFullCorpusCase } from "./corpus.js";
import { extractEvalRawActionDiagnostic } from "./raw-action-diagnostic.js";
import {
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyCaseResult,
  type ModelApplyProposeInput,
} from "./run-model-apply.js";
import {
  destroyHarnessAccount,
  type HarnessAccount,
} from "./run-multi-turn.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Past CONVERSATION_IDLE_MS (40 min) so the server rotates on the next turn. */
export const ROTATION_AGE_MS = 41 * 60 * 1000;

/** Harness accounts whose cleanup left rows behind (reported, never ignored). */
export const productionCleanupLeaks: string[] = [];

/** Recording wrapper: forwards every call to the real client unchanged. */
type RecordedCall = { input: LlmResponseInput; reply: string; usage?: LlmTurn["usage"] };

export function recordingClient(real: LlmClient, calls: RecordedCall[]): LlmClient {
  return {
    createConversation: () => real.createConversation(),
    async createResponse(input) {
      const turn = await real.createResponse(input);
      calls.push({ input, reply: turn.reply, usage: turn.usage ?? null });
      return turn;
    },
    ...(real.appendAssistantMessage
      ? { appendAssistantMessage: (id: string, text: string) => real.appendAssistantMessage!(id, text) }
      : {}),
  };
}

/** Same chat rows the live-sendchat suites clear, then the shared destroy; then verify. */
async function cleanupProductionAccount(account: HarnessAccount): Promise<void> {
  const where = { userId: account.userId };
  await prisma.tipProgress.deleteMany({ where: { tip: where } }).catch(() => undefined);
  await prisma.tip.deleteMany({ where }).catch(() => undefined);
  await prisma.chatMessage.deleteMany({ where: { conversation: where } }).catch(() => undefined);
  await prisma.chatConversation.deleteMany({ where }).catch(() => undefined);
  await destroyHarnessAccount(account);
  const left = await prisma.user.findUnique({ where: { id: account.userId }, select: { id: true } });
  if (left) productionCleanupLeaks.push(account.userId);
}

/** Age every stored message / conversation of this account past the idle window. */
async function ageConversations(userId: string): Promise<void> {
  const past = new Date(Date.now() - ROTATION_AGE_MS);
  await prisma.chatMessage.updateMany({ where: { conversation: { userId } }, data: { createdAt: past } });
  await prisma.chatConversation.updateMany({ where: { userId }, data: { updatedAt: past } });
}

/** A numbered dump shown before turn 0, stored the way a dump turn stores it. */
async function seedNumberedDump(account: HarnessAccount, digitalId: string, lines: LastNumberedDumpLine[]): Promise<void> {
  const chat = await import("../services/chat.service.js");
  const conversation = await chat.getOrCreateConversation(account.userId, account.employeeId, digitalId);
  await chat.saveAssistantMessage({
    conversationId: conversation.id,
    speaker: "לוסי",
    text: lines.map((l) => `${l.n}. ${l.title_stem}`).join("\n"),
    actions: [],
    raw: chat.packStoredLlmRaw(null, null, lines),
  });
}

/** Summed OpenAI usage of a turn's model calls (null fields when not reported). */
function turnUsage(turnCalls: RecordedCall[]): {
  evalInputTokens: number | null;
  evalCachedTokens: number | null;
  evalOutputTokens: number | null;
} {
  const rows = turnCalls.map((call) => call.usage).filter((u): u is NonNullable<typeof u> => Boolean(u));
  if (rows.length === 0) {
    return { evalInputTokens: null, evalCachedTokens: null, evalOutputTokens: null };
  }
  const sum = (key: "inputTokens" | "cachedTokens" | "outputTokens") =>
    rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  return {
    evalInputTokens: sum("inputTokens"),
    evalCachedTokens: sum("cachedTokens"),
    evalOutputTokens: sum("outputTokens"),
  };
}

export async function runLiveFullProductionCase(
  suiteCase: LiveFullCorpusCase,
  applyCase: ModelApplyCase,
  options: { speaker: string; addressGender: EvalAddressGender },
): Promise<ModelApplyCaseResult> {
  const chat = await import("../services/chat.service.js");
  const real = getLlmClient();
  const calls: RecordedCall[] = [];
  setLlmClientForTests(recordingClient(real, calls));
  try {
    return await runModelApplyCase(
      applyCase,
      async (input: ModelApplyProposeInput) => {
        const account = input.account;
        const digitalId = account.digitalEmployeeId;
        if (!digitalId) throw new Error("production path needs the harness digital worker row");
        const turn = suiteCase.turns[input.turnIndex];
        if (input.turnIndex === 0 && suiteCase.context?.lastNumberedDump?.length) {
          await seedNumberedDump(
            account,
            digitalId,
            suiteCase.context.lastNumberedDump.map((l) => ({ ...l, id: input.idMap.get(l.id) ?? l.id })),
          );
        }
        if (input.turnIndex > 0 && turn?.newConversationBefore) await ageConversations(account.userId);

        const before = calls.length;
        const result = await chat.sendChatMessage({
          userId: account.userId,
          employeeId: account.employeeId,
          digitalEmployeeId: digitalId,
          message: input.utterance,
        });
        const main = calls[before];
        if (!main) throw new Error("production turn made no model call");

        // D1: what production sent == the shared builder for this account.
        const employees = await listEmployeesForUser(account.userId);
        const built = chat.buildLucyInstructions({
          digital: employees.find((row) => row.id === digitalId)!,
          employees,
          speaker: options.speaker,
          speakerIsOwner: true,
          guestSpeaker: false,
          pendingInvite: null,
          consultFrom: "",
        });
        if (built !== main.input.instructions) {
          throw new Error("production instructions differ from buildLucyInstructions (parity broken)");
        }

        const inject = turn?.injectAssistantAfter?.trim();
        if (inject) {
          await chat.pushRelayMessage({
            userId: account.userId,
            employeeId: account.employeeId,
            digitalEmployeeId: digitalId,
            speaker: "לוסי",
            text: inject,
          });
        }

        const finalReply = parseLlmReply(result.reply);
        const modelReply = parseLlmReply(main.reply);
        return {
          // ACTION constraints score the model's decision (raw model reply).
          metadata: Object.assign(parseReplyMetadata(main.reply), {
            evalShowIcon: modelReply.showIcon ?? null,
            evalBubbleCount: finalReply.responses.length,
            evalButtons: (finalReply.buttons ?? []).map((b) => ({ label: b.label, command: b.command })),
            evalModelResponse: modelReply.response,
            evalInstructionsSha256: sha(main.input.instructions),
            evalModelCalls: calls.length - before,
            // Stage 0: real OpenAI usage for this turn (all model calls).
            ...turnUsage(calls.slice(before)),
          }),
          // Response constraints score what the user actually receives.
          response: finalReply.response,
          rawActionDiagnostic: extractEvalRawActionDiagnostic(main.reply),
          appliedViaProduction: true,
        };
      },
      {
        speaker: options.speaker,
        harness: { addressGender: options.addressGender, digitalWorker: true },
        applyByProposer: true,
        cleanup: cleanupProductionAccount,
      },
    );
  } finally {
    setLlmClientForTests(null);
  }
}
