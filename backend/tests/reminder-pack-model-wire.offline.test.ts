/**
 * Reminder Pack — MODEL wire offline (stub ACTION, constraints only, no apply/LIVE).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { offlineStubForConstraints } from "../src/eval/offline-stub.js";
import {
  buildBatchAFingerprint,
  runBatchAModelCaseOffline,
  summarizeBatchAModelOffline,
} from "../src/eval/run-batch-a.js";
import {
  defaultReminderPackPath,
  loadReminderPackSuite,
} from "../src/eval/corpus.js";

describe("Reminder Pack MODEL wire (offline)", () => {
  it("every MODEL case passes offline stub constraints", () => {
    const suite = loadReminderPackSuite();
    const model = suite.cases.filter((c) => c.track === "MODEL");
    expect(model.length).toBe(14);

    const results = model.map((row) => {
      const constraints = row.turns[0]?.constraints ?? [];
      const stub = offlineStubForConstraints(constraints);
      return runBatchAModelCaseOffline(row, stub);
    });

    const failed = results.filter((r) => !r.ok);
    expect(
      failed.map((r) => `${r.id}: ${r.failures.join("; ")}`),
      "all MODEL stubs must satisfy authored constraints",
    ).toEqual([]);

    const fp = buildBatchAFingerprint({
      suitePath: defaultReminderPackPath(),
    });
    expect(fp.evalPath).toBe("thin");
    expect(fp.productionParity).toBe(false);
    const summary = summarizeBatchAModelOffline(results, fp);
    expect(summary.ok).toBe(true);
    expect(summary.passed).toBe(14);
    expect(summary.failed).toBe(0);
  });

  it("fails when stub ACTION is empty for a mutate contract", () => {
    const suite = loadReminderPackSuite();
    const row = suite.cases.find((c) => c.id === "R-CREATE-EXPLICIT")!;
    const fail = runBatchAModelCaseOffline(row, {
      metadata: { lists: [], reminders: [], filing: [] },
      response: "אוקי",
    });
    expect(fail.ok).toBe(false);
  });

  it("run-batch-a does not import an LLM client", () => {
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
