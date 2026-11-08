import { parseLlmReply, parseReplyMetadata } from "@workee/shared";
import { loadLlmConfig } from "../config/llm.js";
import { prisma } from "../database/prisma.js";
import { formatSessionClockContext } from "../utils/relative-date.js";
import { getLlmClient } from "./llm-client.js";
import { recordLlmUsage } from "./llm-usage.service.js";
import {
  ACTIVE_MISSION_STATUSES,
  applyMissionActions,
  BOOTSTRAP_PLAN_STEPS,
  buildMissionTurnContext,
  clearReSearchFlags,
  emptyMissionTurnPolicy,
  extractTextFromToolSummary,
  formatNavigateLoopAsk,
  formatPlanApprovalText,
  bumpDigEmptyRetry,
  clearDigEmptyRetries,
  digEmptyRetryCount,
  extractLooksLikeDeadPage,
  extractLooksLikeLogin,
  extractLooksLikePortalGate,
  formatDigStuckAsk,
  formatLoginCredentialsAsk,
  formatProductOptionsAsk,
  formatSearchBudgetExhaustedAsk,
  formatSearchFailedAsk,
  formatSerpFactEvidenceAsk,
  extractMatchesGoal,
  hostFromUrlOrSummary,
  inferMissionShape,
  isFactMissionGoal,
  isOptionsFindGoal,
  isPortalMissionGoal,
  isSearchEngineHost,
  isShoppingGoal,
  isUselessSearchExtract,
  looksLikeGenericHubPath,
  pastResultsControlLabel,
  priorSerpFactExtract,
  serpLooksLikeFactAnswer,
  webSearchLooksStaleForGoal,
  productOptionLinesFromExtract,
  relevantOptionLinesFromExtract,
  MAX_DIG_EMPTY_RETRIES,
  missionNeedsFreshSearch,
  navigateResultLooksUseless,
  parkMissionAskUser,
  planIsApproved,
  SEARCH_BROWSE_BUDGET,
  SEARCH_MAX_HOSTS,
  answerTextFromWebSearchSummary,
  bingSearchUrl,
  countBrowseTools,
  hasWebSearchTool,
  searchFallbackUrlForGoal,
  searchQueryFromMission,
  shouldBootstrapExtract,
  shouldStartEngineWebSearch,
  shouldStopNavigateLoop,
  stillOnSearchEngineOnly,
  topRelevantResultUrls,
  usesHostedWebSearchBootstrap,
  webSearchSummaryLooksComplete,
  type MissionToolResultFact,
} from "./mission.service.js";
import type { Prisma } from "@prisma/client";
import { MISSION_EXECUTOR_INSTRUCTIONS } from "./mission-executor-prompt.js";
import {
  planApprovalButtons,
  pushMissionMessageAsLucy,
  stepApprovalButtons,
} from "./mission-push.js";
import { toPublicEmployee } from "./employee.service.js";
import { WEB_SEARCH_TOOL } from "./mission-tools/index.js";

const TICK_MS = 5_000;
/** Re-wake delay when a turn ends with no waiting gate and no progress. */
export const MISSION_RETRY_WAKE_MS = 15_000;
/** Active missions with null wakeAt older than this are treated as stuck. */
export const MISSION_STALE_MS = 2 * 60_000;

let ticker: ReturnType<typeof setInterval> | null = null;
const running = new Set<string>();
/** Wakes requested while a turn still holds `running` — flushed in finally. */
const pendingWakes = new Set<string>();

const RUNNABLE_FOR_STALE = [
  "open",
  "planning",
  "running",
  "pending",
] as const;

export function startMissionTicker(): void {
  if (ticker || process.env.NODE_ENV === "test") {
    return;
  }
  if (process.env.WORKEE_DISABLE_MISSION_FIRE === "1") {
    return;
  }
  ticker = setInterval(() => {
    void wakeDueMissions();
  }, TICK_MS);
}

export function stopMissionTicker(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

export function scheduleMissionWake(missionId: string, delayMs = 50): void {
  if (running.has(missionId)) {
    // Don't fire while this turn still holds the lock — it would no-op and
    // drop the wake (seen after web.search: answer ready, Lucy silent ~3min).
    pendingWakes.add(missionId);
    return;
  }
  setTimeout(() => {
    void runMissionTurn(missionId, { force: true });
  }, delayMs);
}

/**
 * Promote a successful web.search TOOL_RESULTS dump into missions.complete
 * + Lucy push — avoids a second slow executor LLM turn for public facts.
 */
async function completeMissionFromWebSearchEvidence(input: {
  userId: string;
  speaker: ReturnType<typeof toPublicEmployee>;
  orchestrator: ReturnType<typeof toPublicEmployee>;
  missionId: string;
  goal: string;
  speakerId: string;
  orchestratorId: string;
  resultSummary: string;
}): Promise<boolean> {
  const answer = answerTextFromWebSearchSummary(input.resultSummary);
  if (!webSearchSummaryLooksComplete(input.resultSummary)) {
    return false;
  }
  const applied = await applyMissionActions({
    userId: input.userId,
    speaker: input.speaker,
    orchestrator: input.orchestrator,
    asExecutor: true,
    actions: [
      {
        action: "complete",
        missionId: input.missionId,
        summary: answer,
        evidence: [`tool:${WEB_SEARCH_TOOL}`],
      },
    ],
  });
  if (!applied.notices.some((n) => n.startsWith("done:"))) {
    return false;
  }
  await pushMissionMessageAsLucy({
    userId: input.userId,
    speakerId: input.speakerId,
    orchestratorId: input.orchestratorId,
    text: answer,
    raw: {
      mission_id: input.missionId,
      kind: "done",
      from_web_search: true,
    },
  });
  return true;
}

type EngineSearchMission = {
  id: string;
  goal: string;
  userId: string;
  speakerId: string;
  orchestratorId: string;
  contextFacts?: unknown;
};

/**
 * Kick off search after plan approval.
 * Fact/generic → OpenAI hosted web.search only (no Bing/Playwright fallback).
 * Options/portal → Bing + Playwright (forms/login need a real browser).
 */
async function engineStartWebSearchAndWake(input: {
  userId: string;
  speaker: ReturnType<typeof toPublicEmployee>;
  orchestrator: ReturnType<typeof toPublicEmployee>;
  mission: EngineSearchMission;
}): Promise<"blocked" | "woke" | "failed"> {
  if (usesHostedWebSearchBootstrap(input.mission.goal)) {
    const hosted = await engineStartHostedWebSearchAndWake(input);
    if (hosted === "woke") {
      return hosted;
    }
    // Fact/generic: never fall back to Bing — park and let the speaker refine.
    await pushAskAndPark({
      userId: input.userId,
      speakerId: input.mission.speakerId,
      orchestratorId: input.mission.orchestratorId,
      missionId: input.mission.id,
      summary: formatSearchFailedAsk(input.mission.goal),
    });
    return "failed";
  }
  return engineStartBingWebSearchAndWake(input);
}

/** OpenAI hosted web_search → wake executor with evidence (no Playwright). */
async function engineStartHostedWebSearchAndWake(input: {
  userId: string;
  speaker: ReturnType<typeof toPublicEmployee>;
  orchestrator: ReturnType<typeof toPublicEmployee>;
  mission: EngineSearchMission;
}): Promise<"blocked" | "woke" | "failed"> {
  const query = searchQueryFromMission({
    goal: input.mission.goal,
    contextFacts: input.mission.contextFacts,
  });
  const progress = `מחפשת באינטרנט: ${query}`;
  await pushMissionMessageAsLucy({
    userId: input.userId,
    speakerId: input.mission.speakerId,
    orchestratorId: input.mission.orchestratorId,
    text: progress,
    raw: {
      mission_id: input.mission.id,
      kind: "progress",
      bootstrap_search: true,
      hosted_web_search: true,
    },
  });
  await applyMissionActions({
    userId: input.userId,
    speaker: input.speaker,
    orchestrator: input.orchestrator,
    asExecutor: true,
    actions: [
      {
        action: "run_tools",
        missionId: input.mission.id,
        summary: progress,
        tools: [{ tool: WEB_SEARCH_TOOL, args: { query } }],
      },
    ],
  });
  const latest = await prisma.missionToolCall.findFirst({
    where: { missionId: input.mission.id, tool: WEB_SEARCH_TOOL },
    orderBy: { createdAt: "desc" },
  });
  const summary = (latest?.resultSummary ?? "").trim();
  if (!latest || latest.status !== "done" || summary.length < 20) {
    return "failed";
  }
  if (webSearchLooksStaleForGoal(input.mission.goal, summary)) {
    // Wrong year vs אתמול/היום — wake executor to refine web.search (no Bing).
    await prisma.mission.update({
      where: { id: input.mission.id },
      data: {
        status: "running",
        waitingOn: "",
        wakeAt: null,
        lastSummary: `החיפוש החזיר תאריך לא תואם — מחדדת שאילתה ל«${input.mission.goal}»`,
      },
    });
    scheduleMissionWake(input.mission.id, 50);
    return "woke";
  }
  // Public-fact path: complete from TOOL_RESULTS now — do not wait on another
  // executor LLM turn (that gap left Lucy silent for minutes after plan approval).
  const done = await completeMissionFromWebSearchEvidence({
    userId: input.userId,
    speaker: input.speaker,
    orchestrator: input.orchestrator,
    missionId: input.mission.id,
    goal: input.mission.goal,
    speakerId: input.mission.speakerId,
    orchestratorId: input.mission.orchestratorId,
    resultSummary: summary,
  });
  if (done) {
    return "woke";
  }
  await prisma.mission.update({
    where: { id: input.mission.id },
    data: {
      status: "running",
      waitingOn: "",
      wakeAt: null,
      lastSummary: `מצאתי מידע בחיפוש — מסכמת תשובה ל«${input.mission.goal}»`,
    },
  });
  scheduleMissionWake(input.mission.id, 50);
  return "woke";
}

/**
 * Generic Bing kickoff from goal + speaker context_facts, then extract → wake executor.
 * Not site-hardcoded — query is whatever the mission + answers say.
 */
async function engineStartBingWebSearchAndWake(input: {
  userId: string;
  speaker: ReturnType<typeof toPublicEmployee>;
  orchestrator: ReturnType<typeof toPublicEmployee>;
  mission: EngineSearchMission;
}): Promise<"blocked" | "woke" | "failed"> {
  const query = searchQueryFromMission({
    goal: input.mission.goal,
    contextFacts: input.mission.contextFacts,
  });
  const url = bingSearchUrl(query);
  const progress = `מחפשת באינטרנט: ${query}`;
  await pushMissionMessageAsLucy({
    userId: input.userId,
    speakerId: input.mission.speakerId,
    orchestratorId: input.mission.orchestratorId,
    text: progress,
    raw: {
      mission_id: input.mission.id,
      kind: "progress",
      bootstrap_search: true,
    },
  });
  await applyMissionActions({
    userId: input.userId,
    speaker: input.speaker,
    orchestrator: input.orchestrator,
    asExecutor: true,
    actions: [
      {
        action: "run_tools",
        missionId: input.mission.id,
        summary: progress,
        tools: [{ tool: "browser.navigate", args: { url } }],
      },
    ],
  });
  return engineExtractAndComeBack({
    userId: input.userId,
    speaker: input.speaker,
    orchestrator: input.orchestrator,
    mission: input.mission,
  });
}

/**
 * Clear browser + generic Bing search after speaker asks to search again.
 */
export async function recoverMissionSearchComeback(
  missionId: string,
): Promise<boolean> {
  const ctx = await buildMissionTurnContext(missionId);
  if (!ctx) {
    return false;
  }
  const { mission } = ctx;
  const speaker = await prisma.employee.findUnique({
    where: { id: mission.speakerId },
  });
  const orchestrator = await prisma.employee.findUnique({
    where: { id: mission.orchestratorId },
  });
  if (!speaker || !orchestrator) {
    return false;
  }
  const { clearBrowserSession } = await import("./mission-tools/browser.js");
  await clearBrowserSession(missionId);
  await prisma.mission.update({
    where: { id: missionId },
    data: {
      status: "running",
      waitingOn: "",
      wakeAt: null,
      contextFacts: clearReSearchFlags(
        mission.contextFacts,
      ) as Prisma.InputJsonValue,
      lastSummary: `ממשיכה לפי התשובה שלך: ${mission.goal}`,
    },
  });
  await engineStartWebSearchAndWake({
    userId: mission.userId,
    speaker: toPublicEmployee(speaker),
    orchestrator: toPublicEmployee(orchestrator),
    mission,
  });
  return true;
}

async function setRetryWake(
  missionId: string,
  delayMs = MISSION_RETRY_WAKE_MS,
): Promise<void> {
  try {
    const row = await prisma.mission.findUnique({
      where: { id: missionId },
      select: { status: true, wakeAt: true },
    });
    if (!row) {
      return;
    }
    if (
      row.status === "waiting_plan_approval" ||
      row.status === "waiting_user" ||
      row.status === "waiting_approval" ||
      row.status === "done" ||
      row.status === "failed" ||
      row.status === "cancelled"
    ) {
      return;
    }
    if (row.wakeAt && row.wakeAt.getTime() > Date.now()) {
      return;
    }
    await prisma.mission.update({
      where: { id: missionId },
      data: { wakeAt: new Date(Date.now() + delayMs) },
    });
  } catch {
    // ignore
  }
}

export async function wakeDueMissions(): Promise<void> {
  const now = new Date();
  const staleBefore = new Date(Date.now() - MISSION_STALE_MS);
  const [due, stale] = await Promise.all([
    prisma.mission.findMany({
      where: {
        status: { in: [...ACTIVE_MISSION_STATUSES] },
        wakeAt: { lte: now },
      },
      orderBy: { wakeAt: "asc" },
      take: 5,
    }),
    prisma.mission.findMany({
      where: {
        status: { in: [...RUNNABLE_FOR_STALE] },
        wakeAt: null,
        updatedAt: { lte: staleBefore },
      },
      orderBy: { updatedAt: "asc" },
      take: 5,
    }),
  ]);
  const ids: string[] = [];
  for (const row of [...due, ...stale]) {
    if (running.has(row.id) || ids.includes(row.id)) {
      continue;
    }
    ids.push(row.id);
  }
  for (const id of ids.slice(0, 5)) {
    const isStale = stale.some((row) => row.id === id);
    void runMissionTurn(id, isStale ? { force: true } : undefined);
  }
}

function toolFactsFromCtx(toolResults: unknown[]): MissionToolResultFact[] {
  return toolResults.map((row) => {
    const r = row as {
      tool?: string;
      status?: string;
      result_summary?: string | null;
    };
    return {
      tool: typeof r.tool === "string" ? r.tool : "",
      status: typeof r.status === "string" ? r.status : "",
      result_summary: r.result_summary ?? null,
    };
  });
}

/** Prefer completed tools — ignore in-flight pending rows from a raced turn. */
function doneToolFacts(toolResults: MissionToolResultFact[]): MissionToolResultFact[] {
  return toolResults.filter((row) => row.status === "done");
}

function latestDoneExtract(
  toolResults: MissionToolResultFact[],
): MissionToolResultFact | undefined {
  return doneToolFacts(toolResults).find((row) => row.tool === "browser.extract");
}

async function pushAskAndPark(input: {
  userId: string;
  speakerId: string;
  orchestratorId: string;
  missionId: string;
  summary: string;
  contextExtra?: Record<string, unknown>;
}): Promise<void> {
  await parkMissionAskUser({
    missionId: input.missionId,
    summary: input.summary,
    contextExtra: input.contextExtra,
  });
  await pushMissionMessageAsLucy({
    userId: input.userId,
    speakerId: input.speakerId,
    orchestratorId: input.orchestratorId,
    text: input.summary,
    raw: { mission_id: input.missionId, kind: "ask_user" },
  });
}

async function pushBlockedAskIfParked(missionId: string): Promise<boolean> {
  const row = await prisma.mission.findUnique({
    where: { id: missionId },
  });
  if (!row?.lastSummary) {
    return false;
  }
  await pushMissionMessageAsLucy({
    userId: row.userId,
    speakerId: row.speakerId,
    orchestratorId: row.orchestratorId,
    text: row.lastSummary,
    raw: { mission_id: row.id, kind: "ask_user" },
  });
  return true;
}

/** Clear waiting gates so the engine can keep browsing after a soft park. */
async function resumeRunningForRefine(missionId: string): Promise<void> {
  await prisma.mission.update({
    where: { id: missionId },
    data: { status: "running", waitingOn: "", wakeAt: null },
  });
}

/**
 * Engine: extract page (+ one bot-wall fallback) then wake the executor LLM.
 * The model owns the shortlist / no-results ask — engine does not format product options.
 */
async function engineExtractAndWakeExecutor(input: {
  userId: string;
  speaker: ReturnType<typeof toPublicEmployee>;
  orchestrator: ReturnType<typeof toPublicEmployee>;
  mission: {
    id: string;
    goal: string;
    userId: string;
    speakerId: string;
    orchestratorId: string;
  };
}): Promise<"blocked" | "woke" | "failed"> {
  const runExtract = async () =>
    applyMissionActions({
      userId: input.userId,
      speaker: input.speaker,
      orchestrator: input.orchestrator,
      asExecutor: true,
      actions: [
        {
          action: "run_tools",
          missionId: input.mission.id,
          summary: `קוראת תוצאות חיפוש ל«${input.mission.goal}»`,
          tools: [
            {
              tool: "browser.extract",
              args: { aspect: "search_results" },
            },
          ],
        },
      ],
    });

  const readSample = async (): Promise<{
    sample: string;
    status: string | undefined;
  }> => {
    const extract = await prisma.missionToolCall.findFirst({
      where: { missionId: input.mission.id, tool: "browser.extract" },
      orderBy: { createdAt: "desc" },
    });
    const raw = (extract?.resultSummary ?? "").trim();
    return {
      sample: extractTextFromToolSummary(raw),
      status: extract?.status,
    };
  };

  const handleBlocked = async (
    applied: Awaited<ReturnType<typeof applyMissionActions>>,
  ): Promise<"blocked" | null> => {
    if (!applied.notices.some((n) => n.startsWith("ask_user:"))) {
      return null;
    }
    await pushBlockedAskIfParked(input.mission.id);
    return "blocked";
  };

  let applied = await runExtract();
  const blockedFirst = await handleBlocked(applied);
  if (blockedFirst) {
    return blockedFirst;
  }

  let { sample, status } = await readSample();

  // Bot wall, or shopping extract with no/irrelevant priced lines → try fallback host.
  const shopLines = productOptionLinesFromExtract(sample);
  const shoppingWithoutProducts =
    isShoppingGoal(input.mission.goal) &&
    (shopLines.length === 0 || !extractMatchesGoal(input.mission.goal, sample));
  if (isUselessSearchExtract(sample) || shoppingWithoutProducts) {
    await resumeRunningForRefine(input.mission.id);
    await applyMissionActions({
      userId: input.userId,
      speaker: input.speaker,
      orchestrator: input.orchestrator,
      asExecutor: true,
      actions: [
        {
          action: "run_tools",
          missionId: input.mission.id,
          summary: `ממשיכה בחיפוש חלופי: ${input.mission.goal}`,
          tools: [
            {
              tool: "browser.navigate",
              args: { url: searchFallbackUrlForGoal(input.mission.goal) },
            },
          ],
        },
      ],
    });
    applied = await runExtract();
    const blockedFallback = await handleBlocked(applied);
    if (blockedFallback) {
      return blockedFallback;
    }
    ({ sample, status } = await readSample());
  }

  await prisma.mission.update({
    where: { id: input.mission.id },
    data: { status: "running", waitingOn: "", wakeAt: null },
  });
  scheduleMissionWake(input.mission.id, 50);
  return status === "failed" ? "failed" : "woke";
}

/** @deprecated name kept for recover/call sites — delegates to wake-executor path. */
async function engineExtractAndComeBack(
  input: Parameters<typeof engineExtractAndWakeExecutor>[0],
): Promise<"blocked" | "woke" | "failed"> {
  return engineExtractAndWakeExecutor(input);
}

export async function runMissionTurn(
  missionId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (running.has(missionId)) {
    return;
  }
  running.add(missionId);
  try {
    if (!opts.force) {
      // Cross-process claim: ticker may only take a due wakeAt once.
      const claimed = await prisma.mission.updateMany({
        where: {
          id: missionId,
          status: { in: [...ACTIVE_MISSION_STATUSES] },
          wakeAt: { not: null, lte: new Date() },
        },
        data: { wakeAt: null },
      });
      if (claimed.count === 0) {
        return;
      }
    }

    // Drop orphan pending tool rows left by a crashed/raced worker.
    await prisma.missionToolCall.updateMany({
      where: {
        missionId,
        status: "pending",
        createdAt: { lte: new Date(Date.now() - 20_000) },
      },
      data: {
        status: "failed",
        resultSummary: "orphaned pending tool cleared",
      },
    });

    const ctx = await buildMissionTurnContext(missionId);
    if (!ctx) {
      return;
    }
    const { mission } = ctx;
    if (
      mission.status === "waiting_plan_approval" ||
      mission.status === "waiting_user" ||
      mission.status === "waiting_approval"
    ) {
      await prisma.mission.update({
        where: { id: missionId },
        data: { wakeAt: null },
      });
      return;
    }
    if (
      mission.status === "done" ||
      mission.status === "failed" ||
      mission.status === "cancelled"
    ) {
      return;
    }

    // Hold a short lease so the ticker cannot steal this mission mid-turn
    // (cross-process). Cleared / replaced on exit paths that re-wake.
    await prisma.mission.update({
      where: { id: missionId },
      data: { wakeAt: new Date(Date.now() + 3 * 60_000) },
    });

    const executor = await prisma.employee.findUnique({
      where: { id: mission.executorId },
    });
    const speaker = await prisma.employee.findUnique({
      where: { id: mission.speakerId },
    });
    const orchestrator = await prisma.employee.findUnique({
      where: { id: mission.orchestratorId },
    });
    if (!executor || !speaker || !orchestrator) {
      await setRetryWake(missionId);
      return;
    }

    const publicSpeaker = toPublicEmployee(speaker);
    const publicOrchestrator = toPublicEmployee(orchestrator);
    const toolFacts = toolFactsFromCtx(ctx.toolResults);

    // Speaker asked to search again (resume re_search) — fresh cycle, ignore prior extract.
    if (missionNeedsFreshSearch(mission.contextFacts)) {
      await recoverMissionSearchComeback(missionId);
      return;
    }

    // Do NOT Bing-kick before the executor LLM turn — clarify ask_user must win when
    // GOAL lacks slots. Empty-missions continue_tools path kicks search instead.

    // After navigate(s) from executor: if page looks useless, one Bing fallback then extract.
    if (shouldBootstrapExtract(mission, toolFacts)) {
      const latestNav = [...toolFacts].find(
        (row) => row.tool === "browser.navigate",
      );
      if (
        latestNav &&
        navigateResultLooksUseless(latestNav.result_summary ?? "")
      ) {
        await prisma.mission.update({
          where: { id: mission.id },
          data: { status: "running", waitingOn: "", wakeAt: null },
        });
        await applyMissionActions({
          userId: mission.userId,
          speaker: publicSpeaker,
          orchestrator: publicOrchestrator,
          asExecutor: true,
          actions: [
            {
              action: "run_tools",
              missionId: mission.id,
              summary: `ממשיכה בחיפוש חלופי: ${mission.goal}`,
              tools: [
                {
                  tool: "browser.navigate",
                  args: { url: searchFallbackUrlForGoal(mission.goal) },
                },
              ],
            },
          ],
        });
      }
      await engineExtractAndComeBack({
        userId: mission.userId,
        speaker: publicSpeaker,
        orchestrator: publicOrchestrator,
        mission,
      });
      return;
    }

    // Re-search navigate loop after extract (or if extract never ran somehow).
    if (shouldStopNavigateLoop(toolFacts)) {
      await pushAskAndPark({
        userId: mission.userId,
        speakerId: mission.speakerId,
        orchestratorId: mission.orchestratorId,
        missionId: mission.id,
        summary: formatNavigateLoopAsk(mission.goal),
      });
      return;
    }

    const fileConfig = loadLlmConfig();
    const client = getLlmClient();
    const openaiConversationId = await client.createConversation();
    const liveFacts = [
      "MISSION_TURN — emit metadata.missions only. responses may be empty.",
      formatSessionClockContext(),
      "Resolve אתמול/היום/מחר from SESSION_CLOCK before searching or completing. FORBIDDEN answering with a different calendar year/date than SESSION_CLOCK implies.",
      `MISSION_STATE: ${JSON.stringify({
        mission_id: mission.id,
        goal: mission.goal,
        success_criteria: mission.successCriteria,
        status: mission.status,
        plan_steps: Array.isArray(mission.plan) ? mission.plan : [],
        plan_approved: planIsApproved(mission),
        step_count: mission.stepCount,
        max_steps: mission.maxSteps,
        context_facts: mission.contextFacts,
        last_summary: mission.lastSummary,
        waiting_on: mission.waitingOn,
      })}`,
      `TOOL_RESULTS: ${JSON.stringify(ctx.toolResults)}`,
      `SPEAKER_VAULT_META: ${JSON.stringify(ctx.vaultMeta)}`,
      "If plan not approved: update_plan (goal-specific Hebrew steps) + request_plan_approval (no run_tools).",
      `Mission shape hint (engine): ${inferMissionShape(mission.goal)} — fact/generic→web.search ONLY then complete (no Bing/browser); options→browser form then ask_user ≤3 real options; portal→login then dig to personal data then complete.`,
      "If plan approved and GOAL lacks essentials YOU need (provider/bank/HMO/dates/city/budget): ask_user FIRST — do not browse yet.",
      "If plan approved and slots known / TOOL_RESULTS empty: for fact/generic run_tools web.search only; for options/portal run_tools browser.navigate (Bing or official site) then extract/observe/dig.",
      "If TOOL_RESULTS has web.search: complete quoting that evidence ONLY if dates match SESSION_CLOCK. If wrong day/year → web.search again with absolute date from SESSION_CLOCK. FORBIDDEN browser/Bing fallback on fact/generic. FORBIDDEN inventing.",
      `If TOOL_RESULTS has extract/controls: DIG (observe/click/type/select) toward the GOAL, OR ask_user for login/OTP/missing slots, OR ask_user with up to 3 real options from the page, OR complete with a fact answer evidenced by extract, OR alternate host / לא מצאתי. Browse budget ~${SEARCH_BROWSE_BUDGET} / ≤${SEARCH_MAX_HOSTS} hosts.`,
      "FORBIDDEN dump SERP links as options. FORBIDDEN ask «באיזה אתר לחפש» when slots are known. FORBIDDEN invent scores/balances/lab lines/hotel prices.",
      "On a login/password / personal-area gate: ask_user for credentials (or vault.use) immediately — that is progress.",
      "When context_facts include continue_on_host / speaker credentials: type into the open login form — do NOT Bing/web.search again.",
      digEmptyRetryCount(mission.contextFacts) > 0
        ? hasWebSearchTool(toolFacts) &&
          usesHostedWebSearchBootstrap(mission.goal) &&
          !webSearchLooksStaleForGoal(
            mission.goal,
            toolFacts.find((r) => r.tool === WEB_SEARCH_TOOL)
              ?.result_summary ?? "",
          )
          ? "PRIOR TURN EMPTY + TOOL_RESULTS already have web.search evidence matching SESSION_CLOCK. You MUST missions.complete NOW with a short Hebrew summary quoting that evidence. FORBIDDEN empty missions. FORBIDDEN inventing. FORBIDDEN browser."
          : hasWebSearchTool(toolFacts) &&
              usesHostedWebSearchBootstrap(mission.goal) &&
              webSearchLooksStaleForGoal(
                mission.goal,
                toolFacts.find((r) => r.tool === WEB_SEARCH_TOOL)
                  ?.result_summary ?? "",
              )
            ? "PRIOR TURN EMPTY + web.search evidence is STALE vs SESSION_CLOCK. You MUST run_tools web.search again with the absolute YYYY-MM-DD from SESSION_CLOCK. FORBIDDEN browser/Bing. FORBIDDEN completing from the stale dump."
            : isFactMissionGoal(mission.goal)
              ? "PRIOR TURN EMPTY on a fact goal — run_tools web.search (or complete if TOOL_RESULTS already answer). FORBIDDEN browser dig. FORBIDDEN empty missions[]."
              : "PRIOR TURN WAS EMPTY — you MUST emit run_tools dig (observe then click/type), ask_user, or complete/fail NOW. Empty missions[] is forbidden."
        : isFactMissionGoal(mission.goal)
          ? "Fact goal: web.search only — complete with evidenced answer; if stale dates, web.search again with SESSION_CLOCK absolute date. FORBIDDEN browser."
          : "Prefer concrete tools or ask_user/complete over empty missions.",
    ].join("\n\n");

    const turn = await client.createResponse({
      conversationId: openaiConversationId,
      model: executor.model?.trim() || fileConfig.model,
      temperature:
        typeof executor.temperature === "number"
          ? executor.temperature
          : 0.2,
      instructions: MISSION_EXECUTOR_INSTRUCTIONS,
      textFormat: fileConfig.responseFormat,
      liveFacts,
      message: `Continue mission ${mission.id}. Goal: ${mission.goal}`,
    });

    const conversation = await prisma.chatConversation.findUnique({
      where: {
        userId_employeeId_digitalEmployeeId: {
          userId: mission.userId,
          employeeId: mission.speakerId,
          digitalEmployeeId: mission.orchestratorId,
        },
      },
      select: { id: true },
    });
    if (conversation) {
      await recordLlmUsage({
        conversationId: conversation.id,
        employeeId: mission.speakerId,
        digitalEmployeeId: mission.executorId,
        openaiConversationId,
        model: executor.model?.trim() || fileConfig.model,
        turn,
        purpose: "mission_turn",
      });
    }

    const metadata = parseReplyMetadata(turn.reply);
    const missions = metadata.missions ?? [];
    // Plan-only / no-op turns after browse started — treat like empty so dig can run.
    const actionableMissions = missions.filter((row) => {
      const a = row.action;
      return (
        a === "run_tools" ||
        a === "ask_user" ||
        a === "complete" ||
        a === "fail" ||
        a === "request_plan_approval" ||
        a === "request_approval"
      );
    });
    if (actionableMissions.length === 0) {
      const policy = emptyMissionTurnPolicy(mission);
      if (policy === "bootstrap_plan") {
        const bootstrapSteps = [...BOOTSTRAP_PLAN_STEPS];
        const summary = formatPlanApprovalText(mission.goal, bootstrapSteps);
        await applyMissionActions({
          userId: mission.userId,
          speaker: publicSpeaker,
          orchestrator: publicOrchestrator,
          asExecutor: true,
          actions: [
            {
              action: "update_plan",
              missionId: mission.id,
              planSteps: bootstrapSteps,
              summary,
            },
            {
              action: "request_plan_approval",
              missionId: mission.id,
              planSteps: bootstrapSteps,
              summary,
            },
          ],
        });
        await pushMissionMessageAsLucy({
          userId: mission.userId,
          speakerId: mission.speakerId,
          orchestratorId: mission.orchestratorId,
          text: summary,
          buttons: planApprovalButtons(mission.id),
          raw: { mission_id: mission.id, kind: "plan_approval" },
        });
        return;
      }
      if (policy === "continue_tools") {
        const fresh = toolFactsFromCtx(
          (await buildMissionTurnContext(missionId))?.toolResults ??
            ctx.toolResults,
        );
        if (shouldStartEngineWebSearch(mission, fresh)) {
          await engineStartWebSearchAndWake({
            userId: mission.userId,
            speaker: publicSpeaker,
            orchestrator: publicOrchestrator,
            mission,
          });
          return;
        }
        // Hosted web.search done, model empty — complete from evidence (no Bing).
        // Stale year vs SESSION_CLOCK → wake model to refine web.search only.
        {
          const doneFresh = doneToolFacts(fresh);
          const webRow = doneFresh.find((row) => row.tool === WEB_SEARCH_TOOL);
          if (
            webRow &&
            countBrowseTools(doneFresh) === 0 &&
            usesHostedWebSearchBootstrap(mission.goal)
          ) {
            const sample = (webRow.result_summary ?? "").trim();
            if (
              sample.length >= 20 &&
              webSearchLooksStaleForGoal(mission.goal, sample)
            ) {
              const retries = digEmptyRetryCount(mission.contextFacts);
              if (retries < 2) {
                await prisma.mission.update({
                  where: { id: mission.id },
                  data: {
                    status: "running",
                    waitingOn: "",
                    wakeAt: null,
                    contextFacts: bumpDigEmptyRetry(
                      mission.contextFacts,
                    ) as Prisma.InputJsonValue,
                    lastSummary: `החיפוש החזיר תאריך לא תואם — מחדדת שאילתה ל«${mission.goal}»`,
                  },
                });
                scheduleMissionWake(mission.id, 50);
                return;
              }
              await pushAskAndPark({
                userId: mission.userId,
                speakerId: mission.speakerId,
                orchestratorId: mission.orchestratorId,
                missionId: mission.id,
                summary: formatSearchFailedAsk(mission.goal),
              });
              return;
            }
            if (
              await completeMissionFromWebSearchEvidence({
                userId: mission.userId,
                speaker: publicSpeaker,
                orchestrator: publicOrchestrator,
                missionId: mission.id,
                goal: mission.goal,
                speakerId: mission.speakerId,
                orchestratorId: mission.orchestratorId,
                resultSummary: sample,
              })
            ) {
              return;
            }
            if (sample.length >= 20) {
              await pushAskAndPark({
                userId: mission.userId,
                speakerId: mission.speakerId,
                orchestratorId: mission.orchestratorId,
                missionId: mission.id,
                summary: formatSerpFactEvidenceAsk(mission.goal, sample),
              });
              return;
            }
          }
        }
        if (shouldBootstrapExtract(mission, fresh)) {
          await engineExtractAndComeBack({
            userId: mission.userId,
            speaker: publicSpeaker,
            orchestrator: publicOrchestrator,
            mission,
          });
          return;
        }
        if (shouldStopNavigateLoop(fresh)) {
          await pushAskAndPark({
            userId: mission.userId,
            speakerId: mission.speakerId,
            orchestratorId: mission.orchestratorId,
            missionId: mission.id,
            summary: formatNavigateLoopAsk(mission.goal),
          });
          return;
        }
        if (
          fresh.some((row) => row.tool === "browser.extract") &&
          missionNeedsFreshSearch(mission.contextFacts)
        ) {
          await recoverMissionSearchComeback(missionId);
          return;
        }
        // Empty after extract — prefer giving the model another dig turn over parking.
        {
          const doneFresh = doneToolFacts(fresh);
          const latestEx = latestDoneExtract(fresh);
          if (latestEx) {
          const sample = extractTextFromToolSummary(
            latestEx.result_summary ?? "",
          );
          // Still on SERP: for fact goals, if the SERP dump already answers →
          // wake model to complete; never dig away from good evidence.
          if (stillOnSearchEngineOnly(doneFresh)) {
            if (
              isFactMissionGoal(mission.goal) &&
              serpLooksLikeFactAnswer(mission.goal, sample)
            ) {
              const retries = digEmptyRetryCount(mission.contextFacts);
              if (retries < 2) {
                await prisma.mission.update({
                  where: { id: mission.id },
                  data: {
                    status: "running",
                    waitingOn: "",
                    wakeAt: null,
                    contextFacts: bumpDigEmptyRetry(
                      mission.contextFacts,
                    ) as Prisma.InputJsonValue,
                    lastSummary: `מצאתי מידע בחיפוש — מסכמת תשובה ל«${mission.goal}»`,
                  },
                });
                if (retries === 0) {
                  await pushMissionMessageAsLucy({
                    userId: mission.userId,
                    speakerId: mission.speakerId,
                    orchestratorId: mission.orchestratorId,
                    text: `מצאתי מידע בחיפוש ל«${mission.goal}» — מסכמת…`,
                    raw: {
                      mission_id: mission.id,
                      kind: "progress",
                      fact_from_serp: true,
                    },
                  });
                }
                scheduleMissionWake(mission.id, 200);
                return;
              }
              // Model failed to complete after wakes — present SERP evidence
              // (quote only; no invented score). Do NOT dig to hub/404 pages.
              await pushAskAndPark({
                userId: mission.userId,
                speakerId: mission.speakerId,
                orchestratorId: mission.orchestratorId,
                missionId: mission.id,
                summary: formatSerpFactEvidenceAsk(mission.goal, sample),
              });
              return;
            }
            const digUrls = topRelevantResultUrls(mission.goal, sample, 3).filter(
              (u) => !looksLikeGenericHubPath(u),
            );
            // No navigable result URLs — one generic «אתר רשמי» Bing refine (not site-hardcoded).
            if (digUrls.length === 0) {
              const latestNav = fresh.find(
                (row) => row.tool === "browser.navigate",
              );
              const alreadyRefined = /אתר(?:%20|\+| )?רשמי|official\s*site/iu.test(
                latestNav?.result_summary ?? "",
              );
              if (!alreadyRefined) {
                await applyMissionActions({
                  userId: mission.userId,
                  speaker: publicSpeaker,
                  orchestrator: publicOrchestrator,
                  asExecutor: true,
                  actions: [
                    {
                      action: "run_tools",
                      missionId: mission.id,
                      summary: `מחדדת חיפוש לאתר רשמי: ${mission.goal}`,
                      tools: [
                        {
                          tool: "browser.navigate",
                          args: {
                            url: searchFallbackUrlForGoal(
                              searchQueryFromMission({
                                goal: mission.goal,
                                contextFacts: mission.contextFacts,
                              }),
                            ),
                          },
                        },
                      ],
                    },
                  ],
                });
                await engineExtractAndComeBack({
                  userId: mission.userId,
                  speaker: publicSpeaker,
                  orchestrator: publicOrchestrator,
                  mission,
                });
                return;
              }
              await pushAskAndPark({
                userId: mission.userId,
                speakerId: mission.speakerId,
                orchestratorId: mission.orchestratorId,
                missionId: mission.id,
                summary: formatSearchBudgetExhaustedAsk(mission.goal),
              });
              return;
            }
            for (const digUrl of digUrls) {
              const digProgress = `נכנסת לאתר רלוונטי להמשך: ${digUrl}`;
              await pushMissionMessageAsLucy({
                userId: mission.userId,
                speakerId: mission.speakerId,
                orchestratorId: mission.orchestratorId,
                text: digProgress,
                raw: {
                  mission_id: mission.id,
                  kind: "progress",
                  dig_result: true,
                },
              });
              await applyMissionActions({
                userId: mission.userId,
                speaker: publicSpeaker,
                orchestrator: publicOrchestrator,
                asExecutor: true,
                actions: [
                  {
                    action: "run_tools",
                    missionId: mission.id,
                    summary: digProgress,
                    tools: [
                      { tool: "browser.navigate", args: { url: digUrl } },
                    ],
                  },
                ],
              });
              const afterNav = await prisma.missionToolCall.findFirst({
                where: { missionId: mission.id, tool: "browser.navigate" },
                orderBy: { createdAt: "desc" },
              });
              if (afterNav?.status !== "done") {
                continue;
              }
              const navSummary = afterNav.resultSummary ?? "";
              // Title/summary often has «404 / דף לא נמצא» even when body is a11y chrome.
              if (
                extractLooksLikeDeadPage(navSummary) ||
                navigateResultLooksUseless(navSummary)
              ) {
                continue;
              }
              // Peek extract — skip dead/404 pages and try the next SERP hit.
              await applyMissionActions({
                userId: mission.userId,
                speaker: publicSpeaker,
                orchestrator: publicOrchestrator,
                asExecutor: true,
                actions: [
                  {
                    action: "run_tools",
                    missionId: mission.id,
                    summary: `קוראת דף עבור «${mission.goal}»`,
                    tools: [
                      {
                        tool: "browser.extract",
                        args: { aspect: "search_results" },
                      },
                    ],
                  },
                ],
              });
              const afterEx = await prisma.missionToolCall.findFirst({
                where: {
                  missionId: mission.id,
                  tool: "browser.extract",
                  status: "done",
                },
                orderBy: { createdAt: "desc" },
              });
              const peekRaw = afterEx?.resultSummary ?? "";
              const peek = extractTextFromToolSummary(peekRaw);
              // Pass full summary so "(0 chars)" / empty payload is detected.
              if (
                !afterEx ||
                extractLooksLikeDeadPage(peekRaw) ||
                extractLooksLikeDeadPage(peek)
              ) {
                continue;
              }
              await prisma.mission.update({
                where: { id: mission.id },
                data: { status: "running", waitingOn: "", wakeAt: null },
              });
              scheduleMissionWake(mission.id, 50);
              return;
            }
            // All dig URLs failed — if SERP already had a fact answer, present it.
            if (
              isFactMissionGoal(mission.goal) &&
              serpLooksLikeFactAnswer(mission.goal, sample)
            ) {
              await pushAskAndPark({
                userId: mission.userId,
                speakerId: mission.speakerId,
                orchestratorId: mission.orchestratorId,
                missionId: mission.id,
                summary: formatSerpFactEvidenceAsk(mission.goal, sample),
              });
              return;
            }
          }
          // Destination page: re-wake the model to dig/ask/complete (model-owned).
          if (!stillOnSearchEngineOnly(doneFresh)) {
            const hostHint = doneFresh
              .map((row) => hostFromUrlOrSummary(row.result_summary ?? ""))
              .find((h): h is string => !!h && !isSearchEngineHost(h));
            const priorSerp = priorSerpFactExtract(mission.goal, doneFresh);
            const sampleDead =
              extractLooksLikeDeadPage(fresh[0]?.result_summary ?? "") ||
              extractLooksLikeDeadPage(sample);
            // Portal personal-data goals: ask credentials as soon as gate/login is visible.
            if (
              isPortalMissionGoal(mission.goal) &&
              (extractLooksLikeLogin(sample) ||
                extractLooksLikePortalGate(sample))
            ) {
              await pushAskAndPark({
                userId: mission.userId,
                speakerId: mission.speakerId,
                orchestratorId: mission.orchestratorId,
                missionId: mission.id,
                summary: formatLoginCredentialsAsk(
                  mission.goal,
                  hostHint,
                ),
                contextExtra: { awaiting_credentials: true },
              });
              return;
            }
            // Empty/dead destination but earlier SERP already answered the fact.
            if (
              sampleDead &&
              isFactMissionGoal(mission.goal) &&
              priorSerp
            ) {
              await pushAskAndPark({
                userId: mission.userId,
                speakerId: mission.speakerId,
                orchestratorId: mission.orchestratorId,
                missionId: mission.id,
                summary: formatSerpFactEvidenceAsk(mission.goal, priorSerp),
              });
              return;
            }
            if (sampleDead) {
              // Landed on a dead page outside SERP — ask speaker; avoid endless dig.
              await pushAskAndPark({
                userId: mission.userId,
                speakerId: mission.speakerId,
                orchestratorId: mission.orchestratorId,
                missionId: mission.id,
                summary: formatSearchBudgetExhaustedAsk(mission.goal),
              });
              return;
            }
            const retries = digEmptyRetryCount(mission.contextFacts);
            // Fact goal on fixtures/upcoming page: click past/results control once.
            const pastLabel =
              isFactMissionGoal(mission.goal) &&
              !serpLooksLikeFactAnswer(mission.goal, sample)
                ? pastResultsControlLabel(sample)
                : null;
            const alreadyPastClick = Array.isArray(mission.contextFacts)
              ? mission.contextFacts.some(
                  (f) =>
                    f &&
                    typeof f === "object" &&
                    (f as { past_results_click?: boolean }).past_results_click ===
                      true,
                )
              : false;
            if (pastLabel && !alreadyPastClick) {
              const digProgress = `עוברת ל«${pastLabel}» עבור «${mission.goal}»`;
              await pushMissionMessageAsLucy({
                userId: mission.userId,
                speakerId: mission.speakerId,
                orchestratorId: mission.orchestratorId,
                text: digProgress,
                raw: {
                  mission_id: mission.id,
                  kind: "progress",
                  past_results_click: true,
                },
              });
              const prevFacts = Array.isArray(mission.contextFacts)
                ? [...mission.contextFacts]
                : [];
              prevFacts.push({
                source: "engine",
                text: digProgress,
                at: new Date().toISOString(),
                past_results_click: true,
              });
              await prisma.mission.update({
                where: { id: mission.id },
                data: {
                  status: "running",
                  waitingOn: "",
                  wakeAt: null,
                  contextFacts: prevFacts as Prisma.InputJsonValue,
                  lastSummary: digProgress,
                },
              });
              await applyMissionActions({
                userId: mission.userId,
                speaker: publicSpeaker,
                orchestrator: publicOrchestrator,
                asExecutor: true,
                actions: [
                  {
                    action: "run_tools",
                    missionId: mission.id,
                    summary: digProgress,
                    tools: [
                      {
                        tool: "browser.click",
                        args: { text: pastLabel },
                      },
                      {
                        tool: "browser.extract",
                        args: { aspect: "page" },
                      },
                    ],
                  },
                ],
              });
              scheduleMissionWake(mission.id, 200);
              return;
            }
            if (retries < MAX_DIG_EMPTY_RETRIES) {
              await prisma.mission.update({
                where: { id: mission.id },
                data: {
                  status: "running",
                  waitingOn: "",
                  wakeAt: null,
                  contextFacts: bumpDigEmptyRetry(
                    mission.contextFacts,
                  ) as Prisma.InputJsonValue,
                  lastSummary: `ממשיכה לחפור באתר עבור: ${mission.goal}`,
                },
              });
              // One user-visible progress line — not spam on every empty retry.
              if (retries === 0) {
                await pushMissionMessageAsLucy({
                  userId: mission.userId,
                  speakerId: mission.speakerId,
                  orchestratorId: mission.orchestratorId,
                  text: `ממשיכה לחפור באתר עבור «${mission.goal}»…`,
                  raw: {
                    mission_id: mission.id,
                    kind: "progress",
                    dig_retry: 1,
                  },
                });
              }
              scheduleMissionWake(mission.id, 200);
              return;
            }
            // Retries exhausted — login / options / stuck ask by shape.
            if (
              extractLooksLikeLogin(sample) ||
              extractLooksLikePortalGate(sample)
            ) {
              await pushAskAndPark({
                userId: mission.userId,
                speakerId: mission.speakerId,
                orchestratorId: mission.orchestratorId,
                missionId: mission.id,
                summary: formatLoginCredentialsAsk(
                  mission.goal,
                  hostHint,
                ),
                contextExtra: { awaiting_credentials: true },
              });
              return;
            }
            if (isOptionsFindGoal(mission.goal) || isShoppingGoal(mission.goal)) {
              const productLines = relevantOptionLinesFromExtract(
                mission.goal,
                sample,
              );
              if (productLines.length >= 1) {
                await pushAskAndPark({
                  userId: mission.userId,
                  speakerId: mission.speakerId,
                  orchestratorId: mission.orchestratorId,
                  missionId: mission.id,
                  summary: formatProductOptionsAsk(
                    mission.goal,
                    productLines,
                  ),
                });
                return;
              }
            }
            // Fact goal: prefer quoting any extract that already answers (SERP or page).
            if (isFactMissionGoal(mission.goal)) {
              const evidence =
                (serpLooksLikeFactAnswer(mission.goal, sample)
                  ? sample
                  : null) ?? priorSerp;
              if (evidence) {
                await pushAskAndPark({
                  userId: mission.userId,
                  speakerId: mission.speakerId,
                  orchestratorId: mission.orchestratorId,
                  missionId: mission.id,
                  summary: formatSerpFactEvidenceAsk(mission.goal, evidence),
                });
                return;
              }
            }
            await pushAskAndPark({
              userId: mission.userId,
              speakerId: mission.speakerId,
              orchestratorId: mission.orchestratorId,
              missionId: mission.id,
              summary: formatDigStuckAsk(mission.goal, sample),
            });
            return;
          }
          const productLines = relevantOptionLinesFromExtract(
            mission.goal,
            sample,
          );
          await pushAskAndPark({
            userId: mission.userId,
            speakerId: mission.speakerId,
            orchestratorId: mission.orchestratorId,
            missionId: mission.id,
            summary:
              productLines.length >= 1
                ? formatProductOptionsAsk(mission.goal, productLines)
                : formatSearchBudgetExhaustedAsk(mission.goal),
          });
          return;
          }
        }
        // Never silent-loop: tell the speaker and park.
        await pushAskAndPark({
          userId: mission.userId,
          speakerId: mission.speakerId,
          orchestratorId: mission.orchestratorId,
          missionId: mission.id,
          summary: formatSearchBudgetExhaustedAsk(mission.goal),
        });
        return;
      }
      await setRetryWake(missionId);
      return;
    }

    const applied = await applyMissionActions({
      userId: mission.userId,
      speaker: publicSpeaker,
      orchestrator: publicOrchestrator,
      asExecutor: true,
      actions: actionableMissions,
    });

    // Model made progress — clear dig-empty retry counters.
    if (
      actionableMissions.length > 0 &&
      digEmptyRetryCount(mission.contextFacts) > 0
    ) {
      await prisma.mission.update({
        where: { id: mission.id },
        data: {
          contextFacts: clearDigEmptyRetries(
            mission.contextFacts,
          ) as Prisma.InputJsonValue,
        },
      });
    }

    // Model ran web.search but did not complete — promote evidence now
    // (avoids another multi-minute executor LLM turn after the answer is ready).
    if (
      usesHostedWebSearchBootstrap(mission.goal) &&
      !applied.notices.some(
        (n) => n.startsWith("done:") || n.startsWith("failed:"),
      ) &&
      actionableMissions.some(
        (row) =>
          row.action === "run_tools" &&
          (row.tools ?? []).some((t) => t.tool === WEB_SEARCH_TOOL),
      )
    ) {
      const webRow = await prisma.missionToolCall.findFirst({
        where: {
          missionId: mission.id,
          tool: WEB_SEARCH_TOOL,
          status: "done",
        },
        orderBy: { createdAt: "desc" },
      });
      const summary = webRow?.resultSummary ?? "";
      if (
        summary &&
        !webSearchLooksStaleForGoal(mission.goal, summary) &&
        (await completeMissionFromWebSearchEvidence({
          userId: mission.userId,
          speaker: publicSpeaker,
          orchestrator: publicOrchestrator,
          missionId: mission.id,
          goal: mission.goal,
          speakerId: mission.speakerId,
          orchestratorId: mission.orchestratorId,
          resultSummary: summary,
        }))
      ) {
        return;
      }
    }

    for (const notice of applied.notices) {
      if (notice.startsWith("plan_approval:")) {
        const id = notice.slice("plan_approval:".length);
        const row = await prisma.mission.findUnique({ where: { id } });
        if (row) {
          await pushMissionMessageAsLucy({
            userId: row.userId,
            speakerId: row.speakerId,
            orchestratorId: row.orchestratorId,
            text: row.lastSummary || formatPlanApprovalText(row.goal, []),
            buttons: planApprovalButtons(row.id),
            raw: { mission_id: row.id, kind: "plan_approval" },
          });
        }
      } else if (notice.startsWith("ask_user:")) {
        const id = notice.slice("ask_user:".length);
        const row = await prisma.mission.findUnique({ where: { id } });
        if (row?.lastSummary) {
          await pushMissionMessageAsLucy({
            userId: row.userId,
            speakerId: row.speakerId,
            orchestratorId: row.orchestratorId,
            text: row.lastSummary,
            raw: { mission_id: row.id, kind: "ask_user" },
          });
        }
      } else if (
        notice.startsWith("step_approval:") ||
        notice.startsWith("tool_approval:")
      ) {
        const toolCallId = notice.includes("tool_approval:")
          ? notice.slice("tool_approval:".length)
          : "";
        const row = await prisma.mission.findUnique({
          where: { id: mission.id },
        });
        if (row?.lastSummary) {
          await pushMissionMessageAsLucy({
            userId: row.userId,
            speakerId: row.speakerId,
            orchestratorId: row.orchestratorId,
            text: row.lastSummary,
            buttons: toolCallId ? stepApprovalButtons(toolCallId) : undefined,
            raw: {
              mission_id: row.id,
              kind: "step_approval",
              tool_call_id: toolCallId,
            },
          });
        }
      } else if (notice.startsWith("done:") || notice.startsWith("failed:")) {
        const row = await prisma.mission.findUnique({
          where: { id: mission.id },
        });
        if (row?.lastSummary) {
          await pushMissionMessageAsLucy({
            userId: row.userId,
            speakerId: row.speakerId,
            orchestratorId: row.orchestratorId,
            text: row.lastSummary,
            raw: { mission_id: row.id, kind: notice.split(":")[0] },
          });
        }
      }
    }

    for (const wakeId of applied.wakeIds) {
      scheduleMissionWake(wakeId, 200);
    }

    // Surface spoken executor summary if any (rare).
    const spoken = parseLlmReply(turn.reply).response.trim();
    if (spoken) {
      await pushMissionMessageAsLucy({
        userId: mission.userId,
        speakerId: mission.speakerId,
        orchestratorId: mission.orchestratorId,
        text: spoken,
        raw: { mission_id: mission.id, kind: "progress" },
      });
    }

    // If apply left the mission runnable with no wake scheduled, retry.
    if (applied.wakeIds.length === 0) {
      await setRetryWake(missionId);
    }
  } catch (error) {
    console.error(
      "Mission turn failed",
      missionId,
      error instanceof Error ? error.message : error,
    );
    try {
      await prisma.mission.update({
        where: { id: missionId },
        data: {
          wakeAt: new Date(Date.now() + 30_000),
          lastSummary: "שגיאה זמנית בביצוע — מנסה שוב",
        },
      });
    } catch {
      // ignore
    }
  } finally {
    running.delete(missionId);
    if (pendingWakes.has(missionId)) {
      pendingWakes.delete(missionId);
      setTimeout(() => {
        void runMissionTurn(missionId, { force: true });
      }, 50);
    }
  }
}
