/**
 * M1–M3 HighRiskActionGate — strip high-risk ACTION shapes before CORE side effects.
 * Does not change ACTION semantics; only removes ops that need Class V (PendingConfirm).
 *
 * HIGH_RISK_P_OUT_MODE:
 * - signal (default): allow frictionless P-Out / P-Share when targets are known
 *   AND speaker text has an explicit intent lexicon / button command.
 * - strict: strip all non-self outbound/share (always Class V).
 */
import {
  emptyLlmMetadata,
  llmItemLabel,
  reminderActionFromNestedRemind,
  type LlmDirectoryAction,
  type LlmFilingAction,
  type LlmJobAction,
  type LlmListAction,
  type LlmListOp,
  type LlmListType,
  type LlmMessageAction,
  type LlmMetadata,
  type LlmReminderAction,
  type PublicEmployee,
} from "@workee/shared";
import { getEnv } from "../config/env.js";
import { looksLikePhone, phonesMatch, toWhatsAppAddress } from "../utils/phone.js";
import {
  classifyCollabFromTargets,
  employeeDisplayName,
} from "./employee-targets.service.js";
import type { ResultIntentMiss } from "./apply-result.js";
import {
  clarifyBindAllowsMultiRemove,
  clarifyBindAllowsReminder,
  isSummaryEnvelopeInstruction,
  type ClarifyBind,
} from "./clarify-bind.service.js";
import { splitItemRemind } from "./reminder-soft-link.js";

export type HighRiskPolicy = "P-Out" | "P-Share" | "P-Mass";

export type HighRiskActionKind =
  | "send"
  | "schedule_foreign"
  | "job_outbound"
  | "share"
  | "assign"
  | "unshare"
  | "share_book"
  | "participants"
  | "delete_list"
  | "multi_remove"
  | "directory_phone";

/** Live clock dest labels for F27 effective-ping on update with empty ping. */
export type ExistingReminderPingHint = {
  reminderId: string;
  /** Display names / phones already on the clock. */
  pingLabels: string[];
};

export type HighRiskPOutMode = "signal" | "strict";

export type HighRiskStripReason = {
  policy: HighRiskPolicy;
  kind: HighRiskActionKind;
  detail: string;
};

export type HighRiskGateResult = {
  /** Metadata safe to pass to CORE apply/deliver. */
  metadata: LlmMetadata;
  stripped: HighRiskStripReason[];
  /** Only the high-risk ops that were removed — immutable plan for PendingConfirm. */
  strippedSnapshot: LlmMetadata;
  didStrip: boolean;
};

export type HighRiskGateContext = {
  speaker: PublicEmployee;
  speakerNames?: string[];
  /**
   * Display names of protected digital workers in the speaker's household
   * (e.g. לוסי). List/filing/directory targets that resolve exclusively to
   * these names are Lucy-internal, not P-Share human assign/share.
   */
  digitalWorkerNames?: string[];
  /**
   * When set, Gate does not strip — used only for Class V execute of an
   * already-authorized snapshot (PendingConfirm consume).
   */
  allowAuthorizedSnapshot?: boolean;
  /** Raw speaker utterance this turn (for signal + grounding). */
  speakerText?: string;
  /**
   * P2a EIS channel: text proven as user instruction for allow-signals.
   * When set, outbound/share/mass intent regexes use this instead of speakerText.
   * Shared contact/location cards and forwarded bodies must not appear here.
   * When omitted, falls back to speakerText (tests / legacy callers).
   */
  instructionText?: string;
  /**
   * P1(O1): server-validated clarify bind from the prior assistant turn.
   * Narrows allow for remind_when / delete_scope only; not Class V.
   */
  clarifyBind?: ClarifyBind | null;
  /**
   * Known resolvable human labels: contacts, household employees,
   * active thread participants (display names / nicknames).
   */
  knownTargetNames?: string[];
  /** True when inbound was an opaque / deterministic action button. */
  isButtonCommand?: boolean;
  /** Override env HIGH_RISK_P_OUT_MODE (tests). */
  pOutMode?: HighRiskPOutMode;
  /**
   * Open jobs visible this turn (asker/subject). Used to decide whether a
   * jobs.answer actually delivers a report to someone other than the speaker.
   */
  openJobs?: HighRiskOpenJobRef[];
  /**
   * F27: active clocks for this speaker — resolve empty-ping updates to the
   * real destination before classifying self vs foreign.
   */
  existingReminderPings?: ExistingReminderPingHint[];
};

/** Minimal open-job identity for Gate effect checks (no full JobMeta). */
export type HighRiskOpenJobRef = {
  id: string;
  askerId: string;
  subjectId: string;
  askerName?: string;
  subjectName?: string;
  ask?: string;
};

/** Soft Class V opener — only shown when Gate still strips. */
export const HIGH_RISK_NEEDS_CONFIRM =
  "רגע לפני שאמשיך — הפעולה הזו צריכה אישור מפורש ממך.";

/**
 * Explicit outbound / remind / share intent in the speaker channel.
 * F22: no substring שלח/ask/קצ — שלחתי / please ask / task must not allow.
 * Whole-token שלח (male imperative) still allows «שלח למיכל».
 */
export const OUTBOUND_INTENT_RE =
  /תגידי|תגיד|תשלחי|תשלח|תשלחו|שלחי|(?<![\u0590-\u05FFa-zA-Z])שלח(?![\u0590-\u05FFa-zA-Z])|תמסרי|תמסור|תעדכני|תעדכן|תשאלי|תשאל|תזכירי|תזכיר|תשתפי|תשתף|תקצי|תקצה|תעבירי|תעביר|\btell\b|\bsend\b|\bremind\b|\bshare\b|\bask\s+(?:him|her|them|to)\b/i;

/**
 * Explicit share / assign intent (P-Share allow in signal mode).
 * F22: no bare קצ; bare שתף/שתפי only as whole tokens (not משתף / אשתף).
 */
export const SHARE_INTENT_RE =
  /תשתפי|תשתף|(?<![\u0590-\u05FFa-zA-Z])(?:שתפי|שתף)(?![\u0590-\u05FFa-zA-Z])|תקצי|תקצה|תעבירי|תעביר|באחריות|\bshare\b|\bassign\b/i;

/** Explicit unshare intent. */
export const UNSHARE_INTENT_RE =
  /תורידי שיתוף|תוריד שיתוף|הסירי שיתוף|הסר שיתוף|בטלי שיתוף|בטל שיתוף|unshare\b/i;

/**
 * Explicit mass-delete / bulk-remove intent (P-Mass allow in signal mode).
 * F22: no bare תמחקי/תמחק (matches תמחקתי); keep list/all scopes.
 */
export const MASS_INTENT_RE =
  /תמחקי את רשימת|תמחק את רשימת|תמחקי הכל|תמחק הכל|תמחקי את כל|תמחק את כל|תסירי את כל|תסיר את כל|תמחקי את כולם|תמחק את כולם|תמחקי את שני|תמחק את שני|delete[_\s-]?list|clear all|remove all/i;

/**
 * F2: explicit contact phone add/update intent (not a bare «אנשי קשר» query).
 * Require save/update verbs near phone-book / number language.
 */
export const DIRECTORY_PHONE_INTENT_RE =
  /(?:תוסיפ[יי]?|תוסיף|הוסיפ[יי]?|תעדכנ[יי]?|תעדכן|שמרי|שמור|update|add|save).{0,48}(?:מספר|טלפון|אנשי\s*קשר|contact|phone)|(?:מספר|טלפון|אנשי\s*קשר|contact|phone).{0,48}(?:תוסיפ[יי]?|תוסיף|הוסיפ[יי]?|תעדכנ[יי]?|תעדכן|שמרי|שמור|update|add|save)/i;

const SELF_PING_TOKENS = new Set(
  ["self", "me", "myself", "לי", "לעצמי", "עצמי", "אותי"].map((s) =>
    s.toLowerCase(),
  ),
);

export function resolveHighRiskPOutMode(
  override?: HighRiskPOutMode,
): HighRiskPOutMode {
  if (override === "signal" || override === "strict") {
    return override;
  }
  try {
    return getEnv().HIGH_RISK_P_OUT_MODE === "strict" ? "strict" : "signal";
  } catch {
    return "signal";
  }
}

/**
 * F13: opaque command *prefix* alone is never intent.
 * True only after successful Class V / collab pending ingest this turn.
 */
export function resolveGateIsButtonCommand(input: {
  authorizedHighRiskConfirmId?: string | null;
  authorizedCollabConfirmId?: string | null;
}): boolean {
  return Boolean(
    input.authorizedHighRiskConfirmId || input.authorizedCollabConfirmId,
  );
}

export function hasOutboundIntentSignal(
  speakerText: string | undefined,
  isButtonCommand?: boolean,
): boolean {
  if (isButtonCommand) {
    return true;
  }
  const text = speakerText?.trim() ?? "";
  if (!text) {
    return false;
  }
  return OUTBOUND_INTENT_RE.test(text);
}

export function hasShareIntentSignal(
  speakerText: string | undefined,
  isButtonCommand?: boolean,
): boolean {
  if (isButtonCommand) {
    return true;
  }
  const text = speakerText?.trim() ?? "";
  if (!text) {
    return false;
  }
  // F22: SHARE_INTENT_RE only — dropped loose /שתפ|קצ/ (קצת / משתף).
  return SHARE_INTENT_RE.test(text);
}

export function hasUnshareIntentSignal(
  speakerText: string | undefined,
  isButtonCommand?: boolean,
): boolean {
  if (isButtonCommand) {
    return true;
  }
  const text = speakerText?.trim() ?? "";
  return Boolean(text) && UNSHARE_INTENT_RE.test(text);
}

export function hasMassIntentSignal(
  speakerText: string | undefined,
  isButtonCommand?: boolean,
): boolean {
  if (isButtonCommand) {
    return true;
  }
  const text = speakerText?.trim() ?? "";
  return Boolean(text) && MASS_INTENT_RE.test(text);
}

/** True when every target label appears in the speaker's own utterance. */
export function targetsNamedInSpeakerText(
  targets: string[],
  speakerText: string | undefined,
): boolean {
  const text = normalizeLabel(speakerText ?? "");
  if (!text) {
    return false;
  }
  const named = targets.map((t) => t.trim()).filter(Boolean);
  if (named.length === 0) {
    return false;
  }
  return named.every((target) => {
    const norm = normalizeLabel(target);
    return norm.length >= 2 && text.includes(norm);
  });
}

/**
 * Grounding for signal mode: known contact/employee/thread OR named in
 * the speaker's own message (PI defense still requires intent signal).
 */
export function targetsGroundedForSignal(
  targets: string[],
  knownTargetNames: string[] | undefined,
  speakerText: string | undefined,
): boolean {
  return (
    targetsResolvedAgainstKnown(targets, knownTargetNames) ||
    targetsNamedInSpeakerText(targets, speakerText)
  );
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function knownLabelSet(names: string[] | undefined): Set<string> {
  return new Set(
    (names ?? [])
      .map((n) => normalizeLabel(n))
      .filter(Boolean),
  );
}

/** True when every named target resolves to a known contact/employee/thread label. */
export function targetsResolvedAgainstKnown(
  targets: string[],
  knownTargetNames: string[] | undefined,
): boolean {
  const known = knownLabelSet(knownTargetNames);
  if (known.size === 0) {
    return false;
  }
  const named = targets.map((t) => t.trim()).filter(Boolean);
  if (named.length === 0) {
    return false;
  }
  return named.every((target) => {
    const norm = normalizeLabel(target);
    if (known.has(norm)) {
      return true;
    }
    for (const entry of known) {
      if (entry.includes(norm) || norm.includes(entry)) {
        if (Math.min(entry.length, norm.length) >= 2) {
          return true;
        }
      }
    }
    if (looksLikePhone(target)) {
      for (const entry of knownTargetNames ?? []) {
        if (looksLikePhone(entry) && phonesMatch(entry, target)) {
          return true;
        }
      }
    }
    return false;
  });
}

function namesForSpeaker(speaker: PublicEmployee, extra?: string[]): string[] {
  const phone =
    toWhatsAppAddress(speaker.phone ?? "") ||
    (speaker.phone?.trim() ?? "");
  const guestAlias =
    phone.length >= 4 ? [`אורח …${phone.slice(-4)}`, `אורח ${phone.slice(-4)}`] : [];
  const base = [
    employeeDisplayName(speaker),
    speaker.nickname?.trim() ?? "",
    speaker.name.trim(),
    phone,
    ...guestAlias,
    ...(extra ?? []),
  ];
  return [...new Set(base.map((n) => n.trim()).filter(Boolean))];
}

function speakerSet(names: string[]): Set<string> {
  return new Set(names.map((n) => normalizeLabel(n)).filter(Boolean));
}

/**
 * F26: exact label match only (aligned with matchEmployee aliases).
 * Substring self/Lucy matches caused wrong P-Out skips (e.g. טל ⊂ טלי).
 */
function isSpeakerName(raw: string, speakers: Set<string>): boolean {
  const norm = normalizeLabel(raw);
  if (!norm) {
    return false;
  }
  if (speakers.has(norm)) {
    return true;
  }
  if (SELF_PING_TOKENS.has(norm)) {
    return true;
  }
  return false;
}

export function messageTargetsOnlySpeaker(
  targets: string[],
  speakerNames: string[],
): boolean {
  const speakers = speakerSet(speakerNames);
  const named = targets.map((t) => t.trim()).filter(Boolean);
  if (named.length === 0) {
    return false;
  }
  return named.every((t) => isSpeakerName(t, speakers));
}

/**
 * Self-reminders must never be classified as foreign — including empty ping
 * on *create*, "self"/"לי", speaker name/nickname, phone digits, and guest
 * alias after /as-prospect (אורח …XXXX).
 *
 * F27: updates with empty ping are NOT auto-self — callers must pass
 * effective ping via `effectiveReminderPingTargets` / Gate context hints.
 */
export function isSelfReminderAction(
  reminder: Pick<LlmReminderAction, "ping" | "targets">,
  speakerNames: string[],
  speakerPhone?: string | null,
): boolean {
  const speakers = speakerSet(speakerNames);
  if (speakerPhone?.trim()) {
    const digits =
      toWhatsAppAddress(speakerPhone) || speakerPhone.replace(/\D/g, "");
    if (digits) {
      speakers.add(normalizeLabel(digits));
      if (digits.length >= 4) {
        speakers.add(normalizeLabel(`אורח …${digits.slice(-4)}`));
        speakers.add(normalizeLabel(`אורח ${digits.slice(-4)}`));
      }
    }
  }
  const raw = [...(reminder.ping ?? []), ...(reminder.targets ?? [])]
    .map((t) => t.trim())
    .filter(Boolean);
  if (raw.length === 0) {
    return true;
  }
  return raw.every((t) => {
    if (isSpeakerName(t, speakers)) {
      return true;
    }
    if (speakerPhone?.trim() && looksLikePhone(t) && phonesMatch(speakerPhone, t)) {
      return true;
    }
    return false;
  });
}

/**
 * F27: resolve ping labels for Gate — empty update ping → existing clock dest.
 * Unknown update id with empty ping → [] (treated as foreign / strip).
 */
export function effectiveReminderPingTargets(
  reminder: Pick<LlmReminderAction, "action" | "ping" | "targets" | "reminderId">,
  existingReminderPings?: ExistingReminderPingHint[],
): string[] {
  const named = [...(reminder.ping ?? []), ...(reminder.targets ?? [])]
    .map((t) => t.trim())
    .filter(Boolean);
  if (named.length > 0) {
    return named;
  }
  if (reminder.action !== "update") {
    return [];
  }
  const id = reminder.reminderId?.trim() ?? "";
  if (!id) {
    return [];
  }
  const hint = (existingReminderPings ?? []).find((row) => row.reminderId === id);
  return hint?.pingLabels.map((t) => t.trim()).filter(Boolean) ?? [];
}

export function hasDirectoryPhoneIntentSignal(
  speakerText: string | undefined,
  isButtonCommand?: boolean,
): boolean {
  if (isButtonCommand) {
    return true;
  }
  const text = speakerText?.trim() ?? "";
  if (!text) {
    return false;
  }
  if (!DIRECTORY_PHONE_INTENT_RE.test(text)) {
    return false;
  }
  // Require digits so bare «אנשי קשר» / status asks cannot allow phone plant.
  return text.replace(/\D/g, "").length >= 7;
}

const JOB_OUTBOUND_ACTIONS = new Set<LlmJobAction["action"]>([
  "answer",
  "decline",
  "counter",
  "close",
  "clear_clock",
]);

/**
 * True when applying this job action would deliver a report / notify someone
 * other than the speaker (matches jobs.service addReport: no-op when
 * askerId === speakerId).
 *
 * For `answer` only: a self-job (asker === speaker), including overdue
 * «סגירה», has no external recipient — even if reportText is empty or filled.
 * Unknown jobId stays conservative (treat as external) so we never weaken
 * third-party reporting when OPEN_JOBS was not passed in.
 */
export function jobActionHasExternalEffect(
  row: LlmJobAction,
  ctx: Pick<HighRiskGateContext, "speaker" | "openJobs">,
): boolean {
  if (row.action === "answer") {
    const job = ctx.openJobs?.find((j) => j.id === row.jobId);
    if (job) {
      return job.askerId !== ctx.speaker.id;
    }
    // No open-job context: empty reportText can still defaultReport to asker.
    return true;
  }
  if (JOB_OUTBOUND_ACTIONS.has(row.action) || row.reportText.trim()) {
    return true;
  }
  return false;
}

function itemHasUnshare(item: Record<string, unknown>): boolean {
  const raw = item.unshare_with ?? item.unshareWith;
  if (Array.isArray(raw)) {
    return raw.some((v) => typeof v === "string" && v.trim());
  }
  return typeof raw === "string" && raw.trim().length > 0;
}

function listActionShareKind(
  action: LlmListAction,
  speakerNames: string[],
): "personal" | "co_share" | "assign" | "unshare" {
  if (action.items.some(itemHasUnshare)) {
    return "unshare";
  }
  return classifyCollabFromTargets(action.targets, speakerNames);
}

function filingActionShareKind(
  action: LlmFilingAction,
  speakerNames: string[],
): "personal" | "co_share" | "assign" | "unshare" {
  if ((action.unshareWith ?? []).some((n) => n.trim())) {
    return "unshare";
  }
  return classifyCollabFromTargets(action.targets, speakerNames);
}

/** True when every named target is a household protected digital worker. */
export function targetsOnlyHouseholdDigitalWorkers(
  targets: string[],
  digitalWorkerNames: string[] | undefined,
): boolean {
  const workers = speakerSet(digitalWorkerNames ?? []);
  if (workers.size === 0) {
    return false;
  }
  const named = targets.map((t) => t.trim()).filter(Boolean);
  if (named.length === 0) {
    return false;
  }
  return named.every((t) => isSpeakerName(t, workers));
}

/** Names Gate accepts for Lucy-internal (protected digital) targets. */
export function digitalWorkerGateNames(workers: PublicEmployee[]): string[] {
  const out: string[] = [];
  for (const worker of workers) {
    if (worker.kind !== "digital" || worker.protected !== true) {
      continue;
    }
    for (const raw of [
      employeeDisplayName(worker),
      worker.nickname?.trim() ?? "",
      worker.name.trim(),
    ]) {
      const n = raw.trim();
      if (n && !out.includes(n)) {
        out.push(n);
      }
    }
  }
  return out;
}

function isLucyInternalCollab(
  kind: "co_share" | "assign" | "unshare" | "personal",
  targets: string[],
  digitalWorkerNames: string[] | undefined,
): boolean {
  if (kind !== "co_share" && kind !== "assign") {
    return false;
  }
  return targetsOnlyHouseholdDigitalWorkers(targets, digitalWorkerNames);
}

function countRemoveActions(lists: LlmListAction[], filing: LlmFilingAction[]): number {
  let n = 0;
  for (const row of lists) {
    if (row.action === "remove") {
      n += 1;
    }
  }
  for (const row of filing) {
    if (row.action === "remove_filing") {
      n += 1;
    }
  }
  return n;
}

function primaryActionKind(stripped: HighRiskStripReason[]): HighRiskActionKind {
  const order: HighRiskActionKind[] = [
    "send",
    "schedule_foreign",
    "job_outbound",
    "directory_phone",
    "share",
    "assign",
    "unshare",
    "share_book",
    "participants",
    "delete_list",
    "multi_remove",
  ];
  for (const kind of order) {
    if (stripped.some((s) => s.kind === kind)) {
      return kind;
    }
  }
  return stripped[0]?.kind ?? "send";
}

/** Map Gate strips into ApplyResult intent misses (lists/filing/list_ops/…). */
export function highRiskStripsToMisses(
  stripped: HighRiskStripReason[],
): ResultIntentMiss[] {
  const misses: ResultIntentMiss[] = [];
  for (const row of stripped) {
    if (row.kind === "send" || row.kind === "job_outbound") {
      continue; // not ApplyResult domains — handled via reply override
    }
    const domain =
      row.kind === "delete_list" || row.kind === "participants"
        ? ("list_ops" as const)
        : row.kind === "schedule_foreign"
          ? ("reminders" as const)
          : row.detail.startsWith("filing")
            ? ("filing" as const)
            : row.kind === "directory_phone" ||
                row.detail.startsWith("directory")
              ? ("directory" as const)
              : ("lists" as const);
    misses.push({
      reason: "high_risk_gated",
      domain,
      source: "show_turn_strip",
      label: row.kind,
    });
  }
  return misses;
}

function nonSpeakerTargets(
  targets: string[],
  speakerNames: string[],
): string[] {
  const speakers = speakerSet(speakerNames);
  return targets.map((t) => t.trim()).filter((t) => t && !isSpeakerName(t, speakers));
}

function signalAllowsOutbound(
  targets: string[],
  ctx: HighRiskGateContext,
  speakerNames: string[],
): boolean {
  if (resolveHighRiskPOutMode(ctx.pOutMode) !== "signal") {
    return false;
  }
  const others = nonSpeakerTargets(targets, speakerNames);
  if (others.length === 0) {
    return false;
  }
  // PI defense: non-self targets must resolve to known contacts/employees/thread.
  if (!targetsResolvedAgainstKnown(others, ctx.knownTargetNames)) {
    return false;
  }
  // P2a + F1: EIS verbs only; summary/paste envelopes do not allow P-Out.
  return hasOutboundIntentSignal(
    eisTextForAllowSignals(ctx),
    ctx.isButtonCommand,
  );
}

function signalAllowsShare(
  targets: string[],
  ctx: HighRiskGateContext,
  speakerNames: string[],
): boolean {
  if (resolveHighRiskPOutMode(ctx.pOutMode) !== "signal") {
    return false;
  }
  const others = nonSpeakerTargets(targets, speakerNames);
  if (others.length === 0) {
    return false;
  }
  if (!targetsResolvedAgainstKnown(others, ctx.knownTargetNames)) {
    return false;
  }
  return hasShareIntentSignal(eisTextForAllowSignals(ctx), ctx.isButtonCommand);
}

function signalAllowsUnshare(
  targets: string[],
  ctx: HighRiskGateContext,
  speakerNames: string[],
): boolean {
  if (resolveHighRiskPOutMode(ctx.pOutMode) !== "signal") {
    return false;
  }
  const others = nonSpeakerTargets(targets, speakerNames);
  if (others.length === 0) {
    return false;
  }
  if (!targetsResolvedAgainstKnown(others, ctx.knownTargetNames)) {
    return false;
  }
  return hasUnshareIntentSignal(
    eisTextForAllowSignals(ctx),
    ctx.isButtonCommand,
  );
}

function signalAllowsMass(ctx: HighRiskGateContext): boolean {
  if (resolveHighRiskPOutMode(ctx.pOutMode) !== "signal") {
    return false;
  }
  return hasMassIntentSignal(eisTextForAllowSignals(ctx), ctx.isButtonCommand);
}

function signalAllowsDirectoryPhone(ctx: HighRiskGateContext): boolean {
  if (resolveHighRiskPOutMode(ctx.pOutMode) !== "signal") {
    return false;
  }
  return hasDirectoryPhoneIntentSignal(
    eisTextForAllowSignals(ctx),
    ctx.isButtonCommand,
  );
}

/** P2a: prefer explicit instruction channel when the caller provided one. */
function instructionTextForEis(ctx: HighRiskGateContext): string | undefined {
  if (ctx.instructionText !== undefined) {
    return ctx.instructionText;
  }
  return ctx.speakerText;
}

/**
 * F1: summary/analysis envelopes mix user instruction with quoted payload.
 * Do not treat payload verbs as speaker outbound intent (no provenance claim).
 * Direct instructions without envelope markers still allow.
 */
function eisTextForAllowSignals(ctx: HighRiskGateContext): string | undefined {
  const text = instructionTextForEis(ctx);
  if (text && isSummaryEnvelopeInstruction(text)) {
    return "";
  }
  return text;
}

export function applyHighRiskActionGate(
  metadata: LlmMetadata,
  ctx: HighRiskGateContext,
): HighRiskGateResult {
  if (ctx.allowAuthorizedSnapshot) {
    return {
      metadata,
      stripped: [],
      strippedSnapshot: emptyLlmMetadata(),
      didStrip: false,
    };
  }

  const speakerNames = namesForSpeaker(ctx.speaker, ctx.speakerNames);
  const digitalWorkerNames = ctx.digitalWorkerNames ?? [];
  const stripped: HighRiskStripReason[] = [];
  const snap = emptyLlmMetadata();

  const messagesIn = metadata.messages ?? [];
  const messages: LlmMessageAction[] = [];
  for (const row of messagesIn) {
    if (messageTargetsOnlySpeaker(row.targets, speakerNames)) {
      messages.push(row);
      continue;
    }
    if (signalAllowsOutbound(row.targets, ctx, speakerNames)) {
      messages.push(row);
      continue;
    }
    stripped.push({
      policy: "P-Out",
      kind: "send",
      detail: targetsGroundedForSignal(
        row.targets,
        ctx.knownTargetNames,
        instructionTextForEis(ctx),
      )
        ? "messages_missing_intent_signal"
        : "messages_to_other_or_unresolved",
    });
    snap.messages = [...(snap.messages ?? []), row];
  }

  const remindersIn = metadata.reminders ?? [];
  const reminders: LlmReminderAction[] = [];
  for (const row of remindersIn) {
    // F27: empty-ping updates use existing clock dest, not auto-self.
    const pingTargets = effectiveReminderPingTargets(
      row,
      ctx.existingReminderPings,
    );
    const selfProbe: Pick<LlmReminderAction, "ping" | "targets"> = {
      ping: pingTargets,
      targets: [],
    };
    // Create with empty ping remains self; update with empty+unknown id → foreign.
    const treatAsSelf =
      row.action === "update" &&
      [...(row.ping ?? []), ...(row.targets ?? [])].every((t) => !String(t).trim())
        ? pingTargets.length > 0 &&
          isSelfReminderAction(selfProbe, speakerNames, ctx.speaker.phone)
        : isSelfReminderAction(
            {
              ping: pingTargets.length > 0 ? pingTargets : row.ping,
              targets: pingTargets.length > 0 ? [] : row.targets,
            },
            speakerNames,
            ctx.speaker.phone,
          );
    if (treatAsSelf) {
      reminders.push(row);
      continue;
    }
    // Foreign ping: allow in signal mode when known + remind intent.
    if (signalAllowsOutbound(pingTargets, ctx, speakerNames)) {
      reminders.push(row);
      continue;
    }
    // P1(O1): prior clarify bind may complete schedule only within bound targets.
    if (
      ctx.clarifyBind &&
      clarifyBindAllowsReminder(ctx.clarifyBind, row) &&
      targetsResolvedAgainstKnown(pingTargets, ctx.knownTargetNames)
    ) {
      reminders.push(row);
      continue;
    }
    stripped.push({
      policy: "P-Out",
      kind: "schedule_foreign",
      detail:
        row.action === "update" && pingTargets.length === 0
          ? "reminder_update_unknown_dest"
          : "reminder_foreign_ping",
    });
    snap.reminders = [...(snap.reminders ?? []), row];
  }

  const jobsIn = metadata.jobs ?? [];
  const jobs: LlmJobAction[] = [];
  for (const row of jobsIn) {
    // Check-with / self answer is fulfillment of an open expects_reply job —
    // never Class V. Asker report is delivered automatically with the answer.
    if (row.action === "answer") {
      jobs.push(row);
      continue;
    }
    if (JOB_OUTBOUND_ACTIONS.has(row.action) || row.reportText.trim()) {
      // decline / counter / close / clear_clock (+ unexpected reportText).
      if (
        resolveHighRiskPOutMode(ctx.pOutMode) === "signal" &&
        hasOutboundIntentSignal(
          eisTextForAllowSignals(ctx),
          ctx.isButtonCommand,
        )
      ) {
        jobs.push(row);
        continue;
      }
      stripped.push({
        policy: "P-Out",
        kind: "job_outbound",
        detail: `jobs.${row.action}`,
      });
      snap.jobs = [...(snap.jobs ?? []), row];
      continue;
    }
    jobs.push(row);
  }

  // F16: nested items[].remind must follow the same P-Out rules as top-level.
  const listsAfterNested = gateNestedRemindsInLists(
    metadata.lists ?? [],
    ctx,
    speakerNames,
    stripped,
    snap,
  );
  const listsIn = listsAfterNested;
  const listsKept: LlmListAction[] = [];
  for (const row of listsIn) {
    const kind = listActionShareKind(row, speakerNames);
    if (kind === "co_share" || kind === "assign" || kind === "unshare") {
      if (isLucyInternalCollab(kind, row.targets, digitalWorkerNames)) {
        listsKept.push(row);
        continue;
      }
      if (kind === "unshare") {
        const unshareNames = row.items.flatMap((item) => {
          const raw = item.unshare_with ?? item.unshareWith;
          if (Array.isArray(raw)) {
            return raw.filter((v): v is string => typeof v === "string");
          }
          return typeof raw === "string" ? [raw] : [];
        });
        const names = unshareNames.length > 0 ? unshareNames : row.targets;
        if (signalAllowsUnshare(names, ctx, speakerNames)) {
          listsKept.push(row);
          continue;
        }
      } else if (signalAllowsShare(row.targets, ctx, speakerNames)) {
        listsKept.push(row);
        continue;
      }
      stripped.push({
        policy: "P-Share",
        kind: kind === "co_share" ? "share" : kind,
        detail: `lists_${kind}`,
      });
      snap.lists = [...snap.lists, row];
      continue;
    }
    listsKept.push(row);
  }

  const filingIn = metadata.filing ?? [];
  const filingKept: LlmFilingAction[] = [];
  for (const row of filingIn) {
    const kind = filingActionShareKind(row, speakerNames);
    if (kind === "co_share" || kind === "assign" || kind === "unshare") {
      if (isLucyInternalCollab(kind, row.targets, digitalWorkerNames)) {
        filingKept.push(row);
        continue;
      }
      if (kind === "unshare") {
        const names =
          (row.unshareWith ?? []).filter((n) => n.trim()).length > 0
            ? (row.unshareWith ?? [])
            : row.targets;
        if (signalAllowsUnshare(names, ctx, speakerNames)) {
          filingKept.push(row);
          continue;
        }
      } else if (signalAllowsShare(row.targets, ctx, speakerNames)) {
        filingKept.push(row);
        continue;
      }
      stripped.push({
        policy: "P-Share",
        kind: kind === "co_share" ? "share" : kind,
        detail: `filing_${kind}`,
      });
      snap.filing = [...snap.filing, row];
      continue;
    }
    filingKept.push(row);
  }

  const listOpsIn = metadata.listOps ?? [];
  const listOps: LlmListOp[] = [];
  for (const op of listOpsIn) {
    if (op.action === "delete_list") {
      if (signalAllowsMass(ctx)) {
        listOps.push(op);
        continue;
      }
      stripped.push({
        policy: "P-Mass",
        kind: "delete_list",
        detail: "listOps.delete_list",
      });
      snap.listOps = [...(snap.listOps ?? []), op];
      continue;
    }
    if (op.addParticipants.length > 0 || op.removeParticipants.length > 0) {
      const participantNames = [
        ...op.addParticipants,
        ...op.removeParticipants,
      ];
      if (signalAllowsShare(participantNames, ctx, speakerNames)) {
        listOps.push(op);
        continue;
      }
      stripped.push({
        policy: "P-Share",
        kind: "participants",
        detail: "listOps.participants",
      });
      snap.listOps = [...(snap.listOps ?? []), op];
      continue;
    }
    listOps.push(op);
  }

  const directoryIn = metadata.directory ?? [];
  const directory: LlmDirectoryAction[] = [];
  for (const row of directoryIn) {
    if (row.action === "share_book") {
      if (signalAllowsShare(row.targets, ctx, speakerNames)) {
        directory.push(row);
        continue;
      }
      stripped.push({
        policy: "P-Share",
        kind: "share_book",
        detail: "directory.share_book",
      });
      snap.directory = [...(snap.directory ?? []), row];
      continue;
    }
    if ((row.unshareWith ?? []).some((n) => n.trim())) {
      if (signalAllowsUnshare(row.unshareWith ?? [], ctx, speakerNames)) {
        directory.push(row);
        continue;
      }
      stripped.push({
        policy: "P-Share",
        kind: "unshare",
        detail: "directory.unshare",
      });
      snap.directory = [...(snap.directory ?? []), row];
      continue;
    }
    const collab = classifyCollabFromTargets(row.targets, speakerNames);
    if (collab === "co_share" || collab === "assign") {
      if (isLucyInternalCollab(collab, row.targets, digitalWorkerNames)) {
        directory.push(row);
        continue;
      }
      if (signalAllowsShare(row.targets, ctx, speakerNames)) {
        directory.push(row);
        continue;
      }
      stripped.push({
        policy: "P-Share",
        kind: collab === "co_share" ? "share" : "assign",
        detail: `directory.${row.action}`,
      });
      snap.directory = [...(snap.directory ?? []), row];
      continue;
    }
    // F2: personal directory add/update with a phone is P-Out unless EIS+digits
    // (or Class V button). Prevents PI-7 plant/redirect via ungated fall-through.
    if (
      (row.action === "add" || row.action === "update") &&
      Boolean(row.phone?.trim())
    ) {
      if (signalAllowsDirectoryPhone(ctx)) {
        directory.push(row);
        continue;
      }
      stripped.push({
        policy: "P-Out",
        kind: "directory_phone",
        detail: `directory.${row.action}_phone`,
      });
      snap.directory = [...(snap.directory ?? []), row];
      continue;
    }
    directory.push(row);
  }

  const removeActionCount = countRemoveActions(listsKept, filingKept);
  const dropAllRemoves = removeActionCount >= 2;
  const massAllowed = signalAllowsMass(ctx);
  const lists: LlmListAction[] = [];
  for (const row of listsKept) {
    if (row.action === "remove" && (dropAllRemoves || row.items.length >= 2)) {
      if (massAllowed) {
        lists.push(row);
        continue;
      }
      if (
        ctx.clarifyBind &&
        clarifyBindAllowsMultiRemove(ctx.clarifyBind, row)
      ) {
        lists.push(row);
        continue;
      }
      stripped.push({
        policy: "P-Mass",
        kind: "multi_remove",
        detail: dropAllRemoves
          ? "lists.remove_multi_action"
          : "lists.remove_multi_id",
      });
      snap.lists = [...snap.lists, row];
      continue;
    }
    lists.push(row);
  }
  const filing: LlmFilingAction[] = [];
  for (const row of filingKept) {
    if (row.action === "remove_filing" && dropAllRemoves) {
      if (massAllowed) {
        filing.push(row);
        continue;
      }
      stripped.push({
        policy: "P-Mass",
        kind: "multi_remove",
        detail: "filing.remove_multi_action",
      });
      snap.filing = [...snap.filing, row];
      continue;
    }
    filing.push(row);
  }

  return {
    metadata: {
      ...metadata,
      lists,
      listOps,
      filing,
      messages,
      reminders,
      directory,
      jobs,
    },
    stripped,
    strippedSnapshot: snap,
    didStrip: stripped.length > 0,
  };
}

export function highRiskPrimaryKind(
  stripped: HighRiskStripReason[],
): HighRiskActionKind {
  return primaryActionKind(stripped);
}

/**
 * F16: peel foreign nested items[].remind the same way as top-level reminders.
 * Keeps the list item; strips only ungated nested clocks into strippedSnapshot.
 */
function gateNestedRemindsInLists(
  listsIn: LlmListAction[],
  ctx: HighRiskGateContext,
  speakerNames: string[],
  stripped: HighRiskStripReason[],
  snap: LlmMetadata,
): LlmListAction[] {
  const out: LlmListAction[] = [];
  for (const row of listsIn) {
    if (row.listType !== "shopping" && row.listType !== "tasks") {
      out.push(row);
      continue;
    }
    if (row.action !== "add" && row.action !== "update") {
      out.push(row);
      continue;
    }
    const nextItems: LlmListAction["items"] = [];
    let rowChanged = false;
    for (const rawItem of row.items) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        nextItems.push(rawItem);
        continue;
      }
      const peeled = splitItemRemind(rawItem as Record<string, unknown>);
      if (peeled.reminds.length === 0) {
        nextItems.push(rawItem);
        continue;
      }
      const keptReminds: Record<string, unknown>[] = [];
      let itemChanged = false;
      const label =
        llmItemLabel(peeled.item) ||
        String(
          peeled.item["שם משימה"] ??
            peeled.item["שם פריט"] ??
            peeled.item.name ??
            "",
        ).trim() ||
        "פריט";
      const itemId =
        String(peeled.item.item_id ?? peeled.item.itemId ?? "").trim() ||
        "nested";
      for (const remind of peeled.reminds) {
        const action = reminderActionFromNestedRemind(remind, {
          itemLabel: label,
          listType: row.listType as LlmListType,
          itemId,
        });
        if (!action) {
          keptReminds.push(remind);
          continue;
        }
        const pingTargets = [...(action.ping ?? []), ...(action.targets ?? [])]
          .map((t) => t.trim())
          .filter(Boolean);
        const self = isSelfReminderAction(
          { ping: pingTargets, targets: [] },
          speakerNames,
          ctx.speaker.phone,
        );
        if (self) {
          keptReminds.push(remind);
          continue;
        }
        if (signalAllowsOutbound(pingTargets, ctx, speakerNames)) {
          keptReminds.push(remind);
          continue;
        }
        itemChanged = true;
        rowChanged = true;
        stripped.push({
          policy: "P-Out",
          kind: "schedule_foreign",
          detail: "nested_remind_foreign_ping",
        });
        snap.reminders = [...(snap.reminders ?? []), action];
      }
      if (!itemChanged) {
        nextItems.push(rawItem);
        continue;
      }
      const rebuilt: Record<string, unknown> = { ...peeled.item };
      if (keptReminds.length === 1) {
        rebuilt.remind = keptReminds[0];
      } else if (keptReminds.length > 1) {
        rebuilt.reminds = keptReminds;
      }
      nextItems.push(rebuilt as LlmListAction["items"][number]);
    }
    out.push(rowChanged ? { ...row, items: nextItems } : row);
  }
  return out;
}

/** Build known-target labels for Gate grounding (contacts + humans + thread). */
export function collectKnownTargetNames(input: {
  contacts?: Array<{ name?: string | null; phone?: string | null }>;
  employees?: PublicEmployee[];
  threadParticipantNames?: string[];
  excludeEmployeeId?: string;
}): string[] {
  const out: string[] = [];
  const push = (raw: string | null | undefined) => {
    const n = raw?.trim();
    if (n && !out.includes(n)) {
      out.push(n);
    }
  };
  for (const contact of input.contacts ?? []) {
    push(contact.name);
    if (contact.phone?.trim()) {
      push(toWhatsAppAddress(contact.phone) || contact.phone.trim());
    }
  }
  for (const emp of input.employees ?? []) {
    if (input.excludeEmployeeId && emp.id === input.excludeEmployeeId) {
      continue;
    }
    if (emp.kind === "digital") {
      continue;
    }
    push(employeeDisplayName(emp));
    push(emp.nickname);
    push(emp.name);
    if (emp.phone?.trim()) {
      push(toWhatsAppAddress(emp.phone) || emp.phone.trim());
    }
  }
  for (const name of input.threadParticipantNames ?? []) {
    push(name);
  }
  return out;
}
