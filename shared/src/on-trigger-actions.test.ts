import { describe, expect, it } from "vitest";
import { parseOnTriggerActions, parseLlmMetadata } from "./llm-message.js";

describe("parseOnTriggerActions", () => {
  it("parses nested lists.add with static mode", () => {
    const parsed = parseOnTriggerActions({
      lists: [
        {
          action: "add",
          list_type: "shopping",
          items: [{ "שם פריט": "חלב" }],
          targets: [],
          mode: "static",
        },
      ],
    });
    expect(parsed?.lists).toHaveLength(1);
    expect(parsed?.lists[0]?.action).toBe("add");
    expect(parsed?.lists[0]?.mode).toBe("static");
  });

  it("parses event_bound binds and explicit null clear", () => {
    const bound = parseOnTriggerActions({
      lists: [
        {
          action: "update",
          list_type: "shopping",
          items: [{ item_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }],
          targets: [],
          mode: "event_bound",
          binds: { "items.0.מחיר": "market.price" },
        },
      ],
    });
    expect(bound?.lists[0]?.mode).toBe("event_bound");
    expect(bound?.lists[0]?.binds?.["items.0.מחיר"]).toBe("market.price");
    expect(parseOnTriggerActions(null)).toBeNull();
  });

  it("wires through reminder metadata parse", () => {
    const meta = parseLlmMetadata({
      lists: [],
      reminders: [
        {
          action: "add",
          item: "watch",
          list_type: "tasks",
          compose_condition: { type: "market_price", op: "lt", value: 100 },
          on_trigger_actions: {
            lists: [
              {
                action: "add",
                list_type: "shopping",
                items: [{ "שם פריט": "X" }],
                targets: [],
              },
            ],
          },
        },
      ],
    });
    expect(meta.reminders?.[0]?.onTriggerActions?.lists).toHaveLength(1);
  });
});
