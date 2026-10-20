import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
const p4 = JSON.parse(
  readFileSync(join(root, "docs/qa/phase-4-corpus.json"), "utf8"),
);
const mt = JSON.parse(
  readFileSync(join(root, "docs/qa/phase-4-multi-turn-corpus.json"), "utf8"),
);

function domainOf(id) {
  if (id.startsWith("filing") || id.startsWith("mt-filing")) return "filing";
  if (id.startsWith("directory") || id.startsWith("mt-directory"))
    return "directory";
  if (
    id.startsWith("reminder") ||
    id.startsWith("self-nudge") ||
    id === "no-invented-clock" ||
    id.startsWith("mt-reminder") ||
    id.startsWith("mt-cancel-reminder") ||
    id.startsWith("mt-stop-nudge")
  )
    return "reminders";
  if (
    id.startsWith("task") ||
    id === "meeting-not-list" ||
    id === "occurrence-skip-one-day" ||
    id === "list-clear-tasks" ||
    id === "list-filtered-multi-delete" ||
    id.startsWith("mt-task")
  )
    return "tasks";
  if (
    id.startsWith("shop") ||
    id.startsWith("list-buy") ||
    id.startsWith("list-clear-personal") ||
    id === "shared-list-found-no-not-found" ||
    id.startsWith("shopping") ||
    id.startsWith("mt-clarify") ||
    id.startsWith("mt-ask-then") ||
    id.startsWith("mt-show-then")
  )
    return "shopping";
  if (
    id.startsWith("delete") ||
    id.startsWith("list-named") ||
    id.startsWith("list-not-filing") ||
    id.startsWith("mt-ambiguous")
  )
    return "lists-safety";
  if (id.startsWith("dump") || id === "dump-what-saved") return "show";
  return "misc";
}

const packs = {};
for (const c of p4.cases) {
  const d = domainOf(c.id);
  if (!packs[d]) packs[d] = { single: [], multi: [] };
  packs[d].single.push(c);
}
for (const c of mt.cases) {
  const d = domainOf(c.id);
  if (!packs[d]) packs[d] = { single: [], multi: [] };
  packs[d].multi.push(c);
}

const critSingle = new Set(p4.criticalCaseIds ?? []);
const critMt = new Set(mt.criticalCaseIds ?? []);
const outDir = join(root, "docs/qa/live-model");
const fullDir = join(root, "docs/qa/live-full");
mkdirSync(outDir, { recursive: true });
mkdirSync(fullDir, { recursive: true });

const catalog = {
  version: 1,
  kind: "live-model",
  speaker: "טל",
  passRate: 0.7,
  packs: [],
};

for (const domain of Object.keys(packs).sort()) {
  const bucket = packs[domain];
  const cases = [];
  for (const c of bucket.single) {
    cases.push({
      id: c.id,
      tag: c.tag,
      ...(c.description ? { description: c.description } : {}),
      setup: c.setup || {},
      turns: [{ utterance: c.utterance, constraints: c.constraints }],
    });
  }
  for (const c of bucket.multi) {
    cases.push({
      id: c.id,
      tag: c.tag,
      ...(c.description ? { description: c.description } : {}),
      setup: c.setup || {},
      turns: c.turns,
    });
  }
  const criticalCaseIds = cases
    .map((c) => c.id)
    .filter((id) => critSingle.has(id) || critMt.has(id));
  const packId = `live-model-${domain}-v1`;
  const file = `${domain}-pack.json`;
  const suite = {
    version: 1,
    kind: "live-model",
    domain,
    pack: packId,
    speaker: "טל",
    passRate: 0.7,
    productionApply: false,
    evalPath: "model-output-constraints-only",
    criticalCaseIds,
    cases,
  };
  writeFileSync(join(outDir, file), `${JSON.stringify(suite, null, 2)}\n`);
  catalog.packs.push({
    domain,
    file,
    pack: packId,
    caseCount: cases.length,
    criticalCaseIds,
  });

  const fullSuite = {
    version: 1,
    kind: "live-full",
    domain,
    pack: `live-full-${domain}-v1`,
    speaker: "טל",
    passRate: 0.7,
    productionApply: true,
    evalPath: "model-then-production-apply",
    status: "scaffold",
    criticalCaseIds: [],
    cases: cases.map((c) => ({
      id: c.id,
      tag: c.tag,
      ...(c.description ? { description: c.description } : {}),
      setup: c.setup,
      turns: c.turns.map((t) => ({
        utterance: t.utterance,
        constraints: t.constraints,
        stateAfter: null,
      })),
      enabled: false,
    })),
  };
  writeFileSync(join(fullDir, file), `${JSON.stringify(fullSuite, null, 2)}\n`);
}

catalog.criticalCaseIds = [
  ...new Set(catalog.packs.flatMap((p) => p.criticalCaseIds)),
];
writeFileSync(join(outDir, "index.json"), `${JSON.stringify(catalog, null, 2)}\n`);
writeFileSync(
  join(fullDir, "index.json"),
  `${JSON.stringify(
    {
      version: 1,
      kind: "live-full",
      status: "scaffold",
      note: "Same pack domains as live-model. Cases mirrored with enabled:false until full LIVE runner ships.",
      speaker: "טל",
      passRate: 0.7,
      packs: catalog.packs.map((p) => ({
        domain: p.domain,
        file: p.file,
        pack: `live-full-${p.domain}-v1`,
        caseCount: p.caseCount,
      })),
    },
    null,
    2,
  )}\n`,
);

console.log(
  catalog.packs.map((p) => ({
    domain: p.domain,
    n: p.caseCount,
    crit: p.criticalCaseIds.length,
  })),
);
console.log(
  "total",
  catalog.packs.reduce((s, p) => s + p.caseCount, 0),
);
