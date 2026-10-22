/**
 * Phase A Studio run gates — pure env checks; no Prisma / runners / OpenAI.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  assertStudioTrackRunnable,
  probeLiveModelStudioAllow,
  trackCapabilities,
} from "../src/eval/studio-safety.js";
import { UnapprovedEvalDatabaseError } from "../src/eval/studio-db-guard.js";

describe("assertStudioTrackRunnable (Phase A, no DB I/O)", () => {
  const prevAllow = process.env.STUDIO_ALLOW_LIVE_MODEL;
  const prevKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (prevAllow === undefined) delete process.env.STUDIO_ALLOW_LIVE_MODEL;
    else process.env.STUDIO_ALLOW_LIVE_MODEL = prevAllow;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  });

  it("refuses LIVE_FULL even when other isolation flags look set", () => {
    process.env.STUDIO_ALLOW_LIVE_MODEL = "1";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.STUDIO_ALLOW_LIVE_FULL = "1";
    process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND = "1";
    process.env.WORKEE_DISABLE_REMINDER_FIRE = "1";
    expect(() => assertStudioTrackRunnable("LIVE_FULL")).toThrow(
      UnapprovedEvalDatabaseError,
    );
    expect(() => assertStudioTrackRunnable("LIVE_FULL")).toThrow(/Phase D/i);
  });

  it("refuses LIVE_MODEL when STUDIO_ALLOW_LIVE_MODEL is unset", () => {
    delete process.env.STUDIO_ALLOW_LIVE_MODEL;
    process.env.OPENAI_API_KEY = "sk-test";
    expect(() => assertStudioTrackRunnable("LIVE_MODEL")).toThrow(
      /disabled by default/i,
    );
    expect(() => assertStudioTrackRunnable("LIVE_MODEL_MT")).toThrow(
      /disabled by default/i,
    );
  });

  it("refuses LIVE_MODEL when OpenAI key is missing", () => {
    process.env.STUDIO_ALLOW_LIVE_MODEL = "1";
    delete process.env.OPENAI_API_KEY;
    expect(() => assertStudioTrackRunnable("LIVE_MODEL")).toThrow(
      /OPENAI_API_KEY/i,
    );
  });

  it("allows LIVE_MODEL only when opt-in and key are set", () => {
    process.env.STUDIO_ALLOW_LIVE_MODEL = "1";
    process.env.OPENAI_API_KEY = "sk-test";
    expect(() => assertStudioTrackRunnable("LIVE_MODEL")).not.toThrow();
    expect(() => assertStudioTrackRunnable("LIVE_MODEL_MT")).not.toThrow();
  });

  it("marks LIVE_FULL non-executable in trackCapabilities", () => {
    const caps = trackCapabilities("LIVE_FULL");
    expect(caps.executable).toBe(false);
  });

  it("probeLiveModelStudioAllow reports blockers when unset", () => {
    delete process.env.STUDIO_ALLOW_LIVE_MODEL;
    delete process.env.OPENAI_API_KEY;
    const report = probeLiveModelStudioAllow();
    expect(report.allowed).toBe(false);
    expect(report.blockers.length).toBeGreaterThan(0);
  });
});
