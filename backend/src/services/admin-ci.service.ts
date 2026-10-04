import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AdminCiJob,
  AdminCiRunSummary,
  AdminCiStatusResponse,
} from "@workee/shared";
import { getEnv } from "../config/env.js";
import { resolveRepoRoot } from "./git-changelog.js";

const execFileAsync = promisify(execFile);

const WORKFLOW_FILE = "test.yml";
const BRANCH = "main";
const WORKFLOW_LABEL = "Test";
const PACKAGE_JOBS = ["shared", "backend", "frontend"] as const;

type GhWorkflowRun = {
  id: number;
  status: string;
  conclusion: string | null;
  event: string;
  head_sha: string;
  html_url: string;
  run_started_at?: string | null;
  updated_at: string;
};

type GhJob = {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
};

function emptyStatus(
  partial: Partial<AdminCiStatusResponse> = {},
): AdminCiStatusResponse {
  return {
    configured: false,
    branch: BRANCH,
    workflow: WORKFLOW_LABEL,
    repo: null,
    latest: null,
    jobs: [],
    recentRuns: [],
    ...partial,
  };
}

/** owner/repo from env or `git remote get-url origin`. */
export async function resolveGithubRepo(
  repoRoot = resolveRepoRoot(),
): Promise<string | null> {
  const configured = getEnv().GITHUB_REPO?.trim();
  if (configured) {
    return configured.replace(/\.git$/i, "");
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: repoRoot, windowsHide: true },
    );
    return parseGithubRepoFromRemote(stdout.trim());
  } catch {
    return null;
  }
}

export function parseGithubRepoFromRemote(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) {
    return null;
  }
  const https = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  if (https) {
    return `${https[1]}/${https[2]}`;
  }
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) {
    return `${ssh[1]}/${ssh[2]}`;
  }
  return null;
}

function toRunSummary(run: GhWorkflowRun): AdminCiRunSummary {
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    headSha: run.head_sha,
    htmlUrl: run.html_url,
    startedAt: run.run_started_at ?? null,
    updatedAt: run.updated_at,
  };
}

function normalizeJobName(name: string): string {
  return name.trim().toLowerCase();
}

function pickPackageJobs(jobs: GhJob[]): AdminCiJob[] {
  const byName = new Map(
    jobs.map((job) => [normalizeJobName(job.name), job] as const),
  );
  return PACKAGE_JOBS.map((name) => {
    const row = byName.get(name);
    if (!row) {
      return {
        name,
        status: "unknown",
        conclusion: null,
        htmlUrl: "",
      };
    }
    return {
      name,
      status: row.status,
      conclusion: row.conclusion,
      htmlUrl: row.html_url,
    };
  });
}

async function githubGet<T>(
  token: string,
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; status: number; detail: string }> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "workee-admin-ci",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      detail: body.slice(0, 200) || response.statusText,
    };
  }
  return { ok: true, data: (await response.json()) as T };
}

export async function getAdminCiStatus(): Promise<AdminCiStatusResponse> {
  const token = getEnv().GITHUB_TOKEN?.trim() ?? "";
  if (!token) {
    return emptyStatus({ configured: false });
  }

  const repo = await resolveGithubRepo();
  if (!repo) {
    return emptyStatus({
      configured: true,
      error: "Could not resolve GITHUB_REPO (set owner/repo or configure git remote).",
    });
  }

  const runsPath =
    `/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs` +
    `?branch=${encodeURIComponent(BRANCH)}&per_page=5`;
  const runsResult = await githubGet<{ workflow_runs: GhWorkflowRun[] }>(
    token,
    runsPath,
  );
  if (!runsResult.ok) {
    return emptyStatus({
      configured: true,
      repo,
      error: `GitHub API ${runsResult.status}: ${runsResult.detail}`,
    });
  }

  const recentRuns = (runsResult.data.workflow_runs ?? []).map(toRunSummary);
  const latest = recentRuns[0] ?? null;
  if (!latest) {
    return {
      configured: true,
      branch: BRANCH,
      workflow: WORKFLOW_LABEL,
      repo,
      latest: null,
      jobs: [],
      recentRuns: [],
    };
  }

  const jobsResult = await githubGet<{ jobs: GhJob[] }>(
    token,
    `/repos/${repo}/actions/runs/${latest.id}/jobs`,
  );
  const jobs = jobsResult.ok
    ? pickPackageJobs(jobsResult.data.jobs ?? [])
    : PACKAGE_JOBS.map((name) => ({
        name,
        status: "unknown",
        conclusion: null,
        htmlUrl: "",
      }));

  return {
    configured: true,
    branch: BRANCH,
    workflow: WORKFLOW_LABEL,
    repo,
    latest,
    jobs,
    recentRuns,
    ...(jobsResult.ok
      ? {}
      : {
          error: `Could not load jobs (GitHub API ${jobsResult.status}).`,
        }),
  };
}
