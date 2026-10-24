/**
 * Stage A/C — Context-decision baseline (offline ACTION contracts).
 *
 * Documents desired ACTION shapes for critical Lucy context decisions.
 * Separates pass_existing / gap_coverage / gap_existing / desired_unclear.
 * Stage C: proofLevel labels; A1/B1 contracts executable.
 * Does NOT call OpenAI or external APIs. Does NOT prove live model selection.
 *
 *   npx vitest run tests/context-decision-baseline.offline.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkConstraint,
  type ModelEvalConstraint,
} from "../src/eval/constraints.js";
import { parseReplyMetadata, type LlmMetadata } from "@workee/shared";

type Classification =
  | "pass_existing"
  | "gap_coverage"
  | "gap_existing"
  | "desired_unclear";

type ProofLevel =
  | "parse_shape"
  | "engine_apply"
  | "model_decision_contract";

type CaseAsserts = {
  listsAction?: string;
  listsListType?: string;
  hasItemId?: boolean;
  hasAttachmentIds?: boolean;
  forbidListsAdd?: boolean;
  forbidSpeakerTasksAdd?: boolean;
  hasWorkerTaskAdd?: boolean;
  hasRemindersAdd?: boolean;
  mutationsEmpty?: boolean;
  mutationsEmptyOrUpdateOnly?: boolean;
  showDumpNullOrEmpty?: boolean;
  showDump?: string;
  showDumpIdsNonEmpty?: boolean;
  jobsEmpty?: boolean;
  routesNull?: boolean;
  routesAspectsIncludesLines?: boolean;
  routesDestinationEmpty?: boolean;
  placesIntent?: string;
  placesIncludedType?: string;
  responseLooksLikeAsk?: boolean;
};

type BaselineCase = {
  id: string;
  cluster: string;
  utterance: string;
  classification: Classification;
  proofLevel: ProofLevel;
  existingCoverage?: string[];
  desiredMetadata?: Record<string, unknown>;
  forbiddenMetadata?: Record<string, unknown>;
  desiredResponse?: string;
  asserts?: CaseAsserts;
  notes?: string;
};

type BaselineDoc = {
  version: number;
  proofLevels?: Record<string, string>;
  cases: BaselineCase[];
};

const DOC_PATH = resolve(
  import.meta.dirname,
  "../../docs/qa/context-decision-baseline.json",
);

const PROOF_LEVELS: ProofLevel[] = [
  "parse_shape",
  "engine_apply",
  "model_decision_contract",
];

function loadDoc(): BaselineDoc {
  return JSON.parse(readFileSync(DOC_PATH, "utf8")) as BaselineDoc;
}

function parseMeta(
  metadata: Record<string, unknown>,
  response = "",
): LlmMetadata {
  return parseReplyMetadata(
    JSON.stringify({
      response,
      metadata,
    }),
  );
}

function firstList(meta: LlmMetadata) {
  return meta.lists[0] ?? null;
}

function listHasItemId(meta: LlmMetadata): boolean {
  for (const row of meta.lists) {
    for (const item of row.items ?? []) {
      const id = String(
        item.item_id ?? item.itemId ?? item.id ?? "",
      ).trim();
      if (id) return true;
    }
  }
  return false;
}

function listHasAttachmentIds(meta: LlmMetadata): boolean {
  for (const row of meta.lists) {
    for (const item of row.items ?? []) {
      const ids = item.attachment_ids ?? item.attachmentIds;
      if (Array.isArray(ids) && ids.length > 0) return true;
    }
  }
  for (const row of meta.filing ?? []) {
    if ((row.attachmentIds?.length ?? 0) > 0) return true;
  }
  return false;
}

function hasListsAdd(meta: LlmMetadata, listType?: string): boolean {
  return meta.lists.some(
    (row) =>
      row.action === "add" &&
      (listType == null || row.listType === listType),
  );
}

function hasWorkerTaskAdd(meta: LlmMetadata): boolean {
  return meta.lists.some(
    (row) =>
      row.action === "add" &&
      row.listType === "tasks" &&
      (row.targets ?? []).some((t) => /לוסי|lucy/i.test(t)),
  );
}

function hasRemindersAdd(meta: LlmMetadata): boolean {
  // Unified lists[list_type=reminders] parse into metadata.reminders.
  return (meta.reminders ?? []).some(
    (row) => row.action === "add" || row.action === "create",
  );
}

function hasSpeakerTasksAdd(meta: LlmMetadata): boolean {
  return meta.lists.some(
    (row) =>
      row.action === "add" &&
      row.listType === "tasks" &&
      (row.targets?.length ?? 0) === 0,
  );
}

function assertCase(row: BaselineCase): void {
  const response = row.desiredResponse ?? "";
  if (row.forbiddenMetadata) {
    const forbidden = parseMeta(row.forbiddenMetadata, response);
    // Anti-contract: bare semantic dump shape is detectable (no ids).
    expect(forbidden.showDump, row.id).toBe("tasks");
    expect(forbidden.showDumpIds ?? [], row.id).toEqual([]);
    return;
  }

  const meta = parseMeta(row.desiredMetadata ?? {}, response);
  const a = row.asserts ?? {};

  if (a.listsAction) {
    expect(firstList(meta)?.action, row.id).toBe(a.listsAction);
  }
  if (a.listsListType) {
    expect(firstList(meta)?.listType, row.id).toBe(a.listsListType);
  }
  if (a.hasItemId) {
    expect(listHasItemId(meta), row.id).toBe(true);
  }
  if (a.hasAttachmentIds) {
    expect(listHasAttachmentIds(meta), row.id).toBe(true);
  }
  if (a.forbidListsAdd) {
    expect(hasListsAdd(meta), row.id).toBe(false);
  }
  if (a.forbidSpeakerTasksAdd) {
    expect(hasSpeakerTasksAdd(meta), row.id).toBe(false);
  }
  if (a.hasWorkerTaskAdd) {
    expect(hasWorkerTaskAdd(meta), row.id).toBe(true);
  }
  if (a.hasRemindersAdd) {
    expect(hasRemindersAdd(meta), row.id).toBe(true);
  }
  if (a.mutationsEmpty) {
    expect(meta.lists.length, row.id).toBe(0);
    expect(meta.filing?.length ?? 0, row.id).toBe(0);
    expect(meta.jobs?.length ?? 0, row.id).toBe(0);
  }
  if (a.mutationsEmptyOrUpdateOnly) {
    const badAdd = meta.lists.some((rowList) => rowList.action === "add");
    expect(badAdd, row.id).toBe(false);
  }
  if (a.showDumpNullOrEmpty) {
    expect(meta.showDump ?? "", row.id).toBe("");
  }
  if (a.showDump) {
    expect(meta.showDump, row.id).toBe(a.showDump);
  }
  if (a.showDumpIdsNonEmpty) {
    expect(meta.showDumpIds.length, row.id).toBeGreaterThan(0);
  }
  if (a.jobsEmpty) {
    expect(meta.jobs?.length ?? 0, row.id).toBe(0);
  }
  if (a.routesNull) {
    expect(meta.routes ?? null, row.id).toBeNull();
  }
  if (a.routesAspectsIncludesLines) {
    expect(meta.routes?.aspects ?? [], row.id).toContain("lines");
  }
  if (a.routesDestinationEmpty) {
    expect(meta.routes?.destination ?? "", row.id).toBe("");
  }
  if (a.placesIntent) {
    expect(meta.places?.intent, row.id).toBe(a.placesIntent);
  }
  if (a.placesIncludedType) {
    expect(meta.places?.includedType, row.id).toBe(a.placesIncludedType);
  }
  if (a.responseLooksLikeAsk) {
    const constraints: ModelEvalConstraint[] = [
      { type: "response_looks_like_ask" },
    ];
    for (const c of constraints) {
      const fail = checkConstraint(c, meta, response);
      expect(fail, `${row.id}: ${fail ?? ""}`).toBeNull();
    }
  }
}

describe("Stage A/C context-decision baseline catalog", () => {
  const doc = loadDoc();

  it("loads versioned catalog with required case fields + proofLevel", () => {
    expect(doc.version).toBe(1);
    expect(doc.proofLevels).toBeTruthy();
    expect(doc.cases.length).toBeGreaterThanOrEqual(12);
    for (const row of doc.cases) {
      expect(row.id, "id").toBeTruthy();
      expect(row.cluster, row.id).toBeTruthy();
      expect(row.utterance, row.id).toBeTruthy();
      expect(
        ["pass_existing", "gap_coverage", "gap_existing", "desired_unclear"],
        row.id,
      ).toContain(row.classification);
      expect(PROOF_LEVELS, row.id).toContain(row.proofLevel);
      if (
        row.classification === "gap_existing" ||
        row.classification === "desired_unclear"
      ) {
        expect(String(row.notes ?? "").trim().length, row.id).toBeGreaterThan(
          10,
        );
      }
    }
  });

  it("covers every Stage A cluster at least once", () => {
    const clusters = new Set(doc.cases.map((c) => c.cluster));
    for (const need of [
      "update_vs_add",
      "line_number_mutate",
      "delete_now_vs_ask",
      "attach_destination",
      "self_nudge_reuse",
      "event_host",
      "open_jobs",
      "retrieval_path2",
      "live_routing",
    ]) {
      expect(clusters.has(need), need).toBe(true);
    }
  });

  it("summarizes classifications (inventory — not a behavior lock)", () => {
    const counts: Record<Classification, number> = {
      pass_existing: 0,
      gap_coverage: 0,
      gap_existing: 0,
      desired_unclear: 0,
    };
    for (const row of doc.cases) {
      counts[row.classification] += 1;
    }
    expect(counts.gap_coverage).toBeGreaterThanOrEqual(1);
    expect(counts.pass_existing).toBeGreaterThanOrEqual(1);
  });

  it("gap_coverage proofLevel never claims live model selection", () => {
    for (const row of doc.cases.filter((c) => c.classification === "gap_coverage")) {
      // Catalog fixtures + stubs only. engine_apply on gap_coverage is OK when
      // coverage is engine-side; still not a live MODEL run.
      expect(PROOF_LEVELS).toContain(row.proofLevel);
      if (row.proofLevel === "parse_shape") {
        expect(
          row.desiredMetadata != null || row.forbiddenMetadata != null,
          row.id,
        ).toBe(true);
      }
    }
  });

  it("A1 clear-all and B1 multi-host cases are present after Stage C", () => {
    const ids = new Set(doc.cases.map((c) => c.id));
    expect(ids.has("DEL-CLEAR-ALL-UNIQUE-SHELL")).toBe(true);
    expect(ids.has("DEL-CLEAR-MULTI-SHELL-ASK")).toBe(true);
    expect(ids.has("DEL-CLEAR-TASKS-UNIQUE-SHELL")).toBe(true);
    expect(ids.has("DEL-CLEAR-TASKS-MULTI-SHELL-ASK")).toBe(true);
    expect(ids.has("EVENT-HOST-DATE-COLLISION")).toBe(true);
    expect(ids.has("EVENT-HOST-UNIQUE-DATE-CONTINUE")).toBe(true);
    const clear = doc.cases.find((c) => c.id === "DEL-CLEAR-ALL-UNIQUE-SHELL")!;
    expect(clear.classification).toBe("pass_existing");
    expect(clear.classification).not.toBe("gap_existing");
    const tasksClear = doc.cases.find(
      (c) => c.id === "DEL-CLEAR-TASKS-UNIQUE-SHELL",
    )!;
    expect(tasksClear.classification).toBe("pass_existing");
    const event = doc.cases.find((c) => c.id === "EVENT-HOST-DATE-COLLISION")!;
    expect(event.classification).toBe("gap_coverage");
    expect(event.classification).not.toBe("desired_unclear");
  });
});

describe("Stage A/C desired ACTION contracts (parse only — not model selection)", () => {
  const doc = loadDoc();
  const executable = doc.cases.filter(
    (row) =>
      (row.classification === "pass_existing" ||
        row.classification === "gap_coverage") &&
      (row.desiredMetadata != null || row.forbiddenMetadata != null),
  );

  it("has executable contracts for pass_existing and gap_coverage", () => {
    expect(executable.length).toBeGreaterThanOrEqual(10);
  });

  for (const row of executable) {
    it(`${row.proofLevel}/${row.classification}: ${row.id} — ${row.cluster}`, () => {
      assertCase(row);
    });
  }
});

describe("Stage A/C documented gaps (no silent expectation churn)", () => {
  const doc = loadDoc();
  const gaps = doc.cases.filter(
    (row) =>
      row.classification === "gap_existing" ||
      row.classification === "desired_unclear",
  );

  it("A1/B1 Stage C resolutions are not left as unresolved catalog gaps", () => {
    const gapIds = gaps.map((g) => g.id);
    expect(gapIds).not.toContain("DEL-CLEAR-ALL-UNIQUE-SHELL");
    expect(gapIds).not.toContain("EVENT-HOST-DATE-COLLISION");
  });

  it("any remaining gap_existing / desired_unclear rows have notes only (not asserted PASS)", () => {
    for (const row of gaps) {
      expect(row.desiredMetadata, row.id).toBeUndefined();
      expect(String(row.notes).length).toBeGreaterThan(10);
    }
  });
});
