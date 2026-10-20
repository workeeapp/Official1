/**
 * Batch A Step 2 — MODEL_APPLY offline (stubbed model, real production apply).
 * Must never call OpenAI. Requires DATABASE_URL === WORKEE_APPROVED_TEST_DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadBatchASuite } from "../src/eval/corpus.js";
import { UnapprovedEvalDatabaseError } from "../src/eval/studio-db-guard.js";
import {
  emptyModelMetadata,
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyProposeInput,
} from "../src/eval/run-model-apply.js";
import * as employeeRecords from "../src/services/employee-records.service.js";
import * as listOps from "../src/services/list-ops.service.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BATCH_A_SUITE_MT_IDS = [
  "MT1-clarify-then-delete",
  "MT2-ask-then-add",
  "MT3-stop-nudge-keep-item",
] as const;

function firstLiveItemId(
  snapshot: {
    lists: Array<{ items: Array<Record<string, unknown>> }>;
  },
): string {
  for (const list of snapshot.lists) {
    for (const item of list.items) {
      for (const key of ["item_id", "itemId", "id"]) {
        const raw = item[key];
        if (typeof raw === "string" && raw.trim()) {
          return raw.trim();
        }
      }
    }
  }
  throw new Error("expected a live item id after seed");
}

function itemIdByLabel(
  snapshot: {
    lists: Array<{ list_type?: string; items: Array<Record<string, unknown>> }>;
  },
  needle: string,
  listType = "shopping",
): string {
  for (const list of snapshot.lists) {
    if (list.list_type !== listType) continue;
    for (const item of list.items) {
      if (!JSON.stringify(item).includes(needle)) continue;
      for (const key of ["item_id", "itemId", "id"]) {
        const raw = item[key];
        if (typeof raw === "string" && raw.trim()) return raw.trim();
      }
    }
  }
  throw new Error(`expected ${listType} item containing ${needle}`);
}

function reminderIdByItem(
  snapshot: {
    reminders?: Array<{ reminder_id?: string; item?: string; text?: string }>;
  },
  needle: string,
): string {
  for (const row of snapshot.reminders ?? []) {
    const label = `${row.item ?? ""} ${row.text ?? ""}`;
    if (label.includes(needle) && row.reminder_id?.trim()) {
      return row.reminder_id.trim();
    }
  }
  throw new Error(`expected reminder containing ${needle}`);
}

function loadSuiteModelApplyCase(caseId: string): ModelApplyCase {
  const suite = loadBatchASuite();
  const row = suite.cases.find((c) => c.id === caseId);
  if (!row) {
    throw new Error(`Batch A suite missing case ${caseId}`);
  }
  if (row.track !== "MODEL_APPLY") {
    throw new Error(
      `Batch A case ${caseId} track is ${row.track}, expected MODEL_APPLY`,
    );
  }
  return row as ModelApplyCase;
}

/** Stub proposeTurn for the three committed Batch A MODEL_APPLY cases (not synthetic). */
function proposeBatchASuiteMt(
  caseId: (typeof BATCH_A_SUITE_MT_IDS)[number],
  input: ModelApplyProposeInput,
): { metadata: unknown; response: string } {
  switch (caseId) {
    case "MT1-clarify-then-delete": {
      if (input.turnIndex === 0) {
        return {
          metadata: emptyModelMetadata(),
          response: "איזה פריט — חלב או לחם?",
        };
      }
      const milkId = itemIdByLabel(input.snapshot, "חלב");
      expect(milkId).toMatch(UUID_RE);
      expect(input.facts).toContain("חלב");
      expect(input.facts).toContain("לחם");
      expect(input.priorMetadata).toHaveLength(1);
      return {
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "shopping",
              list_name: "",
              items: [{ item_id: milkId }],
              targets: [],
            },
          ],
          list_ops: [],
          filing: [],
          reminders: [],
        },
        response: "הסרתי את החלב",
      };
    }
    case "MT2-ask-then-add": {
      if (input.turnIndex === 0) {
        return {
          metadata: emptyModelMetadata(),
          response: "מה להוסיף?",
        };
      }
      expect(input.facts).not.toContain("לחם");
      expect(input.priorMetadata).toHaveLength(1);
      return {
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              list_name: "",
              items: [{ "שם פריט": "לחם" }],
              targets: [],
            },
          ],
          list_ops: [],
          filing: [],
          reminders: [],
        },
        response: "הוספתי לחם",
      };
    }
    case "MT3-stop-nudge-keep-item": {
      const reminderId = reminderIdByItem(input.snapshot, "חלב");
      expect(reminderId).toMatch(UUID_RE);
      expect(input.facts).toContain("חלב");
      return {
        metadata: {
          lists: [],
          list_ops: [],
          filing: [],
          reminders: [{ action: "remove", reminder_id: reminderId, item: "" }],
        },
        response: "הפסקתי",
      };
    }
    default: {
      const _exhaustive: never = caseId;
      throw new Error(`no suite stub for ${String(_exhaustive)}`);
    }
  }
}

describe("Batch A MODEL_APPLY DB guard (offline)", () => {
  const prevApproved = process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
  const prevDb = process.env.DATABASE_URL;

  afterEach(() => {
    if (prevApproved === undefined) {
      delete process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
    } else {
      process.env.WORKEE_APPROVED_TEST_DATABASE_URL = prevApproved;
    }
    if (prevDb === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = prevDb;
    }
  });

  it("fails closed when WORKEE_APPROVED_TEST_DATABASE_URL is missing", async () => {
    delete process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ||
      "postgresql://workee:workee@localhost:5432/workee_test";

    const suiteCase: ModelApplyCase = {
      id: "guard-missing-approved",
      track: "MODEL_APPLY",
      turns: [{ utterance: "x" }],
    };
    const result = await runModelApplyCase(suiteCase, () => ({
      metadata: emptyModelMetadata(),
    }));
    expect(result.ok).toBe(false);
    expect(result.failures.some((row) => row.includes("APPROVED"))).toBe(true);
    expect(result.failures.join("\n")).not.toMatch(/postgresql:\/\//i);
  });

  it("fails closed when DATABASE_URL does not match approved URL", async () => {
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL =
      "postgresql://approved-only/workee_test";
    process.env.DATABASE_URL = "postgresql://other/workee_test";

    const suiteCase: ModelApplyCase = {
      id: "guard-mismatch",
      track: "MODEL_APPLY",
      turns: [{ utterance: "x" }],
    };
    const result = await runModelApplyCase(suiteCase, () => ({
      metadata: emptyModelMetadata(),
    }));
    expect(result.ok).toBe(false);
    expect(result.failures.some((row) => row.includes("exactly match"))).toBe(
      true,
    );
    expect(result.failures.join("\n")).not.toMatch(
      /approved-only|postgresql:\/\/other/i,
    );
  });

  it("rejects fixtureMetadata on MODEL_APPLY (model ACTION only)", async () => {
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://x/y";
    const suiteCase = {
      id: "forbid-fixture",
      track: "MODEL_APPLY" as const,
      turns: [
        {
          utterance: "מחק",
          fixtureMetadata: { lists: [{ action: "remove" }] },
        },
      ],
    };
    const result = await runModelApplyCase(suiteCase, () => ({
      metadata: emptyModelMetadata(),
    }));
    expect(result.ok).toBe(false);
    expect(result.failures.some((row) => row.includes("fixtureMetadata"))).toBe(
      true,
    );
  });
});

describe("Batch A MODEL_APPLY apply+reinject (stub model, real apply)", () => {
  beforeAll(() => {
    const db = process.env.DATABASE_URL;
    if (!db?.trim()) {
      throw new Error("DATABASE_URL required for MODEL_APPLY offline apply test");
    }
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = db;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not import openai / llm-client in the MODEL_APPLY module", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/eval/run-model-apply.ts"),
      "utf8",
    );
    const importLines = src
      .split(/\r?\n/)
      .filter((line) => /^\s*import\s/.test(line));
    const joined = importLines.join("\n");
    expect(joined).not.toMatch(/openai|llm-client|getLlmClient/i);
  });

  it("applies model ACTION, reinjects real ids, asserts state each turn", async () => {
    const applyListSpy = vi.spyOn(listOps, "applyListOps");
    const applyRecSpy = vi.spyOn(employeeRecords, "applyEmployeeRecords");

    const suiteCase: ModelApplyCase = {
      id: "mt-stub-add-then-remove",
      track: "MODEL_APPLY",
      description: "Stub model drives ACTION; production apply + reinject",
      setup: {
        lists: [
          {
            list_id: "eval-list-shopping-personal",
            list_type: "shopping",
            owner: "טל",
            scope: "personal",
            items: [],
          },
        ],
      },
      turns: [
        {
          utterance: "תוסיפי חלב לקניות",
          constraints: [
            {
              type: "lists_has_action",
              action: "add",
              listType: "shopping",
              minCount: 1,
            },
          ],
          stateAfter: {
            factsInclude: ["חלב"],
          },
        },
        {
          utterance: "מחקתי את החלב",
          constraints: [
            {
              type: "lists_has_action",
              action: "remove",
              listType: "shopping",
              minCount: 1,
            },
          ],
          stateAfter: {
            factsExclude: ['"שם פריט": "חלב"'],
          },
        },
      ],
    };

    let capturedTurn1ItemId = "";

    const result = await runModelApplyCase(suiteCase, (input) => {
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "shopping",
                list_name: "",
                items: [{ "שם פריט": "חלב" }],
                targets: [],
              },
            ],
            list_ops: [],
            filing: [],
          },
          response: "הוספתי חלב",
        };
      }

      // Turn 1: must use real UUID from reinjected facts/snapshot — not fixture/symbolic.
      const realId = firstLiveItemId(input.snapshot);
      capturedTurn1ItemId = realId;
      expect(realId).toMatch(UUID_RE);
      expect(input.facts).toContain("חלב");
      expect(input.priorMetadata).toHaveLength(1);

      return {
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "shopping",
              list_name: "",
              items: [{ item_id: realId }],
              targets: [],
            },
          ],
          list_ops: [],
          filing: [],
        },
        response: "הסרתי",
      };
    });

    expect(result.track).toBe("MODEL_APPLY");
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]!.appliedViaProduction).toBe(true);
    expect(result.turns[1]!.appliedViaProduction).toBe(true);
    expect(result.turns[0]!.ok).toBe(true);
    expect(result.turns[1]!.ok).toBe(true);
    expect(capturedTurn1ItemId).toBeTruthy();
    expect(applyRecSpy).toHaveBeenCalled();
    // list_ops empty — applyListOps may or may not be called; records apply is required.
    void applyListSpy;
  });

  it("skips apply on empty model ACTION (ask turn) but still reinjects unchanged facts", async () => {
    const applyRecSpy = vi.spyOn(employeeRecords, "applyEmployeeRecords");

    const suiteCase: ModelApplyCase = {
      id: "mt-stub-ask-then-add",
      track: "MODEL_APPLY",
      setup: {
        lists: [
          {
            list_id: "eval-list-shopping-personal",
            list_type: "shopping",
            owner: "טל",
            scope: "personal",
            items: [],
          },
        ],
      },
      turns: [
        {
          utterance: "תוסיפי משהו",
          constraints: [{ type: "mutations_empty_or_read_only" }],
          stateAfter: { factsExclude: ["לחם"] },
        },
        {
          utterance: "לחם",
          constraints: [
            {
              type: "lists_has_action",
              action: "add",
              listType: "shopping",
              minCount: 1,
            },
          ],
          stateAfter: { factsInclude: ["לחם"] },
        },
      ],
    };

    const result = await runModelApplyCase(suiteCase, (input) => {
      if (input.turnIndex === 0) {
        return {
          metadata: emptyModelMetadata(),
          response: "מה להוסיף?",
        };
      }
      return {
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              list_name: "",
              items: [{ "שם פריט": "לחם" }],
              targets: [],
            },
          ],
          list_ops: [],
          filing: [],
        },
        response: "הוספתי לחם",
      };
    });

    expect(result.ok).toBe(true);
    expect(result.turns[0]!.appliedViaProduction).toBe(false);
    expect(result.turns[1]!.appliedViaProduction).toBe(true);
    expect(applyRecSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Batch A suite MT1–MT3 MODEL_APPLY (stub model, real apply)", () => {
  beforeAll(() => {
    const db = process.env.DATABASE_URL;
    if (!db?.trim()) {
      throw new Error("DATABASE_URL required for Batch A suite MODEL_APPLY");
    }
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = db;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("suite exposes exactly the three MODEL_APPLY MT cases", () => {
    const suite = loadBatchASuite();
    const apply = suite.cases.filter((c) => c.track === "MODEL_APPLY");
    expect(apply.map((c) => c.id).sort()).toEqual(
      [...BATCH_A_SUITE_MT_IDS].sort(),
    );
  });

  it.each([...BATCH_A_SUITE_MT_IDS])(
    "%s loads from batch-a-suite.json and passes stub MODEL_APPLY",
    async (caseId) => {
      const suiteCase = loadSuiteModelApplyCase(caseId);
      expect(suiteCase.id).toBe(caseId);
      expect(suiteCase.track).toBe("MODEL_APPLY");
      expect(suiteCase.turns.length).toBeGreaterThan(0);

      const result = await runModelApplyCase(suiteCase, (input) =>
        proposeBatchASuiteMt(caseId, input),
      );

      expect(
        result.failures,
        `${caseId}: ${result.failures.join("; ")}`,
      ).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.track).toBe("MODEL_APPLY");
      expect(result.turns).toHaveLength(suiteCase.turns.length);

      for (const turn of result.turns) {
        expect(turn.constraintOk, `${caseId} turn ${turn.turnIndex}`).toBe(
          true,
        );
        expect(turn.stateFailures, `${caseId} turn ${turn.turnIndex}`).toEqual(
          [],
        );
        expect(turn.ok).toBe(true);
      }
    },
  );

  it("MT1: ask turn skips apply; clarify remove uses reinjected UUID; milk gone bread kept", async () => {
    const suiteCase = loadSuiteModelApplyCase("MT1-clarify-then-delete");
    const result = await runModelApplyCase(suiteCase, (input) =>
      proposeBatchASuiteMt("MT1-clarify-then-delete", input),
    );
    expect(result.ok).toBe(true);
    expect(result.turns[0]!.appliedViaProduction).toBe(false);
    expect(result.turns[1]!.appliedViaProduction).toBe(true);
    const meta1 = result.turns[1]!.metadata;
    const remove = meta1.lists?.find((row) => row.action === "remove");
    expect(remove).toBeTruthy();
    const itemId = String(
      (remove!.items[0] as Record<string, unknown>)?.item_id ?? "",
    );
    expect(itemId).toMatch(UUID_RE);
    const facts = result.turns[1]!.facts;
    expect(facts).toContain("לחם");
    expect(facts).not.toMatch(/"שם פריט":\s*"חלב"/);
  });

  it("MT2: ask then add; bread appears in reinjected facts", async () => {
    const suiteCase = loadSuiteModelApplyCase("MT2-ask-then-add");
    const result = await runModelApplyCase(suiteCase, (input) =>
      proposeBatchASuiteMt("MT2-ask-then-add", input),
    );
    expect(result.ok).toBe(true);
    expect(result.turns[0]!.appliedViaProduction).toBe(false);
    expect(result.turns[1]!.appliedViaProduction).toBe(true);
    expect(result.turns[1]!.metadata.lists?.some((r) => r.action === "add")).toBe(
      true,
    );
    expect(result.turns[1]!.facts).toContain("לחם");
  });

  it("MT3: cancel clock only; shopping milk remains (D3 / C-KEEP)", async () => {
    const suiteCase = loadSuiteModelApplyCase("MT3-stop-nudge-keep-item");
    const result = await runModelApplyCase(suiteCase, (input) =>
      proposeBatchASuiteMt("MT3-stop-nudge-keep-item", input),
    );
    expect(result.ok).toBe(true);
    expect(result.turns[0]!.appliedViaProduction).toBe(true);
    const rem = result.turns[0]!.metadata.reminders ?? [];
    expect(rem.every((r) => r.action === "remove")).toBe(true);
    expect(rem).toHaveLength(1);
    expect(String(rem[0]!.reminderId ?? "")).toMatch(UUID_RE);
    expect(result.turns[0]!.metadata.lists ?? []).toHaveLength(0);
    expect(result.turns[0]!.facts).toContain("חלב");
    expect(result.turns[0]!.snapshot.reminders ?? []).toHaveLength(0);
  });
});

describe("UnapprovedEvalDatabaseError type", () => {
  it("is constructible", () => {
    const err = new UnapprovedEvalDatabaseError("refusing");
    expect(err.name).toBe("UnapprovedEvalDatabaseError");
  });
});
