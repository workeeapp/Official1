/**
 * WhatsApp delivers every forwarded file as its own message. Messages from one
 * phone that arrive while a media batch is open are collected and handed over
 * together once the phone has been quiet for `idleMs` (or `maxMs` has passed
 * since the batch opened). Timing only — nothing here reads the message text.
 *
 * Optional `holdUntil` (M7): an absolute time (same clock as `now`) the batch
 * should stay open until, e.g. "latest WhatsApp send time + window", so files
 * sent together but delivered more than `idleMs` apart still land in one batch.
 * It can only lengthen the idle wait, never past `maxMs`; a value in the past
 * (or null) leaves the plain idle behavior unchanged.
 */
export interface InboundBatcher<T> {
  /** Returns true when the message was queued; false means "handle it now". */
  offer(phone: string, message: T, opensBatch: boolean): boolean;
  pending(phone: string): number;
}

export function createInboundBatcher<T>(options: {
  idleMs: number;
  maxMs: number;
  flush: (phone: string, messages: T[]) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  holdUntil?: (messages: T[]) => number | null;
}): InboundBatcher<T> {
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => Date.now());
  const waitFor = (messages: T[], openedAt: number) => {
    const at = now();
    const held = options.holdUntil?.(messages);
    const wait =
      held !== null && held !== undefined && Number.isFinite(held)
        ? Math.max(options.idleMs, held - at)
        : options.idleMs;
    const remaining = Math.max(0, openedAt + options.maxMs - at);
    return Math.min(wait, remaining);
  };
  const batches = new Map<
    string,
    { messages: T[]; openedAt: number; timer: unknown }
  >();

  const flush = (phone: string) => {
    const batch = batches.get(phone);
    if (!batch) {
      return;
    }
    batches.delete(phone);
    clearTimer(batch.timer);
    options.flush(phone, batch.messages);
  };

  return {
    offer(phone, message, opensBatch) {
      const open = batches.get(phone);
      if (!open && !opensBatch) {
        return false;
      }
      if (open) {
        open.messages.push(message);
        clearTimer(open.timer);
        open.timer = setTimer(() => flush(phone), waitFor(open.messages, open.openedAt));
        return true;
      }
      const openedAt = now();
      const messages = [message];
      batches.set(phone, {
        messages,
        openedAt,
        timer: setTimer(() => flush(phone), waitFor(messages, openedAt)),
      });
      return true;
    },
    pending(phone) {
      return batches.get(phone)?.messages.length ?? 0;
    },
  };
}

/**
 * M7 (flag WHATSAPP_MEDIA_GROUP_BY_SENT_AT, default off): hold a batch open until
 * the latest file's WhatsApp send time + window, so files sent together but
 * delivered more than the idle gap apart form one request. Text never extends
 * the wait; a missing or unreadable send time falls back to the idle gap.
 */
export function mediaBatchHoldUntil(
  batch: { media?: unknown; sentAt?: string }[],
  options: { enabled: boolean; windowMs: number },
): number | null {
  if (!options.enabled) {
    return null;
  }
  let latest: number | null = null;
  for (const message of batch) {
    if (!message.media || !message.sentAt) {
      continue;
    }
    const sent = Date.parse(message.sentAt);
    if (Number.isFinite(sent) && (latest === null || sent > latest)) {
      latest = sent;
    }
  }
  return latest === null ? null : latest + options.windowMs;
}
