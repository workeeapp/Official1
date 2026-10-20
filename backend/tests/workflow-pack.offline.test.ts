/**
 * Workflow Pack — ENGINE multi-turn offline (W1–W4).
 * Fixture ACTION → production apply + reinject. No OpenAI / LIVE / MODEL_APPLY.
 */
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultWorkflowPackPath,
  loadWorkflowPackSuite,
} from "../src/eval/corpus.js";
import { runMultiTurnOffline } from "../src/eval/run-multi-turn.js";

describe("Workflow pack ENGINE (offline)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads workflow-pack-suite.json with W1–W4 critical cases", () => {
    const path = defaultWorkflowPackPath();
    expect(existsSync(path), path).toBe(true);
    const suite = loadWorkflowPackSuite(path);
    expect(suite.pack).toBe("workflow-pack-v1");
    expect(suite.domain).toBe("workflows");
    expect(suite.criticalCaseIds).toEqual([
      "W1-SHOP-THEN-FILING",
      "W2-LIST-SHARE-REMIND",
      "W3-MULTI-ACTION-ONE-TURN",
      "W4-CLARIFY-THEN-MULTI",
    ]);
    for (const id of suite.criticalCaseIds ?? []) {
      const row = suite.cases.find((c) => c.id === id);
      expect(row?.track).toBe("ENGINE");
      expect(row?.turns.length).toBeGreaterThanOrEqual(1);
    }
    expect(suite.cases.some((c) => c.id === "W1-SHOP-THEN-FILING-MA")).toBe(
      true,
    );
    expect(suite.cases.some((c) => c.id === "W3-MULTI-ACTION-ONE-TURN-MA")).toBe(
      true,
    );
    expect(suite.cases.some((c) => c.id === "W4-CLARIFY-THEN-MULTI-MA")).toBe(
      true,
    );
  });

  it("rejects unsupported tracks", async () => {
    const { writeFileSync, unlinkSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "wf-suite-"));
    const path = join(dir, "bad.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        speaker: "טל",
        pack: "workflow-pack-v1",
        domain: "workflows",
        cases: [
          {
            id: "bad",
            track: "MODEL",
            turns: [{ utterance: "x", fixtureMetadata: { lists: [] } }],
          },
        ],
      }),
    );
    expect(() => loadWorkflowPackSuite(path)).toThrow(
      /track must be ENGINE or MODEL_APPLY/,
    );
    unlinkSync(path);
  });

  describe("seed cases W1–W4", () => {
    const suite = loadWorkflowPackSuite();
    const engineCases = suite.cases.filter((c) => c.track === "ENGINE");

    for (const row of engineCases) {
      it(`ENGINE ${row.id}`, async () => {
        const result = await runMultiTurnOffline(row, {
          speaker: suite.speaker,
          partners: ["עמית"],
        });
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

        // W4: clarify turn must not leave shopping/filing rows; complete once.
        if (row.id === "W4-CLARIFY-THEN-MULTI") {
          const clarify = result.turns[0]!;
          const shopItems =
            clarify.snapshot.lists
              .filter((l) => l.list_type === "shopping")
              .flatMap((l) => l.items) ?? [];
          expect(shopItems.length).toBe(0);
          expect(clarify.snapshot.filing.length).toBe(0);

          const done = result.turns[1]!;
          const bread = done.snapshot.lists
            .flatMap((l) => l.items)
            .filter((item) => JSON.stringify(item).includes("לחם"));
          expect(bread.length).toBe(1);
          const filings = done.snapshot.filing.filter((f) =>
            `${f.item_name}${f.item_info}`.includes("לחם"),
          );
          expect(filings.length).toBe(1);
        }

        // W2: share must mark custom list shared with partner; one reminder.
        if (row.id === "W2-LIST-SHARE-REMIND") {
          const sharedTurn = result.turns[1]!;
          const custom = sharedTurn.snapshot.lists.find(
            (l) => l.list_name === "קניות לשבת",
          );
          expect(custom?.scope).toBe("shared");
          expect(custom?.shared_with?.includes("עמית")).toBe(true);

          const remindTurn = result.turns[2]!;
          expect(remindTurn.snapshot.reminders?.length).toBe(1);
          expect(
            remindTurn.snapshot.reminders?.some((r) =>
              String(r.item ?? r.text ?? "").includes("לקנות לשבת"),
            ),
          ).toBe(true);
        }

        // W3: one shopping row + one filing after single multi-action turn.
        if (row.id === "W3-MULTI-ACTION-ONE-TURN") {
          const turn = result.turns[0]!;
          const wine = turn.snapshot.lists
            .flatMap((l) => l.items)
            .filter((item) => JSON.stringify(item).includes("יין"));
          expect(wine.length).toBe(1);
          expect(
            turn.snapshot.filing.filter((f) => f.item_name.includes("יין"))
              .length,
          ).toBe(1);
        }
      });
    }
  });
});
