/**
 * Batch A eval fingerprints — labels the thin eval path as ≠ production.
 * Never logs secrets or connection strings.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

export const EVAL_PATH_THIN = "thin" as const;

export interface EvalFingerprint {
  /** Always "thin" for Batch A / Phase-4 model eval. */
  evalPath: typeof EVAL_PATH_THIN;
  /** Always false for the thin instruction stack (D11). */
  productionParity: false;
  instructionsSha256: string;
  llmConfigSha256: string | null;
  llmActionSha256: string | null;
  suiteSha256: string | null;
  gitCommit: string | null;
  /** True when tracked prompt/action/suite files differ from HEAD. */
  wipDirty: boolean;
  createdAt: string;
}

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function repoRootFromCwd(cwd = process.cwd()): string {
  // Vitest runs with cwd = backend/; configs live at monorepo root.
  const asBackend = resolve(cwd, "..");
  if (existsSync(resolve(asBackend, "LLM.config.json"))) {
    return asBackend;
  }
  if (existsSync(resolve(cwd, "LLM.config.json"))) {
    return cwd;
  }
  return asBackend;
}

function hashFileIfExists(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  return sha256Hex(readFileSync(path));
}

function gitCommitSha(repoRoot: string): string | null {
  try {
    const out = execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * True when any of the named relative paths differ from HEAD (or are untracked).
 * Fail-open to dirty=true on git errors so baselines never claim a clean tree falsely.
 */
function gitPathsDirty(repoRoot: string, relativePaths: string[]): boolean {
  try {
    for (const rel of relativePaths) {
      const status = execSync(`git status --porcelain -- ${rel}`, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (status.length > 0) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

export function resolveLlmConfigPath(repoRoot = repoRootFromCwd()): string {
  return resolve(repoRoot, "LLM.config.json");
}

export function resolveLlmActionPath(repoRoot = repoRootFromCwd()): string {
  return resolve(repoRoot, "LLM.action.json");
}

/**
 * Build a fingerprint for a Batch A / thin-eval run.
 * `instructions` must be the exact string passed to the model client.
 */
export function buildEvalFingerprint(input: {
  instructions: string;
  suitePath?: string | null;
  repoRoot?: string;
  now?: Date;
}): EvalFingerprint {
  const root = input.repoRoot ?? repoRootFromCwd();
  const configPath = resolveLlmConfigPath(root);
  const actionPath = resolveLlmActionPath(root);
  const suitePath = input.suitePath ? resolve(input.suitePath) : null;

  const tracked = ["LLM.config.json", "LLM.action.json"];
  if (suitePath) {
    // Prefer repo-relative for git status when under root.
    const rel = suitePath.startsWith(root)
      ? suitePath.slice(root.length).replace(/^[\\/]/, "").replace(/\\/g, "/")
      : suitePath;
    tracked.push(rel);
  }

  return {
    evalPath: EVAL_PATH_THIN,
    productionParity: false,
    instructionsSha256: sha256Hex(input.instructions),
    llmConfigSha256: hashFileIfExists(configPath),
    llmActionSha256: hashFileIfExists(actionPath),
    suiteSha256: suitePath ? hashFileIfExists(suitePath) : null,
    gitCommit: gitCommitSha(root),
    wipDirty: gitPathsDirty(root, tracked),
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}
