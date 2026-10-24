/**
 * Event pack Phase A — offline only.
 * E-HOST-CREATE: MODEL contract for COMPLEX EVENTS host turn (stub ≠ live model).
 * Does not prove model NL competence. No OpenAI / LIVE.
 * Isolated from Batch A / run-batch-a / chat.service (Option A).
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defaultEventPackPath,
  loadEventPackSuite,
} from "../src/eval/corpus.js";
import { evaluateConstraints } from "../src/eval/constraints.js";
import {
  evaluateOfflineModelProposal,
  offlineStubForConstraints,
} from "../src/eval/offline-stub.js";
import { emptyLlmMetadata } from "@workee/shared";

describe("Event pack loader + E-HOST-CREATE MODEL wire (offline)", () => {
  it("loads event-pack-suite.json with Phase A + Stage C B1 critical cases", () => {
    const path = defaultEventPackPath();
    expect(existsSync(path), path).toBe(true);
    const suite = loadEventPackSuite(path);
    expect(suite.pack).toBe("event-pack-v1");
    expect(suite.domain).toBe("events");
    expect(suite.evalPath).toBe("thin");
    expect(suite.productionParity).toBe(false);
    expect(suite.criticalCaseIds).toContain("E-HOST-CREATE");
    expect(suite.criticalCaseIds).toContain("E-HOST-MULTI-ASK");
    expect(suite.criticalCaseIds).toContain("E-HOST-DATE-MATCH-CONTINUE");
    const host = suite.cases.find((c) => c.id === "E-HOST-CREATE");
    expect(host?.track).toBe("MODEL");
    expect(host?.turns).toHaveLength(1);
  });

  it("E-HOST-CREATE offline stub satisfies COMPLEX EVENTS host constraints", () => {
    const suite = loadEventPackSuite();
    const row = suite.cases.find((c) => c.id === "E-HOST-CREATE")!;
    expect(row.track).toBe("MODEL");
    const constraints = row.turns[0]!.constraints ?? [];
    const stub = offlineStubForConstraints(constraints);
    const result = evaluateOfflineModelProposal({
      constraints,
      metadata: stub.metadata,
      response: stub.response,
    });
    expect(result.ok, result.failures.join("; ")).toBe(true);

    expect(
      result.metadata.lists.some((l) => l.action === "add" && l.listType === "tasks"),
    ).toBe(true);
    expect(
      result.metadata.lists.some((l) => l.action === "add" && l.listType === "custom"),
    ).toBe(false);
    expect(JSON.stringify(result.metadata.lists)).toContain("ערב פוקר");
    expect(JSON.stringify(result.metadata.lists)).not.toContain("לארגן ערב פוקר");
  });

  it("E-HOST-MULTI-ASK offline stub: empty mutates + ask (B1)", () => {
    const suite = loadEventPackSuite();
    const row = suite.cases.find((c) => c.id === "E-HOST-MULTI-ASK")!;
    expect(row.track).toBe("MODEL");
    const constraints = row.turns[0]!.constraints ?? [];
    const stub = offlineStubForConstraints(constraints);
    const result = evaluateOfflineModelProposal({
      constraints,
      metadata: stub.metadata,
      response: stub.response,
    });
    expect(result.ok, result.failures.join("; ")).toBe(true);
    expect(result.metadata.lists).toEqual([]);
    expect(result.response).toMatch(/\?|איזה|לאיזה/);
  });

  it("E-HOST-DATE-MATCH-CONTINUE offline stub: no second host add", () => {
    const suite = loadEventPackSuite();
    const row = suite.cases.find((c) => c.id === "E-HOST-DATE-MATCH-CONTINUE")!;
    expect(row.track).toBe("MODEL");
    const constraints = row.turns[0]!.constraints ?? [];
    const stub = offlineStubForConstraints(constraints);
    const result = evaluateOfflineModelProposal({
      constraints,
      metadata: stub.metadata,
      response: stub.response,
    });
    expect(result.ok, result.failures.join("; ")).toBe(true);
    expect(
      result.metadata.lists.some(
        (l) => l.action === "add" && l.listType === "tasks",
      ),
    ).toBe(false);
  });

  it("no_lists_add rejects premature custom domain on host turn", () => {
    const constraints = [
      {
        type: "lists_has_action" as const,
        action: "add",
        listType: "tasks",
        itemTextIncludes: "ערב פוקר",
      },
      { type: "no_lists_add" as const, listType: "custom" },
    ];
    const bad = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add" as const,
          listType: "tasks" as const,
          listName: "",
          items: [{ "שם מטלה": "ערב פוקר" }],
          targets: [] as string[],
        },
        {
          action: "add" as const,
          listType: "custom" as const,
          listName: "כיבוד",
          items: [{ שם: "בירות" }],
          targets: [] as string[],
        },
      ],
    };
    const checked = evaluateConstraints(constraints, bad, "רשמתי ערב פוקר");
    expect(checked.ok).toBe(false);
    expect(checked.failures.some((f) => f.includes("must not lists.add/custom"))).toBe(
      true,
    );
  });
});
