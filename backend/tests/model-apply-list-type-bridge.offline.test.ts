/**
 * Harness bridge: already-normalized LlmMetadata (camelCase listType) must
 * survive the MODEL_APPLY re-parse without collapsing to custom.
 * Shared toListAction fix is separate (server); this keeps LIVE_FULL usable.
 */
import { describe, expect, it } from "vitest";
import { parseLlmMetadata, parseReplyMetadata } from "@workee/shared";
import { bridgeListTypeAliasesForParse } from "../src/eval/run-model-apply.js";

describe("bridgeListTypeAliasesForParse (harness)", () => {
  it("keeps shopping after parseReplyMetadata → bridge → parseLlmMetadata", () => {
    const once = parseReplyMetadata(
      JSON.stringify({
        responses: ["הוספתי חלב לרשימת הקניות שלך."],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              list_name: "",
              items: [{ "שם פריט": "חלב" }],
            },
          ],
          messages: [],
          jobs: [],
          directory: [],
          handoff: null,
          confirm: null,
          targets: [],
        },
      }),
    );
    expect(once.lists[0]?.listType).toBe("shopping");

    const twice = parseLlmMetadata(bridgeListTypeAliasesForParse(once));
    expect(twice.lists[0]?.listType).toBe("shopping");
  });

  it("keeps tasks after the same double-parse path", () => {
    const once = parseReplyMetadata(
      JSON.stringify({
        responses: ["הוספתי"],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "tasks",
              list_name: "",
              items: [{ "שם מטלה": "לבקר את אמא" }],
            },
          ],
        },
      }),
    );
    expect(once.lists[0]?.listType).toBe("tasks");
    const twice = parseLlmMetadata(bridgeListTypeAliasesForParse(once));
    expect(twice.lists[0]?.listType).toBe("tasks");
  });

  it("leaves snake-case stubs unchanged", () => {
    const bridged = bridgeListTypeAliasesForParse({
      lists: [
        {
          action: "add",
          list_type: "shopping",
          items: [{ "שם פריט": "חלב" }],
        },
      ],
    }) as { lists: Array<{ list_type?: string }> };
    expect(bridged.lists[0]?.list_type).toBe("shopping");
    expect(parseLlmMetadata(bridged).lists[0]?.listType).toBe("shopping");
  });
});
