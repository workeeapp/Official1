/**
 * Engine safety-net for POST-SAVE REMINDER OFFER after a timed tasks add.
 * Idempotent: never doubles an existing soft כן/לא offer, and skips when a
 * reminder was already requested or saved this turn.
 */
import type {
  LlmMetadata,
  LlmReplyButton,
  LlmReminderAction,
  LlmSpokenBubble,
} from "@workee/shared";

export const POST_SAVE_REMINDER_OFFER_TEXT =
  "אוסיף גם תזכורת בוואטסאפ?";

export const POST_SAVE_REMINDER_OFFER_BUTTONS: LlmReplyButton[] = [
  { label: "כן", command: "כן" },
  { label: "לא", command: "לא" },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readText(data: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const raw = data[key];
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }
  }
  return "";
}

function isSoftYesNoButton(button: LlmReplyButton): boolean {
  const label = button.label.trim();
  const command = button.command.trim();
  return (
    (label === "כן" || label === "לא") &&
    label === command
  );
}

/** A bubble that is (or includes) the soft reminder-offer choice pair. */
export function bubbleHasSoftYesNoOffer(bubble: LlmSpokenBubble): boolean {
  const buttons = bubble.buttons ?? [];
  const yes = buttons.some(
    (button) => isSoftYesNoButton(button) && button.label.trim() === "כן",
  );
  const no = buttons.some(
    (button) => isSoftYesNoButton(button) && button.label.trim() === "לא",
  );
  return yes && no;
}

export function bubblesHaveSoftYesNoOffer(
  bubbles: LlmSpokenBubble[],
): boolean {
  return bubbles.some((bubble) => bubbleHasSoftYesNoOffer(bubble));
}

function itemHasSchedule(item: Record<string, unknown>): boolean {
  if (readText(item, ["תאריך לביצוע", "תאריך", "date", "day"])) {
    return true;
  }
  if (readText(item, ["שעה לביצוע", "time"])) {
    return true;
  }
  const allDay = item["יום שלם"];
  if (allDay === true || allDay === "true" || allDay === 1) {
    return true;
  }
  return false;
}

function itemHasNestedRemind(item: Record<string, unknown>): boolean {
  return Boolean(item.remind && typeof item.remind === "object");
}

export function metadataRequestsReminderThisTurn(
  metadata: LlmMetadata,
): boolean {
  const reminders = metadata.reminders ?? [];
  if (
    reminders.some(
      (row: LlmReminderAction) =>
        row.action === "add" || row.action === "update",
    )
  ) {
    return true;
  }
  // list_type reminders is split into metadata.reminders before apply; only
  // nested items[].remind remains on lists.*.
  for (const list of metadata.lists ?? []) {
    if (list.action !== "add" && list.action !== "update") {
      continue;
    }
    for (const raw of list.items ?? []) {
      if (itemHasNestedRemind(asRecord(raw))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Model emitted a timed tasks add, or a timed tasks update that the engine may
 * rewrite into an add (past one-off → new occurrence).
 */
export function metadataHasTimedTasksAdd(metadata: LlmMetadata): boolean {
  for (const list of metadata.lists ?? []) {
    if (list.listType !== "tasks") {
      continue;
    }
    if (list.action !== "add" && list.action !== "update") {
      continue;
    }
    for (const raw of list.items ?? []) {
      const item = asRecord(raw);
      if (itemHasNestedRemind(item)) {
        // Branch A — explicit reminder same turn; no soft offer.
        continue;
      }
      if (itemHasSchedule(item)) {
        return true;
      }
    }
  }
  return false;
}

export function listMutationsIncludeTimedTasksAdd(
  mutations: Array<{
    action: string;
    listType: string;
    calendarYmd?: string;
  }>,
): boolean {
  return mutations.some(
    (row) =>
      row.action === "add" &&
      row.listType === "tasks" &&
      Boolean(row.calendarYmd?.trim()),
  );
}

/**
 * Whether the engine should append a soft offer bubble.
 * Safe to call multiple times — returns false when an offer already exists.
 */
export function shouldInjectPostSaveReminderOffer(input: {
  metadata: LlmMetadata;
  listMutations: Array<{
    action: string;
    listType: string;
    calendarYmd?: string;
  }>;
  reminderSavedCount: number;
  bubbles: LlmSpokenBubble[];
}): boolean {
  if (input.reminderSavedCount > 0) {
    return false;
  }
  if (metadataRequestsReminderThisTurn(input.metadata)) {
    return false;
  }
  if (bubblesHaveSoftYesNoOffer(input.bubbles)) {
    return false;
  }
  const timedEmitted = metadataHasTimedTasksAdd(input.metadata);
  const timedApplied = listMutationsIncludeTimedTasksAdd(input.listMutations);
  // Require both intent and apply proof so a refused add does not offer.
  return timedEmitted && timedApplied;
}

export function injectPostSaveReminderOfferBubbles(
  bubbles: LlmSpokenBubble[],
): LlmSpokenBubble[] {
  if (bubblesHaveSoftYesNoOffer(bubbles)) {
    return bubbles;
  }
  const offer: LlmSpokenBubble = {
    text: POST_SAVE_REMINDER_OFFER_TEXT,
    buttons: POST_SAVE_REMINDER_OFFER_BUTTONS.map((button) => ({ ...button })),
  };
  if (bubbles.length === 0) {
    return [offer];
  }
  return [...bubbles, offer];
}

/** Pure pipeline helper for tests and chat.service. */
export function applyPostSaveReminderOfferSafetyNet(input: {
  metadata: LlmMetadata;
  listMutations: Array<{
    action: string;
    listType: string;
    calendarYmd?: string;
  }>;
  reminderSavedCount: number;
  bubbles: LlmSpokenBubble[];
}): LlmSpokenBubble[] {
  if (!shouldInjectPostSaveReminderOffer(input)) {
    return input.bubbles;
  }
  return injectPostSaveReminderOfferBubbles(input.bubbles);
}
