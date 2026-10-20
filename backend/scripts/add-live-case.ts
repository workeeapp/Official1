#!/usr/bin/env npx tsx
/**
 * Append (or print) a LIVE eval case from product intents / templates.
 *
 * Prefer drafts (no ACTION schema):
 *   npx tsx backend/scripts/add-live-case.ts --draft path.json [--write]
 *
 * Legacy templates still work (compiled via draftFromTemplate):
 *   npx tsx backend/scripts/add-live-case.ts --track model --template ask --id my-ask --write
 *
 * Bulk: JSON/JSONL of drafts, template specs, or ready cases.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIVE_AUTHOR_CORPUS_RELATIVE,
  compileLiveAuthorDraft,
  draftFromTemplate,
  type LiveAuthorDraft,
  type LiveAuthorTrack,
} from "../src/eval/live-author-compile.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const CORPUS: Record<LiveAuthorTrack, string> = {
  model: resolve(repoRoot, LIVE_AUTHOR_CORPUS_RELATIVE.model),
  mt: resolve(repoRoot, LIVE_AUTHOR_CORPUS_RELATIVE.mt),
  full: resolve(repoRoot, LIVE_AUTHOR_CORPUS_RELATIVE.full),
};

type CliOpts = {
  track: LiveAuthorTrack;
  template: string;
  id: string;
  utterance: string;
  utterance2: string;
  itemId: string;
  itemLabel: string;
  tags: string[];
  write: boolean;
  bulk: string;
  draft: string;
  help?: boolean;
};

function parseArgs(argv: string[]): CliOpts {
  const out: CliOpts = {
    track: "model",
    template: "ask",
    id: "",
    utterance: "",
    utterance2: "",
    itemId: "eval-item-milk",
    itemLabel: "חלב",
    tags: [],
    write: false,
    bulk: "",
    draft: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i]!;
    if (a === "--track") out.track = next() as LiveAuthorTrack;
    else if (a === "--template") out.template = next();
    else if (a === "--id") out.id = next();
    else if (a === "--utterance") out.utterance = next();
    else if (a === "--utterance2") out.utterance2 = next();
    else if (a === "--item-id") out.itemId = next();
    else if (a === "--item-label") out.itemLabel = next();
    else if (a === "--tags") {
      out.tags = String(next())
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--bulk") out.bulk = next();
    else if (a === "--draft") out.draft = next();
    else if (a === "--write") out.write = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function appendCase(
  track: LiveAuthorTrack,
  caseRow: unknown,
  write: boolean,
): void {
  const text = JSON.stringify(caseRow, null, 2);
  if (!write) {
    console.log(text);
    console.error(`\n(dry-run) To append: add --write  → ${CORPUS[track]}`);
    return;
  }
  const path = CORPUS[track];
  const corpus = JSON.parse(readFileSync(path, "utf8")) as {
    cases: Array<{ id: string }>;
  };
  if (!Array.isArray(corpus.cases)) {
    throw new Error(`Corpus has no cases[]: ${path}`);
  }
  const id = (caseRow as { id: string }).id;
  if (corpus.cases.some((c) => c.id === id)) {
    throw new Error(`Case id already exists: ${id} in ${path}`);
  }
  corpus.cases.push(caseRow as { id: string });
  writeFileSync(path, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
  console.error(`Appended ${id} → ${path} (cases=${corpus.cases.length})`);
}

function loadBulkRows(bulkPath: string): unknown[] {
  const abs = resolve(bulkPath);
  const raw = readFileSync(abs, "utf8").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) throw new Error("bulk JSON must be an array");
    return arr;
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`bulk JSONL line ${i + 1}: invalid JSON`);
      }
    });
}

function isAuthorDraft(row: Record<string, unknown>): boolean {
  return (
    Array.isArray(row.turns) &&
    row.turns.length > 0 &&
    typeof (row.turns[0] as { intent?: unknown })?.intent === "object"
  );
}

function resolveRow(row: unknown): {
  track: LiveAuthorTrack;
  caseRow: unknown;
} {
  if (!row || typeof row !== "object") {
    throw new Error("bulk/draft row must be an object");
  }
  const rec = row as Record<string, unknown>;
  const track = (rec.track as LiveAuthorTrack | undefined) ?? "model";

  // Intent draft (product language).
  if (isAuthorDraft(rec) && typeof rec.id === "string") {
    const compiled = compileLiveAuthorDraft(rec as unknown as LiveAuthorDraft);
    return { track: compiled.track, caseRow: compiled.case };
  }

  // Ready corpus case (already has constraints, no template).
  if (
    !rec.template &&
    typeof rec.id === "string" &&
    (typeof rec.utterance === "string" || Array.isArray(rec.turns)) &&
    !isAuthorDraft(rec)
  ) {
    const { track: _t, ...caseRow } = rec;
    return { track, caseRow };
  }

  if (!rec.template || typeof rec.id !== "string") {
    throw new Error(
      "row needs intent draft {id,track,turns[].intent}, template spec, or ready case",
    );
  }

  const draft = draftFromTemplate({
    track,
    template: String(rec.template),
    id: rec.id,
    utterance: typeof rec.utterance === "string" ? rec.utterance : "",
    utterance2: typeof rec.utterance2 === "string" ? rec.utterance2 : "",
    itemId:
      typeof rec.itemId === "string"
        ? rec.itemId
        : typeof rec.item_id === "string"
          ? rec.item_id
          : undefined,
    itemLabel:
      typeof rec.itemLabel === "string"
        ? rec.itemLabel
        : typeof rec.item_label === "string"
          ? rec.item_label
          : undefined,
    tags: Array.isArray(rec.tags)
      ? (rec.tags as string[])
      : typeof rec.tags === "string"
        ? rec.tags.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
  });
  const compiled = compileLiveAuthorDraft(draft);
  return { track: compiled.track, caseRow: compiled.case };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`add-live-case.ts

  Intent draft (preferred — no ACTION schema):
    --draft path.json         { id, track, turns: [{ utterance, intent }] }
    --write

  Legacy templates (compiled to intents):
    --track model|mt|full
    --template ask|remove-id|add-shopping|reminder-add|clarify-act
    --id CASE_ID
    --utterance / --utterance2 / --item-id / --item-label / --tags

  Bulk:
    --bulk path.json|.jsonl   drafts, template specs, or ready cases

See docs/qa/live-authoring.md`);
    return;
  }

  if (opts.draft) {
    const raw = JSON.parse(readFileSync(resolve(opts.draft), "utf8")) as unknown;
    const rows = Array.isArray(raw) ? raw : [raw];
    for (const row of rows) {
      const { track, caseRow } = resolveRow(row);
      appendCase(track, caseRow, opts.write);
    }
    console.error(
      `Draft done: ${rows.length} case(s)${opts.write ? " written" : " (dry-run)"}`,
    );
    return;
  }

  if (opts.bulk) {
    const rows = loadBulkRows(opts.bulk);
    for (const row of rows) {
      const { track, caseRow } = resolveRow(row);
      appendCase(track, caseRow, opts.write);
    }
    console.error(
      `Bulk done: ${rows.length} case(s)${opts.write ? " written" : " (dry-run)"}`,
    );
    return;
  }

  if (!["model", "mt", "full"].includes(opts.track)) {
    throw new Error(`--track must be model|mt|full (got ${opts.track})`);
  }
  if (!opts.id) throw new Error("--id is required (or use --draft / --bulk)");

  const draft = draftFromTemplate({
    track: opts.track,
    template: opts.template,
    id: opts.id,
    utterance: opts.utterance,
    utterance2: opts.utterance2,
    itemId: opts.itemId,
    itemLabel: opts.itemLabel,
    tags: opts.tags,
  });
  const compiled = compileLiveAuthorDraft(draft);
  appendCase(compiled.track, compiled.case, opts.write);
}

try {
  main();
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(1);
}
