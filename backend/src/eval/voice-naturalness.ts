/**
 * LIVE MODEL QA — Hebrew VOICE naturalness / repetition on sendChatMessage.
 *
 * Measurement suite (not a soft pass-rate corpus). Does not change VOICE,
 * temperature, or production behavior. Reports exact/near-duplicate rates and
 * qualitative notes without treating uniqueness as success/failure.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLlmReply } from "@workee/shared";
import { loadLlmConfig, type LlmConfig } from "../config/llm.js";
import { prisma } from "../database/prisma.js";
import { sendChatMessage } from "../services/chat.service.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
} from "./run-multi-turn.js";
import { assertApprovedEvalDatabaseUrl } from "./studio-db-guard.js";

/** Known A/B arms for VOICE naturalness comparison (QA only). */
export const VOICE_AB_BASELINE_COMMIT = "79b9846";
export const VOICE_AB_CURRENT_COMMIT = "3688eab";
export const VOICE_AB_BASELINE_SHA16 = "c25dcf23fad9749a";
export const VOICE_AB_CURRENT_SHA16 = "021c94579cb83cd6";

const HELP_CLOSERS = [
  "במה אוכל",
  "יש עוד משהו",
  "איך אוכל לעזור",
  "רוצה שאשמור",
  "רוצה שאעזור",
] as const;

const EMOJI_RE = /\p{Extended_Pictographic}/u;

export type VoiceNaturalnessScenarioId =
  | "greet-hi"
  | "thanks"
  | "personal-update"
  | "contextual-followup";

export type VoiceNaturalnessTurnRecord = {
  index: number;
  userMessage: string;
  response: string;
  responses: string[];
  /** Compact ACTION footprint — never secrets. */
  actionSummary: string;
  metadataKeys: string[];
};

export type VoiceNaturalnessSample = {
  scenarioId: VoiceNaturalnessScenarioId;
  sampleIndex: number; // 1-based
  harnessUserIdPrefix: string;
  /** Diagnostic prompt inputs (no secrets): seeded sha + user turns. */
  promptInput: {
    seededInstructionsSha16: string;
    userTurns: string[];
  };
  turns: VoiceNaturalnessTurnRecord[];
  /** Final speaker-facing text used for repetition stats (last turn). */
  primaryResponse: string;
  hardFailures: string[];
  observations: string[];
};

export type VoiceNaturalnessScenarioStats = {
  scenarioId: VoiceNaturalnessScenarioId;
  n: number;
  exactUnique: number;
  exactDuplicateRate: number;
  nearUnique: number;
  nearDuplicateRate: number;
  distinctOpenings: number;
  emojiRate: number;
  questionRate: number;
  nameRate: number;
  helpCloserHits: number;
  hardFailureCount: number;
  responses: Array<{
    sampleIndex: number;
    harnessUserIdPrefix: string;
    promptInput: VoiceNaturalnessSample["promptInput"];
    response: string;
    normalized: string;
    opening: string;
    hasEmoji: boolean;
    hasQuestion: boolean;
    usesName: boolean;
    helpClosers: string[];
    observations: string[];
    hardFailures: string[];
    turns: VoiceNaturalnessTurnRecord[];
  }>;
};

export type VoiceNaturalnessReport = {
  suite: "voice-naturalness";
  generatedAt: string;
  databaseName: string;
  prompt: {
    instructionsSha256: string;
    instructionsSha16: string;
    chars: number;
    model: string | null;
    temperature: number | null;
    reasoningEffort: string | null;
    hasSituationalVoice: boolean;
  };
  scenarios: VoiceNaturalnessScenarioStats[];
  qualitative: {
    findings: string[];
    goodExamples: Array<{ scenarioId: string; sampleIndex: number; why: string; response: string }>;
    weakExamples: Array<{ scenarioId: string; sampleIndex: number; why: string; response: string }>;
  };
  hardOk: boolean;
  hardFailures: string[];
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function redactId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

function extractRawMetadata(replyText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(replyText) as { metadata?: unknown };
    if (parsed?.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)) {
      return parsed.metadata as Record<string, unknown>;
    }
  } catch {
    // non-JSON model/engine wrap — treat as no metadata
  }
  return null;
}

function actionSummary(meta: Record<string, unknown> | null): string {
  if (!meta) return "none";
  const bits: string[] = [];
  for (const key of ["lists", "jobs", "messages", "reminders", "directory", "list_ops"] as const) {
    const v = meta[key];
    if (Array.isArray(v) && v.length) bits.push(`${key}:${v.length}`);
  }
  if (meta.show_dump) bits.push("show_dump");
  return bits.length ? bits.join(",") : "empty";
}

function metadataKeys(meta: Record<string, unknown> | null): string[] {
  if (!meta) return [];
  return Object.keys(meta).filter((k) => {
    const v = meta[k];
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as object).length > 0;
    if (typeof v === "string") return v.trim().length > 0;
    return true;
  });
}

/** Strip emoji/punctuation/whitespace for near-duplicate comparison. */
export function normalizeForNearDup(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(EMOJI_RE, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function openingPhrase(text: string): string {
  const tokens = normalizeForNearDup(text).split(" ").filter(Boolean);
  return tokens.slice(0, 3).join(" ");
}

function helpClosersIn(text: string): string[] {
  return HELP_CLOSERS.filter((s) => text.includes(s));
}

function usesSpeakerName(text: string): boolean {
  return /(?:^|[^\p{L}])טל(?:[^\p{L}]|$)/u.test(text);
}

type ScenarioSpec = {
  id: VoiceNaturalnessScenarioId;
  label: string;
  /** User turns in order. */
  turns: string[];
  /** Tokens the final reply should often reflect (observation). */
  contextTokens?: string[];
  /** Empathy / relevance tokens for personal updates. */
  relevanceTokens?: string[];
};

const SCENARIOS: ScenarioSpec[] = [
  {
    id: "greet-hi",
    label: "Independent bare greeting",
    turns: ["היי"],
  },
  {
    id: "thanks",
    label: "Independent thanks",
    turns: ["תודה"],
  },
  {
    id: "personal-update",
    label: "Short personal update",
    turns: ["היה יום ממש עמוס בעבודה, סוף סוף בבית"],
    relevanceTokens: ["עמוס", "בית", "מתיש", "נוח", "לנוח", "עייפ", "קשה", "סוף"],
  },
  {
    id: "contextual-followup",
    label: "Contextual follow-up (workout → park run)",
    turns: ["היי, חזרתי עכשיו מהאימון", "כן, רצתי חצי שעה בפארק"],
    contextTokens: ["אימון", "ריצ", "פארק", "חצי", "שעה", "רצ"],
  },
];

function observeSample(
  spec: ScenarioSpec,
  primary: string,
  turns: VoiceNaturalnessTurnRecord[],
): { hardFailures: string[]; observations: string[] } {
  const hardFailures: string[] = [];
  const observations: string[] = [];
  if (!primary.trim()) hardFailures.push("empty_response");

  const closers = helpClosersIn(primary);
  if (closers.length) {
    hardFailures.push(`help_closer:${closers.join("|")}`);
  }

  const mutated = turns.some((t) => t.actionSummary !== "empty" && t.actionSummary !== "none");
  if (spec.id === "personal-update" && mutated) {
    hardFailures.push(`unexpected_mutation:${turns.map((t) => t.actionSummary).join(";")}`);
  }
  if ((spec.id === "greet-hi" || spec.id === "thanks") && mutated) {
    observations.push(`unexpected_action_on_casual:${turns.map((t) => t.actionSummary).join(";")}`);
  }

  if (spec.relevanceTokens?.length) {
    const hit = spec.relevanceTokens.some((tok) => primary.includes(tok));
    observations.push(hit ? "relevance_token_hit" : "relevance_token_miss");
  }
  if (spec.contextTokens?.length) {
    const hit = spec.contextTokens.some((tok) => primary.includes(tok));
    observations.push(hit ? "context_token_hit" : "context_token_miss");
    if (!hit) {
      observations.push("weak_context_grounding");
    }
  }

  if (EMOJI_RE.test(primary)) observations.push("has_emoji");
  if (/[?？]/.test(primary)) observations.push("has_question");
  if (usesSpeakerName(primary)) observations.push("uses_name");

  return { hardFailures, observations };
}

export type SeededPromptConfig = Pick<
  LlmConfig,
  "systemMessage" | "model" | "temperature" | "reasoningEffort"
>;

async function withSeededAccount<T>(
  seed: SeededPromptConfig,
  fn: (say: (message: string) => Promise<VoiceNaturalnessTurnRecord>) => Promise<T>,
): Promise<T & { harnessUserIdPrefix: string }> {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  const account = await createHarnessAccount("טל", {
    digitalWorker: true,
    addressGender: "male",
  });
  if (!account.digitalEmployeeId) {
    await destroyHarnessAccount(account);
    throw new Error("harness account missing digitalEmployeeId");
  }
  await prisma.employee.update({
    where: { id: account.digitalEmployeeId },
    data: {
      instructions: seed.systemMessage,
      model: seed.model,
      temperature: seed.temperature,
      reasoningEffort: seed.reasoningEffort,
    },
  });

  let turnIndex = 0;
  const say = async (message: string): Promise<VoiceNaturalnessTurnRecord> => {
    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: account.digitalEmployeeId,
      message,
    });
    const reply = parseLlmReply(result.reply);
    const meta = extractRawMetadata(result.reply);
    const responses = Array.isArray(reply.responses)
      ? reply.responses.map((r) => String(r ?? ""))
      : [String(reply.response ?? "")];
    const response = String(reply.response ?? responses.filter(Boolean).join("\n") ?? "");
    const record: VoiceNaturalnessTurnRecord = {
      index: turnIndex,
      userMessage: message,
      response,
      responses,
      actionSummary: actionSummary(meta),
      metadataKeys: metadataKeys(meta),
    };
    turnIndex += 1;
    return record;
  };

  try {
    const value = await fn(say);
    return { ...value, harnessUserIdPrefix: redactId(account.userId) };
  } finally {
    await prisma.chatMessage
      .deleteMany({ where: { conversation: { userId: account.userId } } })
      .catch(() => undefined);
    await prisma.chatConversation
      .deleteMany({ where: { userId: account.userId } })
      .catch(() => undefined);
    await destroyHarnessAccount(account);
  }
}

function summarizeScenario(
  scenarioId: VoiceNaturalnessScenarioId,
  samples: VoiceNaturalnessSample[],
): VoiceNaturalnessScenarioStats {
  const rows = samples.map((s) => {
    const response = s.primaryResponse;
    return {
      sampleIndex: s.sampleIndex,
      harnessUserIdPrefix: s.harnessUserIdPrefix,
      promptInput: s.promptInput,
      response,
      normalized: normalizeForNearDup(response),
      opening: openingPhrase(response),
      hasEmoji: EMOJI_RE.test(response),
      hasQuestion: /[?？]/.test(response),
      usesName: usesSpeakerName(response),
      helpClosers: helpClosersIn(response),
      observations: s.observations,
      hardFailures: s.hardFailures,
      turns: s.turns,
    };
  });
  const n = rows.length;
  const exactUnique = new Set(rows.map((r) => r.response.trim())).size;
  const nearUnique = new Set(rows.map((r) => r.normalized)).size;
  const openings = new Set(rows.map((r) => r.opening).filter(Boolean)).size;
  return {
    scenarioId,
    n,
    exactUnique,
    exactDuplicateRate: n ? (n - exactUnique) / n : 0,
    nearUnique,
    nearDuplicateRate: n ? (n - nearUnique) / n : 0,
    distinctOpenings: openings,
    emojiRate: n ? rows.filter((r) => r.hasEmoji).length / n : 0,
    questionRate: n ? rows.filter((r) => r.hasQuestion).length / n : 0,
    nameRate: n ? rows.filter((r) => r.usesName).length / n : 0,
    helpCloserHits: rows.filter((r) => r.helpClosers.length).length,
    hardFailureCount: rows.filter((r) => r.hardFailures.length).length,
    responses: rows,
  };
}

function buildQualitative(
  scenarios: VoiceNaturalnessScenarioStats[],
): VoiceNaturalnessReport["qualitative"] {
  const findings: string[] = [];
  const goodExamples: VoiceNaturalnessReport["qualitative"]["goodExamples"] = [];
  const weakExamples: VoiceNaturalnessReport["qualitative"]["weakExamples"] = [];

  for (const sc of scenarios) {
    findings.push(
      `${sc.scenarioId}: exact unique ${sc.exactUnique}/${sc.n} (dup rate ${(sc.exactDuplicateRate * 100).toFixed(0)}%), near-unique ${sc.nearUnique}/${sc.n}, openings ${sc.distinctOpenings}, emoji ${(sc.emojiRate * 100).toFixed(0)}% (observation), questions ${(sc.questionRate * 100).toFixed(0)}%, name ${(sc.nameRate * 100).toFixed(0)}%, help-closers ${sc.helpCloserHits}.`,
    );

    if (sc.scenarioId === "personal-update") {
      const hits = sc.responses.filter((r) => r.observations.includes("relevance_token_hit"));
      const misses = sc.responses.filter((r) => r.observations.includes("relevance_token_miss"));
      findings.push(
        `personal-update relevance: ${hits.length}/${sc.n} hit content tokens; ${misses.length} missed.`,
      );
      const good = hits.find((r) => !r.hardFailures.length && r.response.length > 20);
      if (good) {
        goodExamples.push({
          scenarioId: sc.scenarioId,
          sampleIndex: good.sampleIndex,
          why: "Acknowledges the personal share without help-closers or mutations",
          response: good.response,
        });
      }
      const weak = misses[0] ?? sc.responses.find((r) => r.hardFailures.length);
      if (weak) {
        weakExamples.push({
          scenarioId: sc.scenarioId,
          sampleIndex: weak.sampleIndex,
          why: weak.hardFailures.length
            ? `Hard failure: ${weak.hardFailures.join(", ")}`
            : "Little grounding in the personal update content",
          response: weak.response,
        });
      }
    }

    if (sc.scenarioId === "contextual-followup") {
      const hits = sc.responses.filter((r) => r.observations.includes("context_token_hit"));
      const misses = sc.responses.filter((r) => r.observations.includes("context_token_miss"));
      findings.push(
        `contextual-followup grounding: ${hits.length}/${sc.n} mention workout/run/park cues; ${misses.length} look ungrounded.`,
      );
      const good = hits.find((r) => !r.hardFailures.length);
      if (good) {
        goodExamples.push({
          scenarioId: sc.scenarioId,
          sampleIndex: good.sampleIndex,
          why: "Follow-up reflects prior workout/run context",
          response: good.response,
        });
      }
      const weak = misses[0];
      if (weak) {
        weakExamples.push({
          scenarioId: sc.scenarioId,
          sampleIndex: weak.sampleIndex,
          why: "Follow-up does not clearly use prior conversation cues",
          response: weak.response,
        });
      }
    }

    if (sc.scenarioId === "greet-hi" || sc.scenarioId === "thanks") {
      // Cluster note — not a failure.
      if (sc.nearDuplicateRate >= 0.5) {
        findings.push(
          `${sc.scenarioId}: high near-duplicate clustering (${(sc.nearDuplicateRate * 100).toFixed(0)}%) — note only; short acks may legitimately converge.`,
        );
      }
      const warm = sc.responses.find(
        (r) => !r.hardFailures.length && (r.hasEmoji || r.hasQuestion || r.response.length > 8),
      );
      if (warm) {
        goodExamples.push({
          scenarioId: sc.scenarioId,
          sampleIndex: warm.sampleIndex,
          why: "Short casual reply without help-closer padding",
          response: warm.response,
        });
      }
      const weak = sc.responses.find((r) => r.hardFailures.length);
      if (weak) {
        weakExamples.push({
          scenarioId: sc.scenarioId,
          sampleIndex: weak.sampleIndex,
          why: `Hard failure: ${weak.hardFailures.join(", ")}`,
          response: weak.response,
        });
      }
    }
  }

  findings.push(
    "Emoji rate is observational only — neither high nor low frequency is scored as success/failure.",
  );
  findings.push(
    "Uniqueness is descriptive only — repeated appropriate wording is not a failure; unique wording is not automatic success.",
  );

  return { findings, goodExamples, weakExamples };
}

export function formatVoiceNaturalnessMarkdown(report: VoiceNaturalnessReport): string {
  const lines: string[] = [];
  lines.push(`# VOICE naturalness LIVE MODEL QA`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`DB: ${report.databaseName}`);
  lines.push(
    `Prompt sha16=${report.prompt.instructionsSha16} chars=${report.prompt.chars} model=${report.prompt.model} temp=${report.prompt.temperature} situationalVoice=${report.prompt.hasSituationalVoice}`,
  );
  lines.push(`Hard OK: ${report.hardOk ? "yes" : "no"}`);
  if (report.hardFailures.length) {
    lines.push(`Hard failures: ${report.hardFailures.join("; ")}`);
  }
  lines.push("");
  lines.push(`## Findings`);
  for (const f of report.qualitative.findings) lines.push(`- ${f}`);
  lines.push("");
  lines.push(`## Good examples`);
  for (const g of report.qualitative.goodExamples) {
    lines.push(`- **${g.scenarioId}#${g.sampleIndex}** — ${g.why}`);
    lines.push(`  - \`${g.response.replace(/`/g, "'")}\``);
  }
  if (!report.qualitative.goodExamples.length) lines.push(`- (none selected)`);
  lines.push("");
  lines.push(`## Weak examples`);
  for (const w of report.qualitative.weakExamples) {
    lines.push(`- **${w.scenarioId}#${w.sampleIndex}** — ${w.why}`);
    lines.push(`  - \`${w.response.replace(/`/g, "'")}\``);
  }
  if (!report.qualitative.weakExamples.length) lines.push(`- (none selected)`);
  lines.push("");

  for (const sc of report.scenarios) {
    lines.push(`## ${sc.scenarioId} (n=${sc.n})`);
    lines.push("");
    lines.push(
      `| metric | value |`,
    );
    lines.push(`| --- | --- |`);
    lines.push(`| exact unique | ${sc.exactUnique}/${sc.n} |`);
    lines.push(`| exact duplicate rate | ${(sc.exactDuplicateRate * 100).toFixed(1)}% |`);
    lines.push(`| near-unique | ${sc.nearUnique}/${sc.n} |`);
    lines.push(`| near-duplicate rate | ${(sc.nearDuplicateRate * 100).toFixed(1)}% |`);
    lines.push(`| distinct openings | ${sc.distinctOpenings} |`);
    lines.push(`| emoji rate (obs.) | ${(sc.emojiRate * 100).toFixed(1)}% |`);
    lines.push(`| question rate | ${(sc.questionRate * 100).toFixed(1)}% |`);
    lines.push(`| name rate | ${(sc.nameRate * 100).toFixed(1)}% |`);
    lines.push(`| help-closer hits | ${sc.helpCloserHits} |`);
    lines.push("");
    for (const r of sc.responses) {
      lines.push(`### sample ${r.sampleIndex}`);
      for (const t of r.turns) {
        lines.push(`- U${t.index}: ${t.userMessage}`);
        lines.push(`- A${t.index}: ${t.response}`);
        lines.push(`  - actions=${t.actionSummary}; metaKeys=${t.metadataKeys.join(",") || "—"}`);
      }
      if (r.hardFailures.length) lines.push(`- hard: ${r.hardFailures.join(", ")}`);
      if (r.observations.length) lines.push(`- obs: ${r.observations.join(", ")}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

export function writeVoiceNaturalnessReports(
  report: VoiceNaturalnessReport,
  docsQaDir?: string,
): { jsonPath: string; mdPath: string } {
  const root = docsQaDir
    ?? resolve(fileURLToPath(new URL("../../../docs/qa/", import.meta.url)));
  mkdirSync(root, { recursive: true });
  const jsonPath = resolve(root, "voice-naturalness-last-report.json");
  const mdPath = resolve(root, "voice-naturalness-last-report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, formatVoiceNaturalnessMarkdown(report), "utf8");
  return { jsonPath, mdPath };
}

export type RunVoiceNaturalnessOptions = {
  repeats?: number;
  scenarios?: VoiceNaturalnessScenarioId[];
  /**
   * Exact systemMessage to seed onto each harness Lucy.
   * Defaults to current LLM.config.json. Model/temp/effort always from file
   * unless seedConfig overrides them.
   */
  systemMessage?: string;
  /** Optional full seed (systemMessage + model settings). */
  seedConfig?: SeededPromptConfig;
  /** Label for logs (e.g. baseline / current). */
  armLabel?: string;
};

function assertLiveEvalEnv(): string {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  if (process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND !== "1") {
    throw new Error("WORKEE_DISABLE_WHATSAPP_OUTBOUND must be 1");
  }
  if (process.env.WORKEE_DISABLE_REMINDER_FIRE !== "1") {
    throw new Error("WORKEE_DISABLE_REMINDER_FIRE must be 1");
  }
  const dbName = new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, "");
  if (dbName !== "workee_test") {
    throw new Error(`Refusing: database must be workee_test, got ${dbName}`);
  }
  return dbName;
}

function resolveSeedConfig(options: RunVoiceNaturalnessOptions): SeededPromptConfig {
  const file = loadLlmConfig();
  if (options.seedConfig) return options.seedConfig;
  if (options.systemMessage) {
    return {
      systemMessage: options.systemMessage,
      model: file.model,
      temperature: file.temperature,
      reasoningEffort: file.reasoningEffort,
    };
  }
  return {
    systemMessage: file.systemMessage,
    model: file.model,
    temperature: file.temperature,
    reasoningEffort: file.reasoningEffort,
  };
}

function docsQaRoot(docsQaDir?: string): string {
  return (
    docsQaDir ??
    resolve(fileURLToPath(new URL("../../../docs/qa/", import.meta.url)))
  );
}

/** Load systemMessage from `git show <commit>:LLM.config.json` (array-joined). */
export function loadSystemMessageFromGitCommit(
  commit: string,
  repoRoot?: string,
): { systemMessage: string; sha256: string; sha16: string; chars: number } {
  const root =
    repoRoot ??
    resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const raw = execFileSync(
    "git",
    ["show", `${commit}:LLM.config.json`],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw) as { systemMessage?: unknown };
  const systemMessage = Array.isArray(parsed.systemMessage)
    ? parsed.systemMessage.map((line) => String(line)).join("\n")
    : String(parsed.systemMessage ?? "");
  if (!systemMessage.trim()) {
    throw new Error(`Empty systemMessage at ${commit}:LLM.config.json`);
  }
  const digest = sha256(systemMessage);
  return {
    systemMessage,
    sha256: digest,
    sha16: digest.slice(0, 16),
    chars: systemMessage.length,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(items: T[], rand: () => number): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
}

/**
 * Run the suite. Caller must set workee_test + kill switches + OPENAI_API_KEY.
 */
export async function runVoiceNaturalnessSuite(
  options: RunVoiceNaturalnessOptions = {},
): Promise<VoiceNaturalnessReport> {
  const dbName = assertLiveEvalEnv();
  const repeats = Math.max(1, Math.min(options.repeats ?? 10, 20));
  const wanted = new Set(
    options.scenarios ?? SCENARIOS.map((s) => s.id),
  );
  const seed = resolveSeedConfig(options);
  const instructionsSha = sha256(seed.systemMessage);
  const instructionsSha16 = instructionsSha.slice(0, 16);
  const arm = options.armLabel ? `[${options.armLabel}] ` : "";

  const samples: VoiceNaturalnessSample[] = [];
  for (const spec of SCENARIOS) {
    if (!wanted.has(spec.id)) continue;
    for (let i = 1; i <= repeats; i += 1) {
      process.stderr.write(
        `[voice-naturalness] ${arm}${spec.id} ${i}/${repeats}\n`,
      );
      const run = await withSeededAccount(seed, async (say) => {
        const turns: VoiceNaturalnessTurnRecord[] = [];
        for (const utterance of spec.turns) {
          turns.push(await say(utterance));
        }
        const primaryResponse = turns[turns.length - 1]?.response ?? "";
        const { hardFailures, observations } = observeSample(
          spec,
          primaryResponse,
          turns,
        );
        return { turns, primaryResponse, hardFailures, observations };
      });
      samples.push({
        scenarioId: spec.id,
        sampleIndex: i,
        harnessUserIdPrefix: run.harnessUserIdPrefix,
        promptInput: {
          seededInstructionsSha16: instructionsSha16,
          userTurns: spec.turns,
        },
        turns: run.turns,
        primaryResponse: run.primaryResponse,
        hardFailures: run.hardFailures,
        observations: run.observations,
      });
    }
  }

  const scenarioStats = SCENARIOS.filter((s) => wanted.has(s.id)).map((s) =>
    summarizeScenario(
      s.id,
      samples.filter((row) => row.scenarioId === s.id),
    ),
  );

  const hardFailures = samples.flatMap((s) =>
    s.hardFailures.map((f) => `${s.scenarioId}#${s.sampleIndex}:${f}`),
  );

  const report: VoiceNaturalnessReport = {
    suite: "voice-naturalness",
    generatedAt: new Date().toISOString(),
    databaseName: dbName,
    prompt: {
      instructionsSha256: instructionsSha,
      instructionsSha16,
      chars: seed.systemMessage.length,
      model: seed.model ?? null,
      temperature: seed.temperature ?? null,
      reasoningEffort: seed.reasoningEffort ?? null,
      hasSituationalVoice: seed.systemMessage.includes(
        "respond to the person and the moment",
      ),
    },
    scenarios: scenarioStats,
    qualitative: buildQualitative(scenarioStats),
    hardOk: hardFailures.length === 0,
    hardFailures,
  };

  return report;
}

export type VoiceAbArmId = "baseline" | "current";

export type VoiceAbArmMeta = {
  id: VoiceAbArmId;
  label: string;
  commit: string;
  expectedSha16: string;
  instructionsSha256: string;
  instructionsSha16: string;
  chars: number;
  hasSituationalVoice: boolean;
};

export type VoiceAbScenarioComparison = {
  scenarioId: VoiceNaturalnessScenarioId;
  baseline: VoiceNaturalnessScenarioStats;
  current: VoiceNaturalnessScenarioStats;
  delta: {
    exactUnique: number;
    nearUnique: number;
    distinctOpenings: number;
    emojiRate: number;
    helpCloserHits: number;
    relevanceHitRate: number | null;
    contextHitRate: number | null;
  };
  assessment: string;
  examples: {
    baseline: string[];
    current: string[];
  };
};

export type VoiceNaturalnessAbReport = {
  suite: "voice-naturalness-ab";
  generatedAt: string;
  databaseName: string;
  config: {
    model: string | null;
    temperature: number | null;
    reasoningEffort: string | null;
    repeatsPerArm: number;
    shuffleSeed: number;
    executionOrder: Array<{
      arm: VoiceAbArmId;
      scenarioId: VoiceNaturalnessScenarioId;
      sampleIndex: number;
    }>;
  };
  arms: {
    baseline: VoiceAbArmMeta;
    current: VoiceAbArmMeta;
  };
  scenarios: VoiceAbScenarioComparison[];
  overall: {
    clearlyBetter: string[];
    noMeaningfulDifference: string[];
    regressions: string[];
    shortAckRepetitionAcceptable: boolean;
    recommendation: "accept" | "accept-with-notes" | "reject";
    summary: string;
  };
  baselineReport: VoiceNaturalnessReport;
  currentReport: VoiceNaturalnessReport;
};

function hitRate(
  stats: VoiceNaturalnessScenarioStats,
  obs: string,
): number | null {
  if (!stats.n) return null;
  const hits = stats.responses.filter((r) => r.observations.includes(obs)).length;
  return hits / stats.n;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function assessScenarioPair(
  scenarioId: VoiceNaturalnessScenarioId,
  baseline: VoiceNaturalnessScenarioStats,
  current: VoiceNaturalnessScenarioStats,
): string {
  const notes: string[] = [];
  const bRel = hitRate(baseline, "relevance_token_hit");
  const cRel = hitRate(current, "relevance_token_hit");
  const bCtx = hitRate(baseline, "context_token_hit");
  const cCtx = hitRate(current, "context_token_hit");

  if (scenarioId === "personal-update" && bRel != null && cRel != null) {
    if (cRel > bRel + 0.05) notes.push("current grounds personal content more often");
    else if (bRel > cRel + 0.05) notes.push("baseline grounded personal content more often");
    else notes.push("personal relevance similar");
  }
  if (scenarioId === "contextual-followup" && bCtx != null && cCtx != null) {
    if (cCtx > bCtx + 0.05) notes.push("current uses prior-turn cues more often");
    else if (bCtx > cCtx + 0.05) notes.push("baseline used prior-turn cues more often");
    else notes.push("context grounding similar");
  }
  if (current.helpCloserHits < baseline.helpCloserHits) {
    notes.push("current fewer help-closers");
  } else if (current.helpCloserHits > baseline.helpCloserHits) {
    notes.push("current more help-closers (regression risk)");
  }
  if (
    scenarioId === "greet-hi" ||
    scenarioId === "thanks"
  ) {
    notes.push(
      `short-ack clustering: baseline near-dup ${pct(baseline.nearDuplicateRate)}, current ${pct(current.nearDuplicateRate)} (descriptive)`,
    );
  } else if (current.exactUnique > baseline.exactUnique + 1) {
    notes.push("current shows more exact variety (descriptive)");
  } else if (baseline.exactUnique > current.exactUnique + 1) {
    notes.push("baseline showed more exact variety (descriptive)");
  }
  if (!notes.length) notes.push("no clear difference on scored dimensions");
  return notes.join("; ");
}

function buildOverallAssessment(
  scenarios: VoiceAbScenarioComparison[],
  baseline: VoiceNaturalnessReport,
  current: VoiceNaturalnessReport,
): VoiceNaturalnessAbReport["overall"] {
  const clearlyBetter: string[] = [];
  const noMeaningfulDifference: string[] = [];
  const regressions: string[] = [];

  for (const sc of scenarios) {
    const a = sc.assessment.toLowerCase();
    if (a.includes("regression")) {
      regressions.push(`${sc.scenarioId}: ${sc.assessment}`);
    } else if (
      a.includes("current grounds") ||
      a.includes("current uses prior") ||
      a.includes("current fewer help")
    ) {
      clearlyBetter.push(`${sc.scenarioId}: ${sc.assessment}`);
    } else if (
      a.includes("similar") ||
      a.includes("no clear difference") ||
      a.includes("short-ack clustering")
    ) {
      // short-ack alone is not "clearly better"
      if (
        sc.scenarioId === "greet-hi" ||
        sc.scenarioId === "thanks"
      ) {
        noMeaningfulDifference.push(`${sc.scenarioId}: short acks still cluster; help-closers ${sc.current.helpCloserHits} vs baseline ${sc.baseline.helpCloserHits}`);
      } else if (a.includes("similar") || a.includes("no clear")) {
        noMeaningfulDifference.push(`${sc.scenarioId}: ${sc.assessment}`);
      }
    } else {
      noMeaningfulDifference.push(`${sc.scenarioId}: ${sc.assessment}`);
    }
  }

  const shortAckRepetitionAcceptable =
    scenarios
      .filter((s) => s.scenarioId === "greet-hi" || s.scenarioId === "thanks")
      .every((s) => s.current.helpCloserHits === 0 && s.current.hardFailureCount === 0);

  const personal = scenarios.find((s) => s.scenarioId === "personal-update");
  const contextual = scenarios.find((s) => s.scenarioId === "contextual-followup");
  const personalOk =
    (personal?.delta.relevanceHitRate ?? 0) >= -0.05 &&
    (personal?.current.helpCloserHits ?? 0) === 0;
  const contextualOk =
    (contextual?.delta.contextHitRate ?? 0) >= -0.05 &&
    (contextual?.current.helpCloserHits ?? 0) === 0;

  let recommendation: VoiceNaturalnessAbReport["overall"]["recommendation"] =
    "accept-with-notes";
  if (regressions.length || !current.hardOk) {
    recommendation = "reject";
  } else if (personalOk && contextualOk && shortAckRepetitionAcceptable) {
    // Accept when current holds relevance/context and adds no closers —
    // even if short-ack metrics are parity (clustering is expected).
    recommendation = clearlyBetter.length > 0 ? "accept" : "accept-with-notes";
    if (
      clearlyBetter.length === 0 &&
      current.prompt.hasSituationalVoice &&
      !baseline.prompt.hasSituationalVoice
    ) {
      recommendation = "accept-with-notes";
    }
  }

  const summary = [
    `Baseline ${VOICE_AB_BASELINE_COMMIT} (${VOICE_AB_BASELINE_SHA16}) vs current ${VOICE_AB_CURRENT_COMMIT} (${VOICE_AB_CURRENT_SHA16}).`,
    clearlyBetter.length
      ? `Clear gains: ${clearlyBetter.map((x) => x.split(":")[0]).join(", ")}.`
      : "No strong scenario-level gains beyond parity.",
    noMeaningfulDifference.length
      ? `Parity / expected clustering: ${noMeaningfulDifference.map((x) => x.split(":")[0]).join(", ")}.`
      : "",
    regressions.length ? `Regressions: ${regressions.join(" | ")}.` : "No help-closer / hard-fail regressions detected.",
    shortAckRepetitionAcceptable
      ? "Remaining greeting/thanks repetition looks acceptable for short acks."
      : "Short-ack repetition needs review (closers or hard fails).",
    `Recommendation: ${recommendation}.`,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    clearlyBetter,
    noMeaningfulDifference,
    regressions,
    shortAckRepetitionAcceptable,
    recommendation,
    summary,
  };
}

/**
 * Controlled A/B: same scenarios/model/temp; only systemMessage differs.
 * Interleaves arms with a seeded shuffle to reduce ordering bias.
 */
export async function runVoiceNaturalnessAbComparison(
  options: {
    repeats?: number;
    shuffleSeed?: number;
    baselineCommit?: string;
    currentCommit?: string;
    expectedBaselineSha16?: string;
    expectedCurrentSha16?: string;
  } = {},
): Promise<VoiceNaturalnessAbReport> {
  const dbName = assertLiveEvalEnv();
  const repeats = Math.max(1, Math.min(options.repeats ?? 10, 20));
  const envSeed = Number.parseInt(process.env.VOICE_NATURALNESS_AB_SEED ?? "", 10);
  const shuffleSeed =
    options.shuffleSeed ??
    (Number.isFinite(envSeed) ? envSeed : Date.now() % 1_000_000_000);
  const rand = mulberry32(shuffleSeed);

  const file = loadLlmConfig();
  const baselineCommit = options.baselineCommit ?? VOICE_AB_BASELINE_COMMIT;
  const currentCommit = options.currentCommit ?? VOICE_AB_CURRENT_COMMIT;
  const expectedBaseline =
    options.expectedBaselineSha16 ?? VOICE_AB_BASELINE_SHA16;
  const expectedCurrent =
    options.expectedCurrentSha16 ?? VOICE_AB_CURRENT_SHA16;

  const baselinePrompt = loadSystemMessageFromGitCommit(baselineCommit);
  const currentPrompt = loadSystemMessageFromGitCommit(currentCommit);
  if (baselinePrompt.sha16 !== expectedBaseline) {
    throw new Error(
      `Baseline sha16 mismatch: got ${baselinePrompt.sha16}, expected ${expectedBaseline}`,
    );
  }
  if (currentPrompt.sha16 !== expectedCurrent) {
    throw new Error(
      `Current sha16 mismatch: got ${currentPrompt.sha16}, expected ${expectedCurrent}`,
    );
  }

  const baselineSeed: SeededPromptConfig = {
    systemMessage: baselinePrompt.systemMessage,
    model: file.model,
    temperature: file.temperature,
    reasoningEffort: file.reasoningEffort,
  };
  const currentSeed: SeededPromptConfig = {
    systemMessage: currentPrompt.systemMessage,
    model: file.model,
    temperature: file.temperature,
    reasoningEffort: file.reasoningEffort,
  };

  type Job = {
    arm: VoiceAbArmId;
    scenarioId: VoiceNaturalnessScenarioId;
    sampleIndex: number;
  };
  const jobs: Job[] = [];
  for (const spec of SCENARIOS) {
    for (let i = 1; i <= repeats; i += 1) {
      jobs.push({ arm: "baseline", scenarioId: spec.id, sampleIndex: i });
      jobs.push({ arm: "current", scenarioId: spec.id, sampleIndex: i });
    }
  }
  shuffleInPlace(jobs, rand);

  const baselineSamples: VoiceNaturalnessSample[] = [];
  const currentSamples: VoiceNaturalnessSample[] = [];
  const executionOrder: VoiceNaturalnessAbReport["config"]["executionOrder"] = [];

  for (const job of jobs) {
    const spec = SCENARIOS.find((s) => s.id === job.scenarioId)!;
    const seed = job.arm === "baseline" ? baselineSeed : currentSeed;
    const sha16 =
      job.arm === "baseline" ? baselinePrompt.sha16 : currentPrompt.sha16;
    process.stderr.write(
      `[voice-naturalness-ab] ${job.arm} ${job.scenarioId} #${job.sampleIndex}\n`,
    );
    executionOrder.push({
      arm: job.arm,
      scenarioId: job.scenarioId,
      sampleIndex: job.sampleIndex,
    });
    const run = await withSeededAccount(seed, async (say) => {
      const turns: VoiceNaturalnessTurnRecord[] = [];
      for (const utterance of spec.turns) {
        turns.push(await say(utterance));
      }
      const primaryResponse = turns[turns.length - 1]?.response ?? "";
      const { hardFailures, observations } = observeSample(
        spec,
        primaryResponse,
        turns,
      );
      return { turns, primaryResponse, hardFailures, observations };
    });
    const sample: VoiceNaturalnessSample = {
      scenarioId: job.scenarioId,
      sampleIndex: job.sampleIndex,
      harnessUserIdPrefix: run.harnessUserIdPrefix,
      promptInput: {
        seededInstructionsSha16: sha16,
        userTurns: spec.turns,
      },
      turns: run.turns,
      primaryResponse: run.primaryResponse,
      hardFailures: run.hardFailures,
      observations: run.observations,
    };
    if (job.arm === "baseline") baselineSamples.push(sample);
    else currentSamples.push(sample);
  }

  const sortSamples = (rows: VoiceNaturalnessSample[]) =>
    [...rows].sort((a, b) => {
      const ai = SCENARIOS.findIndex((s) => s.id === a.scenarioId);
      const bi = SCENARIOS.findIndex((s) => s.id === b.scenarioId);
      if (ai !== bi) return ai - bi;
      return a.sampleIndex - b.sampleIndex;
    });

  const baselineSorted = sortSamples(baselineSamples);
  const currentSorted = sortSamples(currentSamples);

  const mkReport = (
    samples: VoiceNaturalnessSample[],
    prompt: { sha256: string; sha16: string; chars: number; systemMessage: string },
  ): VoiceNaturalnessReport => {
    const scenarioStats = SCENARIOS.map((s) =>
      summarizeScenario(
        s.id,
        samples.filter((row) => row.scenarioId === s.id),
      ),
    );
    const hardFailures = samples.flatMap((s) =>
      s.hardFailures.map((f) => `${s.scenarioId}#${s.sampleIndex}:${f}`),
    );
    return {
      suite: "voice-naturalness",
      generatedAt: new Date().toISOString(),
      databaseName: dbName,
      prompt: {
        instructionsSha256: prompt.sha256,
        instructionsSha16: prompt.sha16,
        chars: prompt.chars,
        model: file.model ?? null,
        temperature: file.temperature ?? null,
        reasoningEffort: file.reasoningEffort ?? null,
        hasSituationalVoice: prompt.systemMessage.includes(
          "respond to the person and the moment",
        ),
      },
      scenarios: scenarioStats,
      qualitative: buildQualitative(scenarioStats),
      hardOk: hardFailures.length === 0,
      hardFailures,
    };
  };

  const baselineReport = mkReport(baselineSorted, baselinePrompt);
  const currentReport = mkReport(currentSorted, currentPrompt);

  const scenarios: VoiceAbScenarioComparison[] = SCENARIOS.map((spec) => {
    const baseline = baselineReport.scenarios.find((s) => s.scenarioId === spec.id)!;
    const current = currentReport.scenarios.find((s) => s.scenarioId === spec.id)!;
    const bRel = hitRate(baseline, "relevance_token_hit");
    const cRel = hitRate(current, "relevance_token_hit");
    const bCtx = hitRate(baseline, "context_token_hit");
    const cCtx = hitRate(current, "context_token_hit");
    return {
      scenarioId: spec.id,
      baseline,
      current,
      delta: {
        exactUnique: current.exactUnique - baseline.exactUnique,
        nearUnique: current.nearUnique - baseline.nearUnique,
        distinctOpenings: current.distinctOpenings - baseline.distinctOpenings,
        emojiRate: current.emojiRate - baseline.emojiRate,
        helpCloserHits: current.helpCloserHits - baseline.helpCloserHits,
        relevanceHitRate:
          bRel == null || cRel == null ? null : cRel - bRel,
        contextHitRate: bCtx == null || cCtx == null ? null : cCtx - bCtx,
      },
      assessment: assessScenarioPair(spec.id, baseline, current),
      examples: {
        baseline: baseline.responses.slice(0, 3).map((r) => r.response),
        current: current.responses.slice(0, 3).map((r) => r.response),
      },
    };
  });

  const overall = buildOverallAssessment(
    scenarios,
    baselineReport,
    currentReport,
  );

  return {
    suite: "voice-naturalness-ab",
    generatedAt: new Date().toISOString(),
    databaseName: dbName,
    config: {
      model: file.model ?? null,
      temperature: file.temperature ?? null,
      reasoningEffort: file.reasoningEffort ?? null,
      repeatsPerArm: repeats,
      shuffleSeed,
      executionOrder,
    },
    arms: {
      baseline: {
        id: "baseline",
        label: "Baseline VOICE (pre-naturalness)",
        commit: baselineCommit,
        expectedSha16: expectedBaseline,
        instructionsSha256: baselinePrompt.sha256,
        instructionsSha16: baselinePrompt.sha16,
        chars: baselinePrompt.chars,
        hasSituationalVoice: baselinePrompt.systemMessage.includes(
          "respond to the person and the moment",
        ),
      },
      current: {
        id: "current",
        label: "Current VOICE (situational)",
        commit: currentCommit,
        expectedSha16: expectedCurrent,
        instructionsSha256: currentPrompt.sha256,
        instructionsSha16: currentPrompt.sha16,
        chars: currentPrompt.chars,
        hasSituationalVoice: currentPrompt.systemMessage.includes(
          "respond to the person and the moment",
        ),
      },
    },
    scenarios,
    overall,
    baselineReport,
    currentReport,
  };
}

export function formatVoiceNaturalnessAbMarkdown(
  report: VoiceNaturalnessAbReport,
): string {
  const lines: string[] = [];
  lines.push(`# VOICE naturalness A/B comparison`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`DB: ${report.databaseName}`);
  lines.push(
    `Model=${report.config.model} temp=${report.config.temperature} reasoning=${report.config.reasoningEffort} repeats/arm=${report.config.repeatsPerArm} shuffleSeed=${report.config.shuffleSeed}`,
  );
  lines.push("");
  lines.push(`## Arms`);
  lines.push(
    `- **Baseline:** commit \`${report.arms.baseline.commit}\` sha16=\`${report.arms.baseline.instructionsSha16}\` chars=${report.arms.baseline.chars} situationalVoice=${report.arms.baseline.hasSituationalVoice}`,
  );
  lines.push(
    `- **Current:** commit \`${report.arms.current.commit}\` sha16=\`${report.arms.current.instructionsSha16}\` chars=${report.arms.current.chars} situationalVoice=${report.arms.current.hasSituationalVoice}`,
  );
  lines.push("");
  lines.push(`## Overall assessment`);
  lines.push(report.overall.summary);
  lines.push("");
  lines.push(`- Recommendation: **${report.overall.recommendation}**`);
  lines.push(
    `- Short greeting/thanks repetition acceptable: ${report.overall.shortAckRepetitionAcceptable ? "yes" : "no"}`,
  );
  if (report.overall.clearlyBetter.length) {
    lines.push(`- Clearly better:`);
    for (const x of report.overall.clearlyBetter) lines.push(`  - ${x}`);
  }
  if (report.overall.noMeaningfulDifference.length) {
    lines.push(`- No meaningful difference / expected:`);
    for (const x of report.overall.noMeaningfulDifference) lines.push(`  - ${x}`);
  }
  if (report.overall.regressions.length) {
    lines.push(`- Regressions:`);
    for (const x of report.overall.regressions) lines.push(`  - ${x}`);
  }
  lines.push("");

  for (const sc of report.scenarios) {
    lines.push(`## ${sc.scenarioId}`);
    lines.push("");
    lines.push(`Assessment: ${sc.assessment}`);
    lines.push("");
    lines.push(`| metric | baseline | current | Δ |`);
    lines.push(`| --- | --- | --- | --- |`);
    lines.push(
      `| exact unique | ${sc.baseline.exactUnique}/${sc.baseline.n} | ${sc.current.exactUnique}/${sc.current.n} | ${sc.delta.exactUnique >= 0 ? "+" : ""}${sc.delta.exactUnique} |`,
    );
    lines.push(
      `| near-unique | ${sc.baseline.nearUnique}/${sc.baseline.n} | ${sc.current.nearUnique}/${sc.current.n} | ${sc.delta.nearUnique >= 0 ? "+" : ""}${sc.delta.nearUnique} |`,
    );
    lines.push(
      `| exact dup rate | ${pct(sc.baseline.exactDuplicateRate)} | ${pct(sc.current.exactDuplicateRate)} | |`,
    );
    lines.push(
      `| near dup rate | ${pct(sc.baseline.nearDuplicateRate)} | ${pct(sc.current.nearDuplicateRate)} | |`,
    );
    lines.push(
      `| openings | ${sc.baseline.distinctOpenings} | ${sc.current.distinctOpenings} | ${sc.delta.distinctOpenings >= 0 ? "+" : ""}${sc.delta.distinctOpenings} |`,
    );
    lines.push(
      `| emoji (obs.) | ${pct(sc.baseline.emojiRate)} | ${pct(sc.current.emojiRate)} | ${sc.delta.emojiRate >= 0 ? "+" : ""}${(sc.delta.emojiRate * 100).toFixed(0)}pp |`,
    );
    lines.push(
      `| help-closers | ${sc.baseline.helpCloserHits} | ${sc.current.helpCloserHits} | ${sc.delta.helpCloserHits >= 0 ? "+" : ""}${sc.delta.helpCloserHits} |`,
    );
    if (sc.delta.relevanceHitRate != null) {
      lines.push(
        `| relevance hit rate | ${pct(hitRate(sc.baseline, "relevance_token_hit")!)} | ${pct(hitRate(sc.current, "relevance_token_hit")!)} | ${sc.delta.relevanceHitRate >= 0 ? "+" : ""}${(sc.delta.relevanceHitRate * 100).toFixed(0)}pp |`,
      );
    }
    if (sc.delta.contextHitRate != null) {
      lines.push(
        `| context hit rate | ${pct(hitRate(sc.baseline, "context_token_hit")!)} | ${pct(hitRate(sc.current, "context_token_hit")!)} | ${sc.delta.contextHitRate >= 0 ? "+" : ""}${(sc.delta.contextHitRate * 100).toFixed(0)}pp |`,
      );
    }
    lines.push("");
    lines.push(`### Examples — baseline`);
    for (const ex of sc.examples.baseline) lines.push(`- ${ex}`);
    lines.push(`### Examples — current`);
    for (const ex of sc.examples.current) lines.push(`- ${ex}`);
    lines.push("");
    lines.push(`### All baseline responses`);
    for (const r of sc.baseline.responses) {
      lines.push(`- #${r.sampleIndex}: ${r.response}`);
    }
    lines.push(`### All current responses`);
    for (const r of sc.current.responses) {
      lines.push(`- #${r.sampleIndex}: ${r.response}`);
    }
    lines.push("");
  }

  lines.push(`## Execution order (arm / scenario / sample)`);
  lines.push(
    report.config.executionOrder
      .map((e) => `${e.arm}:${e.scenarioId}#${e.sampleIndex}`)
      .join(", "),
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function writeVoiceNaturalnessAbReports(
  report: VoiceNaturalnessAbReport,
  docsQaDir?: string,
): { jsonPath: string; mdPath: string } {
  const root = docsQaRoot(docsQaDir);
  mkdirSync(root, { recursive: true });
  const jsonPath = resolve(root, "voice-naturalness-ab-last-report.json");
  const mdPath = resolve(root, "voice-naturalness-ab-last-report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, formatVoiceNaturalnessAbMarkdown(report), "utf8");
  return { jsonPath, mdPath };
}
