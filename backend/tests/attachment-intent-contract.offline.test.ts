/**
 * STUB CONTRACT ONLY — documents DESTINATION LADDER expectations for attach
 * intents (Cases 1–3 + continuity). Does NOT call OpenAI and is NOT proof that
 * a live model follows the prompt; production apply is in
 * attachment-apply.eval-db.test.ts.
 *
 * Run: npx vitest run tests/attachment-intent-contract.offline.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  checkConstraint,
  type ModelEvalConstraint,
} from "../src/eval/constraints.js";
import { emptyLlmMetadata, parseLlmMetadata } from "@workee/shared";

const ATT_ID = "11111111-1111-4111-8111-111111111111";
const LIST_ID = "00000000-0000-4000-8000-000000000001";
const ITEM_1 = "11111111-1111-4111-8111-111111111101";
const ITEM_2 = "11111111-1111-4111-8111-111111111102";
const ITEM_3 = "11111111-1111-4111-8111-111111111103";

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

function forbidFilingAndAlterList(
  metadata: ReturnType<typeof parseLlmMetadata>,
) {
  expect(metadata.filing ?? []).toHaveLength(0);
  expect(metadata.listOps ?? []).toHaveLength(0);
}

describe("attachment intent stub-contract (not live model proof)", () => {
  it("ambiguous bare תתייקי + files → empty mutates + ask-like response", () => {
    assertConstraints(
      [
        { type: "mutations_empty_or_read_only" },
        { type: "response_looks_like_ask" },
      ],
      meta({}),
      "לאן לתייק — תיוקים, רשימה, או פריט?",
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

  it("Case 1: unique custom list + identifiable item → update item + attachment_ids (not filing)", () => {
    const metadata = meta({
      lists: [
        {
          action: "update",
          list_type: "custom",
          list_name: "שיעורי הנהיגה",
          items: [
            {
              item_id: ITEM_1,
              attachment_ids: [ATT_ID],
            },
          ],
          targets: [],
        },
      ],
    });
    expect(metadata.lists).toHaveLength(1);
    expect(metadata.lists[0]?.action).toBe("update");
    expect(metadata.lists[0]?.listType).toBe("custom");
    const item = metadata.lists[0]?.items?.[0] as Record<string, unknown>;
    expect(item?.item_id ?? item?.itemId).toBe(ITEM_1);
    forbidFilingAndAlterList(metadata);
  });

  it("Case 1: unique custom list + item unclear → empty mutates + ask which item", () => {
    assertConstraints(
      [
        { type: "mutations_empty_or_read_only" },
        { type: "response_looks_like_ask" },
      ],
      meta({}),
      "לאיזה פריט ברשימת שיעורי הנהיגה לצרף את התמונה?",
    );
  });

  it("Case 1: explicit list-level → alter_list add_attachments — not filing", () => {
    const metadata = meta({
      list_ops: [
        {
          action: "alter_list",
          list_id: LIST_ID,
          add_attachments: [ATT_ID],
        },
      ],
    });
    expect(metadata.lists).toHaveLength(0);
    expect(metadata.filing).toHaveLength(0);
    expect(metadata.listOps?.[0]?.action).toBe("alter_list");
    expect(metadata.listOps?.[0]?.addAttachments?.length).toBe(1);
  });

  it("Case 1: explicit filings → filing add + attachment_ids", () => {
    const metadata = meta({
      filing: [
        {
          action: "add_filing",
          item_name: "רישיון נהיגה",
          item_info: "",
          item_description: "",
          attachment_ids: [ATT_ID],
        },
      ],
    });
    expect(metadata.filing?.[0]?.action).toBe("add_filing");
    expect(metadata.filing?.[0]?.attachmentIds?.length).toBe(1);
    expect(metadata.lists).toHaveLength(0);
  });

  it("Case 1 multi-turn: deferred file completes item attach with PENDING ids", () => {
    const metadata = meta({
      lists: [
        {
          action: "update",
          list_type: "custom",
          list_name: "שיעורי הנהיגה",
          items: [{ item_id: ITEM_2, attachment_ids: [ATT_ID] }],
          targets: [],
        },
      ],
    });
    forbidFilingAndAlterList(metadata);
    expect(metadata.lists[0]?.action).toBe("update");
  });

  it("Scenario 6: intervening Lucy ack does not invent attach — empty until USER+file ACTION", () => {
    // Documents: automated assistant turns are not save intent; stub stays empty.
    assertConstraints(
      [{ type: "mutations_empty_or_read_only" }],
      meta({}),
      "מעולה, שלח את הקובץ כשתהיה מוכן.",
    );
  });

  it("Case 2: no save intent (bare forward) → empty mutates", () => {
    assertConstraints(
      [{ type: "mutations_empty_or_read_only" }],
      meta({}),
      "קיבלתי את ההודעה.",
    );
  });

  it("Case 2: explicit save with filings title → filing + ids", () => {
    const metadata = meta({
      filing: [
        {
          action: "add_filing",
          item_name: "הודעת מורה",
          item_info: "",
          item_description: "",
          attachment_ids: [ATT_ID],
        },
      ],
    });
    expect(metadata.filing?.[0]?.attachmentIds).toEqual([ATT_ID]);
  });

  it("Case 3: lines 1–3 → update three item_ids + same attachment_ids", () => {
    const metadata = meta({
      lists: [
        {
          action: "update",
          list_type: "custom",
          list_name: "שיעורי הנהיגה",
          items: [
            { item_id: ITEM_1, attachment_ids: [ATT_ID] },
            { item_id: ITEM_2, attachment_ids: [ATT_ID] },
            { item_id: ITEM_3, attachment_ids: [ATT_ID] },
          ],
          targets: [],
        },
      ],
    });
    forbidFilingAndAlterList(metadata);
    expect(metadata.lists[0]?.items).toHaveLength(3);
  });

  it("Case 3: missing/stale dump → empty mutates + ask", () => {
    assertConstraints(
      [
        { type: "mutations_empty_or_read_only" },
        { type: "response_looks_like_ask" },
      ],
      meta({}),
      "הציגי שוב את רשימת שיעורי הנהיגה כדי שאצרף לפי מספרים?",
    );
  });

  it("STABLE REFS: הראשון after dump → update dump line-1 item_id + attachment_ids (not last-mentioned invent)", () => {
    const metadata = meta({
      lists: [
        {
          action: "update",
          list_type: "custom",
          list_name: "שיעורי הנהיגה",
          items: [{ item_id: ITEM_1, attachment_ids: [ATT_ID] }],
          targets: [],
        },
      ],
    });
    forbidFilingAndAlterList(metadata);
    const item = metadata.lists[0]?.items?.[0] as Record<string, unknown>;
    expect(item?.item_id ?? item?.itemId).toBe(ITEM_1);
  });

  it("accidental task prevention: bare save stub must not include tasks add", () => {
    const ambiguous = meta({});
    expect(
      ambiguous.lists.some(
        (row) => row.action === "add" && row.listType === "tasks",
      ),
    ).toBe(false);
  });

  it("explicit list shell stub uses list_ops add_attachments — not tasks/filing invent", () => {
    const metadata = meta({
      list_ops: [
        {
          action: "alter_list",
          list_id: LIST_ID,
          add_attachments: [ATT_ID],
        },
      ],
    });
    expect(metadata.lists).toHaveLength(0);
    expect(metadata.filing).toHaveLength(0);
    expect(metadata.listOps?.[0]?.action).toBe("alter_list");
    expect(metadata.listOps?.[0]?.addAttachments?.length).toBe(1);
  });
});
