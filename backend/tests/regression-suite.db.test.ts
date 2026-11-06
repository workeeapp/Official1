/**
 * Gate 1 — ENGINE-only multi-turn regression (offline).
 * Exercises production applyListOps + applyEmployeeRecords against Prisma.
 * Does not prove model NL understanding. No OpenAI calls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultRegressionSuitePath,
  loadRegressionSuite,
  type RegressionSuiteCase,
} from "../src/eval/corpus.js";
import {
  EngineFixtureRequiredError,
  runMultiTurnOffline,
} from "../src/eval/run-multi-turn.js";
import * as employeeRecords from "../src/services/employee-records.service.js";
import * as listOps from "../src/services/list-ops.service.js";

describe("Gate 1 ENGINE regression suite (offline)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("S1.H2 loader", () => {
    it("loads the committed suite from docs/qa/regression-suite.json", () => {
      const suite = loadRegressionSuite();
      expect(suite.cases.length).toBeGreaterThanOrEqual(6);
      expect(suite.criticalCaseIds?.length).toBeGreaterThanOrEqual(6);
      expect(defaultRegressionSuitePath().replace(/\\/g, "/")).toMatch(
        /docs\/qa\/regression-suite\.json$/,
      );
    });

    it("rejects a suite object with unknown criticalCaseIds", async () => {
      const { writeFileSync, unlinkSync, mkdtempSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "reg-suite-"));
      const path = join(dir, "bad.json");
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          speaker: "טל",
          criticalCaseIds: ["missing-id"],
          cases: [
            {
              id: "only-case",
              track: "ENGINE",
              turns: [
                {
                  utterance: "x",
                  fixtureMetadata: { lists: [], filing: [] },
                },
              ],
            },
          ],
        }),
      );
      expect(() => loadRegressionSuite(path)).toThrow(/criticalCaseIds unknown/);
      unlinkSync(path);
    });
  });

  describe("S1.H1 fixture required", () => {
    it("refuses a turn without fixtureMetadata (no LLM fallback)", async () => {
      const bad: RegressionSuiteCase = {
        id: "missing-fixture",
        track: "ENGINE",
        turns: [
          {
            utterance: "שלום",
            fixtureMetadata: null,
          },
        ],
      };
      const result = await runMultiTurnOffline(bad);
      expect(result.ok).toBe(false);
      expect(result.failures.some((row) => row.includes("fixtureMetadata"))).toBe(
        true,
      );
      expect(() => {
        throw new EngineFixtureRequiredError("missing-fixture", 0);
      }).toThrow(EngineFixtureRequiredError);
    });
  });

  describe("S1.H3 discovery", () => {
    it("discovers every critical seed case from the committed suite without per-case files", () => {
      const suite = loadRegressionSuite();
      const ids = new Set(suite.cases.map((row) => row.id));
      for (const id of suite.criticalCaseIds ?? []) {
        expect(ids.has(id)).toBe(true);
      }
      expect(ids.has("g1-c1-shop-add-remove")).toBe(true);
      expect(ids.has("g1-c2-ask-then-add")).toBe(true);
      expect(ids.has("g1-c3-clarify-then-delete")).toBe(true);
      expect(ids.has("g1-p1-when-clear-delete")).toBe(true);
      expect(ids.has("g1-p2-event-host-link")).toBe(true);
      expect(ids.has("g1-p3-host-rename")).toBe(true);
    });
  });

  describe("production apply path", () => {
    it("calls applyEmployeeRecords for fixture add and uses resulting snapshot on next turn", async () => {
      const applySpy = vi.spyOn(employeeRecords, "applyEmployeeRecords");
      const snapSpy = vi.spyOn(employeeRecords, "getEmployeeRecordSnapshot");
      const suite = loadRegressionSuite();
      const row = suite.cases.find((c) => c.id === "g1-c1-shop-add-remove");
      expect(row).toBeTruthy();

      const result = await runMultiTurnOffline(row!, { speaker: suite.speaker });
      expect(result.ok).toBe(true);
      expect(applySpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(snapSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(result.turns.every((t) => t.appliedViaProduction)).toBe(true);

      // Turn 1 production apply created a real UUID visible in reinjected facts.
      const turn1ItemId = String(
        result.turns[0]?.snapshot.lists
          .flatMap((list) => list.items)
          .map((item) => item.item_id ?? item.itemId)
          .find((id) => typeof id === "string" && id.length > 0) ?? "",
      );
      expect(turn1ItemId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(result.turns[0]?.facts).toContain(turn1ItemId);

      // Turn 2 remove must target that same production UUID (not a fixture alias).
      const turn2Meta = applySpy.mock.calls[1]?.[1] as {
        lists?: Array<{ action: string; items?: Array<Record<string, unknown>> }>;
      };
      const removeItem = turn2Meta.lists?.find((a) => a.action === "remove")
        ?.items?.[0];
      const removeId = String(
        removeItem?.item_id ?? removeItem?.itemId ?? "",
      );
      expect(removeId).toBe(turn1ItemId);
      const turn2Item = result.turns[1]?.metadata.lists[0]?.items[0] as
        | Record<string, unknown>
        | undefined;
      expect(
        String(turn2Item?.item_id ?? turn2Item?.itemId ?? ""),
      ).toBe(turn1ItemId);
    });

    it("calls applyListOps when a fixture emits list_ops", async () => {
      const listOpsSpy = vi.spyOn(listOps, "applyListOps");
      // Minimal inline case: empty list_ops should not call; non-empty should.
      const withOps: RegressionSuiteCase = {
        id: "g1-list-ops-smoke",
        track: "ENGINE",
        setup: {
          lists: [
            {
              list_id: "eval-list-custom-bugs",
              list_type: "custom",
              list_name: "באגים",
              owner: "טל",
              scope: "personal",
              items: [{ item_id: "eval-item-bug", שם: "באג" }],
            },
          ],
        },
        turns: [
          {
            utterance: "תמחק את רשימת באגים",
            fixtureMetadata: {
              lists: [],
              list_ops: [
                {
                  action: "delete_list",
                  list_id: "eval-list-custom-bugs",
                  new_name: "",
                  add_columns: [],
                  remove_columns: [],
                  rename_columns: [],
                  add_participants: [],
                  remove_participants: [],
                },
              ],
              filing: [],
            },
            constraints: [
              {
                type: "list_ops_delete_list_ids",
                listIds: ["eval-list-custom-bugs"],
              },
            ],
            stateAfter: {
              listTypeCounts: { custom: 0 },
            },
          },
        ],
      };

      const result = await runMultiTurnOffline(withOps);
      expect(result.ok).toBe(true);
      expect(listOpsSpy).toHaveBeenCalled();
      const opsArg = listOpsSpy.mock.calls[0]?.[0] as {
        ops: Array<{ listId: string }>;
      };
      expect(opsArg.ops[0]?.listId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe("seed cases G1.C* / G1.P* (ENGINE only)", () => {
    const suite = loadRegressionSuite();

    for (const row of suite.cases) {
      it(`ENGINE ${row.id}`, async () => {
        const result = await runMultiTurnOffline(row, { speaker: suite.speaker });
        expect(result.track).toBe("ENGINE");
        if (!result.ok) {
          expect.fail(
            `${row.id} failed:\n${result.failures.map((f) => ` - ${f}`).join("\n")}`,
          );
        }
        expect(result.ok).toBe(true);
        expect(result.turns.length).toBe(row.turns.length);
        for (const turn of result.turns) {
          expect(turn.ok).toBe(true);
          expect(turn.appliedViaProduction).toBe(true);
          expect(turn.facts).toContain("EMPLOYEE_SAVED_DATA");
        }
      });
    }
  });
});
