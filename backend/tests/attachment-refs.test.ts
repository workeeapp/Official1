import { beforeEach, describe, expect, it, vi } from "vitest";

const { linkFindMany } = vi.hoisted(() => ({
  linkFindMany: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    attachmentLink: { findMany: linkFindMany },
  },
}));

import { withAttachmentRefs } from "../src/services/attachment.service.js";

const listId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const itemId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const listAttId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const itemAttId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function attachment(id: string, kind = "image") {
  return {
    id,
    kind,
    fileName: "pic.jpg",
    deletedAt: null,
  };
}

describe("withAttachmentRefs has_attachments", () => {
  beforeEach(() => {
    linkFindMany.mockReset();
  });

  it("does not set has_attachments when only an item has files", async () => {
    linkFindMany.mockResolvedValue([
      {
        listId: null,
        listItemId: itemId,
        filingId: null,
        reminderId: null,
        createdAt: new Date(),
        attachment: attachment(itemAttId),
      },
    ]);

    const snapshot = await withAttachmentRefs({
      lists: [
        {
          list_id: listId,
          items: [{ item_id: itemId, "שם מטלה": "להתקשר" }],
        },
      ],
      filing: [],
    });

    expect(snapshot.lists[0]).not.toHaveProperty("has_attachments");
    expect(snapshot.lists[0]).not.toHaveProperty("attachments");
    expect(snapshot.lists[0]?.items[0]).toMatchObject({
      attachments: [{ attachment_id: itemAttId, kind: "image", file_name: "pic.jpg" }],
    });
  });

  it("sets has_attachments when the list itself has files", async () => {
    linkFindMany.mockResolvedValue([
      {
        listId,
        listItemId: null,
        filingId: null,
        reminderId: null,
        createdAt: new Date(),
        attachment: attachment(listAttId),
      },
    ]);

    const snapshot = await withAttachmentRefs({
      lists: [
        {
          list_id: listId,
          items: [{ item_id: itemId, "שם מטלה": "להתקשר" }],
        },
      ],
      filing: [],
    });

    expect(snapshot.lists[0]).toMatchObject({
      has_attachments: true,
      attachments: [{ attachment_id: listAttId, kind: "image", file_name: "pic.jpg" }],
    });
    expect(snapshot.lists[0]?.items[0]).not.toHaveProperty("attachments");
  });
});
