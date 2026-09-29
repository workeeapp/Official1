import { describe, expect, it } from "vitest";
import {
  formatGitChangelogForCompose,
  resolveRepoRoot,
} from "../src/services/git-changelog.js";

describe("formatGitChangelogForCompose", () => {
  it("returns empty string when there are no commits", () => {
    expect(formatGitChangelogForCompose([])).toBe("");
  });

  it("formats subjects and bodies for the compose prompt", () => {
    const text = formatGitChangelogForCompose([
      {
        sha: "abc",
        subject: "Add compose-at-fire digests",
        body: "Summarize git commits in English.",
      },
      { sha: "def", subject: "Hide WhatsApp guests", body: "" },
    ]);
    expect(text).toContain("1. Add compose-at-fire digests");
    expect(text).toContain("Summarize git commits in English.");
    expect(text).toContain("2. Hide WhatsApp guests");
  });
});

describe("resolveRepoRoot", () => {
  it("finds the git root from the backend package cwd", () => {
    const root = resolveRepoRoot();
    expect(root.length).toBeGreaterThan(0);
  });
});
