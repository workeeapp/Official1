/**
 * M2 plumbing: WhatsApp's own message time (`timestamp`) and the media SHA-256
 * from the webhook are carried on the inbound message. Pass-through only —
 * batching and every user-visible behavior are unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  extractInboundTexts,
  readInboundMedia,
  readWhatsAppTimestamp,
} from "../src/services/whatsapp.service.js";

function webhook(messages: unknown[]) {
  return { entry: [{ changes: [{ value: { messages } }] }] };
}

describe("WhatsApp inbound metadata pass-through", () => {
  it("reads the webhook timestamp (Unix seconds) as ISO time", () => {
    expect(readWhatsAppTimestamp("1762650000")).toBe("2025-11-09T01:00:00.000Z");
    expect(readWhatsAppTimestamp(1762650000)).toBe("2025-11-09T01:00:00.000Z");
    expect(readWhatsAppTimestamp(" 1762650000 ")).toBe("2025-11-09T01:00:00.000Z");
  });

  it("ignores a missing or malformed timestamp", () => {
    for (const raw of [undefined, null, "", "abc", "12", "1762650000.5", {}, "99999999999999"]) {
      expect(readWhatsAppTimestamp(raw)).toBeUndefined();
    }
  });

  it("carries sentAt on text and media messages; absent when WhatsApp sent none", () => {
    const [text, doc, bare] = extractInboundTexts(
      webhook([
        { id: "m1", from: "972500000001", timestamp: "1762650000", type: "text", text: { body: "היי" } },
        {
          id: "m2",
          from: "972500000001",
          timestamp: "1762650003",
          type: "document",
          document: { id: "media-2", mime_type: "application/pdf", filename: "ticket-2.pdf", sha256: "abc123==" },
        },
        { id: "m3", from: "972500000001", type: "text", text: { body: "בלי זמן" } },
      ]),
    );
    expect(text?.sentAt).toBe("2025-11-09T01:00:00.000Z");
    expect(doc?.sentAt).toBe("2025-11-09T01:00:03.000Z");
    expect(bare && "sentAt" in bare).toBe(false);
  });

  it("carries the media sha256 when present; omits it when absent", () => {
    const withHash = readInboundMedia({
      type: "image",
      image: { id: "media-1", mime_type: "image/jpeg", sha256: "  xyz==  ", caption: "" },
    });
    expect(withHash?.sha256).toBe("xyz==");
    const without = readInboundMedia({
      type: "document",
      document: { id: "media-2", mime_type: "application/pdf", filename: "a.pdf" },
    });
    expect(without && "sha256" in without).toBe(false);
  });

  it("everything else about the message is unchanged", () => {
    const [doc] = extractInboundTexts(
      webhook([
        {
          id: "m2",
          from: "972500000001",
          timestamp: "1762650003",
          type: "document",
          document: { id: "media-2", mime_type: "application/pdf", filename: "ticket-2.pdf", caption: "כרטיס", sha256: "h" },
        },
      ]),
    );
    expect(doc).toEqual({
      from: "972500000001",
      text: "כרטיס",
      messageId: "m2",
      sentAt: "2025-11-09T01:00:03.000Z",
      media: {
        kind: "document",
        mediaId: "media-2",
        mimeType: "application/pdf",
        caption: "כרטיס",
        fileName: "ticket-2.pdf",
        voice: false,
        sha256: "h",
      },
    });
  });
});
