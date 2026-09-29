import type {
  LlmDirectoryAction,
  LlmFilingAction,
  LlmListAction,
  LlmReminderAction,
} from "@workee/shared";
import {
  PENDING_DELETE_TIMEOUT_MS,
  type PendingDeleteAction,
} from "./reminder.service.js";

export const PENDING_HOLD_TIMEOUT_MS = PENDING_DELETE_TIMEOUT_MS;

export type PendingHoldKind =
  | "directory"
  | "lists"
  | "reminders"
  | "filing";

export type PendingHoldAction = {
  action:
    | "complete_directory"
    | "complete_lists"
    | "complete_reminders"
    | "complete_filing";
  step: "awaiting_fields";
  need: string;
  draft: {
    directory?: LlmDirectoryAction[];
    lists?: LlmListAction[];
    reminders?: LlmReminderAction[];
    filing?: LlmFilingAction[];
  };
  at: Date;
};

export type ConversationPendingAction = PendingDeleteAction | PendingHoldAction;

export type LlmHold = {
  kind: PendingHoldKind;
  need: string;
  directory: LlmDirectoryAction[];
  lists: LlmListAction[];
  reminders: LlmReminderAction[];
  filing: LlmFilingAction[];
};

const HOLD_ACTIONS: Record<PendingHoldKind, PendingHoldAction["action"]> = {
  directory: "complete_directory",
  lists: "complete_lists",
  reminders: "complete_reminders",
  filing: "complete_filing",
};

export function pendingHoldFromLlm(hold: LlmHold | null | undefined): PendingHoldAction | null {
  if (!hold) {
    return null;
  }
  const need = hold.need.trim();
  if (!need) {
    return null;
  }
  const draft = {
    ...(hold.directory.length > 0 ? { directory: hold.directory } : {}),
    ...(hold.lists.length > 0 ? { lists: hold.lists } : {}),
    ...(hold.reminders.length > 0 ? { reminders: hold.reminders } : {}),
    ...(hold.filing.length > 0 ? { filing: hold.filing } : {}),
  };
  if (Object.keys(draft).length === 0) {
    return null;
  }
  return {
    action: HOLD_ACTIONS[hold.kind],
    step: "awaiting_fields",
    need: need.slice(0, 200),
    draft,
    at: new Date(),
  };
}

export function conversationPendingFromStored(row: {
  pendingAction: string | null;
  pendingTargets: unknown;
  pendingStep: string | null;
  pendingAt: Date | null;
} | null): ConversationPendingAction | null {
  if (!row?.pendingAction || !row.pendingAt) {
    return null;
  }
  if (row.pendingAction === "delete_reminder" && row.pendingStep === "confirm") {
    const targets = Array.isArray(row.pendingTargets)
      ? row.pendingTargets.filter(
          (item): item is string => typeof item === "string" && Boolean(item.trim()),
        )
      : [];
    if (targets.length === 0) {
      return null;
    }
    return {
      action: "delete_reminder",
      step: "confirm",
      targets,
      at: row.pendingAt,
    };
  }

  if (
    row.pendingStep === "awaiting_fields" &&
    (row.pendingAction === "complete_directory" ||
      row.pendingAction === "complete_lists" ||
      row.pendingAction === "complete_reminders" ||
      row.pendingAction === "complete_filing")
  ) {
    const payload =
      row.pendingTargets &&
      typeof row.pendingTargets === "object" &&
      !Array.isArray(row.pendingTargets)
        ? (row.pendingTargets as Record<string, unknown>)
        : null;
    const need =
      typeof payload?.need === "string" ? payload.need.trim() : "";
    const draftRaw =
      payload?.draft && typeof payload.draft === "object" && !Array.isArray(payload.draft)
        ? (payload.draft as Record<string, unknown>)
        : null;
    if (!need || !draftRaw) {
      return null;
    }
    return {
      action: row.pendingAction,
      step: "awaiting_fields",
      need,
      draft: {
        directory: Array.isArray(draftRaw.directory)
          ? (draftRaw.directory as LlmDirectoryAction[])
          : undefined,
        lists: Array.isArray(draftRaw.lists)
          ? (draftRaw.lists as LlmListAction[])
          : undefined,
        reminders: Array.isArray(draftRaw.reminders)
          ? (draftRaw.reminders as LlmReminderAction[])
          : undefined,
        filing: Array.isArray(draftRaw.filing)
          ? (draftRaw.filing as LlmFilingAction[])
          : undefined,
      },
      at: row.pendingAt,
    };
  }

  return null;
}

export function pendingToStored(pending: ConversationPendingAction | null): {
  pendingAction: string | null;
  pendingTargets: unknown;
  pendingStep: string | null;
  pendingAt: Date | null;
} {
  if (!pending) {
    return {
      pendingAction: null,
      pendingTargets: null,
      pendingStep: null,
      pendingAt: null,
    };
  }
  if (pending.action === "delete_reminder") {
    return {
      pendingAction: pending.action,
      pendingTargets: pending.targets,
      pendingStep: pending.step,
      pendingAt: pending.at,
    };
  }
  return {
    pendingAction: pending.action,
    pendingTargets: { need: pending.need, draft: pending.draft },
    pendingStep: pending.step,
    pendingAt: pending.at,
  };
}

export function formatConversationPendingContext(
  pending: ConversationPendingAction | null,
  options: { now?: Date; timeoutMs?: number } = {},
): string {
  if (!pending) {
    return "";
  }
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? PENDING_HOLD_TIMEOUT_MS;
  if (now.getTime() - pending.at.getTime() > timeoutMs) {
    return "";
  }

  if (pending.action === "delete_reminder") {
    return [
      "PENDING_ACTION_STATE:",
      `current_action: ${pending.action}`,
      `current_target: ${pending.targets.join(", ")}`,
      `current_step: ${pending.step}`,
      "Stay inside this action until the server clears it.",
      "A reminder name from the speaker selects/narrows targets — it is NOT a send or new command.",
      "Yes / confirm → metadata.confirm=true and empty reminders.",
      "No / cancel → metadata.confirm=false and empty reminders.",
      "Do not emit messages, lists, or reminder adds while current_step is confirm.",
    ].join("\n");
  }

  return [
    "PENDING_ACTION_STATE:",
    `current_action: ${pending.action}`,
    `current_step: ${pending.step}`,
    `missing_field: ${pending.need}`,
    `known_draft: ${JSON.stringify(pending.draft)}`,
    "The speaker's short reply fills missing_field for this draft — a name, time, number, or yes/no.",
    "Never reply לא הבנתי / מה תרצה לעשות to that short reply.",
    "Complete the draft: emit the finished metadata (directory/lists/reminders/filing) with hold=null.",
    "If still missing something else, emit hold again with the updated draft and the new need.",
    "Do not start an unrelated new request until this hold is completed or the speaker clearly switches topic.",
  ].join("\n");
}

export function holdFulfilledByMetadata(
  pending: PendingHoldAction,
  meta: {
    directory: LlmDirectoryAction[];
    lists: LlmListAction[];
    reminders: LlmReminderAction[];
    filing: LlmFilingAction[];
    hold: LlmHold | null;
  },
): boolean {
  if (meta.hold) {
    return false;
  }
  if (pending.action === "complete_directory") {
    return meta.directory.some(
      (row) => row.action === "add" && row.name.trim() && row.phone.trim(),
    );
  }
  if (pending.action === "complete_lists") {
    return meta.lists.some(
      (row) =>
        (row.action === "add" || row.action === "update") && row.items.length > 0,
    );
  }
  if (pending.action === "complete_reminders") {
    return meta.reminders.some(
      (row) => row.action === "add" || row.action === "update",
    );
  }
  if (pending.action === "complete_filing") {
    return meta.filing.some(
      (row) =>
        row.action === "add_filing" || row.action === "update_filing",
    );
  }
  return false;
}

export function hasUnrelatedWorkWhileHold(input: {
  hold: LlmHold | null;
  directory: LlmDirectoryAction[];
  lists: LlmListAction[];
  reminders: LlmReminderAction[];
  filing: LlmFilingAction[];
  messages: Array<{ text: string; targets: string[] }>;
  confirm: boolean | null;
  pending: PendingHoldAction;
}): boolean {
  if (input.hold || input.confirm !== null) {
    return false;
  }
  if (holdFulfilledByMetadata(input.pending, input)) {
    return false;
  }
  if (
    input.messages.some(
      (row) => row.text.trim().length > 0 && row.targets.length > 0,
    )
  ) {
    return true;
  }
  // Other domains than the one held count as a topic switch.
  if (input.pending.action === "complete_directory") {
    return (
      input.lists.length > 0 ||
      input.reminders.length > 0 ||
      input.filing.length > 0
    );
  }
  if (input.pending.action === "complete_lists") {
    return (
      input.directory.length > 0 ||
      input.reminders.length > 0 ||
      input.filing.length > 0
    );
  }
  if (input.pending.action === "complete_reminders") {
    return (
      input.directory.length > 0 ||
      input.lists.length > 0 ||
      input.filing.length > 0
    );
  }
  return (
    input.directory.length > 0 ||
    input.lists.length > 0 ||
    input.reminders.length > 0
  );
}

export function resolveNextPending(input: {
  stored: ConversationPendingAction | null;
  hold: LlmHold | null;
  reminderNext: PendingDeleteAction | null;
  directory: LlmDirectoryAction[];
  lists: LlmListAction[];
  reminders: LlmReminderAction[];
  filing: LlmFilingAction[];
  messages: Array<{ text: string; targets: string[] }>;
  confirm: boolean | null;
  now?: Date;
}): ConversationPendingAction | null {
  const now = input.now ?? new Date();
  // Reminder delete confirm always wins while active / newly planned.
  if (input.reminderNext) {
    return input.reminderNext;
  }

  const freshHold = pendingHoldFromLlm(input.hold);
  if (freshHold) {
    return freshHold;
  }

  if (
    input.stored &&
    input.stored.action !== "delete_reminder" &&
    now.getTime() - input.stored.at.getTime() <= PENDING_HOLD_TIMEOUT_MS
  ) {
    if (
      holdFulfilledByMetadata(input.stored, {
        directory: input.directory,
        lists: input.lists,
        reminders: input.reminders,
        filing: input.filing,
        hold: input.hold,
      })
    ) {
      return null;
    }
    if (
      hasUnrelatedWorkWhileHold({
        hold: input.hold,
        directory: input.directory,
        lists: input.lists,
        reminders: input.reminders,
        filing: input.filing,
        messages: input.messages,
        confirm: input.confirm,
        pending: input.stored,
      })
    ) {
      return null;
    }
    return input.stored;
  }

  return null;
}
