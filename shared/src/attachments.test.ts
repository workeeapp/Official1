import { describe, expect, it } from "vitest";
import {
  attachmentContentUrl,
  parseAttachmentIds,
  parseAttachmentKind,
  parseChatAttachmentRefs,
} from "./attachments.js";
import { parseReplyMetadata } from "./llm-message.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("attachment helpers", () => {
  it("dedupes and trims ids, ignoring non-strings", () => {
    expect(parseAttachmentIds([` ${A} `, A, "", 3, null, B])).toEqual([A, B]);
    expect(parseAttachmentIds("nope")).toEqual([]);
  });

  it("reads known kinds only", () => {
    expect(parseAttachmentKind("image")).toBe("image");
    expect(parseAttachmentKind("location")).toBeNull();
    expect(parseAttachmentKind(undefined)).toBeNull();
  });

  it("keeps only well-formed saved chat refs", () => {
    expect(
      parseChatAttachmentRefs([
        { id: A, kind: "image", file_name: "" },
        { id: B, kind: "document", file_name: "a.pdf" },
        { id: "", kind: "image" },
        { id: A, kind: "location" },
        "x",
      ]),
    ).toEqual([
      { id: A, kind: "image", file_name: "" },
      { id: B, kind: "document", file_name: "a.pdf" },
    ]);
  });

  it("builds the content URL", () => {
    expect(attachmentContentUrl(A)).toBe(`/api/attachments/${A}/content`);
  });
});

describe("attachment fields in the ACTION", () => {
  it("parses send_attachments, list, list_ops, filing and reminder ids", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        response: "",
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              list_attachment_ids: [A],
              items: [{ "שם פריט": "מיץ", attachment_ids: [B] }],
            },
          ],
          list_ops: [
            { action: "alter_list", list_id: "l1", add_attachments: [A], remove_attachments: [B] },
          ],
          filing: [
            {
              action: "add_filing",
              item_name: "תמונות מהחתונה בתאילנד",
              item_info: "2 תמונות",
              item_description: "תמונות מהחתונה בתאילנד",
              attachment_ids: [A, B],
            },
          ],
          reminders: [
            {
              action: "add",
              item: "להתקשר לרן",
              in: 7200,
              attachment_ids: [A],
              detach_attachment_ids: [B],
            },
          ],
          send_attachments: [A, A, B],
        },
      }),
    );
    expect(meta.sendAttachments).toEqual([A, B]);
    expect(meta.lists[0]?.listAttachmentIds).toEqual([A]);
    expect(meta.lists[0]?.items[0]).toMatchObject({ attachment_ids: [B] });
    expect(meta.listOps[0]).toMatchObject({ addAttachments: [A], removeAttachments: [B] });
    expect(meta.filing[0]).toMatchObject({ attachmentIds: [A, B] });
    expect(meta.reminders?.[0]).toMatchObject({
      attachmentIds: [A],
      detachAttachmentIds: [B],
    });
  });

  it("omits attachment fields when the model sent none", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        response: "",
        metadata: {
          lists: [{ action: "add", list_type: "shopping", items: [{ "שם פריט": "חלב" }] }],
          send_attachments: [],
        },
      }),
    );
    expect(meta).not.toHaveProperty("sendAttachments");
    expect(meta.lists[0]).not.toHaveProperty("listAttachmentIds");
  });
});
