import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommitSummary {
  sha: string;
  subject: string;
  body: string;
}

export function resolveRepoRoot(cwd = process.cwd()): string {
  const candidates = [cwd, resolve(cwd, ".."), resolve(cwd, "../..")];
  for (const dir of candidates) {
    if (existsSync(resolve(dir, ".git"))) {
      return dir;
    }
  }
  return cwd;
}

export async function readGitHeadSha(repoRoot = resolveRepoRoot()): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoRoot, windowsHide: true },
  );
  return stdout.trim();
}

/**
 * Commits after `sinceSha` (exclusive) up to HEAD.
 * If `sinceSha` is empty, use commits since `sinceDate` when provided, else last 50.
 */
export async function readGitChangelog(input: {
  repoRoot?: string;
  sinceSha?: string;
  sinceDate?: Date;
  maxCount?: number;
}): Promise<{ headSha: string; commits: GitCommitSummary[] }> {
  const repoRoot = input.repoRoot ?? resolveRepoRoot();
  const headSha = await readGitHeadSha(repoRoot);
  const maxCount = Math.min(Math.max(input.maxCount ?? 40, 1), 80);
  const rangeArgs =
    input.sinceSha?.trim() && input.sinceSha.trim() !== headSha
      ? [`${input.sinceSha.trim()}..HEAD`]
      : input.sinceDate
        ? [`--since=${input.sinceDate.toISOString()}`]
        : [`-n`, String(maxCount)];

  const { stdout } = await execFileAsync(
    "git",
    [
      "log",
      ...rangeArgs,
      `-n`,
      String(maxCount),
      "--pretty=format:%H%x1f%s%x1f%b%x1e",
    ],
    { cwd: repoRoot, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
  );

  const commits = stdout
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha = "", subject = "", body = ""] = chunk.split("\x1f");
      return {
        sha: sha.trim(),
        subject: subject.trim(),
        body: body.trim().slice(0, 500),
      };
    })
    .filter((row) => row.sha && row.subject);

  return { headSha, commits };
}

export function formatGitChangelogForCompose(commits: GitCommitSummary[]): string {
  if (commits.length === 0) {
    return "";
  }
  return commits
    .map((row, index) => {
      const body = row.body ? `\n${row.body}` : "";
      return `${index + 1}. ${row.subject}${body}`;
    })
    .join("\n\n");
}
