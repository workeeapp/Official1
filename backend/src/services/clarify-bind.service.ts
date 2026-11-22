/**
 * P1 — Conversation clarifyBind (not Class V).
 * awaiting from the model is a proposal only; the server owns userScope.
 *
 * PRODUCTION: not active on WA or Web/UI free-text — bindAuthority stays "none".
 * trusted_control is a future server-issued interactive-control authority; no
 * user path mints it today. EIS / awaiting / hash / dry-Gate are never provenance.
 * FP-2/FP-3 remain known UX limits until a real trusted_control channel exists.
 * Status: docs/product/lucy-high-risk-gate-p0-p1-status.md
 */
import type {
  LlmListAction,
  LlmMetadata,
  LlmReminderAction,
  PublicEmployee,
} from "@workee/shared";
import { emptyLlmMetadata } from "@workee/shared";
import {
  applyHighRiskActionGate,
  type HighRiskGateContext,
} from "./high-risk-action-gate.js";

export const CLARIFY_BIND_RAW_KEY = "clarifyBind";

/**
 * Server-only provenance for creating a clarifyBind.
 * Never read from model ACTION / metadata — callers must set this in code.
 */
export type ClarifyBindAuthority = "none" | "trusted_control";

export type ClarifyBindKind = "remind_when" | "delete_scope";

/** Normalize caller authority. Anything except exact trusted_control → none. */
export function resolveClarifyBindAuthority(
  raw: unknown,
): ClarifyBindAuthority {
  return raw === "trusted_control" ? "trusted_control" : "none";
}

export type ClarifyBind = {
  v: 1;
  kind: ClarifyBindKind;
  /** Allowed reminder ping labels (remind_when). */
  targets: string[];
  /** Allowed list/filing remove item ids (delete_scope). */
  itemIds: string[];
  /** Hash of instruction text that authorized the scope. */
  sourceInstructionHash: string;
  createdAt: string;
};

export type ModelAwaitingProposal = {
  kind: ClarifyBindKind;
  targets: string[];
  itemIds: string[];
};

/**
 * Summary/analysis envelopes — instruction is mixed; no O1 bind.
 * Hebrew verbs: no JS `\b` (fails on Hebrew); require colon/newline payload.
 */
const SUMMARY_ENVELOPE_RE =
  /^(?:\s*)(?:תסכמי|תסכמו|תסכם|תקראי|תקראו|תקרא|תנתחי|תנתחו|תנתח|מה כתוב|תסבירי|תסבירו|תסביר)/i;

export function isSummaryEnvelopeInstruction(instructionText: string): boolean {
  const text = instructionText.trim();
  if (!text) {
    return false;
  }
  if (!SUMMARY_ENVELOPE_RE.test(text)) {
    return false;
  }
  // Envelope + payload after : or newline → mixed, not O1 for bind.
  return /[:：]|\n/.test(text);
}

export function hashInstructionSource(instructionText: string): string {
  // Lightweight stable fingerprint (not crypto auth).
  let h = 0;
  const s = instructionText.trim();
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `h${(h >>> 0).toString(16)}`;
}

export function parseModelAwaitingProposal(
  metadata: LlmMetadata,
): ModelAwaitingProposal | null {
  const raw = metadata.awaiting;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const kind = raw.kind;
  if (kind !== "remind_when" && kind !== "delete_scope") {
    return null;
  }
  return {
    kind,
    targets: (raw.targets ?? []).map((t) => String(t).trim()).filter(Boolean),
    itemIds: (raw.itemIds ?? []).map((t) => String(t).trim()).filter(Boolean),
  };
}

function readStringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((v) => String(v ?? "").trim()).filter(Boolean);
}

export function parseClarifyBind(raw: unknown): ClarifyBind | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (row.v !== 1) {
    return null;
  }
  const kind =
    row.kind === "remind_when" || row.kind === "delete_scope"
      ? row.kind
      : null;
  if (!kind) {
    return null;
  }
  const targets = readStringList(row.targets);
  const itemIds = readStringList(row.itemIds ?? row.item_ids);
  const sourceInstructionHash = String(row.sourceInstructionHash ?? "").trim();
  const createdAt = String(row.createdAt ?? "").trim();
  if (!sourceInstructionHash || !createdAt) {
    return null;
  }
  if (kind === "remind_when" && targets.length === 0) {
    return null;
  }
  if (kind === "delete_scope" && itemIds.length === 0) {
    return null;
  }
  return {
    v: 1,
    kind,
    targets,
    itemIds,
    sourceInstructionHash,
    createdAt,
  };
}

/**
 * Build a clarifyBind only with server bindAuthority=trusted_control.
 * Returns null when authority/scope/dry-Gate fail.
 * instructionText / awaiting / hash are scope helpers — not provenance.
 */
export function tryCreateClarifyBind(input: {
  instructionText: string;
  proposal: ModelAwaitingProposal | null;
  /** Visible item ids this turn (dump / ESD). */
  visibleItemIds: Iterable<string>;
  knownTargetNames: string[];
  speaker: PublicEmployee;
  speakerNames?: string[];
  now?: Date;
  /**
   * Required provenance. Default / omit / forged → none → no bind.
   * Do not pass values from model metadata.
   */
  bindAuthority?: ClarifyBindAuthority | unknown;
}): ClarifyBind | null {
  // Hard gate: free-text channels must stay none; only future server controls.
  if (resolveClarifyBindAuthority(input.bindAuthority) !== "trusted_control") {
    return null;
  }

  const instruction = input.instructionText.trim();
  if (!instruction) {
    return null;
  }
  // Mixed summary/analysis envelopes: no bind even with trusted_control.
  if (isSummaryEnvelopeInstruction(instruction)) {
    return null;
  }
  if (!input.proposal) {
    return null;
  }

  const visible = new Set(
    [...input.visibleItemIds].map((id) => id.trim()).filter(Boolean),
  );

  let targets: string[] = [];
  let itemIds: string[] = [];

  if (input.proposal.kind === "remind_when") {
    // Server scope: names that appear in instruction AND are known.
    // Proposal may only narrow, never expand beyond instruction∩known.
    const fromInstruction = input.knownTargetNames.filter((name) => {
      const n = name.trim();
      if (n.length < 2) return false;
      return instruction.toLowerCase().includes(n.toLowerCase());
    });
    if (fromInstruction.length === 0) {
      return null;
    }
    const proposed = input.proposal.targets.map((t) => t.trim()).filter(Boolean);
    targets =
      proposed.length > 0
        ? fromInstruction.filter((t) =>
            proposed.some((p) => p.toLowerCase() === t.toLowerCase()),
          )
        : fromInstruction;
    // Require an outbound/remind cue in instruction (EIS), not name-only.
    if (!/\bתזכיר|\bתזכירי|\bהזכירי|remind\b/i.test(instruction)) {
      // Hebrew verbs without word boundaries:
      if (!/תזכירי|תזכיר|הזכירי|תזכור|remind/i.test(instruction)) {
        return null;
      }
    }
    if (targets.length === 0) {
      return null;
    }
  } else {
    // delete_scope: proposal ids ∩ visible; instruction must show delete intent.
    if (!/תמחק|תמחקי|תסירי|תסיר|מחק|delete|remove/i.test(instruction)) {
      return null;
    }
    const proposed = input.proposal.itemIds.map((id) => id.trim()).filter(Boolean);
    itemIds = proposed.filter((id) => visible.has(id));
    if (itemIds.length === 0) {
      return null;
    }
  }

  const synthetic = buildSyntheticMetadata({
    kind: input.proposal.kind,
    targets,
    itemIds,
  });
  const dryCtx: HighRiskGateContext = {
    speaker: input.speaker,
    speakerNames: input.speakerNames,
    pOutMode: "signal",
    speakerText: instruction,
    instructionText: instruction,
    knownTargetNames: input.knownTargetNames,
  };
  const dry = applyHighRiskActionGate(synthetic, dryCtx);
  if (dry.didStrip) {
    return null;
  }

  return {
    v: 1,
    kind: input.proposal.kind,
    targets,
    itemIds,
    sourceInstructionHash: hashInstructionSource(instruction),
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

function buildSyntheticMetadata(input: {
  kind: ClarifyBindKind;
  targets: string[];
  itemIds: string[];
}): LlmMetadata {
  const base = emptyLlmMetadata();
  if (input.kind === "remind_when") {
    const reminder: LlmReminderAction = {
      action: "add",
      item: "clarify",
      listType: "tasks",
      date: "2099-01-01",
      time: "12:00",
      repeat: "once",
      ping: input.targets,
      targets: [],
      text: "clarify",
      inSeconds: null,
      everyCount: null,
      everyUnit: null,
      weekdays: null,
      confirmed: true,
      compose: false,
      composeSource: "",
      composeLookbackHours: 0,
      composePlace: "",
      reminderId: "",
    };
    return { ...base, reminders: [reminder] };
  }
  const list: LlmListAction = {
    action: "remove",
    listType: "shopping",
    listName: "",
    items: input.itemIds.map((item_id) => ({ item_id })),
    targets: [],
  };
  return { ...base, lists: [list] };
}

/** Whether Gate may allow this ACTION slice via an active clarifyBind. */
export function clarifyBindAllowsReminder(
  bind: ClarifyBind,
  reminder: Pick<LlmReminderAction, "ping" | "targets" | "action">,
): boolean {
  if (bind.kind !== "remind_when") {
    return false;
  }
  if (reminder.action !== "add" && reminder.action !== "update") {
    return false;
  }
  const pings = [...reminder.ping, ...reminder.targets]
    .map((p) => p.trim())
    .filter(Boolean);
  if (pings.length === 0) {
    return false;
  }
  const allowed = new Set(bind.targets.map((t) => t.toLowerCase()));
  return pings.every((p) => allowed.has(p.toLowerCase()));
}

export function clarifyBindAllowsMultiRemove(
  bind: ClarifyBind,
  list: Pick<LlmListAction, "action" | "items">,
): boolean {
  if (bind.kind !== "delete_scope") {
    return false;
  }
  if (list.action !== "remove") {
    return false;
  }
  const ids = (list.items ?? [])
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const row = item as Record<string, unknown>;
      return String(row.item_id ?? row.itemId ?? "").trim();
    })
    .filter(Boolean);
  if (ids.length === 0) {
    return false;
  }
  const allowed = new Set(bind.itemIds);
  return ids.every((id) => allowed.has(id));
}
