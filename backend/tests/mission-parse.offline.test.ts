import { describe, expect, it } from "vitest";
import { parseLlmMetadata } from "@workee/shared";

describe("missions metadata parse", () => {
  it("parses create + approve_plan + run_tools", () => {
    const meta = parseLlmMetadata({
      missions: [
        {
          action: "create",
          goal: "לקנות קורקינט",
          success_criteria: "מספר הזמנה",
          summary: "אתכנן ואחזור",
        },
        {
          action: "approve_plan",
          mission_id: "11111111-1111-4111-8111-111111111111",
        },
        {
          action: "run_tools",
          mission_id: "11111111-1111-4111-8111-111111111111",
          tools: [
            {
              tool: "browser.navigate",
              args: { url: "https://example.com" },
            },
            {
              tool: "payment.charge",
              args: { prepare_id: "abc" },
              requires_approval: true,
            },
          ],
        },
      ],
    });
    expect(meta.missions).toHaveLength(3);
    expect(meta.missions?.[0]?.action).toBe("create");
    expect(meta.missions?.[0]?.goal).toBe("לקנות קורקינט");
    expect(meta.missions?.[0]?.successCriteria).toBe("מספר הזמנה");
    expect(meta.missions?.[1]?.missionId).toContain("11111111");
    expect(meta.missions?.[2]?.tools?.[0]?.tool).toBe("browser.navigate");
    expect(meta.missions?.[2]?.tools?.[1]?.requiresApproval).toBe(true);
  });
});
