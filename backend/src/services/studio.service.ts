/**
 * Lucy Test Studio — reuse eval runners; persist runs under docs/qa/studio/.
 * LIVE_FULL executes only when isolation gate passes (real apply, isolated DB).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileLiveAuthorDraft,
  type LiveAuthorDraft,
} from "../eval/live-author-compile.js";
import {
  filterCasesByTags,
  loadLiveFullCorpus,
  loadModelEvalCorpus,
  loadModelEvalMultiTurnCorpus,
  type ModelEvalCorpusCase,
  type ModelEvalMultiTurnCase,
} from "../eval/corpus.js";
import {
  runModelEvalCorpus,
  runModelEvalMultiTurnCorpus,
} from "../eval/run-case.js";
import { runLiveFullCorpus } from "../eval/run-live-full.js";
import { validateStudioScenario } from "../eval/studio-validate.js";
import { loadLlmConfig } from "../config/llm.js";
import {
  assertLiveFullAllowed,
  assertStudioTrackRunnable,
  probeLiveFullSafety,
  probeLiveModelStudioAllow,
  trackCapabilities,
  type StudioTrack,
} from "../eval/studio-safety.js";
import { AppError, NotFoundError, ValidationError } from "../utils/errors.js";
import { UnapprovedEvalDatabaseError } from "../eval/studio-db-guard.js";

const TRACKS: StudioTrack[] = ["LIVE_MODEL", "LIVE_MODEL_MT", "LIVE_FULL"];

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function studioDir(...parts: string[]): string {
  return join(repoRoot(), "docs", "qa", "studio", ...parts);
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export type StudioCheckpointStatus =
  | "captured"
  | "not_evaluated"
  | "unavailable"
  | "skipped";

export type StudioCheckpoint = {
  id: string;
  label: string;
  status: StudioCheckpointStatus;
  detail?: string;
  value?: unknown;
};

export type StudioCaseResult = {
  id: string;
  ok: boolean;
  failures: string[];
  llmMs?: number;
  turns: Array<{
    index: number;
    utterance: string;
    response?: string;
    metadata?: unknown;
    ok: boolean;
    failures: string[];
    assertions: Array<{
      expected: string;
      result: "PASS" | "FAIL" | "NOT_EVALUATED";
      detail?: string;
    }>;
    checkpoints: StudioCheckpoint[];
  }>;
};

/** Run identity / prompt provenance — no secrets or connection strings. */
export type StudioRunProvenance = {
  productionApply: boolean;
  promptSource: string;
  promptHash: string;
  speakerIdentity: {
    kind: "fixture" | "harness" | "product";
    employeeId: string | null;
    name: string;
    note: string;
  };
  digitalEmployee: {
    kind: "fixture" | "product";
    id: string | null;
    name: string;
    instructionsSource: string;
    note: string;
  };
  userId: string | null;
  userIdKind: "none" | "disposable_harness" | "product";
  databaseTarget: {
    classification: "none" | "approved_isolated" | "product_or_unapproved" | "unknown";
    detail: string;
  };
  safetyGate: {
    allowed: boolean;
    blockers: string[];
  };
};

export type StudioRunRecord = {
  id: string;
  createdAt: string;
  finishedAt?: string;
  status: "running" | "passed" | "failed" | "blocked" | "error";
  track: StudioTrack;
  caseIds: string[];
  tags: string[] | null;
  durationMs?: number;
  summary?: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    ok: boolean;
  };
  blockers?: string[];
  cases: StudioCaseResult[];
  costNote: string;
  trackCapabilities: ReturnType<typeof trackCapabilities>;
  provenance?: StudioRunProvenance;
};

function buildLiveModelProvenance(track: StudioTrack): StudioRunProvenance {
  let promptSource = "LLM.config.json (worktree via loadLlmConfig)";
  let promptHash = "unavailable";
  try {
    const cfg = loadLlmConfig();
    promptHash = createHash("sha256")
      .update(cfg.systemMessage)
      .digest("hex")
      .slice(0, 16);
  } catch {
    promptSource = "LLM.config.json (load failed — hash unavailable)";
  }
  return {
    productionApply: false,
    promptSource,
    promptHash,
    speakerIdentity: {
      kind: "fixture",
      employeeId: "eval-human-1",
      name: "טל",
      note: "Fixture only — not a product Employees row; not inferred from Chat UI selection",
    },
    digitalEmployee: {
      kind: "fixture",
      id: "eval-lucy-1",
      name: "לוסי",
      instructionsSource:
        "fixture instructions=null → file systemMessage (not Lucy2 / DB Employees.instructions)",
      note: "Selecting Lucy2 in Chat UI does not change this eval prompt source",
    },
    userId: null,
    userIdKind: "none",
    databaseTarget: {
      classification: "none",
      detail:
        track === "LIVE_MODEL_MT"
          ? "In-memory snapshot only — no Prisma apply"
          : "LIVE_MODEL does not open Prisma for apply",
    },
    safetyGate: {
      allowed: true,
      blockers: [],
    },
  };
}

function modelCheckpoints(input: {
  utterance: string;
  response?: string;
  metadata?: unknown;
  failures: string[];
}): StudioCheckpoint[] {
  return [
    {
      id: "user_message",
      label: "User message",
      status: "captured",
      value: input.utterance,
    },
    {
      id: "model_response",
      label: "Model response text",
      status: input.response !== undefined ? "captured" : "unavailable",
      value: input.response,
    },
    {
      id: "parsed_metadata_action",
      label: "Parsed ACTION metadata",
      status: input.metadata !== undefined ? "captured" : "unavailable",
      value: input.metadata,
    },
    {
      id: "constraint_results",
      label: "Constraint evaluation",
      status: "captured",
      detail:
        input.failures.length === 0
          ? "all constraints passed"
          : input.failures.join("; "),
    },
    {
      id: "engine_apply",
      label: "Engine validation / apply",
      status: "not_evaluated",
      detail: "LIVE_MODEL does not run production apply",
    },
    {
      id: "database_state",
      label: "Database state before/after",
      status: "not_evaluated",
      detail: "No product DB writes on LIVE_MODEL",
    },
    {
      id: "server_replaced_response",
      label: "Server-replaced final UX",
      status: "unavailable",
      detail: "sendChatMessage dump/claim path not used on this track",
    },
    {
      id: "whatsapp_delivery",
      label: "WhatsApp delivery",
      status: "not_evaluated",
      detail: "Not invoked on LIVE_MODEL",
    },
  ];
}

function fullCheckpoints(input: {
  utterance: string;
  response?: string;
  metadata?: unknown;
  applied?: boolean;
  stateNote?: string;
  failures: string[];
}): StudioCheckpoint[] {
  return [
    {
      id: "user_message",
      label: "User message",
      status: "captured",
      value: input.utterance,
    },
    {
      id: "model_response",
      label: "Model response text",
      status: input.response !== undefined ? "captured" : "unavailable",
      value: input.response,
    },
    {
      id: "parsed_metadata_action",
      label: "Parsed ACTION metadata",
      status: input.metadata !== undefined ? "captured" : "unavailable",
      value: input.metadata,
    },
    {
      id: "constraint_results",
      label: "Constraint evaluation",
      status: "captured",
      detail:
        input.failures.length === 0
          ? "all constraints passed"
          : input.failures.join("; "),
    },
    {
      id: "engine_apply",
      label: "Production apply (lists/filing/reminders/directory)",
      status: input.applied ? "captured" : "not_evaluated",
      detail: input.applied
        ? "applyModelMetadataTurn / harness apply"
        : "No mutating ACTION this turn",
    },
    {
      id: "database_state",
      label: "Harness DB stateAfter",
      status: input.stateNote ? "captured" : "not_evaluated",
      detail: input.stateNote ?? "No stateAfter assert on this turn",
    },
    {
      id: "server_replaced_response",
      label: "Server-replaced final UX",
      status: "unavailable",
      detail:
        "Current LIVE_FULL runner uses MODEL_APPLY + LLM, not full sendChatMessage dump replace",
    },
    {
      id: "whatsapp_delivery",
      label: "WhatsApp delivery",
      status: "skipped",
      detail:
        "Outbound intercepted when WORKEE_DISABLE_WHATSAPP_OUTBOUND=1; harness does not Graph-send",
    },
    {
      id: "harness_cleanup",
      label: "Harness account cleanup",
      status: "captured",
      detail: "destroyHarnessAccount after case (test-owned rows only)",
    },
  ];
}

function writeRun(run: StudioRunRecord): void {
  const dir = studioDir("runs");
  ensureDir(dir);
  writeFileSync(join(dir, `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`);
  const indexPath = join(dir, "index.json");
  let index: Array<{
    id: string;
    createdAt: string;
    status: string;
    track: string;
    total?: number;
    passed?: number;
  }> = [];
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, "utf8")) as typeof index;
    } catch {
      index = [];
    }
  }
  index = [
    {
      id: run.id,
      createdAt: run.createdAt,
      status: run.status,
      track: run.track,
      total: run.summary?.total,
      passed: run.summary?.passed,
    },
    ...index.filter((row) => row.id !== run.id),
  ].slice(0, 200);
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

export function listStudioTracks() {
  return TRACKS.map((track) => trackCapabilities(track));
}

export function getStudioSafety() {
  return {
    liveFull: probeLiveFullSafety(),
    liveModel: probeLiveModelStudioAllow(),
    writeTracksExposed: false,
    writeTracksNote:
      "ENGINE, MODEL_APPLY, and LIVE_FULL are not exposed via Studio run-start until Phase D isolation is proven. Safety flags alone are not isolation.",
    isolationPolicy:
      "LIVE_FULL uses real apply code on an approved test DB; WhatsApp Graph and reminder ticks must be disabled so production users are never messaged. Credentials may remain. Phase A Studio refuses LIVE_FULL regardless of env green-ness.",
  };
}

export function listStudioCases(track: StudioTrack): Array<{
  id: string;
  tag?: string;
  tags?: string[];
  description?: string;
  utterancePreview: string;
  turnCount: number;
}> {
  if (track === "LIVE_MODEL") {
    return loadModelEvalCorpus().cases.map((c) => ({
      id: c.id,
      tag: c.tag,
      tags: c.tags,
      utterancePreview: c.utterance,
      turnCount: 1,
    }));
  }
  if (track === "LIVE_MODEL_MT") {
    return loadModelEvalMultiTurnCorpus().cases.map((c) => ({
      id: c.id,
      tag: c.tag,
      tags: c.tags,
      description: c.description,
      utterancePreview: c.turns.map((t) => t.utterance).join(" → "),
      turnCount: c.turns.length,
    }));
  }
  return loadLiveFullCorpus().cases.map((c) => ({
    id: c.id,
    tag: typeof c.tag === "string" ? c.tag : undefined,
    tags: c.tags,
    description: c.description,
    utterancePreview: c.turns.map((t) => t.utterance).join(" → "),
    turnCount: c.turns.length,
  }));
}

export function getStudioCase(
  track: StudioTrack,
  id: string,
): ModelEvalCorpusCase | ModelEvalMultiTurnCase | Record<string, unknown> {
  const cases = listStudioCases(track);
  if (!cases.some((c) => c.id === id)) {
    throw new NotFoundError(`Unknown case ${id} on ${track}`);
  }
  if (track === "LIVE_MODEL") {
    const row = loadModelEvalCorpus().cases.find((c) => c.id === id);
    if (!row) throw new NotFoundError(`Unknown case ${id}`);
    return row;
  }
  if (track === "LIVE_MODEL_MT") {
    const row = loadModelEvalMultiTurnCorpus().cases.find((c) => c.id === id);
    if (!row) throw new NotFoundError(`Unknown case ${id}`);
    return row;
  }
  const row = loadLiveFullCorpus().cases.find((c) => c.id === id);
  if (!row) throw new NotFoundError(`Unknown case ${id}`);
  return row;
}

export function previewStudioSuite(input: {
  track: StudioTrack;
  tags?: string[] | null;
  caseIds?: string[];
}): { track: StudioTrack; caseIds: string[]; count: number } {
  let ids = listStudioCases(input.track).map((c) => c.id);
  if (input.tags?.length) {
    const tagged = filterCasesByTags(
      listStudioCases(input.track).map((c) => ({ id: c.id, tags: c.tags })),
      input.tags,
    );
    ids = tagged.map((c) => c.id);
  }
  if (input.caseIds?.length) {
    const want = new Set(input.caseIds);
    ids = ids.filter((id) => want.has(id));
  }
  return { track: input.track, caseIds: ids, count: ids.length };
}

export function listStudioRuns(): StudioRunRecord[] {
  const dir = studioDir("runs");
  if (!existsSync(dir)) return [];
  const indexPath = join(dir, "index.json");
  if (!existsSync(indexPath)) return [];
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as Array<{
    id: string;
  }>;
  return index
    .map((row) => {
      try {
        return JSON.parse(
          readFileSync(join(dir, `${row.id}.json`), "utf8"),
        ) as StudioRunRecord;
      } catch {
        return null;
      }
    })
    .filter((row): row is StudioRunRecord => Boolean(row));
}

export function getStudioRun(id: string): StudioRunRecord {
  const path = studioDir("runs", `${id}.json`);
  if (!existsSync(path)) throw new NotFoundError(`Unknown run ${id}`);
  return JSON.parse(readFileSync(path, "utf8")) as StudioRunRecord;
}

export async function startStudioRun(input: {
  track: StudioTrack;
  caseIds?: string[];
  tags?: string[] | null;
}): Promise<StudioRunRecord> {
  if (!TRACKS.includes(input.track)) {
    throw new ValidationError(`Unsupported track: ${String(input.track)}`);
  }

  // Server-side gate before any runner / Prisma / OpenAI (UI cannot bypass).
  try {
    assertStudioTrackRunnable(input.track);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Studio track refused";
    const caps = trackCapabilities(input.track);
    const blocked: StudioRunRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "blocked",
      track: input.track,
      caseIds: input.caseIds ?? [],
      tags: input.tags ?? null,
      cases: [],
      blockers: [message],
      costNote:
        "Eval runs do not write LlmUsages (production accounting). Latency (llmMs) only when captured.",
      trackCapabilities: caps,
      provenance: {
        productionApply: input.track === "LIVE_FULL",
        promptSource: "not_started",
        promptHash: "n/a",
        speakerIdentity: {
          kind: "fixture",
          employeeId: null,
          name: "(not started)",
          note: "Run blocked before identity binding",
        },
        digitalEmployee: {
          kind: "fixture",
          id: null,
          name: "(not started)",
          instructionsSource: "n/a",
          note: "Run blocked before prompt load",
        },
        userId: null,
        userIdKind: "none",
        databaseTarget: {
          classification:
            input.track === "LIVE_FULL"
              ? "product_or_unapproved"
              : "none",
          detail: message,
        },
        safetyGate: { allowed: false, blockers: [message] },
      },
      summary: {
        total: 0,
        passed: 0,
        failed: 0,
        passRate: 0,
        ok: false,
      },
      durationMs: 0,
    };
    writeRun(blocked);
    return blocked;
  }

  const caps = trackCapabilities(input.track);
  const preview = previewStudioSuite({
    track: input.track,
    tags: input.tags,
    caseIds: input.caseIds,
  });
  if (preview.count === 0) {
    throw new ValidationError("No cases matched the selection");
  }

  const provenance = buildLiveModelProvenance(input.track);

  const run: StudioRunRecord = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: "running",
    track: input.track,
    caseIds: preview.caseIds,
    tags: input.tags ?? null,
    cases: [],
    costNote:
      "Eval runs do not write LlmUsages (production accounting). Latency (llmMs) only when captured.",
    trackCapabilities: caps,
    provenance,
  };
  writeRun(run);

  const started = Date.now();

  try {
    // LIVE_FULL is refused by assertStudioTrackRunnable (Phase A).
    // Keep assertLiveFullAllowed as defense-in-depth if Phase D re-enables.
    if (input.track === "LIVE_FULL") {
      assertLiveFullAllowed();
    }

    if (input.track === "LIVE_MODEL") {
      const corpus = loadModelEvalCorpus();
      const summary = await runModelEvalCorpus(corpus, {
        caseIds: preview.caseIds,
        tags: null,
      });
      run.cases = summary.results.map((row) => ({
        id: row.id,
        ok: row.ok,
        failures: row.failures,
        llmMs: row.llmMs,
        turns: [
          {
            index: 0,
            utterance: row.utterance,
            response: row.response,
            metadata: row.metadata,
            ok: row.ok,
            failures: row.failures,
            assertions: row.ok
              ? [{ expected: "constraints", result: "PASS" as const }]
              : row.failures.map((f) => ({
                  expected: "constraints",
                  result: "FAIL" as const,
                  detail: f,
                })),
            checkpoints: modelCheckpoints({
              utterance: row.utterance,
              response: row.response,
              metadata: row.metadata,
              failures: row.failures,
            }),
          },
        ],
      }));
      run.summary = {
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        passRate: summary.passRate,
        ok: summary.ok,
      };
      run.status = summary.ok ? "passed" : "failed";
    } else if (input.track === "LIVE_MODEL_MT") {
      const corpus = loadModelEvalMultiTurnCorpus();
      const summary = await runModelEvalMultiTurnCorpus(corpus, {
        caseIds: preview.caseIds,
        tags: null,
      });
      run.cases = summary.multiTurnResults.map((row) => ({
        id: row.id,
        ok: row.ok,
        failures: row.failures,
        llmMs: row.llmMs,
        turns: row.turns.map((t) => ({
          index: t.index,
          utterance: t.utterance,
          response: t.response,
          metadata: t.metadata,
          ok: t.ok,
          failures: t.failures,
          assertions: t.ok
            ? [{ expected: "constraints", result: "PASS" as const }]
            : t.failures.map((f) => ({
                expected: "constraints",
                result: "FAIL" as const,
                detail: f,
              })),
          checkpoints: [
            ...modelCheckpoints({
              utterance: t.utterance,
              response: t.response,
              metadata: t.metadata,
              failures: t.failures,
            }),
            {
              id: "in_memory_snapshot",
              label: "In-memory snapshot context (not DB)",
              status: "captured",
              detail:
                "Prior-turn ACTIONs may evolve eval snapshot for next turn only",
            },
          ],
        })),
      }));
      run.summary = {
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        passRate: summary.passRate,
        ok: summary.ok,
      };
      run.status = summary.ok ? "passed" : "failed";
    } else {
      // LIVE_FULL — real MODEL_APPLY + LLM on approved test DB only
      const corpus = loadLiveFullCorpus();
      const summary = await runLiveFullCorpus(corpus, {
        caseIds: preview.caseIds,
        tags: null,
      });
      run.cases = summary.results.map((row) => ({
        id: row.id,
        ok: row.ok,
        failures: row.failures,
        turns: row.turns.map((t) => ({
          index: t.index,
          utterance: t.utterance,
          response: t.response,
          metadata: t.metadata,
          ok: t.ok,
          failures: t.failures,
          assertions: [
            ...(t.ok
              ? [{ expected: "constraints+state", result: "PASS" as const }]
              : t.failures.map((f) => ({
                  expected: "constraints+state",
                  result: "FAIL" as const,
                  detail: f,
                }))),
          ],
          checkpoints: fullCheckpoints({
            utterance: t.utterance,
            response: t.response,
            metadata: t.metadata,
            applied: t.appliedViaProduction,
            stateNote: t.stateNote,
            failures: t.failures,
          }),
        })),
      }));
      run.summary = {
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        passRate: summary.passRate,
        ok: summary.ok,
      };
      run.status = summary.ok ? "passed" : "failed";
    }
  } catch (err) {
    if (err instanceof UnapprovedEvalDatabaseError) {
      run.status = "blocked";
      run.blockers = [err.message];
    } else if (err instanceof AppError) {
      run.status = "error";
      run.blockers = [err.message];
    } else {
      run.status = "error";
      run.blockers = [
        err instanceof Error ? err.message : "Unknown studio run error",
      ];
    }
    run.summary = {
      total: run.cases.length,
      passed: run.cases.filter((c) => c.ok).length,
      failed: run.cases.filter((c) => !c.ok).length,
      passRate: 0,
      ok: false,
    };
  }

  run.finishedAt = new Date().toISOString();
  run.durationMs = Date.now() - started;
  writeRun(run);
  return run;
}

/** Drafts — separate from approved corpora until explicit promote. */
export function listStudioDrafts(): Array<{ id: string; path: string }> {
  const dir = studioDir("drafts");
  ensureDir(dir);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      id: name.replace(/\.json$/i, ""),
      path: `docs/qa/studio/drafts/${name}`,
    }));
}

export function getStudioDraft(id: string): unknown {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe || safe !== id) throw new ValidationError("Invalid draft id");
  const path = studioDir("drafts", `${safe}.json`);
  if (!existsSync(path)) throw new NotFoundError(`Unknown draft ${id}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveStudioDraft(id: string, body: unknown): { id: string } {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe || safe !== id) throw new ValidationError("Invalid draft id");
  ensureDir(studioDir("drafts"));
  writeFileSync(
    studioDir("drafts", `${safe}.json`),
    `${JSON.stringify(body, null, 2)}\n`,
  );
  return { id: safe };
}

export function compileStudioDraft(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Draft must be an object");
  }
  const draft = body as LiveAuthorDraft;
  if (!draft.id?.trim()) throw new ValidationError("draft.id required");
  if (!Array.isArray(draft.turns) || draft.turns.length === 0) {
    throw new ValidationError("draft.turns required");
  }
  return compileLiveAuthorDraft(draft);
}

export function validateStudioDraftScenario(body: unknown): { ok: true } {
  validateStudioScenario(body);
  return { ok: true };
}

/**
 * Promote compiled ready case into the matching corpus. Requires confirmPromote.
 * Never silently overwrites an existing case id.
 */
export function promoteStudioDraft(input: {
  confirmPromote: boolean;
  caseRow: Record<string, unknown>;
  track: "model" | "mt" | "full";
}): { id: string; corpus: string } {
  if (!input.confirmPromote) {
    throw new ValidationError("confirmPromote must be true to write corpora");
  }
  const id = String(input.caseRow.id ?? "").trim();
  if (!id) throw new ValidationError("case id required");

  const corpusRel =
    input.track === "model"
      ? "docs/qa/phase-4-corpus.json"
      : input.track === "mt"
        ? "docs/qa/phase-4-multi-turn-corpus.json"
        : "docs/qa/live-full-corpus.json";
  const path = join(repoRoot(), corpusRel);
  const corpus = JSON.parse(readFileSync(path, "utf8")) as {
    cases: Array<{ id: string }>;
  };
  if (corpus.cases.some((c) => c.id === id)) {
    throw new ValidationError(
      `Case id already exists in approved corpus: ${id}`,
    );
  }
  corpus.cases.push(input.caseRow as { id: string });
  writeFileSync(path, `${JSON.stringify(corpus, null, 2)}\n`);
  return { id, corpus: corpusRel };
}
