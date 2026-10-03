import type {
  LlmDirectoryAction,
  LlmFilingAction,
  LlmHold,
  LlmListAction,
  LlmMessageAction,
  LlmReminderAction,
} from "@workee/shared";
import {
  PENDING_DELETE_TIMEOUT_MS,
  type PendingDeleteAction,
} from "./reminder.service.js";

/** Hold payload from the model — messages may be omitted on older drafts. */
export type LlmHoldInput = Omit<LlmHold, "messages"> & {
  messages?: LlmMessageAction[];
};

export const PENDING_HOLD_TIMEOUT_MS = PENDING_DELETE_TIMEOUT_MS;

/** Explicit abort of an awaiting_fields hold (send body, missing phone, etc.). */
export function isPendingHoldCancelText(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[!.?,״"']/g, "")
    .replace(/\s+/g, " ");
  if (!normalized) {
    return false;
  }
  const exact = new Set([
    "לא",
    "בטל",
    "ביטול",
    "תבטל",
    "תבטלי",
    "cancel",
    "no",
    "לא תודה",
    "בעצם לא",
    "שכחי מזה",
    "תשכחי מזה",
    "never mind",
    "forget it",
    "dont send",
    "don't send",
    "do not send",
  ]);
  if (exact.has(normalized)) {
    return true;
  }
  const prefixes = [
    "אל תשלח",
    "אל תשלחי",
    "לא לשלוח",
    "תבטל את",
    "תבטלי את",
    "בטלי את",
    "בטל את",
    "בעצם לא",
    "don't send",
    "do not send",
    "never mind",
  ];
  return prefixes.some(
    (prefix) =>
      normalized === prefix ||
      normalized.startsWith(`${prefix} `) ||
      normalized.startsWith(`${prefix}את`) ||
      normalized.startsWith(`${prefix}את `),
  );
}

/** Hold.need values that mean yes/no confirm (not a free-text field fill). */
export function isConfirmHoldNeed(need: string): boolean {
  const normalized = need.trim().toLowerCase().replace(/\s+/g, "_");
  return (
    normalized === "confirm" ||
    normalized === "confirm_share" ||
    normalized === "confirm_save" ||
    normalized.startsWith("confirm_") ||
    normalized.includes("confirm")
  );
}

/** Short accept for confirm-style holds (כן / yes) — not cancel. */
export function isPendingHoldAcceptText(text: string): boolean {
  if (isPendingHoldCancelText(text)) {
    return false;
  }
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[!.?,״"']/g, "")
    .replace(/\s+/g, " ");
  if (!normalized) {
    return false;
  }
  const exact = new Set([
    "כן",
    "כן בבקשה",
    "כן תוסיפי",
    "כן תוסיף",
    "כן שמרי",
    "בבקשה",
    "תוסיפי",
    "תוסיף",
    "שמרי",
    "שמור",
    "ok",
    "okay",
    "yes",
    "yep",
    "sure",
  ]);
  if (exact.has(normalized)) {
    return true;
  }
  return (
    normalized.startsWith("כן ") ||
    normalized.startsWith("yes ") ||
    normalized.startsWith("ok ")
  );
}

export function isAwaitingFieldsHold(
  pending: ConversationPendingAction | null,
): pending is PendingHoldAction {
  return Boolean(pending && pending.step === "awaiting_fields");
}

/** Clear unfinished drafts when the speaker aborts an awaiting_fields hold. */
export function metadataAfterHoldCancel<T extends {
  directory?: LlmDirectoryAction[];
  lists?: LlmListAction[];
  reminders?: LlmReminderAction[];
  filing?: LlmFilingAction[];
  messages?: LlmMessageAction[];
  hold?: LlmHoldInput | null;
}>(metadata: T): T & {
  directory: [];
  lists: [];
  reminders: [];
  filing: [];
  messages: [];
  hold: null;
} {
  return {
    ...metadata,
    directory: [],
    lists: [],
    reminders: [],
    filing: [],
    messages: [],
    hold: null,
  };
}

export function formatCancelledHoldReply(
  pending: PendingHoldAction,
): string {
  switch (pending.action) {
    case "complete_messages":
      return "ביטלתי את השליחה.";
    case "complete_directory":
      return "ביטלתי את שמירת איש הקשר.";
    case "complete_lists":
      return "ביטלתי את עדכון הרשימה.";
    case "complete_reminders":
      return "ביטלתי את הגדרת התזכורת.";
    case "complete_filing":
      return "ביטלתי את התיוק.";
    default:
      return "ביטלתי.";
  }
}

export type PendingHoldKind =
  | "directory"
  | "lists"
  | "reminders"
  | "filing"
  | "messages";

export type PendingHoldAction = {
  action:
    | "complete_directory"
    | "complete_lists"
    | "complete_reminders"
    | "complete_filing"
    | "complete_messages";
  step: "awaiting_fields";
  need: string;
  draft: {
    directory?: LlmDirectoryAction[];
    lists?: LlmListAction[];
    reminders?: LlmReminderAction[];
    filing?: LlmFilingAction[];
    messages?: LlmMessageAction[];
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
  const needsConfirm = removeCount >= BULK_LIST_REMOVE_CONFIRM_MIN;

  if (stored && input.confirm === false) {
    return {
      applyLists: other,
      askLabels: [],
      nextPending: null,
      cancelled: true,
    };
  }

  // Yes after delete_lists pending OR after a confirm-hold that filled removes.
  if (input.confirm === true) {
    return {
      applyLists: [...other, ...(stored?.lists ?? removes)],
      askLabels: [],
      nextPending: null,
      cancelled: false,
    };
  }

  if (needsConfirm && removeCount > 0) {
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
  const bullets = labels.map((name) => `• ${name}`).join("\n");
  return `לאשר מחיקה של ${labels.length} פריטים?\n${bullets}`;
}

const HOLD_ACTIONS: Record<PendingHoldKind, PendingHoldAction["action"]> = {
  directory: "complete_directory",
  lists: "complete_lists",
  reminders: "complete_reminders",
  filing: "complete_filing",
  messages: "complete_messages",
};

export function pendingHoldFromLlm(
  hold: LlmHoldInput | null | undefined,
): PendingHoldAction | null {
  if (!hold) {
    return null;
  }
  const need = hold.need.trim();
  if (!need) {
    return null;
  }
  const messages = hold.messages ?? [];
  const draft = {
    ...(hold.directory.length > 0 ? { directory: hold.directory } : {}),
    ...(hold.lists.length > 0 ? { lists: hold.lists } : {}),
    ...(hold.reminders.length > 0 ? { reminders: hold.reminders } : {}),
    ...(hold.filing.length > 0 ? { filing: hold.filing } : {}),
    ...(messages.length > 0 ? { messages } : {}),
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

/** When the speaker named a recipient but left message text empty. */
export function pendingHoldFromMissingMessages(
  messages: LlmMessageAction[],
): PendingHoldAction | null {
  const drafts = messages.filter(
    (row) => row.targets.length > 0 && !row.text.trim(),
  );
  if (drafts.length === 0) {
    return null;
  }
  return {
    action: "complete_messages",
    step: "awaiting_fields",
    need: "text",
    draft: { messages: drafts },
    at: new Date(),
  };
}

/**
 * If we are waiting for send text and the model did not emit a complete message,
 * use the speaker's short reply as the body for the held targets.
 */
export function fillMessagesFromPendingHold(
  pending: ConversationPendingAction | null,
  messages: LlmMessageAction[],
  speakerText: string,
): LlmMessageAction[] | null {
  if (
    !pending ||
    pending.action !== "complete_messages" ||
    pending.step !== "awaiting_fields"
  ) {
    return null;
  }
  const already = messages.filter(
    (row) => row.targets.length > 0 && row.text.trim(),
  );
  if (already.length > 0) {
    return null;
  }
  const body = speakerText.trim();
  if (!body) {
    return null;
  }
  if (isPendingHoldCancelText(body)) {
    return null;
  }
  const drafts = pending.draft.messages ?? [];
  if (drafts.length === 0) {
    return null;
  }
  return drafts.map((row) => ({
    targets: row.targets,
    text: body,
  }));
}

/**
 * Confirm-style lists hold (e.g. shared shopping after tell): on yes / confirm /
 * model list emit, apply the stored draft lists so private speaker-only saves lose.
 */
export function fillListsFromPendingHold(
  pending: ConversationPendingAction | null,
  lists: LlmListAction[],
  speakerText: string,
  confirm: boolean | null,
): LlmListAction[] | null {
  if (
    !pending ||
    pending.action !== "complete_lists" ||
    pending.step !== "awaiting_fields" ||
    !isConfirmHoldNeed(pending.need)
  ) {
    return null;
  }
  const draftLists = pending.draft.lists ?? [];
  if (draftLists.length === 0) {
    return null;
  }
  if (confirm === false || isPendingHoldCancelText(speakerText)) {
    return null;
  }
  const modelListed = lists.some(
    (row) =>
      (row.action === "add" ||
        row.action === "update" ||
        row.action === "remove") &&
      row.items.length > 0,
  );
  const accepted =
    confirm === true ||
    isPendingHoldAcceptText(speakerText) ||
    modelListed;
  if (!accepted) {
    return null;
  }
  return draftLists;
}

function reminderDraftHasClock(row: LlmReminderAction): boolean {
  return (
    Boolean(row.time?.trim()) ||
    Boolean(row.inSeconds && row.inSeconds > 0) ||
    Boolean(row.everyCount && row.everyUnit) ||
    Boolean(row.weekdays && row.weekdays.length > 0)
  );
}

function isReminderTimeHoldNeed(need: string): boolean {
  const normalized = need.trim().toLowerCase();
  return (
    normalized === "time" ||
    normalized === "מתי" ||
    normalized.includes("time") ||
    normalized.includes("מתי") ||
    normalized.includes("שעה") ||
    isConfirmHoldNeed(need)
  );
}

/**
 * Time hold for reminders (e.g. git digest without a clock): «עכשיו» → short in;
 * or keep waiting until the model emits a complete clock.
 */
export function fillRemindersFromPendingHold(
  pending: ConversationPendingAction | null,
  reminders: LlmReminderAction[],
  speakerText: string,
): LlmReminderAction[] | null {
  if (
    !pending ||
    pending.action !== "complete_reminders" ||
    pending.step !== "awaiting_fields" ||
    !isReminderTimeHoldNeed(pending.need)
  ) {
    return null;
  }
  const draft = pending.draft.reminders ?? [];
  if (draft.length === 0) {
    return null;
  }
  if (isPendingHoldCancelText(speakerText)) {
    return null;
  }
  if (reminders.some((row) => row.action === "add" && reminderDraftHasClock(row))) {
    return null;
  }
  const normalized = speakerText
    .trim()
    .toLowerCase()
    .replace(/[!.?,״"']/g, "")
    .replace(/\s+/g, " ");
  const nowish =
    normalized === "עכשיו" ||
    normalized === "now" ||
    normalized === "מיד" ||
    normalized.startsWith("עכשיו ") ||
    normalized.startsWith("now ");
  if (!nowish) {
    return null;
  }
  return draft.map((row) => ({
    ...row,
    action: "add" as const,
    inSeconds:
      typeof row.inSeconds === "number" && row.inSeconds > 0 ? row.inSeconds : 5,
    time: "",
  }));
}

/**
 * Same-turn guard: shopping/tasks add with empty targets while messages name
 * recipients → attach those recipients (plus optional speaker label) as targets.
 */
export function alignListTargetsWithMessageRecipients(input: {
  lists: LlmListAction[];
  messages: LlmMessageAction[];
  speakerName?: string;
}): LlmListAction[] {
  const recipients = [
    ...new Set(
      input.messages.flatMap((row) =>
        row.targets.map((name) => name.trim()).filter(Boolean),
      ),
    ),
  ];
  if (recipients.length === 0 || input.lists.length === 0) {
    return input.lists;
  }
  const speaker = input.speakerName?.trim() ?? "";
  let changed = false;
  const next = input.lists.map((row) => {
    if (row.action !== "add" && row.action !== "update") {
      return row;
    }
    if (row.listType !== "shopping" && row.listType !== "tasks") {
      return row;
    }
    if (row.targets.length > 0) {
      return row;
    }
    changed = true;
    const targets = speaker
      ? [...new Set([speaker, ...recipients])]
      : recipients;
    return { ...row, targets };
  });
  return changed ? next : input.lists;
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
      row.pendingAction === "complete_filing" ||
      row.pendingAction === "complete_messages")
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
        messages: Array.isArray(draftRaw.messages)
          ? (draftRaw.messages as LlmMessageAction[])
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
    "The speaker's short reply fills missing_field for this draft — a name, time, number, message body, or yes/no.",
    "Never reply לא הבנתי / מה תרצה לעשות to that short reply.",
    "Complete the draft: emit the finished metadata (directory/lists/reminders/filing/messages) with hold=null.",
    "If current_action is complete_messages: the short reply IS the WhatsApp body — emit messages with known_draft targets and that text; do not ask מה לשלוח again.",
    "If current_action is complete_lists and missing_field is confirm / confirm_share: Yes / confirm=true → apply known_draft.lists (shared targets included). Do not replace with the speaker's private list. The server prefers known_draft lists on accept.",
    "If current_action is complete_reminders and missing_field is time / מתי: the short reply sets the clock — «עכשיו» / now → send soon; or emit reminders add with in/time from their words. Do not claim אשלח until a clock exists.",
    "CANCEL (לא / בטל / ביטול / אל תשלחי / cancel / no / בעצם לא): abort this draft — hold=null and empty directory/lists/reminders/filing/messages. Do not complete the unfinished action. Say you cancelled (e.g. ביטלתי את השליחה / ביטלתי את התיוק).",
    "If still missing something else, emit hold again with the updated draft and the new need.",
    "Do not start an unrelated new request until this hold is completed, cancelled, or the speaker clearly switches topic.",
  ].join("\n");
}

export function holdFulfilledByMetadata(
  pending: PendingHoldAction,
  meta: {
    directory: LlmDirectoryAction[];
    lists: LlmListAction[];
    reminders: LlmReminderAction[];
    filing: LlmFilingAction[];
    messages?: LlmMessageAction[];
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
    return meta.reminders.some((row) => {
      if (row.action === "update") {
        return true;
      }
      if (row.action !== "add") {
        return false;
      }
      return reminderDraftHasClock(row);
    });
  }
  if (pending.action === "complete_filing") {
    return meta.filing.some(
      (row) =>
        (row.action === "add_filing" || row.action === "update_filing") &&
        Boolean(row.itemName.trim()) &&
        Boolean(row.itemDescription.trim()),
    );
  }
  if (pending.action === "complete_messages") {
    return (meta.messages ?? []).some(
      (row) => row.targets.length > 0 && Boolean(row.text.trim()),
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
  if (input.pending.action === "complete_messages") {
    return (
      input.directory.length > 0 ||
      input.lists.length > 0 ||
      input.reminders.length > 0 ||
      input.filing.length > 0
    );
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
        messages: input.messages,
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
