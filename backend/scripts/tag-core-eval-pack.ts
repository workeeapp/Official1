#!/usr/bin/env npx tsx
/**
 * Idempotently add core-pack / freeze-pack tags to existing LIVE corpus cases.
 * Does not invent product behavior — retags coverage already in corpora.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

type CaseRow = { id: string; tags?: string[] };

const FREEZE_IDS = new Set([
  "event-maybe-no-host",
  "event-help-organize-host",
  "mt-event-clarify-then-link",
  "mt-event-second-poker-dated",
]);

/** Existing cases that map to the ~35 core scenarios (plus freeze). */
const CORE_IDS = new Set([
  ...FREEZE_IDS,
  "shopping-add-milk",
  "list-buy-milk",
  "shopping-add-yogurt",
  "list-buy-eggs",
  "shopping-empty-ask",
  "task-empty-ask",
  "task-done-doctor",
  "task-add-timed-no-auto-clock",
  "share-assign-task-amit",
  "share-shop-with-amit",
  "share-ask-missing-partner",
  "reminder-create-relative",
  "reminder-create-explicit",
  "reminder-create-no-time",
  "reminder-cancel-named",
  "reminder-stop-nudge-keep-item",
  "reminder-recur-weekday",
  "no-invented-clock",
  "dump-what-saved",
  "event-host-create-poker",
  "mt-multi-add-then-buy",
  "mt-show-then-bought",
  "mt-reminder-ask-then-time",
  "mt-clarify-task-which",
  "mt-multi-task-add-then-done",
  "mt-share-ask-then-partner",
  "mt-cancel-reminder-resolve",
  "mt-clarify-then-delete",
  "mt-ask-then-add",
  "full-shopping-add-milk",
  "full-list-buy-milk",
  "full-reminder-create-relative",
  "full-reminder-create-explicit",
  "full-reminder-cancel-named",
  "full-share-shop-with-amit",
  "full-event-host-create-poker",
  "full-mt-event-clarify-then-link",
  "full-mt-clarify-task-which",
  "full-mt-multi-add-then-buy",
  "full-mt-share-ask-then-partner",
  "full-task-done-doctor",
  "full-dump-what-saved",
]);

const PATHS = [
  "docs/qa/phase-4-corpus.json",
  "docs/qa/phase-4-multi-turn-corpus.json",
  "docs/qa/live-full-corpus.json",
];

function addTags(row: CaseRow): boolean {
  const want = new Set<string>(row.tags ?? []);
  let changed = false;
  if (CORE_IDS.has(row.id) && !want.has("core-pack")) {
    want.add("core-pack");
    changed = true;
  }
  if (FREEZE_IDS.has(row.id) && !want.has("freeze-pack")) {
    want.add("freeze-pack");
    changed = true;
  }
  if (changed) {
    row.tags = [...want];
  }
  return changed;
}

function main(): void {
  let total = 0;
  for (const rel of PATHS) {
    const path = resolve(repoRoot, rel);
    const corpus = JSON.parse(readFileSync(path, "utf8")) as {
      cases: CaseRow[];
    };
    let n = 0;
    for (const row of corpus.cases) {
      if (addTags(row)) n += 1;
    }
    if (n > 0) {
      writeFileSync(path, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
    }
    console.error(`${rel}: retagged ${n} case(s)`);
    total += n;
  }
  console.error(`Done. Retagged ${total} case(s) total.`);
}

main();
