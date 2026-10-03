import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EmployeeRecordSnapshot } from "../services/employee-records.service.js";
import type { ReminderSnapshotRow } from "../services/reminder.service.js";
import type { ModelEvalConstraint, ModelEvalTag } from "./constraints.js";

export interface ModelEvalCorpusCase {
  id: string;
  tag: ModelEvalTag;
  utterance: string;
  setup: {
    lists?: EmployeeRecordSnapshot["lists"];
    filing?: EmployeeRecordSnapshot["filing"];
    reminders?: ReminderSnapshotRow[];
    contacts?: Array<{ name: string; phone: string }>;
  };
  constraints: ModelEvalConstraint[];
}

export interface ModelEvalCorpus {
  version: number;
  passRate: number;
  speaker: string;
  cases: ModelEvalCorpusCase[];
}

export function defaultCorpusPath(repoRoot = resolve(import.meta.dirname, "../../..")): string {
  return resolve(repoRoot, "docs/qa/phase-4-corpus.json");
}

export function loadModelEvalCorpus(path = defaultCorpusPath()): ModelEvalCorpus {
  const raw = JSON.parse(readFileSync(path, "utf8")) as ModelEvalCorpus;
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`Model eval corpus has no cases: ${path}`);
  }
  return raw;
}

export function snapshotFromSetup(
  setup: ModelEvalCorpusCase["setup"],
  speaker: string,
): EmployeeRecordSnapshot {
  return {
    lists: setup.lists ?? [],
    filing: setup.filing ?? [],
    reminders: (setup.reminders ?? []).map((row) => ({
      ...row,
      owner: row.owner || speaker,
    })),
  };
}
