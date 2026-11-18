import { describe, expect, it } from "vitest";
import {
  parseComposeCondition,
  parseWebMonitorCondition,
} from "./llm-message.js";

describe("web_monitor compose_condition parse", () => {
  it("accepts multi-objective WatchSpec", () => {
    const parsed = parseComposeCondition({
      type: "web_monitor",
      intent: "הופעות שלמה ארצי + שינויי מועד",
      canonical_query: "שלמה ארצי הופעות מרכז הארץ",
      constraints: { entities: ["שלמה ארצי"], geo: "מרכז הארץ" },
      objectives: [
        { id: "o_discover", kind: "discover_new" },
        {
          id: "o_change",
          kind: "detect_change",
          change_aspects: ["eventAt", "venue"],
        },
      ],
    });
    expect(parsed?.type).toBe("web_monitor");
    if (parsed?.type !== "web_monitor") return;
    expect(parsed.objectives).toHaveLength(2);
    expect(parsed.objectives.map((o) => o.kind)).toEqual([
      "discover_new",
      "detect_change",
    ]);
    expect(parsed.constraints?.geo).toBe("מרכז הארץ");
    expect(parsed.canonicalQuery).toContain("ארצי");
  });

  it("accepts time_before_event with minutes_before", () => {
    const parsed = parseWebMonitorCondition({
      type: "web_monitor",
      intent: "שעה לפני משחק ריאל",
      canonical_query: "Real Madrid La Liga fixtures",
      objectives: [
        { kind: "time_before_event", minutes_before: 60 },
        { kind: "discover_new" },
      ],
    });
    expect(parsed?.objectives[0]).toMatchObject({
      kind: "time_before_event",
      minutesBefore: 60,
    });
    expect(parsed?.objectives[0]?.id).toMatch(/^o0_/);
  });

  it("rejects missing objectives", () => {
    expect(
      parseComposeCondition({
        type: "web_monitor",
        intent: "x",
        canonical_query: "y",
        objectives: [],
      }),
    ).toBeNull();
  });

  it("rejects unknown objective kind", () => {
    expect(
      parseComposeCondition({
        type: "web_monitor",
        intent: "x",
        canonical_query: "y",
        objectives: [{ kind: "lottery_draw" }],
      }),
    ).toBeNull();
  });

  it("rejects time_before_event without minutes", () => {
    expect(
      parseComposeCondition({
        type: "web_monitor",
        intent: "x",
        canonical_query: "y",
        objectives: [{ kind: "time_before_event" }],
      }),
    ).toBeNull();
  });

  it("rejects missing intent or query", () => {
    expect(
      parseComposeCondition({
        type: "web_monitor",
        canonical_query: "y",
        objectives: [{ kind: "discover_new" }],
      }),
    ).toBeNull();
  });

  it("keeps existing typed conditions working", () => {
    expect(
      parseComposeCondition({ type: "market_price", op: "lt", value: 10 }),
    ).toEqual({ type: "market_price", op: "lt", value: 10 });
    expect(
      parseComposeCondition({
        type: "sports_match",
        team: "Real Madrid",
        minutes_before: 60,
        competition: "La Liga",
      }),
    ).toMatchObject({ type: "sports_match", team: "Real Madrid" });
  });
});
