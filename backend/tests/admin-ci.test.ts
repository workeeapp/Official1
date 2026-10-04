import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

import { resetEnvCache } from "../src/config/env.js";
import {
  getAdminCiStatus,
  parseGithubRepoFromRemote,
} from "../src/services/admin-ci.service.js";

describe("parseGithubRepoFromRemote", () => {
  it("parses https and ssh remotes", () => {
    expect(
      parseGithubRepoFromRemote("https://github.com/workeeapp/Official1.git"),
    ).toBe("workeeapp/Official1");
    expect(
      parseGithubRepoFromRemote("git@github.com:workeeapp/Official1.git"),
    ).toBe("workeeapp/Official1");
  });
});

describe("getAdminCiStatus", () => {
  const prevToken = process.env.GITHUB_TOKEN;
  const prevRepo = process.env.GITHUB_REPO;

  beforeEach(() => {
    fetchMock.mockReset();
    resetEnvCache();
  });

  afterEach(() => {
    if (prevToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = prevToken;
    }
    if (prevRepo === undefined) {
      delete process.env.GITHUB_REPO;
    } else {
      process.env.GITHUB_REPO = prevRepo;
    }
    resetEnvCache();
  });

  it("returns configured false when GITHUB_TOKEN is missing", async () => {
    delete process.env.GITHUB_TOKEN;
    resetEnvCache();
    const result = await getAdminCiStatus();
    expect(result.configured).toBe(false);
    expect(result.latest).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns package jobs when the latest Test run succeeded", async () => {
    process.env.GITHUB_TOKEN = "ghs_test_token";
    process.env.GITHUB_REPO = "workeeapp/Official1";
    resetEnvCache();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          workflow_runs: [
            {
              id: 100,
              status: "completed",
              conclusion: "success",
              event: "push",
              head_sha: "abc123def456",
              html_url: "https://github.com/workeeapp/Official1/actions/runs/100",
              run_started_at: "2026-10-04T07:22:00.000Z",
              updated_at: "2026-10-04T07:22:44.000Z",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jobs: [
            {
              name: "shared",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/workeeapp/Official1/actions/runs/100/job/1",
            },
            {
              name: "backend",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/workeeapp/Official1/actions/runs/100/job/2",
            },
            {
              name: "frontend",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/workeeapp/Official1/actions/runs/100/job/3",
            },
          ],
        }),
      });

    const result = await getAdminCiStatus();
    expect(result.configured).toBe(true);
    expect(result.repo).toBe("workeeapp/Official1");
    expect(result.latest?.conclusion).toBe("success");
    expect(result.jobs.map((job) => job.name)).toEqual([
      "shared",
      "backend",
      "frontend",
    ]);
    expect(result.jobs.every((job) => job.conclusion === "success")).toBe(true);
  });

  it("surfaces a failed package job on the latest run", async () => {
    process.env.GITHUB_TOKEN = "ghs_test_token";
    process.env.GITHUB_REPO = "workeeapp/Official1";
    resetEnvCache();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          workflow_runs: [
            {
              id: 101,
              status: "completed",
              conclusion: "failure",
              event: "push",
              head_sha: "deadbeef01",
              html_url: "https://github.com/workeeapp/Official1/actions/runs/101",
              run_started_at: "2026-10-04T08:00:00.000Z",
              updated_at: "2026-10-04T08:01:00.000Z",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jobs: [
            {
              name: "shared",
              status: "completed",
              conclusion: "success",
              html_url: "https://example.com/shared",
            },
            {
              name: "backend",
              status: "completed",
              conclusion: "failure",
              html_url: "https://example.com/backend",
            },
            {
              name: "frontend",
              status: "completed",
              conclusion: "success",
              html_url: "https://example.com/frontend",
            },
          ],
        }),
      });

    const result = await getAdminCiStatus();
    expect(result.latest?.conclusion).toBe("failure");
    expect(result.jobs.find((job) => job.name === "backend")?.conclusion).toBe(
      "failure",
    );
  });
});
