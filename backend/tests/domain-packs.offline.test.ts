/**
 * Domain packs (≥20 contracts each) — loader + MODEL offline stub wire.
 * MODEL_APPLY DB harness covered per-pack where wired (Reminder Pack first).
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DOMAIN_PACK_FILES,
  defaultDomainPackPath,
  loadDomainPackSuite,
} from "../src/eval/corpus.js";
import { offlineStubForConstraints } from "../src/eval/offline-stub.js";
import {
  buildBatchAFingerprint,
  runBatchAModelCaseOffline,
  summarizeBatchAModelOffline,
} from "../src/eval/run-batch-a.js";

describe("Domain packs loader + MODEL wire (offline)", () => {
  it.each([...DOMAIN_PACK_FILES])(
    "$pack loads thin with ≥20 contracts",
    ({ file, domain, pack }) => {
      const path = defaultDomainPackPath(file);
      expect(existsSync(path), path).toBe(true);
      const suite = loadDomainPackSuite(path, {
        expectedDomain: domain,
        expectedPack: pack,
      });
      expect(suite.evalPath).toBe("thin");
      expect(suite.productionParity).toBe(false);
      const contracts = new Set(
        suite.cases.map((row) => row.contract?.trim() || row.id),
      );
      expect(contracts.size).toBeGreaterThanOrEqual(20);
      expect(suite.cases.every((c) => c.heldOut !== true)).toBe(true);
      expect(suite.cases.every((c) => c.track === "MODEL" || c.track === "MODEL_APPLY")).toBe(
        true,
      );
    },
  );

  it.each([...DOMAIN_PACK_FILES])(
    "$pack every MODEL case passes offline stub constraints",
    ({ file, domain, pack }) => {
      const path = defaultDomainPackPath(file);
      const suite = loadDomainPackSuite(path, {
        expectedDomain: domain,
        expectedPack: pack,
      });
      const model = suite.cases.filter((c) => c.track === "MODEL");
      expect(model.length).toBeGreaterThan(0);

      const results = model.map((row) => {
        const constraints = row.turns[0]?.constraints ?? [];
        const stub = offlineStubForConstraints(constraints);
        return runBatchAModelCaseOffline(row, stub);
      });

      const failed = results.filter((r) => !r.ok);
      expect(
        failed.map((r) => `${r.id}: ${r.failures.join("; ")}`),
      ).toEqual([]);

      const fp = buildBatchAFingerprint({ suitePath: path });
      const summary = summarizeBatchAModelOffline(results, fp);
      expect(summary.ok).toBe(true);
      expect(summary.evalPath).toBe("thin");
      expect(summary.productionParity).toBe(false);
    },
  );
});
