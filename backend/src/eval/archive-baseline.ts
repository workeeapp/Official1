/**
 * Immutable Batch A baseline archives — never overwrite an existing path.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EvalFingerprint } from "./fingerprint.js";

export class BaselineArchiveExistsError extends Error {
  constructor(path: string) {
    super(`Baseline archive already exists (immutable): ${path}`);
    this.name = "BaselineArchiveExistsError";
  }
}

export interface BaselineArchivePayload {
  fingerprint: EvalFingerprint;
  /** ENGINE | MODEL | MODEL_APPLY — caller-separated. */
  trackSummaries: Record<string, unknown>;
  results: unknown[];
  /** Free-form note; must not claim production parity. */
  notes?: string;
}

export function defaultBaselinesDir(
  repoRoot = resolve(import.meta.dirname, "../../.."),
): string {
  return resolve(repoRoot, "docs/qa/baselines");
}

export function baselineArchiveFileName(
  fingerprint: EvalFingerprint,
  now = new Date(),
): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const short = fingerprint.instructionsSha256.slice(0, 12);
  return `batch-a-${iso}-${short}.json`;
}

/**
 * Write a new baseline file. Refuses if the target path already exists.
 * Returns the absolute path written.
 */
export function writeBaselineArchive(input: {
  payload: BaselineArchivePayload;
  dir?: string;
  fileName?: string;
  now?: Date;
}): string {
  const dir = input.dir ?? defaultBaselinesDir();
  const fileName =
    input.fileName ??
    baselineArchiveFileName(input.payload.fingerprint, input.now ?? new Date());
  const path = resolve(dir, fileName);

  if (existsSync(path)) {
    throw new BaselineArchiveExistsError(path);
  }

  mkdirSync(dirname(path), { recursive: true });

  const body = {
    ...input.payload,
    fingerprint: {
      ...input.payload.fingerprint,
      evalPath: "thin" as const,
      productionParity: false as const,
    },
    archivedAt: (input.now ?? new Date()).toISOString(),
  };

  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return path;
}
