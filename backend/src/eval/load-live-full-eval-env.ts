/**
 * Fail-closed loader for the existing repo `.env.live-full-eval` (workee_test).
 *
 * Eval / write-harness only — never reads product `.env`, never invents a
 * default DATABASE_URL, never self-approves. Callers must opt in (vitest
 * eval-db config or Load-LiveFullEvalEnv.ps1).
 *
 * Pure file I/O + process.env mutation; does not open Prisma.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertApprovedEvalDatabaseUrl } from "./studio-db-guard.js";

export const LIVE_FULL_EVAL_ENV_FILENAME = ".env.live-full-eval";

/** When set to "1", product dotenv must not override eval DB URLs (see config/env.ts). */
export const WORKEE_EVAL_ENV_LOCKED = "WORKEE_EVAL_ENV_LOCKED";

export const LIVE_FULL_EVAL_REQUIRED_KEYS = [
  "DATABASE_URL",
  "WORKEE_APPROVED_TEST_DATABASE_URL",
  "WORKEE_DISABLE_WHATSAPP_OUTBOUND",
  "WORKEE_DISABLE_REMINDER_FIRE",
] as const;

export class LiveFullEvalEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveFullEvalEnvError";
  }
}

export type LiveFullEvalEnvLoadResult = {
  path: string;
  values: Record<string, string>;
};

/** Strip optional surrounding quotes from a single env value. */
export function stripEnvQuotes(value: string): string {
  const v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/** Parse KEY=VALUE lines (comments / blanks ignored). */
export function parseEnvFileContents(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    if (!key) {
      continue;
    }
    out[key] = stripEnvQuotes(line.slice(eq + 1));
  }
  return out;
}

/**
 * Resolve `.env.live-full-eval` from cwd or parent (backend vs repo root).
 * Throws when missing — no fallback to product `.env`.
 */
export function resolveLiveFullEvalEnvPath(
  cwd: string = process.cwd(),
): string {
  const candidates = [
    resolve(cwd, LIVE_FULL_EVAL_ENV_FILENAME),
    resolve(cwd, "..", LIVE_FULL_EVAL_ENV_FILENAME),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }
  throw new LiveFullEvalEnvError(
    `Missing ${LIVE_FULL_EVAL_ENV_FILENAME} (looked in ${candidates.join(", ")}). ` +
      "Copy .env.live-full-eval.example and configure workee_test — refusing eval DB use.",
  );
}

/**
 * Validate parsed values: required keys, exact URL match, then studio-db-guard.
 * Does not read product `.env` and does not apply to process.env.
 */
export function validateLiveFullEvalEnvValues(
  values: Record<string, string>,
  sourceLabel: string,
): void {
  for (const key of LIVE_FULL_EVAL_REQUIRED_KEYS) {
    const v = values[key];
    if (typeof v !== "string" || v.trim() === "") {
      throw new LiveFullEvalEnvError(
        `${sourceLabel}: missing required ${key}; refusing eval DB use (no product .env fallback).`,
      );
    }
  }
  const db = values.DATABASE_URL!;
  const approved = values.WORKEE_APPROVED_TEST_DATABASE_URL!;
  if (db !== approved) {
    throw new LiveFullEvalEnvError(
      `${sourceLabel}: DATABASE_URL must exactly equal WORKEE_APPROVED_TEST_DATABASE_URL; refusing eval DB use.`,
    );
  }
}

/**
 * Load and validate `.env.live-full-eval`.
 * When `apply` is true, writes into process.env and sets WORKEE_EVAL_ENV_LOCKED=1.
 */
export function loadLiveFullEvalEnv(options?: {
  /** Override path (tests). When omitted, resolves the real file only. */
  envPath?: string;
  /** Mutate process.env (default true for harness entrypoints). */
  apply?: boolean;
  cwd?: string;
}): LiveFullEvalEnvLoadResult {
  const path =
    options?.envPath !== undefined
      ? options.envPath
      : resolveLiveFullEvalEnvPath(options?.cwd ?? process.cwd());

  if (!existsSync(path)) {
    throw new LiveFullEvalEnvError(
      `Missing eval env file at ${path}; refusing eval DB use (no product .env fallback).`,
    );
  }

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new LiveFullEvalEnvError(
      `Cannot read ${path}: ${detail}; refusing eval DB use.`,
    );
  }

  const values = parseEnvFileContents(contents);
  validateLiveFullEvalEnvValues(values, path);

  // Guard reads approved from process.env — set temporarily, restore if not applying.
  const prevApproved = process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
  const prevDb = process.env.DATABASE_URL;
  const apply = options?.apply !== false;
  const restoreKey = (key: "DATABASE_URL" | "WORKEE_APPROVED_TEST_DATABASE_URL", prev: string | undefined) => {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  };

  process.env.WORKEE_APPROVED_TEST_DATABASE_URL =
    values.WORKEE_APPROVED_TEST_DATABASE_URL;
  process.env.DATABASE_URL = values.DATABASE_URL;
  try {
    assertApprovedEvalDatabaseUrl(values.DATABASE_URL);
  } catch (err) {
    restoreKey("WORKEE_APPROVED_TEST_DATABASE_URL", prevApproved);
    restoreKey("DATABASE_URL", prevDb);
    throw err;
  }

  if (apply) {
    for (const [key, value] of Object.entries(values)) {
      process.env[key] = value;
    }
    process.env[WORKEE_EVAL_ENV_LOCKED] = "1";
  } else {
    restoreKey("WORKEE_APPROVED_TEST_DATABASE_URL", prevApproved);
    restoreKey("DATABASE_URL", prevDb);
  }

  return { path, values };
}

/** Sanitized one-line summary (no password). */
export function summarizeLiveFullEvalEnv(
  result: LiveFullEvalEnvLoadResult,
): string {
  try {
    const u = new URL(result.values.DATABASE_URL!);
    const db = u.pathname.replace(/^\//, "").split("/")[0] ?? "";
    return `${LIVE_FULL_EVAL_ENV_FILENAME} loaded: ${u.hostname}:${u.port || "(default)"}/${db} user=${u.username} (password hidden)`;
  } catch {
    return `${LIVE_FULL_EVAL_ENV_FILENAME} loaded (URL parse skipped)`;
  }
}
