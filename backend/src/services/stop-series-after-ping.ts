/**
 * Engine safety-net: bare STOP SERIES right after a delivered ping.
 *
 * When RECENT_OUTBOUND has reminder_id R and the speaker says bare «הפסיקי» /
 * «תפסיקי» / «בטלי» (no other chore named), cancel R only — never a different
 * active clock (e.g. a market watch). Prompt-only routing is not enough.
 */
import {
  emptyLlmMetadata,
  type LlmMetadata,
  type LlmReminderAction,
} from "@workee/shared";

/** Bare stop / cancel cues that bind to RECENT_OUTBOUND when present. */
const BARE_STOP_SERIES_RE =
  /^(?:הפסיקי|תפסיקי|תבטלי|בטלי|את זה|אל תזכירי לי(?: יותר)?|תפסיקי להזכיר(?: לי(?: את זה)?)?|הפסיקי להזכיר(?: לי(?: את זה)?)?|תבטלי את התזכורת|בטלי את התזכורת|תפסיקי את התזכורת|הפסיקי את התזכורת)(?:\s+בבקשה)?[.!?…]*$/u;

export type RecentOutboundBind = {
  reminder_id: string;
  item: string;
};

export function isBareStopSeriesAfterPingMessage(message: string): boolean {
  const text = message.trim();
  if (!text) {
    return false;
  }
  return BARE_STOP_SERIES_RE.test(text);
}

function forcedRemoveAction(input: {
  reminderId: string;
  item: string;
}): LlmReminderAction {
  return {
    action: "remove",
    item: input.item,
    listType: "tasks",
    date: "",
    time: "",
    repeat: "once",
    ping: [],
    about: [],
    targets: [],
    text: "",
    inSeconds: null,
    everyCount: null,
    everyUnit: null,
    weekdays: null,
    confirmed: false,
    compose: false,
    composeSource: "",
    composeLookbackHours: 0,
    composePlace: "",
    reminderId: input.reminderId,
  };
}

export function formatStopSeriesAfterPingAck(item: string): string {
  const label = item.trim();
  if (!label) {
    return "הפסקתי את התזכורת.";
  }
  return `הפסקתי להזכיר לך על «${label}».`;
}

/**
 * When bare stop + RECENT_OUTBOUND.reminder_id: force reminders.remove of that
 * id only. Drops wrong removes (other clocks / watches) and empty cancels.
 */
export function applyStopSeriesAfterPingSafetyNet(input: {
  message: string;
  recentOutbound: RecentOutboundBind[];
  metadata: LlmMetadata;
}): {
  metadata: LlmMetadata;
  rewrote: boolean;
  targetReminderId: string | null;
  targetItem: string | null;
} {
  const outbound = input.recentOutbound[0];
  const targetReminderId = outbound?.reminder_id?.trim() || "";
  const targetItem = outbound?.item?.trim() || "";
  if (!targetReminderId) {
    return {
      metadata: input.metadata,
      rewrote: false,
      targetReminderId: null,
      targetItem: null,
    };
  }
  if (!isBareStopSeriesAfterPingMessage(input.message)) {
    return {
      metadata: input.metadata,
      rewrote: false,
      targetReminderId: null,
      targetItem: null,
    };
  }

  const existing = input.metadata.reminders ?? [];
  const removes = existing.filter((row) => row.action === "remove");
  const nonRemoves = existing.filter((row) => row.action !== "remove");
  const removeIds = removes
    .map((row) => row.reminderId.trim())
    .filter(Boolean);
  const alreadyCorrect =
    nonRemoves.length === 0 &&
    removeIds.length === 1 &&
    removeIds[0] === targetReminderId;

  if (alreadyCorrect) {
    return {
      metadata: input.metadata,
      rewrote: false,
      targetReminderId,
      targetItem,
    };
  }

  const forced = forcedRemoveAction({
    reminderId: targetReminderId,
    item: targetItem,
  });
  return {
    metadata: {
      ...(input.metadata ?? emptyLlmMetadata()),
      reminders: [forced],
    },
    rewrote: true,
    targetReminderId,
    targetItem,
  };
}
