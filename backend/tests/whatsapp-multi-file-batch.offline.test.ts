/**
 * WhatsApp multi-file batching — CURRENT behavior, documented (offline, no DB).
 * WhatsApp delivers every file as its own message; the inbound batcher groups
 * them by arrival time (3 s idle / 15 s cap, production values). These tests
 * pin today's behavior so later changes (WhatsApp send-time grouping, partial
 * failure handling) show up as deliberate diffs. Timing only — no text is read.
 */
import { describe, expect, it } from "vitest";
import { createInboundBatcher } from "../src/services/whatsapp-inbound-batch.js";

const IDLE_MS = 3_000;
const MAX_MS = 15_000;

function harness() {
  let clock = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const flushed: string[][] = [];
  const batcher = createInboundBatcher<string>({
    idleMs: IDLE_MS,
    maxMs: MAX_MS,
    flush: (_phone, messages) => flushed.push(messages),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (handle) => timers.delete(handle as number),
    now: () => clock,
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  return { batcher, flushed, advance };
}

describe("multi-file batching (current arrival-time behavior)", () => {
  it("two documents a few seconds apart, then the request text → ONE batch (one logical request)", () => {
    const { batcher, flushed, advance } = harness();
    expect(batcher.offer("p", "ticket-1.pdf", true)).toBe(true);
    advance(2_500);
    expect(batcher.offer("p", "ticket-2.pdf", true)).toBe(true);
    advance(1_000);
    expect(batcher.offer("p", "תתייקי את שני הכרטיסים תחת ההופעה", false)).toBe(true);
    advance(IDLE_MS);
    expect(flushed).toEqual([["ticket-1.pdf", "ticket-2.pdf", "תתייקי את שני הכרטיסים תחת ההופעה"]]);
  });

  it("two documents whose captions carry the request, close together → ONE batch", () => {
    const { batcher, flushed, advance } = harness();
    batcher.offer("p", "ticket-1.pdf + caption", true);
    advance(2_999);
    batcher.offer("p", "ticket-2.pdf", true);
    advance(IDLE_MS);
    expect(flushed).toEqual([["ticket-1.pdf + caption", "ticket-2.pdf"]]);
  });

  it("KNOWN GAP: a second file arriving after the idle window becomes a separate batch (a separate turn)", () => {
    const { batcher, flushed, advance } = harness();
    batcher.offer("p", "ticket-1.pdf + caption", true);
    advance(IDLE_MS); // quiet for 3 s → flushed
    expect(flushed).toEqual([["ticket-1.pdf + caption"]]);
    batcher.offer("p", "ticket-2.pdf", true);
    advance(IDLE_MS);
    // Today the late file is its own request; it is never silently merged into the
    // first one. A later commit decides the intended behavior from WhatsApp send times.
    expect(flushed).toEqual([["ticket-1.pdf + caption"], ["ticket-2.pdf"]]);
  });

  it("KNOWN GAP: files still arriving at the 15 s cap are split at the cap", () => {
    const { batcher, flushed, advance } = harness();
    for (let index = 1; index <= 6; index += 1) {
      batcher.offer("p", `file-${index}`, true);
      advance(2_900);
    }
    // 6 files 2.9 s apart: the batch opened at 0 s closes at 15 s; file-6 (at 14.5 s)
    // is inside, anything after the cap opens a new batch.
    expect(flushed[0]).toEqual(["file-1", "file-2", "file-3", "file-4", "file-5", "file-6"]);
    batcher.offer("p", "file-7", true);
    advance(IDLE_MS);
    expect(flushed[1]).toEqual(["file-7"]);
  });

  it("text alone never opens a batch (handled immediately); files after it form their own batch", () => {
    const { batcher, flushed, advance } = harness();
    expect(batcher.offer("p", "תתייקי את הכרטיסים", false)).toBe(false);
    batcher.offer("p", "ticket-1.pdf", true);
    advance(1_000);
    batcher.offer("p", "ticket-2.pdf", true);
    advance(IDLE_MS);
    expect(flushed).toEqual([["ticket-1.pdf", "ticket-2.pdf"]]);
  });
});
