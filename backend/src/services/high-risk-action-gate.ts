/**
 * M1–M3 HighRiskActionGate — strip high-risk ACTION shapes before CORE side effects.
 * Does not change ACTION semantics; only removes ops that need Class V (PendingConfirm).
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
};

export const HIGH_RISK_NEEDS_CONFIRM =
  "לא ביצעתי את הפעולה — היא דורשת אישור מפורש.";

function namesForSpeaker(speaker: PublicEmployee, extra?: string[]): string[] {
  const base = [
    employeeDisplayName(speaker),
    speaker.nickname?.trim() ?? "",
    speaker.name.trim(),
    ...(extra ?? []),
  ];
  return [...new Set(base.map((n) => n.trim()).filter(Boolean))];
}

function speakerSet(names: string[]): Set<string> {
  return new Set(names.map((n) => n.trim()).filter(Boolean));
}

function isSpeakerName(raw: string, speakers: Set<string>): boolean {
  return speakers.has(raw.trim());
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

function reminderPingsOthers(
  reminder: LlmReminderAction,
  speakerNames: string[],
): boolean {
  const speakers = speakerSet(speakerNames);
  const raw = [...reminder.ping, ...reminder.targets]
    .map((t) => t.trim())
    .filter(Boolean);
  if (raw.length === 0) {
    return false;
  }
  return raw.some((t) => !isSpeakerName(t, speakers));
}

const JOB_OUTBOUND_ACTIONS = new Set<LlmJobAction["action"]>([
  "answer",
  "decline",
  "counter",
  "close",
  "clear_clock",
]);

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
  return named.every((t) => workers.has(t));
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
    stripped.push({
      policy: "P-Out",
      kind: "send",
      detail: "messages_to_other_or_unresolved",
    });
    snap.messages = [...(snap.messages ?? []), row];
  }

  const remindersIn = metadata.reminders ?? [];
  const reminders: LlmReminderAction[] = [];
  for (const row of remindersIn) {
    if (reminderPingsOthers(row, speakerNames)) {
      stripped.push({
        policy: "P-Out",
        kind: "schedule_foreign",
        detail: "reminder_foreign_ping",
      });
      snap.reminders = [...(snap.reminders ?? []), row];
      continue;
    }
    reminders.push(row);
  }

  const jobsIn = metadata.jobs ?? [];
  const jobs: LlmJobAction[] = [];
  for (const row of jobsIn) {
    if (JOB_OUTBOUND_ACTIONS.has(row.action) || row.reportText.trim()) {
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
      stripped.push({
        policy: "P-Mass",
        kind: "delete_list",
        detail: "listOps.delete_list",
      });
      snap.listOps = [...(snap.listOps ?? []), op];
      continue;
    }
    if (op.addParticipants.length > 0 || op.removeParticipants.length > 0) {
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
      stripped.push({
        policy: "P-Share",
        kind: "share_book",
        detail: "directory.share_book",
      });
      snap.directory = [...(snap.directory ?? []), row];
      continue;
    }
    if ((row.unshareWith ?? []).some((n) => n.trim())) {
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
  const lists: LlmListAction[] = [];
  for (const row of listsKept) {
    if (row.action === "remove" && (dropAllRemoves || row.items.length >= 2)) {
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
