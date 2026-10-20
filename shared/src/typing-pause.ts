export const TYPING_PAUSE_MIN_MS = 1200;
export const TYPING_PAUSE_MAX_MS = 3500;
/** Wait after Graph reaction ack so the emoji can land on-device before typing. */
export const REACTION_SETTLE_MS = 2000;
const TYPING_PAUSE_PER_CHAR_MS = 25;

/** How long the worker "types" before sending the next message of the same turn. */
export function typingPauseMs(nextText: string): number {
  const scaled = TYPING_PAUSE_MIN_MS + nextText.trim().length * TYPING_PAUSE_PER_CHAR_MS;
  return Math.min(TYPING_PAUSE_MAX_MS, scaled);
}
