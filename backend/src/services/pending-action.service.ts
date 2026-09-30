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

export type PendingListDeleteAction = {
  action: "delete_lists";
  step: "confirm";
  /** Hebrew labels shown in the confirm ask. */
  targets: string[];
  lists: LlmListAction[];
  at: Date;
};

export type ConversationPendingAction =
  | PendingDeleteAction
  | PendingHoldAction
  | PendingListDeleteAction;

/** Two or more list removes in one turn require server confirm (like reminder delete). */
export const BULK_LIST_REMOVE_CONFIRM_MIN = 2;

function listRemoveItemLabel(
  listType: string,
  item: Record<string, unknown>,
): string {
  const keys =
    listType === "shopping"
      ? ["שם פריט", "name", "item_name"]
      : listType === "tasks"
        ? ["שם מטלה", "name", "task", "item_name"]
        : ["name", "שם", "title", "item_name", "שם פריט"];
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  for (const value of Object.values(item)) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "פריט";
}

export function countListRemoveItems(lists: LlmListAction[]): number {
  return lists
    .filter((row) => row.action === "remove")
    .reduce((n, row) => n + row.items.length, 0);
}

export function planListDeletes(input: {
  lists: LlmListAction[];
  confirm: boolean | null;
  stored: ConversationPendingAction | null;
  now?: Date;
  timeoutMs?: number;
}): {
  applyLists: LlmListAction[];
  askLabels: string[];
  nextPending: PendingListDeleteAction | null;
  cancelled: boolean;
} {
  const now = input.now ?? new Date();
  const timeoutMs = input.timeoutMs ?? PENDING_HOLD_TIMEOUT_MS;
  let stored =
    input.stored?.action === "delete_lists" ? input.stored : null;
  if (stored && now.getTime() - stored.at.getTime() > timeoutMs) {
    stored = null;
  }

  const removes = input.lists.filter((row) => row.action === "remove");
  const other = input.lists.filter((row) => row.action !== "remove");
  const removeCount = countListRemoveItems(removes);

  if (stored && input.confirm === false) {
    return {
      applyLists: other,
      askLabels: [],
      nextPending: null,
      cancelled: true,
    };
  }

  if (stored && input.confirm === true) {
    return {
      applyLists: [...other, ...stored.lists],
      askLabels: [],
      nextPending: null,
      cancelled: false,
    };
  }

  if (removeCount >= BULK_LIST_REMOVE_CONFIRM_MIN) {
    const labels = removes.flatMap((row) =>
      row.items.map((item) => listRemoveItemLabel(row.listType, item)),
    );
    return {
      applyLists: other,
      askLabels: labels,
      nextPending: {
        action: "delete_lists",
        step: "confirm",
        targets: labels,
        lists: removes,
        at: stored?.at ?? now,
      },
      cancelled: false,
    };
  }

  if (stored && input.confirm === null) {
    return {
      applyLists: other,
      askLabels: stored.targets,
      nextPending: stored,
      cancelled: false,
    };
  }

  return {
    applyLists: [...other, ...removes],
    askLabels: [],
    nextPending: null,
    cancelled: false,
  };
}

export function formatListDeleteConfirmNotice(
  labels: string[],
  cancelled: boolean,
): string {
  if (cancelled) {
    return "ביטלתי את המחיקה.";
  }
  if (labels.length === 0) {
    return "";
  }
  if (labels.length === 1) {
    return `לאשר מחיקה של «${labels[0]}»?`;
  }
  const listed = labels.map((name) => `«${name}»`).join(", ");
  return `לאשר מחיקה של ${labels.length} פריטים (${listed})?`;
}

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

  if (row.pendingAction === "delete_lists" && row.pendingStep === "confirm") {
    const payload =
      row.pendingTargets &&
      typeof row.pendingTargets === "object" &&
      !Array.isArray(row.pendingTargets)
        ? (row.pendingTargets as Record<string, unknown>)
        : null;
    const lists = Array.isArray(payload?.lists)
      ? (payload.lists as LlmListAction[])
      : [];
    const targets = Array.isArray(payload?.targets)
      ? payload.targets.filter(
          (item): item is string => typeof item === "string" && Boolean(item.trim()),
        )
      : [];
    if (lists.length === 0 || targets.length === 0) {
      return null;
    }
    return {
      action: "delete_lists",
      step: "confirm",
      targets,
      lists,
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
  if (pending.action === "delete_lists") {
    return {
      pendingAction: pending.action,
      pendingTargets: { targets: pending.targets, lists: pending.lists },
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
      "After yes: response must say the reminder(s) were deleted (past tense), naming current_target — never מאשרת/לאשר/confirming language.",
      "No / cancel → metadata.confirm=false and empty reminders.",
      "Do not emit messages, lists, or reminder adds while current_step is confirm.",
    ].join("\n");
  }

  if (pending.action === "delete_lists") {
    return [
      "PENDING_ACTION_STATE:",
      `current_action: ${pending.action}`,
      `current_target: ${pending.targets.join(", ")}`,
      `current_step: ${pending.step}`,
      "Stay inside this action until the server clears it.",
      "Yes / confirm → metadata.confirm=true and empty lists.",
      "After yes: response must list the deleted items by name from current_target in past tense (e.g. נמחקו הפריטים הבאים מרשימת הקניות: …). Never מאשרת/לאשר/confirming — the yes already confirmed.",
      "No / cancel → metadata.confirm=false and empty lists.",
      "Do not emit new list adds/updates or messages while current_step is confirm.",
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
  listDeleteNext?: PendingListDeleteAction | null;
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
  if (input.listDeleteNext) {
    return input.listDeleteNext;
  }

  const freshHold = pendingHoldFromLlm(input.hold);
  if (freshHold) {
    return freshHold;
  }

  if (
    input.stored &&
    input.stored.action !== "delete_reminder" &&
    input.stored.action !== "delete_lists" &&
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
