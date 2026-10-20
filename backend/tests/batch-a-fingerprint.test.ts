/**
 * Batch A Step 1 — fingerprints + immutable archive (offline, no OpenAI).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BaselineArchiveExistsError,
  writeBaselineArchive,
} from "../src/eval/archive-baseline.js";
import {
  EVAL_PATH_THIN,
  buildEvalFingerprint,
} from "../src/eval/fingerprint.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Batch A fingerprint (offline)", () => {
  it("labels thin eval path with productionParity false", () => {
    const fp = buildEvalFingerprint({
      instructions: "system-a\n\ntargeting-b",
      now: new Date("2026-10-20T12:00:00.000Z"),
    });
    expect(fp.evalPath).toBe(EVAL_PATH_THIN);
    expect(fp.evalPath).toBe("thin");
    expect(fp.productionParity).toBe(false);
    expect(fp.instructionsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fp.createdAt).toBe("2026-10-20T12:00:00.000Z");
  });

  it("is stable for identical instructions", () => {
    const a = buildEvalFingerprint({ instructions: "same-instructions" });
    const b = buildEvalFingerprint({ instructions: "same-instructions" });
    expect(a.instructionsSha256).toBe(b.instructionsSha256);
  });

  it("changes when instructions change", () => {
    const a = buildEvalFingerprint({ instructions: "one" });
    const b = buildEvalFingerprint({ instructions: "two" });
    expect(a.instructionsSha256).not.toBe(b.instructionsSha256);
  });

  it("hashes an optional suite file", () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-a-fp-"));
    tempDirs.push(dir);
    const suitePath = join(dir, "suite.json");
    writeFileSync(suitePath, '{"version":1,"cases":[]}\n', "utf8");
    const fp = buildEvalFingerprint({
      instructions: "x",
      suitePath,
    });
    expect(fp.suiteSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("Batch A baseline archive (offline, synthetic)", () => {
  it("writes a new archive with thin / productionParity false", () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-a-arch-"));
    tempDirs.push(dir);
    const fingerprint = buildEvalFingerprint({
      instructions: "synthetic-baseline",
      now: new Date("2026-10-20T15:00:00.000Z"),
    });
    const path = writeBaselineArchive({
      dir,
      fileName: "batch-a-synthetic.json",
      payload: {
        fingerprint,
        trackSummaries: {
          MODEL: { total: 2, passed: 1, failed: 1 },
          MODEL_APPLY: { total: 1, passed: 0, failed: 1 },
        },
        results: [
          { id: "pass-case", track: "MODEL", ok: true },
          { id: "fail-case", track: "MODEL", ok: false, failures: ["x"] },
          { id: "mt-fail", track: "MODEL_APPLY", ok: false },
        ],
        notes: "synthetic offline archive — not a LIVE baseline",
      },
    });
    expect(existsSync(path)).toBe(true);
    const body = JSON.parse(readFileSync(path, "utf8")) as {
      fingerprint: { evalPath: string; productionParity: boolean };
      results: unknown[];
    };
    expect(body.fingerprint.evalPath).toBe("thin");
    expect(body.fingerprint.productionParity).toBe(false);
    expect(body.results).toHaveLength(3);
  });

  it("refuses to overwrite an existing archive (immutable)", () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-a-arch-immut-"));
    tempDirs.push(dir);
    const fingerprint = buildEvalFingerprint({ instructions: "immut" });
    const first = writeBaselineArchive({
      dir,
      fileName: "same-name.json",
      payload: {
        fingerprint,
        trackSummaries: {},
        results: [{ id: "a", ok: true }],
      },
    });
    expect(existsSync(first)).toBe(true);
    expect(() =>
      writeBaselineArchive({
        dir,
        fileName: "same-name.json",
        payload: {
          fingerprint,
          trackSummaries: {},
          results: [{ id: "b", ok: false }],
        },
      }),
    ).toThrow(BaselineArchiveExistsError);
  });
});
