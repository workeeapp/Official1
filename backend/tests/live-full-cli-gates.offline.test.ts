/**
 * LIVE_FULL CLI isolation gate — process env only.
 * No Prisma, OpenAI, WhatsApp, reminder fire, or LIVE runners.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnapprovedEvalDatabaseError } from "../src/eval/studio-db-guard.js";
import {
  assertLiveFullCliAllowed,
  probeLiveFullCliSafety,
} from "../src/eval/studio-safety.js";

const ENV_KEYS = [
  "DATABASE_URL",
  "WORKEE_APPROVED_TEST_DATABASE_URL",
  "WORKEE_DISABLE_WHATSAPP_OUTBOUND",
  "WORKEE_DISABLE_REMINDER_FIRE",
  "STUDIO_ALLOW_LIVE_FULL",
] as const;

describe("assertLiveFullCliAllowed (offline, no I/O)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const prev = saved[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  function setApprovedPair(url: string) {
    process.env.DATABASE_URL = url;
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = url;
  }

  it("refuses when kill switches are unset even with approved non-product DB", () => {
    setApprovedPair("postgresql://workee:workee@localhost:5435/workee_test");
    delete process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND;
    delete process.env.WORKEE_DISABLE_REMINDER_FIRE;
    delete process.env.STUDIO_ALLOW_LIVE_FULL;

    const report = probeLiveFullCliSafety();
    expect(report.allowed).toBe(false);
    expect(report.blockers.some((b) => b.includes("whatsapp_outbound"))).toBe(
      true,
    );
    expect(report.blockers.some((b) => b.includes("reminder_fire"))).toBe(true);

    expect(() => assertLiveFullCliAllowed()).toThrow(UnapprovedEvalDatabaseError);
    expect(() => assertLiveFullCliAllowed()).toThrow(/LIVE_FULL CLI blocked/i);
  });

  it("refuses product database identity workee even with kill switches", () => {
    setApprovedPair("postgresql://workee:workee@localhost:5435/workee");
    process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND = "1";
    process.env.WORKEE_DISABLE_REMINDER_FIRE = "1";

    expect(() => assertLiveFullCliAllowed()).toThrow(/workee/i);
  });

  it("refuses mismatched DATABASE_URL vs approved URL", () => {
    process.env.DATABASE_URL =
      "postgresql://workee:workee@localhost:5435/workee_test";
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL =
      "postgresql://workee:workee@localhost:5435/other_test";
    process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND = "1";
    process.env.WORKEE_DISABLE_REMINDER_FIRE = "1";

    expect(() => assertLiveFullCliAllowed()).toThrow(/exactly match/i);
  });

  it("refuses approved non-product DB that is not named workee_test", () => {
    setApprovedPair("postgresql://workee:workee@localhost:5435/other_test");
    process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND = "1";
    process.env.WORKEE_DISABLE_REMINDER_FIRE = "1";

    const report = probeLiveFullCliSafety();
    expect(report.allowed).toBe(false);
    expect(
      report.checks.some(
        (c) => c.id === "live_full_database_name" && c.ok === false,
      ),
    ).toBe(true);
    expect(() => assertLiveFullCliAllowed()).toThrow(/workee_test/i);
  });

  it("allows when approved test DB + both kill switches are set (no Studio FULL opt-in)", () => {
    setApprovedPair("postgresql://workee:workee@localhost:5435/workee_test");
    process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND = "1";
    process.env.WORKEE_DISABLE_REMINDER_FIRE = "1";
    delete process.env.STUDIO_ALLOW_LIVE_FULL;

    const report = probeLiveFullCliSafety();
    expect(report.allowed).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(
      report.checks.some(
        (c) => c.id === "live_full_database_name" && c.ok === true,
      ),
    ).toBe(true);
    expect(() => assertLiveFullCliAllowed()).not.toThrow();
  });

  it("does not require STUDIO_ALLOW_LIVE_FULL for CLI", () => {
    setApprovedPair("postgresql://workee:workee@localhost:5435/workee_test");
    process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND = "1";
    process.env.WORKEE_DISABLE_REMINDER_FIRE = "1";
    delete process.env.STUDIO_ALLOW_LIVE_FULL;

    expect(
      probeLiveFullCliSafety().checks.every(
        (c) => c.id !== "explicit_live_full_opt_in",
      ),
    ).toBe(true);
  });
});
