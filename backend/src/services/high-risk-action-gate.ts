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
  type LlmDirectoryAction,
  type LlmFilingAction,
  type LlmJobAction,
  type LlmListAction,
  type LlmListOp,
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
  | "multi_remove";

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

/** Explicit outbound / remind / share intent in the speaker channel. */
export const OUTBOUND_INTENT_RE =
  /תגידי|תגיד|תשלחי|תשלח|תמסרי|תמסור|תעדכני|תעדכן|תשאלי|תשאל|תזכירי|תזכיר|תשתפי|תשתף|תקצי|תקצה|שלחי|שלח|גידי|מסרי|עדכני|שאלי|הזכירי|שתפי|קצי|tell\b|send\b|remind\b|share\b|ask\b/i;

/** Explicit share / assign intent (P-Share allow in signal mode). */
export const SHARE_INTENT_RE =
  /תשתפי|תשתף|שתפי|שתף|תקצי|תקצה|קצי|תעבירי|תעביר|באחריות|share\b|assign\b/i;

/** Explicit unshare intent. */
export const UNSHARE_INTENT_RE =
  /תורידי שיתוף|תוריד שיתוף|הסירי שיתוף|הסר שיתוף|בטלי שיתוף|בטל שיתוף|unshare\b/i;

/** Explicit mass-delete / bulk-remove intent (P-Mass allow in signal mode). */
export const MASS_INTENT_RE =
  /תמחקי את רשימת|תמחק את רשימת|תמחקי הכל|תמחק הכל|תמחקי את כל|תמחק את כל|תסירי את כל|תסיר את כל|תסירי את|תמחקי|תמחק|delete[_\s-]?list|clear all|remove all/i;

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
  return SHARE_INTENT_RE.test(text) || /שתפ|קצ/.test(text);
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
  for (const entry of speakers) {
    if (entry.includes(norm) || norm.includes(entry)) {
      if (Math.min(entry.length, norm.length) >= 2) {
        return true;
      }
    }
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
 * Self-reminders must never be classified as foreign — including empty ping,
 * "self"/"לי", speaker name/nickname, phone digits, and guest alias after
 * /as-prospect (אורח …XXXX).
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
  const raw = [...reminder.ping, ...reminder.targets]
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
            : row.detail.startsWith("directory")
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
  // Explicit send/remind verb OR the speaker named that known target.
  return (
    hasOutboundIntentSignal(ctx.speakerText, ctx.isButtonCommand) ||
    targetsNamedInSpeakerText(others, ctx.speakerText)
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
  return (
    hasShareIntentSignal(ctx.speakerText, ctx.isButtonCommand) ||
    targetsNamedInSpeakerText(others, ctx.speakerText)
  );
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
  return (
    hasUnshareIntentSignal(ctx.speakerText, ctx.isButtonCommand) ||
    targetsNamedInSpeakerText(others, ctx.speakerText)
  );
}

function signalAllowsMass(ctx: HighRiskGateContext): boolean {
  if (resolveHighRiskPOutMode(ctx.pOutMode) !== "signal") {
    return false;
  }
  return hasMassIntentSignal(ctx.speakerText, ctx.isButtonCommand);
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
        ctx.speakerText,
      )
        ? "messages_missing_intent_signal"
        : "messages_to_other_or_unresolved",
    });
    snap.messages = [...(snap.messages ?? []), row];
  }

  const remindersIn = metadata.reminders ?? [];
  const reminders: LlmReminderAction[] = [];
  for (const row of remindersIn) {
    if (isSelfReminderAction(row, speakerNames, ctx.speaker.phone)) {
      reminders.push(row);
      continue;
    }
    // Foreign ping: allow in signal mode when known + remind intent.
    const pingTargets = [...row.ping, ...row.targets]
      .map((t) => t.trim())
      .filter(Boolean);
    if (signalAllowsOutbound(pingTargets, ctx, speakerNames)) {
      reminders.push(row);
      continue;
    }
    stripped.push({
      policy: "P-Out",
      kind: "schedule_foreign",
      detail: "reminder_foreign_ping",
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
        hasOutboundIntentSignal(ctx.speakerText, ctx.isButtonCommand)
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

  const listsIn = metadata.lists ?? [];
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
