import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommitSummary {
  sha: string;
  subject: string;
  body: string;
  files: string[];
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
 * If `sinceSha` is empty, use commits since `sinceDate` when provided, else last N.
 */
export async function readGitChangelog(input: {
  repoRoot?: string;
  sinceSha?: string;
  sinceDate?: Date;
  maxCount?: number;
}): Promise<{ headSha: string; commits: GitCommitSummary[] }> {
  const repoRoot = input.repoRoot ?? resolveRepoRoot();
  const headSha = await readGitHeadSha(repoRoot);
  const maxCount = Math.min(Math.max(input.maxCount ?? 50, 1), 80);
  const rangeArgs =
    input.sinceSha?.trim() && input.sinceSha.trim() !== headSha
      ? [`${input.sinceSha.trim()}..HEAD`]
      : input.sinceDate
        ? [`--since=${input.sinceDate.toISOString()}`]
        : [`-n`, String(maxCount)];

  // %x1d marks end of subject/body; --name-only lists paths until the next %x1e commit.
  const { stdout } = await execFileAsync(
    "git",
    [
      "log",
      ...rangeArgs,
      `-n`,
      String(maxCount),
      "--name-only",
      "--pretty=format:%x1e%H%x1f%s%x1f%b%x1d",
    ],
    { cwd: repoRoot, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );

  const commits = stdout
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [header = "", filesPart = ""] = chunk.split("\x1d");
      const [sha = "", subject = "", body = ""] = header.split("\x1f");
      const files = filesPart
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 12);
      return {
        sha: sha.trim(),
        subject: subject.trim(),
        body: body.trim().slice(0, 800),
        files,
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
      const files =
        row.files.length > 0
          ? `\nFiles: ${row.files.slice(0, 8).join(", ")}`
          : "";
      return `${index + 1}. ${row.subject}${body}${files}`;
    })
    .join("\n\n");
}

/** How to load commits for a git_log fire, and whether to stamp last_report_sha after. */
export function resolveGitDigestWindow(input: {
  repeat: string;
  lastReportSha?: string | null;
  lookbackHours?: number | null;
  now?: Date;
}): {
  sinceSha?: string;
  sinceDate?: Date;
  advanceLastReportSha: boolean;
  windowLabel: string;
} {
  const now = input.now ?? new Date();
  const isOnce = !input.repeat || input.repeat === "once";
  const lookback =
    typeof input.lookbackHours === "number" &&
    Number.isFinite(input.lookbackHours) &&
    input.lookbackHours > 0
      ? Math.min(input.lookbackHours, 24 * 90)
      : isOnce
        ? 168
        : 0;

  if (lookback > 0) {
    return {
      sinceDate: new Date(now.getTime() - lookback * 60 * 60 * 1000),
      // Windowed / one-shot reports must not move the recurring baseline.
      advanceLastReportSha: false,
      windowLabel: formatLookbackLabel(lookback),
    };
  }

  const sinceSha = input.lastReportSha?.trim() || undefined;
  return {
    sinceSha,
    advanceLastReportSha: true,
    windowLabel: sinceSha
      ? "since the last report"
      : "recent commits (first recurring baseline)",
  };
}

function formatLookbackLabel(lookbackHours: number): string {
  if (lookbackHours < 1) {
    const minutes = Math.max(1, Math.round(lookbackHours * 60));
    return `last ${minutes} minutes`;
  }
  if (lookbackHours === 24) {
    return "last 24 hours";
  }
  if (lookbackHours === 168) {
    return "last 7 days";
  }
  if (Number.isInteger(lookbackHours)) {
    return `last ${lookbackHours} hours`;
  }
  const minutes = Math.round(lookbackHours * 60);
  if (minutes % 60 === 0) {
    return `last ${minutes / 60} hours`;
  }
  return `last ${minutes} minutes`;
}
