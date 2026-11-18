/**
 * Follow-up reminders & watch hooks derived from returned external facts.
 *
 * Persistence stays on Reminder Action → apply → Gates (no cache-write Action).
 * - One-shot relative: schedule_anchor=external_event + scheduleOffsetMinutes
 * - Recurring/state: compose_condition sports_match | flight_changed (+ watch_once)
 */
import type { LlmComposeCondition, LlmReminderAction } from "@workee/shared";
import type { SportsMatchFact } from "./sports-schedule.service.js";

/** Encode event ISO (+ optional label) into composePlace for external_event anchors. */
export function encodeExternalEventPlace(
  eventAtIso: string,
  label = "",
): string {
  const iso = eventAtIso.trim();
  const lab = label.trim().slice(0, 120);
  return lab ? `${iso}|${lab}`.slice(0, 255) : iso.slice(0, 255);
}

export function decodeExternalEventPlace(place: string): {
  eventAtIso: string;
  label: string;
} {
  const raw = place.trim();
  const pipe = raw.indexOf("|");
  if (pipe > 0) {
    return {
      eventAtIso: raw.slice(0, pipe).trim(),
      label: raw.slice(pipe + 1).trim(),
    };
  }
  return { eventAtIso: raw, label: "" };
}

/** fireAt = eventAt + offsetMinutes (negative = before). */
export function fireAtFromExternalEvent(
  eventAtIso: string,
  offsetMinutes: number,
): Date | null {
  const ms = Date.parse(eventAtIso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + offsetMinutes * 60_000);
}

/**
 * GIVEN a returned fact with a known event time
 * WHEN user asks «תזכירי לי שעה לפני»
 * THEN Reminder add with schedule_anchor=external_event + offset.
 */
export function buildExternalEventFollowUpReminder(input: {
  eventAtIso: string;
  minutesBefore: number;
  text: string;
  label?: string;
}): Pick<
  LlmReminderAction,
  | "action"
  | "item"
  | "text"
  | "date"
  | "time"
  | "inSeconds"
  | "repeat"
  | "targets"
  | "reminderId"
  | "compose"
  | "composeSource"
  | "composeLookbackHours"
  | "composePlace"
  | "scheduleAnchor"
  | "scheduleOffsetMinutes"
  | "watchOnce"
> {
  const minutesBefore = Math.max(0, Math.trunc(input.minutesBefore));
  return {
    action: "add",
    item: input.text.trim().slice(0, 255) || "תזכורת לאירוע",
    text: input.text.trim(),
    date: "",
    time: "",
    inSeconds: null,
    repeat: "once",
    targets: [],
    reminderId: "",
    compose: false,
    composeSource: "",
    composeLookbackHours: 0,
    composePlace: encodeExternalEventPlace(
      input.eventAtIso,
      input.label ?? "",
    ),
    scheduleAnchor: "external_event",
    scheduleOffsetMinutes: -minutesBefore,
    watchOnce: true,
  };
}

/**
 * Recurring «כל משחק של ריאל מדריד» / one-shot «שעה לפני המשחק».
 */
export function buildSportsMatchWatchReminder(input: {
  team: string;
  minutesBefore: number;
  text?: string;
  /** false = every match; true = next match only. */
  watchOnce?: boolean;
  competition?: string;
}): Pick<
  LlmReminderAction,
  | "action"
  | "item"
  | "text"
  | "date"
  | "time"
  | "inSeconds"
  | "repeat"
  | "targets"
  | "reminderId"
  | "compose"
  | "composeSource"
  | "composeLookbackHours"
  | "composePlace"
  | "composeCondition"
  | "watchOnce"
  | "recurrence"
> {
  const team = input.team.trim();
  const minutesBefore = Math.max(0, Math.trunc(input.minutesBefore));
  const watchOnce = input.watchOnce !== false;
  const condition: LlmComposeCondition = {
    type: "sports_match",
    team,
    minutesBefore,
    competition: String(input.competition ?? "").trim(),
  };
  return {
    action: "add",
    item:
      input.text?.trim().slice(0, 255) ||
      (watchOnce
        ? `תזכורת למשחק של ${team}`
        : `תזכורת לכל משחק של ${team}`),
    text: input.text?.trim() || "",
    date: "",
    time: "",
    inSeconds: null,
    repeat: "interval",
    targets: [],
    reminderId: "",
    compose: true,
    composeSource: "sports",
    composeLookbackHours: 0,
    composePlace: team.slice(0, 255),
    composeCondition: condition,
    watchOnce,
    recurrence: {
      freq: "interval",
      interval: 5,
      unit: "minutes",
    },
  };
}

/** One-shot fire time from a concrete match fact («שעה לפני»). */
export function buildReminderFromSportsMatchFact(input: {
  match: SportsMatchFact;
  team: string;
  minutesBefore: number;
  text?: string;
}): ReturnType<typeof buildExternalEventFollowUpReminder> {
  const label = `${input.team} נגד ${input.match.opponent}`;
  return buildExternalEventFollowUpReminder({
    eventAtIso: input.match.kickoffIso,
    minutesBefore: input.minutesBefore,
    text:
      input.text?.trim() ||
      `תזכורת: משחק ${label} בעוד ${input.minutesBefore} דקות`,
    label,
  });
}
