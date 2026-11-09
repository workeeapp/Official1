/**
 * M7 — grouping WhatsApp files by their WhatsApp send time (offline, no DB).
 * Production batcher + production `mediaBatchHoldUntil`, fake clock. With the
 * flag on, a batch stays open until the latest file's send time + window, so
 * files sent together but delivered more than 3 s apart form one request; the
 * 15 s cap and the plain 3 s idle gap are unchanged. Flag off = M1 behavior.
 */
import { describe, expect, it } from "vitest";
import { createInboundBatcher, mediaBatchHoldUntil } from "../src/services/whatsapp-inbound-batch.js";

const IDLE_MS = 3_000;
const MAX_MS = 15_000;
const WINDOW_MS = 10_000;
const T0 = Date.parse("2030-01-01T10:00:00.000Z");

interface Msg {
  id: string;
  media?: { kind: string };
  sentAt?: string;
}

const file = (id: string, sentAtMs?: number): Msg => ({
  id,
  media: { kind: "document" },
  ...(sentAtMs === undefined ? {} : { sentAt: new Date(sentAtMs).toISOString() }),
});
const text = (id: string, sentAtMs?: number): Msg => ({
  id,
  ...(sentAtMs === undefined ? {} : { sentAt: new Date(sentAtMs).toISOString() }),
});

function harness(enabled: boolean) {
  let clock = T0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const flushed: string[][] = [];
  const batcher = createInboundBatcher<Msg>({
    idleMs: IDLE_MS,
    maxMs: MAX_MS,
    flush: (_phone, messages) => flushed.push(messages.map((m) => m.id)),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (handle) => timers.delete(handle as number),
    now: () => clock,
    holdUntil: (messages) => mediaBatchHoldUntil(messages, { enabled, windowMs: WINDOW_MS }),
  });
  /** Arrival at absolute T0 + ms (fires due timers on the way). */
  const at = (ms: number) => {
    const target = T0 + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    clock = target;
  };
  const offer = (message: Msg) => batcher.offer("p", message, Boolean(message.media));
  return { offer, flushed, at, pending: () => batcher.pending("p") };
}

describe("M7: group files by WhatsApp send time", () => {
  it("flag off: unchanged — files sent together but delivered 5 s apart are split (M1 known gap)", () => {
    const h = harness(false);
    h.at(1_000);
    h.offer(file("ticket-1", T0));
    h.at(6_000);
    h.offer(file("ticket-2", T0));
    h.at(30_000);
    expect(h.flushed).toEqual([["ticket-1"], ["ticket-2"]]);
  });

  it("flag on: files sent together, delivered 5 s and 8 s apart → ONE batch", () => {
    const h = harness(true);
    h.at(1_000);
    h.offer(file("ticket-1", T0));
    h.at(6_000);
    h.offer(file("ticket-2", T0));
    h.at(9_000);
    h.offer(file("ticket-3", T0 + 1_000));
    h.at(30_000);
    expect(h.flushed).toEqual([["ticket-1", "ticket-2", "ticket-3"]]);
  });

  it("flag on: the batch closes at latest send time + window (or idle gap, whichever is later)", () => {
    const h = harness(true);
    h.at(1_000);
    h.offer(file("ticket-1", T0));
    h.at(9_999);
    expect(h.flushed).toEqual([]);
    h.at(10_000);
    expect(h.flushed).toEqual([["ticket-1"]]);
    // A later file after the close is its own request — never merged afterwards.
    h.offer(file("ticket-2", T0 + 1_000));
    h.at(40_000);
    expect(h.flushed).toEqual([["ticket-1"], ["ticket-2"]]);
  });

  it("flag on: request text and captions join the open batch in arrival order; text never extends the wait", () => {
    const h = harness(true);
    h.at(500);
    h.offer(file("ticket-1 + caption", T0));
    h.at(4_000);
    h.offer(file("ticket-2", T0));
    h.at(9_000);
    h.offer(text("תתייקי את שני הכרטיסים", T0 + 9_000));
    // Text sent at +9 s does not move the close to +19 s: idle gap from the text → +12 s.
    h.at(11_999);
    expect(h.flushed).toEqual([]);
    h.at(12_000);
    expect(h.flushed).toEqual([["ticket-1 + caption", "ticket-2", "תתייקי את שני הכרטיסים"]]);
  });

  it("flag on: text alone never opens a batch (handled immediately, no extra wait)", () => {
    const h = harness(true);
    expect(h.offer(text("מה יש לי היום?", T0))).toBe(false);
    expect(h.pending()).toBe(0);
  });

  it("flag on: the 15 s hard cap still closes a batch whose files keep coming", () => {
    const h = harness(true);
    for (let i = 0; i < 8; i += 1) {
      h.at(i * 2_500);
      h.offer(file(`file-${i + 1}`, T0 + i * 2_500));
    }
    // Opened at 0 → closed at 15 s with files 1–6; file-7 (arriving at 15 s, after the close) starts the next batch.
    h.at(60_000);
    expect(h.flushed[0]).toEqual(["file-1", "file-2", "file-3", "file-4", "file-5", "file-6"]);
    expect(h.flushed.flat()).toEqual(["file-1", "file-2", "file-3", "file-4", "file-5", "file-6", "file-7", "file-8"]);
  });

  it("flag on: no WhatsApp send time → plain 3 s idle gap (safe fallback)", () => {
    const h = harness(true);
    h.at(1_000);
    h.offer(file("ticket-1"));
    h.at(4_000);
    expect(h.flushed).toEqual([["ticket-1"]]);
  });

  it("flag on: clock skew — a send time far in the past falls back to the idle gap; far in the future is capped at 15 s", () => {
    const past = harness(true);
    past.at(1_000);
    past.offer(file("old", T0 - 3_600_000));
    past.at(4_000);
    expect(past.flushed).toEqual([["old"]]);

    const future = harness(true);
    future.at(1_000);
    future.offer(file("future", T0 + 3_600_000));
    future.at(15_999);
    expect(future.flushed).toEqual([]);
    future.at(16_000);
    expect(future.flushed).toEqual([["future"]]);
  });

  it("mediaBatchHoldUntil: off → null; ignores text and unreadable send times; uses the latest file", () => {
    expect(mediaBatchHoldUntil([file("a", T0)], { enabled: false, windowMs: WINDOW_MS })).toBeNull();
    expect(mediaBatchHoldUntil([text("t", T0)], { enabled: true, windowMs: WINDOW_MS })).toBeNull();
    const unreadable: Msg = { id: "x", media: { kind: "document" }, sentAt: "not-a-date" };
    expect(mediaBatchHoldUntil([unreadable], { enabled: true, windowMs: WINDOW_MS })).toBeNull();
    expect(
      mediaBatchHoldUntil([file("a", T0 + 2_000), text("t", T0 + 50_000), file("b", T0)], {
        enabled: true,
        windowMs: WINDOW_MS,
      }),
    ).toBe(T0 + 12_000);
  });
});
