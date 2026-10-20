import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

function tagsFor(id) {
  const tags = new Set();
  if (id.startsWith("mt-")) tags.add("multi-turn");
  else tags.add("single-turn");

  if (id.startsWith("filing") || id.startsWith("mt-filing")) tags.add("filing");
  else if (id.startsWith("directory") || id.startsWith("mt-directory"))
    tags.add("directory");
  else if (
    id.startsWith("reminder") ||
    id.startsWith("self-nudge") ||
    id === "no-invented-clock" ||
    id.startsWith("mt-reminder") ||
    id.startsWith("mt-cancel-reminder") ||
    id.startsWith("mt-stop-nudge")
  )
    tags.add("reminders");
  else if (
    id.startsWith("task") ||
    id === "meeting-not-list" ||
    id === "occurrence-skip-one-day" ||
    id === "list-clear-tasks" ||
    id === "list-filtered-multi-delete" ||
    id.startsWith("mt-task")
  )
    tags.add("tasks");
  else if (
    id.startsWith("shop") ||
    id.startsWith("list-buy") ||
    id.startsWith("list-clear-personal") ||
    id === "shared-list-found-no-not-found" ||
    id.startsWith("shopping") ||
    id.startsWith("mt-clarify") ||
    id.startsWith("mt-ask-then") ||
    id.startsWith("mt-show-then")
  )
    tags.add("shopping");
  else if (
    id.startsWith("delete") ||
    id.startsWith("list-named") ||
    id.startsWith("list-not-filing") ||
    id.startsWith("mt-ambiguous")
  )
    tags.add("lists-safety");
  else if (id.startsWith("dump") || id === "dump-what-saved") tags.add("show");
  else tags.add("misc");

  return [...tags].sort();
}

function tagFile(rel) {
  const path = join(root, rel);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  for (const c of raw.cases) {
    c.tags = tagsFor(c.id);
  }
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  const by = {};
  for (const c of raw.cases) {
    for (const t of c.tags) by[t] = (by[t] || 0) + 1;
  }
  console.log(rel, "cases=", raw.cases.length, by);
}

tagFile("docs/qa/phase-4-corpus.json");
tagFile("docs/qa/phase-4-multi-turn-corpus.json");
