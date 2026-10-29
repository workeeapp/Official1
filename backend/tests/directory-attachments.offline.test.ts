import { describe, expect, it } from "vitest";
import { parseLlmMetadata } from "@workee/shared";
import {
  collectAttachmentIdsForDumpRows,
  loadAttachmentRefs,
} from "../src/services/attachment.service.js";
import { formatPhoneBookDump } from "../src/services/show-button-dump.js";
import { loadLlmConfig } from "../src/config/llm.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("directory / phone-book attachments (generic row parity)", () => {
  it("parses directory attachment_ids / detach_attachment_ids like other domains", () => {
    const meta = parseLlmMetadata({
      directory: [
        {
          action: "update",
          name: "מיכל",
          phone: "0501234567",
          contact_id: "c-1",
          attachment_ids: ["a-1", "a-2"],
          detach_attachment_ids: ["a-0"],
        },
      ],
    });
    expect(meta.directory).toEqual([
      expect.objectContaining({
        action: "update",
        contactId: "c-1",
        attachmentIds: ["a-1", "a-2"],
        detachAttachmentIds: ["a-0"],
      }),
    ]);
  });

  it("phone_book dump appends 📎 when the contact row has attachments", () => {
    const dump = formatPhoneBookDump([
      {
        contact_id: "c-meet",
        name: "מיכל",
        phone: "0501111111",
        scope: "personal",
        attachments: [
          { attachment_id: "att-1", kind: "image", file_name: "card.jpg" },
        ],
      },
    ]);
    expect(dump.text).toContain("מיכל");
    expect(dump.text).toContain("📎");
    expect(dump.lines).toEqual([
      expect.objectContaining({ id: "c-meet", kind: "phone_book" }),
    ]);
  });

  it("collectAttachmentIdsForDumpRows reads phone-book extras by contact_id", () => {
    const ids = collectAttachmentIdsForDumpRows(
      { lists: [], filing: [], reminders: [] },
      ["c-meet"],
      10,
      [
        {
          id: "c-meet",
          attachments: [{ attachment_id: "att-9", kind: "document" }],
        },
      ],
    );
    expect(ids).toEqual(["att-9"]);
  });

  it("loadAttachmentRefs exposes a contacts map (same API as other targets)", () => {
    // Shape contract — empty input yields empty contacts map without throwing.
    return loadAttachmentRefs({}).then((refs) => {
      expect(refs.contacts).toBeInstanceOf(Map);
      expect(refs.contacts.size).toBe(0);
    });
  });

  it("prompts teach generic directory attachment_ids (no SPEAKER_CONTACTS 📎 ban)", () => {
    const config = loadLlmConfig(repoRoot);
    const text = config.systemMessage;
    expect(text).toContain("attachment_ids / detach_attachment_ids on directory");
    expect(text).toContain("every dump domain that carries attachment_ids");
    expect(text).not.toContain("not directory this iteration");
    expect(text).not.toContain("FORBIDDEN 📎 on SPEAKER_CONTACTS");
  });
});
