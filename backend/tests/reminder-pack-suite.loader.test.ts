/**
 * Reminder Pack — loader, ≥20 contracts, held-out exclusion (offline).
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNotHeldOutSuitePath,
  defaultReminderPackPath,
  loadReminderPackSuite,
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

describe("Reminder Pack suite loader", () => {
  it("loads committed docs/qa/reminder-pack-suite.json with ≥20 contracts", () => {
    const suite = loadReminderPackSuite();
    expect(defaultReminderPackPath().replace(/\\/g, "/")).toMatch(
      /docs\/qa\/reminder-pack-suite\.json$/,
    );
    expect(suite.pack).toBe("reminder-pack-v1");
    expect(suite.domain).toBe("reminders");
    expect(suite.evalPath).toBe("thin");
    expect(suite.productionParity).toBe(false);
    expect(suite.minIndependentContracts).toBe(20);

    const contracts = new Set(
      suite.cases.map((row) => row.contract?.trim() || row.id),
    );
    expect(contracts.size).toBeGreaterThanOrEqual(20);
    expect(suite.cases.length).toBe(contracts.size);
    expect(suite.criticalCaseIds?.length).toBe(20);

    const model = suite.cases.filter((c) => c.track === "MODEL");
    const apply = suite.cases.filter((c) => c.track === "MODEL_APPLY");
    expect(model.length).toBe(14);
    expect(apply.length).toBe(6);
    expect(suite.cases.every((c) => c.heldOut !== true)).toBe(true);
  });

  it("refuses held-out suite basename (D12)", () => {
    expect(() =>
      assertNotHeldOutSuitePath("/tmp/held-out-suite.json"),
    ).toThrow(/held-out/i);
  });

  it("rejects pack with productionParity true", () => {
    const dir = mkdtempSync(join(tmpdir(), "rem-pack-"));
    tempDirs.push(dir);
    const path = join(dir, "bad.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        speaker: "טל",
        pack: "reminder-pack-v1",
        domain: "reminders",
        evalPath: "thin",
        productionParity: true,
        minIndependentContracts: 20,
        cases: Array.from({ length: 20 }, (_, i) => ({
          id: `R-${i}`,
          track: "MODEL",
          contract: `R-${i}`,
          turns: [{ utterance: "x", constraints: [] }],
        })),
      }),
    );
    expect(() => loadReminderPackSuite(path)).toThrow(/productionParity/);
  });
});
