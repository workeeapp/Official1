/**
 * Offline isolation + injection checks for attachment-intent model eval.
 * No OpenAI calls.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkConstraint } from "../src/eval/constraints.js";
import {
  buildAttachmentIntentUserMessage,
  loadAttachmentIntentCorpus,
} from "../src/eval/run-attachment-intent.js";
import { emptyLlmMetadata, parseLlmMetadata } from "@workee/shared";
import { NEW_ATTACHMENTS_MARKER } from "../src/services/attachment.service.js";

describe("attachment-intent runner (offline)", () => {
  it("corpus loads with the six focused cases", () => {
    const corpus = loadAttachmentIntentCorpus();
    expect(corpus.cases.map((row) => row.id).sort()).toEqual(
      [
        "att-ambiguous",
        "att-deferred-after-lucy",
        "att-filing",
        "att-item-default",
        "att-no-intent",
        "att-rishon",
      ].sort(),
    );
  });

  it("injects new_attachments, PENDING_ATTACHMENTS, and LAST_NUMBERED_DUMP into the user message", () => {
    const message = buildAttachmentIntentUserMessage({
      speaker: "טל",
      utterance: "תצרפי לראשון",
      setup: {
        lists: [
          {
            list_id: "eval-att-list-driving",
            list_type: "custom",
            list_name: "שיעורי הנהיגה",
            owner: "טל",
            scope: "personal",
            items: [
              { item_id: "eval-att-item-dani", "שם פריט": "שיעור עם דני" },
            ],
          },
        ],
      },
      newAttachments: [
        {
          attachment_id: "11111111-1111-4111-8111-111111111111",
          kind: "image",
          file_name: "a.jpg",
        },
      ],
      pendingAttachments: [
        {
          attachment_id: "11111111-1111-4111-8111-111111111111",
          kind: "image",
          file_name: "a.jpg",
        },
        {
          attachment_id: "33333333-3333-4333-8333-333333333333",
          kind: "document",
          file_name: "old.pdf",
        },
      ],
      lastNumberedDump: [
        {
          n: 1,
          id: "eval-att-item-dani",
          kind: "custom",
          title_stem: "שיעור עם דני",
        },
      ],
    });
    expect(message).toContain(NEW_ATTACHMENTS_MARKER);
    expect(message).toContain("new_attachments");
    expect(message).toContain("11111111-1111-4111-8111-111111111111");
    expect(message).toContain("PENDING_ATTACHMENTS:");
    expect(message).toContain("33333333-3333-4333-8333-333333333333");
    // Current-turn id is filtered out of PENDING (matches production chat.service).
    expect(message.match(/33333333-3333-4333-8333-333333333333/g)?.length).toBe(
      1,
    );
    expect(message).toContain("LAST_NUMBERED_DUMP:");
    expect(message).toContain("eval-att-item-dani");
    expect(message).toContain("טל: תצרפי לראשון");
  });

  it("lists_attach_item_ids and filing_attach_ids constraints score ACTION shape", () => {
    const att = "11111111-1111-4111-8111-111111111111";
    const itemMeta = parseLlmMetadata({
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "update",
          list_type: "custom",
          list_name: "שיעורי הנהיגה",
          items: [{ item_id: "eval-att-item-dani", attachment_ids: [att] }],
          targets: [],
        },
      ],
    });
    expect(
      checkConstraint(
        {
          type: "lists_attach_item_ids",
          action: "update",
          listType: "custom",
          itemIds: ["eval-att-item-dani"],
          attachmentIds: [att],
        },
        itemMeta,
        "ok",
      ),
    ).toBeNull();

    const filingMeta = parseLlmMetadata({
      ...emptyLlmMetadata(),
      filing: [
        {
          action: "add_filing",
          item_name: "רישיון",
          item_info: "",
          item_description: "",
          attachment_ids: [att],
        },
      ],
    });
    expect(
      checkConstraint(
        {
          type: "filing_attach_ids",
          action: "add_filing",
          attachmentIds: [att],
        },
        filingMeta,
        "ok",
      ),
    ).toBeNull();
  });

  it("runner module stays model-only (no apply / WhatsApp / reminder-fire imports)", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/eval/run-attachment-intent.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/applyEmployeeRecords|sendWhatsApp|reminder-fire|sync-lucy|prisma\.|notifyShared/);
    expect(src).toMatch(/createResponse/);
    expect(src).toMatch(/productionApply: false/);
  });
});
