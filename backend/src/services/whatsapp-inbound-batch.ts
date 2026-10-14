/**
 * WhatsApp delivers every forwarded file as its own message. Messages from one
 * phone that arrive while a media batch is open are collected and handed over
 * together once the phone has been quiet for `idleMs` (or `maxMs` has passed
 * since the batch opened). Timing only — nothing here reads the message text.
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
}): InboundBatcher<T> {
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => Date.now());
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
        const remaining = Math.max(0, open.openedAt + options.maxMs - now());
        open.timer = setTimer(() => flush(phone), Math.min(options.idleMs, remaining));
        return true;
      }
      batches.set(phone, {
        messages: [message],
        openedAt: now(),
        timer: setTimer(() => flush(phone), options.idleMs),
      });
      return true;
    },
    pending(phone) {
      return batches.get(phone)?.messages.length ?? 0;
    },
  };
}
