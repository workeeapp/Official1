/**
 * Reminder Pack MODEL_APPLY — stub model, real production apply + reinject.
 * Offline only; no OpenAI. Requires DATABASE_URL === WORKEE_APPROVED_TEST_DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadReminderPackSuite } from "../src/eval/corpus.js";
import {
  emptyModelMetadata,
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyProposeInput,
} from "../src/eval/run-model-apply.js";
import {
  assertApprovedEvalDatabaseUrl,
  UnapprovedEvalDatabaseError,
} from "../src/eval/studio-db-guard.js";

function reminderIdByItem(
  snapshot: { reminders?: Array<{ reminder_id?: string; item?: string; text?: string }> },
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

function itemIdByLabel(
  snapshot: { lists: Array<{ list_type?: string; items: Array<Record<string, unknown>> }> },
  needle: string,
  listType?: string,
): string {
  for (const list of snapshot.lists) {
    if (listType && list.list_type !== listType) continue;
    for (const item of list.items) {
      const blob = JSON.stringify(item);
      if (!blob.includes(needle)) continue;
      for (const key of ["item_id", "itemId", "id"]) {
        const raw = item[key];
        if (typeof raw === "string" && raw.trim()) return raw.trim();
      }
    }
  }
  throw new Error(`expected item containing ${needle}`);
}

function proposeForCase(
  caseId: string,
  input: ModelApplyProposeInput,
): { metadata: unknown; response: string } {
  switch (caseId) {
    case "R-CANCEL-ONE-OF-MANY": {
      const id = reminderIdByItem(input.snapshot, "חלב");
      return {
        metadata: {
          lists: [],
          list_ops: [],
          filing: [],
          reminders: [{ action: "remove", reminder_id: id, item: "" }],
        },
        response: "ביטלתי את התזכורת לחלב",
      };
    }
    case "R-STOP-KEEP-ITEM": {
      const id = reminderIdByItem(input.snapshot, "חלב");
      return {
        metadata: {
          lists: [],
          list_ops: [],
          filing: [],
          reminders: [{ action: "remove", reminder_id: id, item: "" }],
        },
        response: "הפסקתי",
      };
    }
    case "R-DONE-TASK": {
      const id = itemIdByLabel(input.snapshot, "להתקשר לרופא", "tasks");
      return {
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "tasks",
              list_name: "",
              items: [{ item_id: id }],
              targets: [],
            },
          ],
          list_ops: [],
          filing: [],
          reminders: [],
        },
        response: "סימנתי כבוצע",
      };
    }
    case "R-CHANGE-MIND-MT": {
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [],
            reminders: [
              {
                action: "add",
                item: "לקנות חלב",
                list_type: "tasks",
                date: "2099-06-15",
                time: "09:00",
                ping: ["טל"],
                targets: [],
              },
            ],
          },
          response: "אזכיר מחר ב־09:00",
        };
      }
      const id = reminderIdByItem(input.snapshot, "חלב");
      return {
        metadata: {
          lists: [],
          reminders: [
            {
              action: "update",
              reminder_id: id,
              item: "לקנות חלב",
              date: "2099-06-15",
              time: "14:00",
            },
          ],
        },
        response: "עדכנתי ל־14:00",
      };
    }
    case "R-CRUD-MT": {
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [],
            reminders: [
              {
                action: "add",
                item: "לשתות מים",
                list_type: "tasks",
                date: "2099-06-15",
                time: "10:00",
                ping: ["טל"],
                targets: [],
              },
            ],
          },
          response: "אזכיר",
        };
      }
      if (input.turnIndex === 1) {
        const id = reminderIdByItem(input.snapshot, "מים");
        return {
          metadata: {
            lists: [],
            reminders: [
              {
                action: "update",
                reminder_id: id,
                item: "לשתות מים",
                date: "2099-06-15",
                time: "11:00",
              },
            ],
          },
          response: "עדכנתי",
        };
      }
      const id = reminderIdByItem(input.snapshot, "מים");
      return {
        metadata: {
          lists: [],
          reminders: [{ action: "remove", reminder_id: id, item: "" }],
        },
        response: "ביטלתי",
      };
    }
    case "R-IDEMPOTENT": {
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [],
            reminders: [
              {
                action: "add",
                item: "לקנות חלב",
                list_type: "shopping",
                date: "2099-06-15",
                time: "08:00",
                ping: ["טל"],
                targets: [],
              },
            ],
          },
          response: "אזכיר",
        };
      }
      return {
        metadata: emptyModelMetadata(),
        response: "כבר יש תזכורת לחלב",
      };
    }
    default:
      throw new Error(`no stub for ${caseId}`);
  }
}

describe("Reminder Pack MODEL_APPLY DB guard (offline)", () => {
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

  it("refuses unapproved DATABASE_URL before Prisma", async () => {
    process.env.DATABASE_URL = "postgresql://unapproved.example/db";
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL =
      "postgresql://approved.example/db";
    const suite = loadReminderPackSuite();
    const row = suite.cases.find((c) => c.track === "MODEL_APPLY")!;
    const result = await runModelApplyCase(row as ModelApplyCase, () => ({
      metadata: emptyModelMetadata(),
      response: "x",
    }));
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => /unapproved|refusing/i.test(f))).toBe(
      true,
    );
    expect(result.failures.join(" ")).not.toMatch(/postgresql:\/\//i);
  });

  it("UnapprovedEvalDatabaseError is constructible", () => {
    const err = new UnapprovedEvalDatabaseError("refusing");
    expect(err.name).toBe("UnapprovedEvalDatabaseError");
  });
});

describe("Reminder Pack MODEL_APPLY apply+reinject (stub model, real apply)", () => {
  beforeAll(() => {
    const db = process.env.DATABASE_URL;
    if (!db?.trim()) {
      throw new Error("DATABASE_URL required for Reminder Pack MODEL_APPLY");
    }
    // Fail closed: never self-approve DATABASE_URL (could be product `workee`).
    assertApprovedEvalDatabaseUrl(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not import openai / llm-client in run-model-apply", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/eval/run-model-apply.ts"),
      "utf8",
    );
    const imports = src
      .split(/\r?\n/)
      .filter((line) => /^\s*import\s/.test(line))
      .join("\n");
    expect(imports).not.toMatch(/openai|llm-client|getLlmClient/i);
  });

  it.each([
    "R-CANCEL-ONE-OF-MANY",
    "R-STOP-KEEP-ITEM",
    "R-DONE-TASK",
    "R-CHANGE-MIND-MT",
    "R-CRUD-MT",
    "R-IDEMPOTENT",
  ])("%s passes with stub model + production apply", async (caseId) => {
    const suite = loadReminderPackSuite();
    const row = suite.cases.find((c) => c.id === caseId);
    expect(row, caseId).toBeTruthy();
    expect(row!.track).toBe("MODEL_APPLY");

    const result = await runModelApplyCase(row as ModelApplyCase, (input) =>
      proposeForCase(caseId, input),
    );

    expect(
      result.failures,
      `${caseId}: ${result.failures.join("; ")}`,
    ).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("R-DONE-TASK keeps unlinked clock (independence)", async () => {
    const suite = loadReminderPackSuite();
    const row = suite.cases.find((c) => c.id === "R-DONE-TASK")!;
    const result = await runModelApplyCase(row as ModelApplyCase, (input) =>
      proposeForCase("R-DONE-TASK", input),
    );
    expect(result.ok).toBe(true);
    const facts = result.turns[0]?.facts ?? "";
    expect(facts).toContain("לקנות חלב");
    expect(facts).not.toContain("להתקשר לרופא");
  });

  it("R-STOP-KEEP-ITEM keeps shopping row after clock cancel", async () => {
    const suite = loadReminderPackSuite();
    const row = suite.cases.find((c) => c.id === "R-STOP-KEEP-ITEM")!;
    const result = await runModelApplyCase(row as ModelApplyCase, (input) =>
      proposeForCase("R-STOP-KEEP-ITEM", input),
    );
    expect(result.ok).toBe(true);
    expect(result.turns[0]?.facts ?? "").toContain("חלב");
  });
});
