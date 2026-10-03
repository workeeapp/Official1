import { beforeEach, describe, expect, it, vi } from "vitest";

const git = vi.hoisted(() => ({
  resolveGitDigestWindow: vi.fn(() => ({
    sinceDate: new Date("2026-09-01T00:00:00.000Z"),
    advanceLastReportSha: false,
    windowLabel: "last 7 days",
  })),
  readGitChangelog: vi.fn(async () => ({
    headSha: "abc",
    commits: [
      {
        sha: "abc",
        subject: "Add compose facts plugins",
        body: "Unify git and saved_data.",
        files: ["backend/src/services/compose-facts.ts"],
      },
    ],
  })),
  formatGitChangelogForCompose: vi.fn(
    (commits: Array<{ subject: string }>) =>
      commits.map((row, i) => `${i + 1}. ${row.subject}`).join("\n"),
  ),
}));

const records = vi.hoisted(() => ({
  getEmployeeRecordSnapshot: vi.fn(async () => ({
    lists: [],
    filing: [],
    reminders: [],
  })),
  formatEmployeeContext: vi.fn(
    () =>
      'EMPLOYEE_SAVED_DATA:\n{"lists":[{"owner":"טל","items":[{"שם פריט":"חלב"}]}]}',
  ),
}));

const contacts = vi.hoisted(() => ({
  listContactsForEmployee: vi.fn(async () => []),
  formatSpeakerContacts: vi.fn(() => ""),
}));

const clock = vi.hoisted(() => ({
  formatSessionClockContext: vi.fn(() => "SESSION_CLOCK: test"),
}));

vi.mock("../src/services/git-changelog.js", () => git);
vi.mock("../src/services/employee-records.service.js", () => records);
vi.mock("../src/services/contact.service.js", () => contacts);
vi.mock("../src/utils/relative-date.js", () => clock);

import { loadComposeFacts } from "../src/services/compose-facts.js";

describe("loadComposeFacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads git_log commits as a shared facts bundle", async () => {
    const bundle = await loadComposeFacts({
      composeSource: "git_log",
      subjectEmployeeId: "tal",
      repeat: "once",
      lookbackHours: 168,
    });
    expect(bundle.kind).toBe("git_log");
    expect(bundle.facts).toContain("Add compose facts plugins");
    expect(bundle.windowLabel).toBe("last 7 days");
    expect(bundle.fixedBody).toBeUndefined();
    expect(git.readGitChangelog).toHaveBeenCalledOnce();
  });

  it("loads saved_data from the employee snapshot", async () => {
    const bundle = await loadComposeFacts({
      composeSource: "saved_data",
      subjectEmployeeId: "tal",
      repeat: "once",
    });
    expect(bundle.kind).toBe("saved_data");
    expect(bundle.facts).toContain("FILTER RULE");
    expect(bundle.facts).toContain("shared_with");
    expect(bundle.facts).toContain("EMPLOYEE_SAVED_DATA");
    expect(bundle.facts).toContain("חלב");
    expect(bundle.sessionClock).toContain("SESSION_CLOCK");
    expect(records.getEmployeeRecordSnapshot).toHaveBeenCalledWith("tal");
  });

  it("returns creative kind when no compose source", async () => {
    const bundle = await loadComposeFacts({
      composeSource: "",
      subjectEmployeeId: "tal",
      repeat: "once",
    });
    expect(bundle).toMatchObject({ kind: "creative", facts: "" });
    expect(git.readGitChangelog).not.toHaveBeenCalled();
    expect(records.getEmployeeRecordSnapshot).not.toHaveBeenCalled();
  });
});
