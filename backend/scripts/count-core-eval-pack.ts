#!/usr/bin/env npx tsx
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  filterCasesByTags,
  loadLiveFullCorpus,
  loadModelEvalCorpus,
  loadModelEvalMultiTurnCorpus,
} from "../src/eval/corpus.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const model = filterCasesByTags(loadModelEvalCorpus().cases, ["core-pack"]);
const mt = filterCasesByTags(loadModelEvalMultiTurnCorpus().cases, ["core-pack"]);
const full = filterCasesByTags(loadLiveFullCorpus().cases, ["core-pack"]);
const freeze = [
  ...filterCasesByTags(loadModelEvalCorpus().cases, ["freeze-pack"]),
  ...filterCasesByTags(loadModelEvalMultiTurnCorpus().cases, ["freeze-pack"]),
];
const report = {
  totals: {
    model: model.length,
    mt: mt.length,
    full: full.length,
    freeze: freeze.length,
    distinctCore: new Set([...model, ...mt, ...full].map((c) => c.id)).size,
  },
  model: model.map((c) => c.id),
  mt: mt.map((c) => c.id),
  full: full.map((c) => c.id),
  freeze: freeze.map((c) => c.id),
};
writeFileSync(
  resolve(repoRoot, "docs/qa/core-eval-pack-counts.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stderr.write(`${JSON.stringify(report.totals)}\n`);
