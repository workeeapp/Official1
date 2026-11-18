import { describe, expect, it } from "vitest";
import { uwmApplyGate } from "../src/services/uwm-apply-gate.js";

describe("UWM Phase 5 apply evidence gate", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const base = {
    shouldNotify: true,
    fingerprint: "wm:abc:o1:discovered",
    evidenceGrade: "observed" as const,
    evidenceMin: "observed" as const,
    retrievedAt: now.toISOString(),
    fresh: true,
  };

  it("allows observed + fresh match", () => {
    expect(uwmApplyGate({ webMonitor: base }, now)).toEqual({ ok: true });
  });

  it("blocks unverified / disputed / stale / no fingerprint", () => {
    expect(
      uwmApplyGate(
        { webMonitor: { ...base, evidenceGrade: "unverified" } },
        now,
      ).ok,
    ).toBe(false);
    expect(
      uwmApplyGate(
        { webMonitor: { ...base, evidenceGrade: "disputed" } },
        now,
      ),
    ).toMatchObject({ ok: false, reason: "disputed" });
    expect(
      uwmApplyGate({ webMonitor: { ...base, stale: true } }, now),
    ).toMatchObject({ ok: false, reason: "stale" });
    expect(
      uwmApplyGate(
        { webMonitor: { ...base, fingerprint: "" } },
        now,
      ),
    ).toMatchObject({ ok: false, reason: "no_fingerprint" });
  });

  it("requires corroborated when evidenceMin says so", () => {
    expect(
      uwmApplyGate(
        {
          webMonitor: {
            ...base,
            evidenceMin: "corroborated",
            evidenceGrade: "observed",
          },
        },
        now,
      ),
    ).toMatchObject({ ok: false, reason: "need_corroborated" });
    expect(
      uwmApplyGate(
        {
          webMonitor: {
            ...base,
            evidenceMin: "corroborated",
            evidenceGrade: "corroborated",
          },
        },
        now,
      ).ok,
    ).toBe(true);
  });

  it("blocks old retrievedAt", () => {
    expect(
      uwmApplyGate(
        {
          webMonitor: {
            ...base,
            retrievedAt: "2020-01-01T00:00:00Z",
          },
        },
        now,
      ),
    ).toMatchObject({ ok: false, reason: "stale" });
  });

  it("model confidence is irrelevant (no field consulted)", () => {
    expect(
      uwmApplyGate(
        {
          webMonitor: {
            ...base,
            // @ts-expect-error confidence must not unlock apply
            confidence: 0.99,
            evidenceGrade: "unverified",
          },
        },
        now,
      ).ok,
    ).toBe(false);
  });
});
