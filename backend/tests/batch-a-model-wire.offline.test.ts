/**
 * Batch A Step 4 — wire MODEL cases + fingerprint (offline, no OpenAI).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { writeBaselineArchive } from "../src/eval/archive-baseline.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBatchAFingerprint,
  buildBatchAThinInstructions,
  loadBatchAModelApplyCases,
  loadBatchAModelCases,
  runBatchAModelCaseOffline,
  summarizeBatchAModelOffline,
} from "../src/eval/run-batch-a.js";
import { loadBatchASuite } from "../src/eval/corpus.js";

describe("Batch A MODEL wire + fingerprint (offline)", () => {
  it("buildBatchAThinInstructions is non-empty and fingerprint is thin / no prod parity", () => {
    const instructions = buildBatchAThinInstructions("טל");
    expect(instructions.length).toBeGreaterThan(100);
    const fp = buildBatchAFingerprint({
      now: new Date("2026-10-20T18:00:00.000Z"),
    });
    expect(fp.evalPath).toBe("thin");
    expect(fp.productionParity).toBe(false);
    expect(fp.instructionsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fp.suiteSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("separates MODEL and MODEL_APPLY case lists", () => {
    const suite = loadBatchASuite();
    const model = loadBatchAModelCases(suite);
    const apply = loadBatchAModelApplyCases(suite);
    expect(model.every((c) => c.track === "MODEL")).toBe(true);
    expect(apply.every((c) => c.track === "MODEL_APPLY")).toBe(true);
    expect(model.length + apply.length).toBe(suite.cases.length);
  });

  it("runs a MODEL case offline against stub ACTION (constraints only, no apply)", () => {
    const suite = loadBatchASuite();
    const row = suite.cases.find((c) => c.id === "L-BOUGHT-canonical")!;
    const pass = runBatchAModelCaseOffline(row, {
      metadata: {
        lists: [
          {
            action: "remove",
            list_type: "shopping",
            list_name: "",
            items: [{ item_id: "eval-item-milk" }],
            targets: [],
          },
        ],
        list_ops: [],
        filing: [],
      },
      response: "הסרתי",
    });
    expect(pass.track).toBe("MODEL");
    expect(pass.ok).toBe(true);

    const fail = runBatchAModelCaseOffline(row, {
      metadata: { lists: [], list_ops: [], filing: [] },
      response: "אוקי",
    });
    expect(fail.ok).toBe(false);
    expect(fail.failures.length).toBeGreaterThan(0);
  });

  it("summary preserves passes and failures with fingerprint labels", () => {
    const suite = loadBatchASuite();
    const row = suite.cases.find((c) => c.id === "L-BOUGHT-canonical")!;
    const results = [
      runBatchAModelCaseOffline(row, {
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "shopping",
              items: [{ item_id: "eval-item-milk" }],
            },
          ],
          list_ops: [],
          filing: [],
        },
      }),
      runBatchAModelCaseOffline(row, {
        metadata: { lists: [], filing: [] },
      }),
    ];
    const fp = buildBatchAFingerprint();
    const summary = summarizeBatchAModelOffline(results, fp);
    expect(summary.evalPath).toBe("thin");
    expect(summary.productionParity).toBe(false);
    expect(summary.track).toBe("MODEL");
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.ok).toBe(false);
    expect(summary.results).toHaveLength(2);
  });

  it("archives synthetic MODEL summary immutably without LIVE", () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-a-wire-arch-"));
    try {
      const fp = buildBatchAFingerprint();
      const path = writeBaselineArchive({
        dir,
        fileName: "batch-a-wire-synthetic.json",
        payload: {
          fingerprint: fp,
          trackSummaries: {
            MODEL: { total: 1, passed: 0, failed: 1 },
            MODEL_APPLY: { total: 0, passed: 0, failed: 0 },
            ENGINE: { note: "Gate 1 separate — not included" },
          },
          results: [{ id: "synth", track: "MODEL", ok: false }],
          notes: "Step 4 synthetic — not a LIVE baseline",
        },
      });
      const body = JSON.parse(readFileSync(path, "utf8"));
      expect(body.fingerprint.evalPath).toBe("thin");
      expect(body.fingerprint.productionParity).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run-batch-a module does not import an LLM client", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/eval/run-batch-a.ts"),
      "utf8",
    );
    const imports = src
      .split(/\r?\n/)
      .filter((line) => /^\s*import\s/.test(line))
      .join("\n");
    expect(imports).not.toMatch(/openai|llm-client|getLlmClient/i);
  });
});
