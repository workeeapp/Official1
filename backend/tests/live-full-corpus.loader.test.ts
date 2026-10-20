import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defaultLiveFullCorpusPath,
  filterCasesByTags,
  loadLiveFullCorpus,
} from "../src/eval/corpus.js";

describe("live-full corpus loader", () => {
  it("loads tagged cases with turns and critical ids", () => {
    const path = defaultLiveFullCorpusPath();
    expect(existsSync(path), path).toBe(true);
    const corpus = loadLiveFullCorpus(path);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(3);
    expect(corpus.cases.every((c) => (c.tags ?? []).includes("full-live"))).toBe(
      true,
    );
    for (const id of corpus.criticalCaseIds ?? []) {
      expect(corpus.cases.some((c) => c.id === id), id).toBe(true);
    }
    const shop = filterCasesByTags(corpus.cases, ["shopping"]);
    expect(shop.length).toBeGreaterThan(0);
  });
});
