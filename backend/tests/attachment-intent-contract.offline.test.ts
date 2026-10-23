/**
 * STUB CONTRACT ONLY — documents the Stage-1 DESTINATION LADDER expectations
 * for ambiguous vs clear attach intents. Does NOT call OpenAI and is NOT proof
 * that a live model follows the prompt; production apply is covered separately
 * in attachment-apply.eval-db.test.ts.
 *
 * Run with default vitest (no DB required):
 *   npx vitest run tests/attachment-intent-contract.offline.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  checkConstraint,
  type ModelEvalConstraint,
} from "../src/eval/constraints.js";
import { emptyLlmMetadata, parseLlmMetadata } from "@workee/shared";

function meta(partial: Record<string, unknown>) {
  return parseLlmMetadata({ ...emptyLlmMetadata(), ...partial });
}

function assertConstraints(
  constraints: ModelEvalConstraint[],
  metadata: ReturnType<typeof parseLlmMetadata>,
  response: string,
) {
  for (const row of constraints) {
    const fail = checkConstraint(row, metadata, response);
    expect(fail, fail ?? undefined).toBeNull();
  }
}

describe("attachment intent stub-contract (not live model proof)", () => {
  it("ambiguous bare תתייקי + files → empty mutates + ask-like response", () => {
    assertConstraints(
      [
        { type: "mutations_empty_or_read_only" },
        { type: "response_looks_like_ask" },
      ],
      meta({}),
      "לשמור ברשימה עצמה, בפריט מסוים, או כתיוק חדש?",
    );
  });

  it("no caption / no clear context → ask, empty mutates", () => {
    assertConstraints(
      [
        { type: "mutations_empty_or_read_only" },
        { type: "response_looks_like_ask" },
      ],
      meta({}),
      "איך לתייק את 2 התמונות?",
    );
  });

  it("explicit list shell stub uses list_ops add_attachments — not tasks/filing invent", () => {
    const metadata = meta({
      list_ops: [
        {
          action: "alter_list",
          list_id: "00000000-0000-4000-8000-000000000001",
          add_attachments: ["11111111-1111-4111-8111-111111111111"],
        },
      ],
    });
    // Shape of the stub ACTION we teach (not live-model proof):
    expect(metadata.lists).toHaveLength(0);
    expect(metadata.filing).toHaveLength(0);
    expect(metadata.listOps?.[0]?.action).toBe("alter_list");
    expect(metadata.listOps?.[0]?.addAttachments?.length).toBe(1);
  });

  it("explicit new filing stub has filing add + attachment_ids", () => {
    const metadata = meta({
      filing: [
        {
          action: "add_filing",
          item_name: "רישיון נהיגה",
          item_info: "",
          item_description: "",
          attachment_ids: ["11111111-1111-4111-8111-111111111111"],
        },
      ],
    });
    expect(metadata.filing?.[0]?.action).toBe("add_filing");
    expect(metadata.filing?.[0]?.attachmentIds?.length).toBe(1);
    expect(metadata.lists).toHaveLength(0);
  });

  it("accidental task prevention: bare save stub must not include tasks add", () => {
    const ambiguous = meta({});
    expect(
      ambiguous.lists.some(
        (row) => row.action === "add" && row.listType === "tasks",
      ),
    ).toBe(false);
  });
});
