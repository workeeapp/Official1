/**
 * G7 stability aggregation: per-case pass counts / rates / class across runs.
 */
import { describe, expect, it } from "vitest";
import {
  aggregateStability,
  classifyStability,
  formatStabilityMarkdown,
  type StabilityRunCase,
} from "../src/eval/stability.js";

function run(id: string, ok: boolean, failures: string[] = [], buttons: string[] = []): StabilityRunCase {
  return {
    id,
    ok,
    failures,
    turns: [
      {
        turnIndex: 0,
        utterance: "כן",
        response: ok ? "יצרתי. רוצה לשתף?" : "יצרתי.",
        ok,
        metadata: {
          evalBubbleCount: ok ? 2 : 1,
          evalButtons: buttons.map((label) => ({ label, command: label })),
        },
      },
    ],
  };
}

describe("eval stability", () => {
  it("classifies stable / intermittent / consistent", () => {
    expect(classifyStability(5, 5)).toBe("stable-pass");
    expect(classifyStability(3, 5)).toBe("intermittent");
    expect(classifyStability(0, 5)).toBe("consistent-fail");
  });

  it("aggregates per case across runs, counts failure reasons once per run", () => {
    const miss = "turn 1 constraints: response missing any of: לשתף";
    const summary = aggregateStability([
      [run("a", true), run("b", true), run("c", false, ["x"])],
      [run("a", true), run("b", false, [miss, miss]), run("c", false, ["x"])],
      [run("a", true), run("b", true, [], ["שתפי עם מיכל"]), run("c", false, ["y"])],
    ]);
    expect(summary.runs).toBe(3);
    expect(summary.totalExecutions).toBe(9);
    expect(summary.totalPassed).toBe(5);
    expect(summary.counts).toEqual({
      "stable-pass": 1,
      intermittent: 1,
      "consistent-fail": 1,
    });
    const b = summary.rows.find((r) => r.id === "b")!;
    expect(b).toMatchObject({ runs: 3, passed: 2, failed: 1, classification: "intermittent" });
    expect(b.failureReasons[miss]).toBe(1);
    // Non-stable cases keep every run (pass AND fail) for comparison.
    expect(b.samples.map((s) => s.ok)).toEqual([true, false, true]);
    expect(b.samples[2]!.turns[0]!.buttons).toEqual(["שתפי עם מיכל → שתפי עם מיכל"]);
    expect(b.samples[1]!.turns[0]!.bubbles).toBe(1);
    const c = summary.rows.find((r) => r.id === "c")!;
    expect(c.failureReasons).toEqual({ x: 2, y: 1 });
    expect(summary.rows.find((r) => r.id === "a")!.samples).toEqual([]);
  });

  it("markdown lists failing classes first with transcripts", () => {
    const summary = aggregateStability([
      [run("a", true), run("b", false, ["m"])],
      [run("a", true), run("b", true)],
    ]);
    const md = formatStabilityMarkdown(summary, {
      generatedAt: "t",
      filter: "cases=a,b",
      contextMode: "production",
    });
    expect(md.indexOf("`b`")).toBeLessThan(md.indexOf("`a`"));
    expect(md).toContain("| `b` | 1/2 | 50% | intermittent |");
    expect(md).toContain("## b — 1/2 (intermittent)");
    expect(md).toContain("- 1× m");
    expect(md).toContain("buttons: (none)");
  });
});
