import { describe, expect, it } from "vitest";
import {
  buildEvalUiReport,
  collectActionWarnings,
  formatEvalHumanReport,
  formatEvalUiReportMarkdown,
  summarizeAction,
  summarizeConstraints,
} from "../src/eval/human-report.js";
import { emptyLlmMetadata, parseLlmMetadata } from "@workee/shared";

describe("human-report", () => {
  it("summarizes constraints and actions compactly", () => {
    expect(
      summarizeConstraints([
        { type: "mutations_empty_or_read_only" },
        { type: "response_looks_like_ask" },
      ]),
    ).toContain("ask");
    const meta = parseLlmMetadata({
      lists: [
        {
          action: "remove",
          list_type: "shopping",
          items: [{ item_id: "x", "שם פריט": "חלב" }],
        },
      ],
    });
    expect(summarizeAction(meta)).toMatch(/lists\.remove:shopping/);
  });

  it("warns when listType mismatches expected shopping", () => {
    const meta = parseLlmMetadata({
      lists: [
        {
          action: "remove",
          list_type: "custom",
          list_name: "קניות",
          items: [{ item_id: "eval-item-milk", "שם פריט": "חלב" }],
        },
      ],
    });
    const warnings = collectActionWarnings(meta, [
      {
        type: "lists_remove_item_ids",
        listType: "shopping",
        itemIds: ["eval-item-milk"],
      },
    ]);
    expect(warnings.some((w) => w.includes("listType=custom"))).toBe(true);
  });

  it("warns on empty response", () => {
    const warnings = collectActionWarnings(emptyLlmMetadata(), [], "");
    expect(warnings).toContain("empty response");
  });

  it("builds UI JSON and English markdown with Scenario/Expectation/Observed", () => {
    const input = {
      track: "LIVE_MODEL" as const,
      suite: "test-suite",
      productionApply: false,
      total: 1,
      passed: 1,
      failed: 0,
      passRate: 1,
      requiredPassRate: 0.7,
      softOk: true,
      criticalOk: true,
      criticalFailed: [] as string[],
      ok: true,
      cases: [
        {
          id: "demo",
          ok: true,
          failures: [] as string[],
          description: "Demo case",
          scenarioUtterances: "קניתי חלב",
          turns: [
            {
              index: 0,
              utterance: "קניתי חלב",
              response: "מחקתי",
              ok: true,
              metadata: emptyLlmMetadata(),
              constraints: [
                {
                  type: "lists_remove_item_ids" as const,
                  listType: "shopping",
                  itemIds: ["eval-item-milk"],
                },
              ],
            },
          ],
        },
      ],
    };
    const ui = buildEvalUiReport(input);
    expect(ui.kind).toBe("live-eval-ui-report");
    expect(ui.version).toBe(1);
    expect(ui.cases[0]?.verdict).toBe("PASS");
    expect(ui.cases[0]?.turns[0]?.expectation).toContain("remove shopping");

    const md = formatEvalUiReportMarkdown(ui);
    expect(md).toContain("## 1. PASS");
    expect(md).toContain("### Scenario");
    expect(md).toContain("### Expectation");
    expect(md).toContain("### Observed");
    expect(md).toContain("### Verdict");
    expect(md).not.toContain("תסריט");
    expect(formatEvalHumanReport(input)).toContain("### Scenario");
  });

  it("summarizes messages in ACTION summary", () => {
    const meta = {
      lists: [],
      listOps: [],
      filing: [],
      messages: [
        {
          text: "תיאום",
          targets: ["עמית"],
          book: { title: "פגישה", date: "2099-01-01", time: "10:00" },
        },
      ],
      reminders: [],
      directory: [],
      jobs: [],
      confirm: null,
      handoff: null,
    } as Parameters<typeof summarizeAction>[0];
    expect(summarizeAction(meta)).toContain("messages→עמית+book");
  });
});
