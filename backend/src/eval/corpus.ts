import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EmployeeRecordSnapshot } from "../services/employee-records.service.js";
import type { ReminderSnapshotRow } from "../services/reminder.service.js";
import type { ModelEvalConstraint, ModelEvalTag } from "./constraints.js";

export interface ModelEvalCorpusCase {
  id: string;
  tag: ModelEvalTag;
  /**
   * Topic filters for selective LIVE runs (e.g. reminders, shopping, multi-turn).
   * Env: MODEL_EVAL_TAGS=reminders,shopping (comma-separated; empty/all = no filter).
   */
  tags?: string[];
  utterance: string;
  setup: {
    lists?: EmployeeRecordSnapshot["lists"];
    filing?: EmployeeRecordSnapshot["filing"];
    reminders?: ReminderSnapshotRow[];
    contacts?: Array<{ name: string; phone: string; contact_id?: string }>;
  };
  constraints: ModelEvalConstraint[];
}

export interface ModelEvalCorpus {
  version: number;
  passRate: number;
  speaker: string;
  /**
   * Case ids that must all pass for the suite to pass, regardless of soft passRate.
   * Ordinary quality cases stay under passRate only.
   */
  criticalCaseIds?: string[];
  cases: ModelEvalCorpusCase[];
}

export function defaultCorpusPath(repoRoot = resolve(import.meta.dirname, "../../..")): string {
  return resolve(repoRoot, "docs/qa/phase-4-corpus.json");
}

export function loadModelEvalCorpus(path = defaultCorpusPath()): ModelEvalCorpus {
  const raw = JSON.parse(readFileSync(path, "utf8")) as ModelEvalCorpus;
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`Model eval corpus has no cases: ${path}`);
  }
  if (raw.criticalCaseIds) {
    if (!Array.isArray(raw.criticalCaseIds)) {
      throw new Error(`Model eval corpus criticalCaseIds must be an array: ${path}`);
    }
    const known = new Set(raw.cases.map((row) => row.id));
    const missing = raw.criticalCaseIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Model eval corpus criticalCaseIds unknown: ${missing.join(", ")}`,
      );
    }
  }
  return raw;
}

/** One turn inside a Phase 4 multi-turn LIVE / offline-wire case. */
export interface ModelEvalMultiTurnTurn {
  utterance: string;
  constraints: ModelEvalConstraint[];
  /**
   * After this turn's model reply, append assistant text into the OpenAI
   * conversation (automated Lucy / reminder-style interrupt). No extra model call.
   */
  injectAssistantAfter?: string;
}

export interface ModelEvalMultiTurnCase {
  id: string;
  tag: ModelEvalTag;
  /** Same topic filter array as single-turn LIVE cases. */
  tags?: string[];
  description?: string;
  setup: ModelEvalCorpusCase["setup"];
  turns: ModelEvalMultiTurnTurn[];
}

/** Parse MODEL_EVAL_TAGS=a,b — empty / "all" / "*" → null (no filter). */
export function parseModelEvalTags(
  raw = process.env.MODEL_EVAL_TAGS,
): string[] | null {
  const parts = (raw ?? "")
    .split(",")
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1 && (parts[0] === "all" || parts[0] === "*")) {
    return null;
  }
  return parts;
}

/** Keep cases that share at least one requested tag (case-insensitive). */
export function filterCasesByTags<T extends { id: string; tags?: string[] }>(
  cases: T[],
  tags: string[] | null | undefined,
): T[] {
  if (!tags?.length) return cases;
  const want = new Set(tags.map((t) => t.toLowerCase()));
  const selected = cases.filter((row) =>
    (row.tags ?? []).some((t) => want.has(t.toLowerCase())),
  );
  if (selected.length === 0) {
    throw new Error(
      `MODEL_EVAL_TAGS=${[...want].join(",")} matched 0 cases (known tags on corpus may differ)`,
    );
  }
  return selected;
}

export interface ModelEvalMultiTurnCorpus {
  version: number;
  passRate: number;
  speaker: string;
  criticalCaseIds?: string[];
  cases: ModelEvalMultiTurnCase[];
}

export function defaultMultiTurnCorpusPath(
  repoRoot = resolve(import.meta.dirname, "../../.."),
): string {
  return resolve(repoRoot, "docs/qa/phase-4-multi-turn-corpus.json");
}

export function defaultLiveFullCorpusPath(
  repoRoot = resolve(import.meta.dirname, "../../.."),
): string {
  return resolve(repoRoot, "docs/qa/live-full-corpus.json");
}

/** LIVE-full corpus turn (model constraints + optional DB stateAfter). */
export interface LiveFullCorpusTurn {
  utterance: string;
  constraints?: ModelEvalConstraint[];
  stateAfter?: RegressionStateAssert;
}

export interface LiveFullCorpusCase {
  id: string;
  tag?: ModelEvalTag | string;
  tags?: string[];
  description?: string;
  setup?: ModelEvalCorpusCase["setup"];
  turns: LiveFullCorpusTurn[];
}

export interface LiveFullCorpus {
  version: number;
  kind?: string;
  speaker: string;
  passRate: number;
  criticalCaseIds?: string[];
  cases: LiveFullCorpusCase[];
}

export function loadLiveFullCorpus(
  path = defaultLiveFullCorpusPath(),
): LiveFullCorpus {
  const raw = JSON.parse(readFileSync(path, "utf8")) as LiveFullCorpus;
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`Live-full corpus has no cases: ${path}`);
  }
  for (const row of raw.cases) {
    if (!Array.isArray(row.turns) || row.turns.length === 0) {
      throw new Error(`Live-full case ${row.id}: turns required`);
    }
  }
  if (raw.criticalCaseIds) {
    const known = new Set(raw.cases.map((c) => c.id));
    const missing = raw.criticalCaseIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(`Live-full criticalCaseIds unknown: ${missing.join(", ")}`);
    }
  }
  return raw;
}

export function loadModelEvalMultiTurnCorpus(
  path = defaultMultiTurnCorpusPath(),
): ModelEvalMultiTurnCorpus {
  const raw = JSON.parse(readFileSync(path, "utf8")) as ModelEvalMultiTurnCorpus;
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`Model eval multi-turn corpus has no cases: ${path}`);
  }
  for (const row of raw.cases) {
    if (!Array.isArray(row.turns) || row.turns.length < 2) {
      throw new Error(
        `Multi-turn case ${row.id}: need ≥2 turns (got ${row.turns?.length ?? 0})`,
      );
    }
    for (let i = 0; i < row.turns.length; i += 1) {
      const turn = row.turns[i]!;
      if (!turn.utterance?.trim()) {
        throw new Error(`Multi-turn case ${row.id} turn ${i}: utterance required`);
      }
      if (!Array.isArray(turn.constraints)) {
        throw new Error(
          `Multi-turn case ${row.id} turn ${i}: constraints required`,
        );
      }
    }
  }
  if (raw.criticalCaseIds) {
    if (!Array.isArray(raw.criticalCaseIds)) {
      throw new Error(
        `Multi-turn corpus criticalCaseIds must be an array: ${path}`,
      );
    }
    const known = new Set(raw.cases.map((row) => row.id));
    const missing = raw.criticalCaseIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Multi-turn corpus criticalCaseIds unknown: ${missing.join(", ")}`,
      );
    }
  }
  return raw;
}

export function snapshotFromSetup(
  setup: ModelEvalCorpusCase["setup"],
  speaker: string,
): EmployeeRecordSnapshot {
  return {
    lists: setup.lists ?? [],
    filing: setup.filing ?? [],
    reminders: (setup.reminders ?? []).map((row) => ({
      ...row,
      owner: row.owner || speaker,
    })),
  };
}

/**
 * Studio / regression track.
 * ENGINE = fixture ACTION → production apply (published Gate 1 suite).
 * MODEL = model/stub proposed ACTION (thin eval; no apply).
 * MODEL_APPLY = model ACTION → production apply → reinject (Batch A MT).
 */
export type RegressionTrack = "ENGINE" | "MODEL" | "MODEL_APPLY";

/** Batch A allows MODEL and MODEL_APPLY only (never ENGINE fixtures as decisions). */
export type BatchATrack = "MODEL" | "MODEL_APPLY";

export const HELD_OUT_SUITE_BASENAME = "held-out-sealed.json";

export type StudioScenarioSetup = ModelEvalCorpusCase["setup"];

export interface RegressionStateAssert {
  /** Every id must appear on some live (non-deleted) item in the snapshot. */
  itemIdsPresent?: string[];
  /** None of these ids may appear on live items. */
  itemIdsAbsent?: string[];
  /** Substrings that must appear in formatEmployeeContext output. */
  factsInclude?: string[];
  /** Substrings that must not appear in formatEmployeeContext output. */
  factsExclude?: string[];
  /**
   * Contact display names that must appear in the phone book
   * (Contacts table / SPEAKER_CONTACTS — not list facts).
   */
  contactNamesInclude?: string[];
  /** Contact display names that must not appear in the phone book. */
  contactNamesExclude?: string[];
  /** Exact count of lists with this list_type (after apply / authored facts). */
  listTypeCounts?: Record<string, number>;
  /** Task item must expose these linked list names (via linked_lists[].list_name or list_id). */
  linkedListNamesOnItem?: { itemId: string; listNames: string[] };
}

export interface StudioTurn {
  utterance: string;
  /**
   * ENGINE: required gold ACTION (decision source).
   * MODEL: forbidden as decision source — omit / null.
   */
  fixtureMetadata?: unknown | null;
  /** Per-turn authored context (MODEL facts; optional ENGINE overlay). */
  setup?: StudioScenarioSetup;
  response?: string;
  constraints?: ModelEvalConstraint[];
  /**
   * ENGINE: assert after production apply.
   * MODEL: optional authored expectation only — not proof of apply.
   */
  stateAfter?: RegressionStateAssert;
}

/** @deprecated Alias — prefer StudioTurn. */
export type RegressionTurn = StudioTurn;

/** Unified Studio scenario: turns.length === 1 (single) or N (multi). */
export interface StudioScenario {
  id: string;
  track: RegressionTrack;
  tag?: string;
  description?: string;
  speaker?: string;
  setup?: StudioScenarioSetup;
  turns: StudioTurn[];
}

export interface RegressionSuiteCase {
  id: string;
  /** Published Gate 1 suite remains ENGINE-only at load time. */
  track: RegressionTrack;
  tag?: string;
  description?: string;
  setup?: StudioScenarioSetup;
  turns: StudioTurn[];
}

/** Adapt a Phase-4 flat corpus case into a single-turn MODEL StudioScenario. */
export function phase4CaseToStudioScenario(
  row: ModelEvalCorpusCase,
): StudioScenario {
  return {
    id: row.id,
    track: "MODEL",
    tag: row.tag,
    setup: row.setup,
    turns: [
      {
        utterance: row.utterance,
        setup: row.setup,
        constraints: row.constraints,
      },
    ],
  };
}

export interface RegressionSuite {
  version: number;
  speaker: string;
  /** Case ids that must all pass (hard gate). */
  criticalCaseIds?: string[];
  cases: RegressionSuiteCase[];
}

export function defaultRegressionSuitePath(
  repoRoot = resolve(import.meta.dirname, "../../.."),
): string {
  return resolve(repoRoot, "docs/qa/regression-suite.json");
}

export function loadRegressionSuite(
  path = defaultRegressionSuitePath(),
): RegressionSuite {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RegressionSuite;
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`Regression suite has no cases: ${path}`);
  }
  if (raw.criticalCaseIds) {
    if (!Array.isArray(raw.criticalCaseIds)) {
      throw new Error(`Regression suite criticalCaseIds must be an array: ${path}`);
    }
    const known = new Set(raw.cases.map((row) => row.id));
    const missing = raw.criticalCaseIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Regression suite criticalCaseIds unknown: ${missing.join(", ")}`,
      );
    }
  }
  for (const row of raw.cases) {
    if (!row.id?.trim()) {
      throw new Error(`Regression suite case missing id: ${path}`);
    }
    if (row.track !== "ENGINE") {
      throw new Error(
        `Regression suite case ${row.id}: only track ENGINE is supported in Gate 1`,
      );
    }
    if (!Array.isArray(row.turns) || row.turns.length === 0) {
      throw new Error(`Regression suite case ${row.id}: turns required`);
    }
  }
  return raw;
}

export interface BatchASuiteCase {
  id: string;
  track: BatchATrack;
  /** Contract id e.g. L-BOUGHT (shared by canonical + contrast). */
  contract?: string;
  /** canonical | contrast — P-SEM pair marker. */
  variant?: "canonical" | "contrast";
  tag?: string;
  description?: string;
  /** When true, loader must reject (held-out must never run in Batch A). */
  heldOut?: boolean;
  setup?: StudioScenarioSetup;
  turns: StudioTurn[];
}

export interface BatchASuite {
  version: number;
  speaker: string;
  batch: "A";
  evalPath: "thin";
  productionParity: false;
  criticalCaseIds?: string[];
  cases: BatchASuiteCase[];
}

export function defaultBatchASuitePath(
  repoRoot = resolve(import.meta.dirname, "../../.."),
): string {
  return resolve(repoRoot, "docs/qa/batch-a-suite.json");
}

/**
 * Refuse held-out suite paths and any case marked heldOut.
 * Batch A must never load or execute held-out cases (D12).
 */
export function assertNotHeldOutSuitePath(path: string): void {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (
    normalized.endsWith(`/${HELD_OUT_SUITE_BASENAME}`) ||
    normalized.endsWith(HELD_OUT_SUITE_BASENAME)
  ) {
    throw new Error(
      `Refusing to load held-out suite in Batch A: ${HELD_OUT_SUITE_BASENAME}`,
    );
  }
  if (normalized.includes("held-out") || normalized.includes("heldout")) {
    throw new Error(`Refusing to load held-out path in Batch A: basename blocked`);
  }
}

export function loadBatchASuite(path = defaultBatchASuitePath()): BatchASuite {
  assertNotHeldOutSuitePath(path);

  const raw = JSON.parse(readFileSync(path, "utf8")) as BatchASuite;
  if (raw.batch !== "A") {
    throw new Error(`Batch A suite batch field must be "A": ${path}`);
  }
  if (raw.evalPath !== "thin" || raw.productionParity !== false) {
    throw new Error(
      `Batch A suite must declare evalPath:"thin" and productionParity:false: ${path}`,
    );
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`Batch A suite has no cases: ${path}`);
  }

  if (raw.criticalCaseIds) {
    if (!Array.isArray(raw.criticalCaseIds)) {
      throw new Error(`Batch A criticalCaseIds must be an array: ${path}`);
    }
    const known = new Set(raw.cases.map((row) => row.id));
    const missing = raw.criticalCaseIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Batch A criticalCaseIds unknown: ${missing.join(", ")}`,
      );
    }
  }

  for (const row of raw.cases) {
    if (!row.id?.trim()) {
      throw new Error(`Batch A case missing id: ${path}`);
    }
    if (row.heldOut === true) {
      throw new Error(
        `Batch A refuses heldOut case ${row.id} (D12 — held-out not run in Batch A)`,
      );
    }
    if (row.track !== "MODEL" && row.track !== "MODEL_APPLY") {
      throw new Error(
        `Batch A case ${row.id}: track must be MODEL or MODEL_APPLY (got ${String(row.track)})`,
      );
    }
    if (!Array.isArray(row.turns) || row.turns.length === 0) {
      throw new Error(`Batch A case ${row.id}: turns required`);
    }
    if (row.track === "MODEL" && row.turns.length !== 1) {
      throw new Error(
        `Batch A MODEL case ${row.id}: must be exactly one turn (got ${row.turns.length})`,
      );
    }
    if (row.track === "MODEL_APPLY") {
      for (let i = 0; i < row.turns.length; i += 1) {
        const turn = row.turns[i]!;
        if (turn.fixtureMetadata !== undefined && turn.fixtureMetadata !== null) {
          throw new Error(
            `Batch A MODEL_APPLY case ${row.id} turn ${i}: fixtureMetadata forbidden`,
          );
        }
      }
    }
  }

  return raw;
}

/** Convert a single-turn Batch A MODEL case into Phase-4-shaped fields for runModelEvalCase. */
export function batchAModelCaseToEvalCase(
  row: BatchASuiteCase,
): ModelEvalCorpusCase {
  if (row.track !== "MODEL") {
    throw new Error(`batchAModelCaseToEvalCase requires MODEL track (got ${row.track})`);
  }
  const turn = row.turns[0]!;
  return {
    id: row.id,
    tag: (row.tag as ModelEvalTag) || "happy",
    utterance: turn.utterance,
    setup: row.setup ?? turn.setup ?? {},
    constraints: turn.constraints ?? [],
  };
}

/** Domain pack (≥20 independent contracts). Same case shape as Batch A. */
export interface DomainPackSuite {
  version: number;
  speaker: string;
  /** Pack id e.g. "reminder-pack-v1". */
  pack: string;
  domain: string;
  evalPath: "thin";
  productionParity: false;
  /** Minimum independent contracts this pack must contain. */
  minIndependentContracts: number;
  criticalCaseIds?: string[];
  cases: BatchASuiteCase[];
}

export function defaultReminderPackPath(
  repoRoot = resolve(import.meta.dirname, "../../.."),
): string {
  return resolve(repoRoot, "docs/qa/reminder-pack-suite.json");
}

export function defaultDomainPackPath(
  packFileName: string,
  repoRoot = resolve(import.meta.dirname, "../../.."),
): string {
  return resolve(repoRoot, "docs/qa", packFileName);
}

/** Known thin domain packs (Reminder Pack + peers). */
export const DOMAIN_PACK_FILES = [
  { file: "reminder-pack-suite.json", domain: "reminders", pack: "reminder-pack-v1" },
  { file: "shopping-pack-suite.json", domain: "shopping", pack: "shopping-pack-v1" },
  { file: "tasks-pack-suite.json", domain: "tasks", pack: "tasks-pack-v1" },
  { file: "filing-pack-suite.json", domain: "filing", pack: "filing-pack-v1" },
  { file: "directory-pack-suite.json", domain: "directory", pack: "directory-pack-v1" },
  { file: "custom-lists-pack-suite.json", domain: "custom-lists", pack: "custom-lists-pack-v1" },
  { file: "show-pack-suite.json", domain: "show", pack: "show-pack-v1" },
  { file: "share-pack-suite.json", domain: "share", pack: "share-pack-v1" },
] as const;

export function loadDomainPackSuite(
  path: string,
  options?: { expectedDomain?: string; expectedPack?: string },
): DomainPackSuite {
  assertNotHeldOutSuitePath(path);
  const raw = JSON.parse(readFileSync(path, "utf8")) as DomainPackSuite;
  if (raw.evalPath !== "thin" || raw.productionParity !== false) {
    throw new Error(
      `Domain pack must declare evalPath:"thin" and productionParity:false: ${path}`,
    );
  }
  if (!raw.pack?.trim() || !raw.domain?.trim()) {
    throw new Error(`Domain pack missing pack/domain: ${path}`);
  }
  if (options?.expectedDomain && raw.domain !== options.expectedDomain) {
    throw new Error(
      `Domain pack domain ${raw.domain} != expected ${options.expectedDomain}`,
    );
  }
  if (options?.expectedPack && raw.pack !== options.expectedPack) {
    throw new Error(
      `Domain pack pack ${raw.pack} != expected ${options.expectedPack}`,
    );
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`Domain pack has no cases: ${path}`);
  }
  const min = raw.minIndependentContracts ?? 20;
  const contracts = new Set(
    raw.cases.map((row) => row.contract?.trim() || row.id),
  );
  if (contracts.size < min) {
    throw new Error(
      `Domain pack ${raw.pack}: ${contracts.size} independent contracts < min ${min}`,
    );
  }
  if (raw.criticalCaseIds) {
    const known = new Set(raw.cases.map((row) => row.id));
    const missing = raw.criticalCaseIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(`Domain pack criticalCaseIds unknown: ${missing.join(", ")}`);
    }
  }
  for (const row of raw.cases) {
    if (!row.id?.trim()) {
      throw new Error(`Domain pack case missing id: ${path}`);
    }
    if (row.heldOut === true) {
      throw new Error(
        `Domain pack refuses heldOut case ${row.id} (D12)`,
      );
    }
    if (row.track !== "MODEL" && row.track !== "MODEL_APPLY") {
      throw new Error(
        `Domain pack case ${row.id}: track must be MODEL or MODEL_APPLY`,
      );
    }
    if (!Array.isArray(row.turns) || row.turns.length === 0) {
      throw new Error(`Domain pack case ${row.id}: turns required`);
    }
    if (row.track === "MODEL" && row.turns.length !== 1) {
      throw new Error(
        `Domain pack MODEL case ${row.id}: exactly one turn required`,
      );
    }
    if (row.track === "MODEL_APPLY") {
      for (let i = 0; i < row.turns.length; i += 1) {
        const turn = row.turns[i]!;
        if (turn.fixtureMetadata !== undefined && turn.fixtureMetadata !== null) {
          throw new Error(
            `Domain pack MODEL_APPLY ${row.id} turn ${i}: fixtureMetadata forbidden`,
          );
        }
      }
    }
  }
  return raw;
}

export function loadReminderPackSuite(
  path = defaultReminderPackPath(),
): DomainPackSuite {
  return loadDomainPackSuite(path, {
    expectedDomain: "reminders",
    expectedPack: "reminder-pack-v1",
  });
}

/** Event pack (COMPLEX EVENTS) — not registered in DOMAIN_PACK_FILES (≥20) yet. */
export function defaultEventPackPath(
  repoRoot = resolve(import.meta.dirname, "../../.."),
): string {
  return resolve(repoRoot, "docs/qa/event-pack-suite.json");
}

export function loadEventPackSuite(
  path = defaultEventPackPath(),
): DomainPackSuite {
  return loadDomainPackSuite(path, {
    expectedDomain: "events",
    expectedPack: "event-pack-v1",
  });
}

/**
 * Workflow Pack — ENGINE multi-turn cross-domain flows.
 * Same case shape as Gate 1 regression; not a thin MODEL domain pack.
 */
export interface WorkflowPackSuite extends RegressionSuite {
  pack: "workflow-pack-v1";
  domain: "workflows";
}

export function defaultWorkflowPackPath(
  repoRoot = resolve(import.meta.dirname, "../../.."),
): string {
  return resolve(repoRoot, "docs/qa/workflow-pack-suite.json");
}

export function loadWorkflowPackSuite(
  path = defaultWorkflowPackPath(),
): WorkflowPackSuite {
  const raw = JSON.parse(readFileSync(path, "utf8")) as WorkflowPackSuite;
  if (raw.pack !== "workflow-pack-v1" || raw.domain !== "workflows") {
    throw new Error(
      `Workflow pack must declare pack:"workflow-pack-v1" domain:"workflows": ${path}`,
    );
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`Workflow pack has no cases: ${path}`);
  }
  if (raw.criticalCaseIds) {
    if (!Array.isArray(raw.criticalCaseIds)) {
      throw new Error(`Workflow pack criticalCaseIds must be an array: ${path}`);
    }
    const known = new Set(raw.cases.map((row) => row.id));
    const missing = raw.criticalCaseIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Workflow pack criticalCaseIds unknown: ${missing.join(", ")}`,
      );
    }
  }
  for (const row of raw.cases) {
    if (!row.id?.trim()) {
      throw new Error(`Workflow pack case missing id: ${path}`);
    }
    if (row.track !== "ENGINE" && row.track !== "MODEL_APPLY") {
      throw new Error(
        `Workflow pack case ${row.id}: track must be ENGINE or MODEL_APPLY`,
      );
    }
    if (!Array.isArray(row.turns) || row.turns.length === 0) {
      throw new Error(`Workflow pack case ${row.id}: turns required`);
    }
    for (let i = 0; i < row.turns.length; i += 1) {
      const turn = row.turns[i]!;
      if (row.track === "ENGINE") {
        if (turn.fixtureMetadata === undefined || turn.fixtureMetadata === null) {
          throw new Error(
            `Workflow pack ${row.id} turn ${i}: fixtureMetadata required for ENGINE`,
          );
        }
      } else if (
        turn.fixtureMetadata !== undefined &&
        turn.fixtureMetadata !== null
      ) {
        throw new Error(
          `Workflow pack ${row.id} turn ${i}: fixtureMetadata forbidden on MODEL_APPLY`,
        );
      }
    }
  }
  return raw;
}
