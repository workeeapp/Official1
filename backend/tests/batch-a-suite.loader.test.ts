/**
 * Batch A Step 3 — suite loader, track separation, held-out exclusion (offline).
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HELD_OUT_SUITE_BASENAME,
  assertNotHeldOutSuitePath,
  batchAModelCaseToEvalCase,
  defaultBatchASuitePath,
  loadBatchASuite,
  loadRegressionSuite,
} from "../src/eval/corpus.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Batch A suite loader", () => {
  it("loads committed docs/qa/batch-a-suite.json", () => {
    const suite = loadBatchASuite();
    expect(defaultBatchASuitePath().replace(/\\/g, "/")).toMatch(
      /docs\/qa\/batch-a-suite\.json$/,
    );
    expect(suite.batch).toBe("A");
    expect(suite.evalPath).toBe("thin");
    expect(suite.productionParity).toBe(false);

    const model = suite.cases.filter((c) => c.track === "MODEL");
    const apply = suite.cases.filter((c) => c.track === "MODEL_APPLY");
    expect(model.length).toBeGreaterThanOrEqual(40);
    expect(apply.length).toBe(3);
    expect(apply.map((c) => c.id).sort()).toEqual(
      [
        "MT1-clarify-then-delete",
        "MT2-ask-then-add",
        "MT3-stop-nudge-keep-item",
      ].sort(),
    );

    // Each MODEL contract has canonical + contrast
    const byContract = new Map<string, Set<string>>();
    for (const row of model) {
      const set = byContract.get(row.contract ?? row.id) ?? new Set();
      if (row.variant) set.add(row.variant);
      byContract.set(row.contract ?? row.id, set);
    }
    for (const [contract, variants] of byContract) {
      expect(variants.has("canonical"), contract).toBe(true);
      expect(variants.has("contrast"), contract).toBe(true);
    }

    expect(suite.cases.every((c) => c.heldOut !== true)).toBe(true);
  });

  it("keeps Gate 1 ENGINE loader unchanged (ENGINE-only)", () => {
    const eng = loadRegressionSuite();
    expect(eng.cases.every((c) => c.track === "ENGINE")).toBe(true);
  });

  it("converts MODEL case for thin single-turn eval shape", () => {
    const suite = loadBatchASuite();
    const row = suite.cases.find((c) => c.id === "L-BOUGHT-canonical");
    expect(row).toBeTruthy();
    const evalCase = batchAModelCaseToEvalCase(row!);
    expect(evalCase.id).toBe("L-BOUGHT-canonical");
    expect(evalCase.utterance.length).toBeGreaterThan(0);
    expect(evalCase.constraints.length).toBeGreaterThan(0);
  });
});

describe("Batch A held-out exclusion (D12)", () => {
  it("refuses held-out-sealed.json basename", () => {
    expect(() =>
      assertNotHeldOutSuitePath(`C:/repo/docs/qa/${HELD_OUT_SUITE_BASENAME}`),
    ).toThrow(/held-out/i);
  });

  it("refuses paths containing held-out", () => {
    expect(() =>
      assertNotHeldOutSuitePath("/tmp/my-held-out-cases.json"),
    ).toThrow(/held-out/i);
  });

  it("loadBatchASuite refuses held-out path even if file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-a-ho-"));
    tempDirs.push(dir);
    const path = join(dir, HELD_OUT_SUITE_BASENAME);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        speaker: "טל",
        batch: "A",
        evalPath: "thin",
        productionParity: false,
        cases: [
          {
            id: "ho-1",
            track: "MODEL",
            heldOut: true,
            turns: [{ utterance: "x", constraints: [] }],
          },
        ],
      }),
    );
    expect(() => loadBatchASuite(path)).toThrow(/held-out/i);
  });

  it("rejects a Batch A suite file that embeds heldOut:true cases", () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-a-embed-ho-"));
    tempDirs.push(dir);
    const path = join(dir, "batch-a-suite.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        speaker: "טל",
        batch: "A",
        evalPath: "thin",
        productionParity: false,
        cases: [
          {
            id: "ok",
            track: "MODEL",
            turns: [{ utterance: "שלום", constraints: [] }],
          },
          {
            id: "secret-ho",
            track: "MODEL",
            heldOut: true,
            turns: [{ utterance: "held", constraints: [] }],
          },
        ],
      }),
    );
    expect(() => loadBatchASuite(path)).toThrow(/heldOut|held-out/i);
  });

  it("rejects ENGINE track inside Batch A suite", () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-a-eng-"));
    tempDirs.push(dir);
    const path = join(dir, "batch-a-suite.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        speaker: "טל",
        batch: "A",
        evalPath: "thin",
        productionParity: false,
        cases: [
          {
            id: "bad-engine",
            track: "ENGINE",
            turns: [
              {
                utterance: "x",
                fixtureMetadata: { lists: [] },
                constraints: [],
              },
            ],
          },
        ],
      }),
    );
    expect(() => loadBatchASuite(path)).toThrow(/MODEL or MODEL_APPLY/);
  });

  it("rejects MODEL_APPLY turns that include fixtureMetadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-a-fix-"));
    tempDirs.push(dir);
    const path = join(dir, "batch-a-suite.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        speaker: "טל",
        batch: "A",
        evalPath: "thin",
        productionParity: false,
        cases: [
          {
            id: "mt-bad",
            track: "MODEL_APPLY",
            turns: [
              {
                utterance: "x",
                fixtureMetadata: { lists: [{ action: "add" }] },
                constraints: [],
              },
            ],
          },
        ],
      }),
    );
    expect(() => loadBatchASuite(path)).toThrow(/fixtureMetadata/);
  });
});
