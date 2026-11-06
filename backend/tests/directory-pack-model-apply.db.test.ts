/**
 * Directory Pack MODEL_APPLY — stub model + production applyDirectoryActions (offline).
 * No OpenAI / Graph / reminder fire. Requires DATABASE_URL === WORKEE_APPROVED_TEST_DATABASE_URL.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  defaultDomainPackPath,
  loadDomainPackSuite,
} from "../src/eval/corpus.js";
import {
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyProposeInput,
} from "../src/eval/run-model-apply.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { listContactsForEmployee } from "../src/services/contact.service.js";

async function contactIdByName(
  employeeId: string,
  needle: string,
): Promise<string> {
  const rows = await listContactsForEmployee(employeeId);
  const hit = rows.find((row) => row.name.includes(needle));
  if (!hit?.id?.trim()) {
    throw new Error(`expected contact named ${needle}`);
  }
  return hit.id.trim();
}

async function propose(caseId: string, input: ModelApplyProposeInput) {
  switch (caseId) {
    case "D-ADD-THEN-RM":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            directory: [
              {
                action: "add",
                name: "נועה",
                phone: "0521111111",
                contact_id: "",
                targets: [],
              },
            ],
          },
          response: "שמרתי",
        };
      }
      return {
        metadata: {
          directory: [
            {
              action: "remove",
              name: "נועה",
              phone: "",
              contact_id: await contactIdByName(input.account.employeeId, "נועה"),
              targets: [],
            },
          ],
        },
        response: "מחקתי",
      };
    case "D-UPD-MT":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            directory: [
              {
                action: "add",
                name: "גיל",
                phone: "0531111111",
                contact_id: "",
                targets: [],
              },
            ],
          },
          response: "שמרתי",
        };
      }
      return {
        metadata: {
          directory: [
            {
              action: "update",
              name: "גיל",
              phone: "0532222222",
              contact_id: await contactIdByName(input.account.employeeId, "גיל"),
              targets: [],
            },
          ],
        },
        response: "עדכנתי",
      };
    case "D-CRUD-MT":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            directory: [
              {
                action: "add",
                name: "יעל",
                phone: "0511111111",
                contact_id: "",
                targets: [],
              },
            ],
          },
          response: "שמרתי",
        };
      }
      if (input.turnIndex === 1) {
        return {
          metadata: {
            directory: [
              {
                action: "update",
                name: "יעל",
                phone: "0512222222",
                contact_id: await contactIdByName(input.account.employeeId, "יעל"),
                targets: [],
              },
            ],
          },
          response: "עדכנתי",
        };
      }
      return {
        metadata: {
          directory: [
            {
              action: "remove",
              name: "יעל",
              phone: "",
              contact_id: await contactIdByName(input.account.employeeId, "יעל"),
              targets: [],
            },
          ],
        },
        response: "מחקתי",
      };
    case "D-DUP-MT":
      // Already seeded מיכל@0541111111 — do not re-add; empty ACTION (product ask path).
      return {
        metadata: { directory: [] },
        response: "מיכל כבר שמורה בספר הטלפונים",
      };
    default:
      throw new Error(caseId);
  }
}

describe("Directory Pack MODEL_APPLY (offline)", () => {
  beforeAll(() => {
    const db = process.env.DATABASE_URL;
    if (!db?.trim()) {
      throw new Error("DATABASE_URL required for Directory pack MODEL_APPLY");
    }
    // Fail closed: never self-approve DATABASE_URL (could be product `workee`).
    assertApprovedEvalDatabaseUrl(db);
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["D-ADD-THEN-RM", "D-UPD-MT", "D-CRUD-MT", "D-DUP-MT"])(
    "%s",
    async (caseId) => {
      const suite = loadDomainPackSuite(
        defaultDomainPackPath("directory-pack-suite.json"),
        { expectedDomain: "directory", expectedPack: "directory-pack-v1" },
      );
      const row = suite.cases.find((c) => c.id === caseId)!;
      expect(row.track).toBe("MODEL_APPLY");

      const result = await runModelApplyCase(row as ModelApplyCase, (input) =>
        propose(caseId, input),
      );
      expect(result.failures, result.failures.join("; ")).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.track).toBe("MODEL_APPLY");

      if (caseId === "D-DUP-MT") {
        // Empty ACTION → no production apply needed; contact still present from seed.
        expect(result.turns.every((t) => t.appliedViaProduction === false)).toBe(
          true,
        );
      } else {
        expect(result.turns.some((t) => t.appliedViaProduction === true)).toBe(
          true,
        );
      }
    },
  );
});
