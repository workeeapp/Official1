import { describe, expect, it } from "vitest";
import {
  formatGitChangelogForCompose,
  resolveGitDigestWindow,
  resolveRepoRoot,
} from "../src/services/git-changelog.js";

describe("formatGitChangelogForCompose", () => {
  it("returns empty string when there are no commits", () => {
    expect(formatGitChangelogForCompose([])).toBe("");
  });

  it("formats subjects, bodies, and files for the compose prompt", () => {
    const text = formatGitChangelogForCompose([
      {
        sha: "abc",
        subject: "Add compose-at-fire digests",
        body: "Summarize git commits in English.",
        files: ["backend/src/services/reminder-compose.ts"],
      },
      {
        sha: "def",
        subject: "Hide WhatsApp guests",
        body: "",
        files: [],
      },
    ]);
    expect(text).toContain("1. Add compose-at-fire digests");
    expect(text).toContain("Summarize git commits in English.");
    expect(text).toContain("Files: backend/src/services/reminder-compose.ts");
    expect(text).toContain("2. Hide WhatsApp guests");
  });
});

describe("resolveGitDigestWindow", () => {
  const now = new Date("2026-10-02T00:00:00.000Z");

  it("uses lookback for one-shot digests and does not advance last_report_sha", () => {
    const window = resolveGitDigestWindow({
      repeat: "once",
      lastReportSha: "abc",
      lookbackHours: 0,
      now,
    });
    expect(window.advanceLastReportSha).toBe(false);
    expect(window.sinceDate?.toISOString()).toBe(
      new Date(now.getTime() - 168 * 3600_000).toISOString(),
    );
    expect(window.sinceSha).toBeUndefined();
  });

  it("honors an explicit lookback window without advancing the baseline", () => {
    const window = resolveGitDigestWindow({
      repeat: "once",
      lookbackHours: 24,
      now,
    });
    expect(window.advanceLastReportSha).toBe(false);
    expect(window.windowLabel).toBe("last 24 hours");
    expect(window.sinceDate?.toISOString()).toBe(
      new Date(now.getTime() - 24 * 3600_000).toISOString(),
    );
  });

  it("honors a short minute window without advancing the baseline", () => {
    const window = resolveGitDigestWindow({
      repeat: "once",
      lastReportSha: "abc",
      lookbackHours: 5 / 60,
      now,
    });
    expect(window.advanceLastReportSha).toBe(false);
    expect(window.windowLabel).toBe("last 5 minutes");
    expect(window.sinceDate?.toISOString()).toBe(
      new Date(now.getTime() - 5 * 60_000).toISOString(),
    );
  });

  it("uses since-last-report mode for recurring digests without lookback", () => {
    const window = resolveGitDigestWindow({
      repeat: "1:days",
      lastReportSha: "deadbeef",
      lookbackHours: 0,
      now,
    });
    expect(window.advanceLastReportSha).toBe(true);
    expect(window.sinceSha).toBe("deadbeef");
    expect(window.sinceDate).toBeUndefined();
  });
});

describe("resolveRepoRoot", () => {
  it("finds the git root from the backend package cwd", () => {
    const root = resolveRepoRoot();
    expect(root.length).toBeGreaterThan(0);
  });
});
