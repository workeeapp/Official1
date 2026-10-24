#!/usr/bin/env npx tsx
/**
 * Idempotently add decision-core tags to a compact LIVE subset.
 * Reuses existing cases only — does not invent product behavior.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

type CaseRow = { id: string; tags?: string[] };

/** Compact decision-core gate (actual-model tracks only). */
const DECISION_CORE_IDS = new Set([
  // Intent classification
  "core-intent-maybe-roi",
  "core-intent-maybe-mom",
  "core-intent-need-doctor",
  "core-intent-explicit-call-doctor",
  "event-maybe-no-host",
  "freeze-f7-need-milk-no-reminder",
  "freeze-f8-finish-presentation-offer",
  // Explicit act / display / clarify
  "list-buy-milk",
  "dump-what-saved",
  "delete-everything",
  "reminder-create-no-time",
  "no-invented-clock",
  "task-add-timed-no-auto-clock",
  // Create vs update / dup
  "core-dup-signal-existing-milk",
  // Multi-turn continuity / clarify / multi-act / reminders
  "mt-clarify-then-delete",
  "mt-reminder-ask-then-time",
  "mt-show-then-bought",
  "mt-clarify-task-which",
  "mt-multi-add-then-buy",
  "core-reminder-offer-decline-mt",
  "core-shopping-crud-mt",
  // Attachment-intent (fixture context + real model)
  "att-no-intent",
  "att-deferred-after-lucy",
  "att-item-default",
  "att-rishon",
  "att-ambiguous",
  // P1 gap cases
  "dm-update-existing-task",
  "dm-multi-shop-and-filing",
  "dm-intervening-reminder-draft",
  "dm-soft-offer-accept-mt",
]);

const PATHS = [
  "docs/qa/phase-4-corpus.json",
  "docs/qa/phase-4-multi-turn-corpus.json",
  "docs/qa/attachment-intent-corpus.json",
];

function addTag(row: CaseRow): boolean {
  if (!DECISION_CORE_IDS.has(row.id)) {
    return false;
  }
  const want = new Set<string>(row.tags ?? []);
  if (want.has("decision-core")) {
    return false;
  }
  want.add("decision-core");
  row.tags = [...want];
  return true;
}

function main(): void {
  let total = 0;
  const found = new Set<string>();
  for (const rel of PATHS) {
    const path = resolve(repoRoot, rel);
    const corpus = JSON.parse(readFileSync(path, "utf8")) as {
      cases: CaseRow[];
    };
    let n = 0;
    for (const row of corpus.cases) {
      if (DECISION_CORE_IDS.has(row.id)) {
        found.add(row.id);
      }
      if (addTag(row)) {
        n += 1;
      }
    }
    writeFileSync(path, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
    console.error(`${rel}: retagged ${n} case(s)`);
    total += n;
  }
  const missing = [...DECISION_CORE_IDS].filter((id) => !found.has(id));
  if (missing.length > 0) {
    console.error(`WARNING missing ids: ${missing.join(", ")}`);
    process.exitCode = 1;
  }
  console.error(
    `Done. Retagged ${total}. decision-core size=${found.size}/${DECISION_CORE_IDS.size}`,
  );
}

main();
