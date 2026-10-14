import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import type { LlmReminderAction } from "@workee/shared";
import { createApp } from "../src/app.js";
import {
  attachmentStorageKey,
  extensionForMime,
  LocalDiskStorage,
} from "../src/services/attachment-storage.js";
import {
  formatNewAttachmentsBlock,
  formatPendingAttachmentsContext,
  isInlineSafeMime,
  NEW_ATTACHMENTS_MARKER,
  toChatAttachmentRef,
} from "../src/services/attachment.service.js";
import { splitItemAttachments } from "../src/services/employee-records.service.js";
import { toResponsesInput } from "../src/services/llm-client.js";
import { isAttachmentOnlyReminderUpdate } from "../src/services/reminder.service.js";
import { createInboundBatcher } from "../src/services/whatsapp-inbound-batch.js";
import { whatsappMediaBody } from "../src/services/whatsapp-send.js";
import {
  batchSpokenText,
  extractInboundTexts,
  readInboundMedia,
} from "../src/services/whatsapp.service.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function webhook(messages: unknown[]) {
  return { entry: [{ changes: [{ value: { messages } }] }] };
}

describe("inbound WhatsApp media", () => {
  it("reads an image with its caption as the spoken text", () => {
    expect(
      extractInboundTexts(
        webhook([
          {
            id: "wamid.img",
            from: "972501234567",
            type: "image",
            image: { id: "m1", mime_type: "image/jpeg", caption: " תוסיפי מיץ לרשימת קניות " },
          },
        ]),
      ),
    ).toEqual([
      {
        from: "972501234567",
        text: "תוסיפי מיץ לרשימת קניות",
        messageId: "wamid.img",
        media: {
          kind: "image",
          mediaId: "m1",
          mimeType: "image/jpeg",
          caption: "תוסיפי מיץ לרשימת קניות",
          fileName: "",
          voice: false,
        },
      },
    ]);
  });

  it("keeps a caption-less file as a media-only message", () => {
    const [message] = extractInboundTexts(
      webhook([
        {
          id: "wamid.doc",
          from: "972501234567",
          type: "document",
          document: { id: "m2", mime_type: "application/pdf", filename: "חוזה.pdf" },
        },
      ]),
    );
    expect(message?.text).toBe("");
    expect(message?.media).toMatchObject({ kind: "document", fileName: "חוזה.pdf" });
  });

  it("marks voice notes and ignores unsupported or id-less media", () => {
    expect(
      readInboundMedia({
        type: "audio",
        audio: { id: "m3", mime_type: "audio/ogg; codecs=opus", voice: true },
      }),
    ).toMatchObject({ kind: "audio", voice: true });
    expect(readInboundMedia({ type: "location", location: { latitude: 1 } })).toBeUndefined();
    expect(readInboundMedia({ type: "image", image: { mime_type: "image/png" } })).toBeUndefined();
  });

  it("uses typed text first and the voice transcript only when there is none", () => {
    expect(batchSpokenText([{ text: "" }, { text: "תייקי תחת חתונה" }], ["שלום"])).toBe(
      "תייקי תחת חתונה",
    );
    expect(batchSpokenText([{ text: "" }], [" תזכירי לי להתקשר לרן "])).toBe(
      "תזכירי לי להתקשר לרן",
    );
  });
});

describe("inbound batcher", () => {
  function harness(idleMs = 3000, maxMs = 15000) {
    let clock = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let nextId = 1;
    const flushed: Array<{ phone: string; messages: string[] }> = [];
    const batcher = createInboundBatcher<string>({
      idleMs,
      maxMs,
      flush: (phone, messages) => flushed.push({ phone, messages }),
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { at: clock + ms, fn });
        return id;
      },
      clearTimer: (handle) => timers.delete(handle as number),
      now: () => clock,
    });
    const advance = (ms: number) => {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(id);
          timer.fn();
        }
      }
    };
    return { batcher, flushed, advance };
  }

  it("passes plain text straight through when no batch is open", () => {
    const { batcher, flushed } = harness();
    expect(batcher.offer("p", "שלום", false)).toBe(false);
    expect(flushed).toEqual([]);
  });

  it("collects files and the following text until the phone is quiet", () => {
    const { batcher, flushed, advance } = harness();
    expect(batcher.offer("p", "img1", true)).toBe(true);
    advance(1000);
    expect(batcher.offer("p", "img2", true)).toBe(true);
    advance(2000);
    expect(batcher.offer("p", "תייקי", false)).toBe(true);
    expect(batcher.pending("p")).toBe(3);
    advance(2999);
    expect(flushed).toEqual([]);
    advance(1);
    expect(flushed).toEqual([{ phone: "p", messages: ["img1", "img2", "תייקי"] }]);
    expect(batcher.pending("p")).toBe(0);
  });

  it("flushes at the hard cap even while files keep arriving", () => {
    const { batcher, flushed, advance } = harness(3000, 5000);
    batcher.offer("p", "a", true);
    advance(2500);
    batcher.offer("p", "b", true);
    advance(2500);
    expect(flushed).toEqual([{ phone: "p", messages: ["a", "b"] }]);
  });

  it("keeps phones separate", () => {
    const { batcher, flushed, advance } = harness();
    batcher.offer("p1", "a", true);
    expect(batcher.offer("p2", "text", false)).toBe(false);
    advance(3000);
    expect(flushed).toEqual([{ phone: "p1", messages: ["a"] }]);
  });
});

describe("outbound WhatsApp media body", () => {
  it("sends a document with caption and file name", () => {
    expect(
      whatsappMediaBody("972501234567", {
        kind: "document",
        mediaId: "out1",
        caption: "החוזה",
        fileName: "חוזה.pdf",
      }),
    ).toEqual({
      messaging_product: "whatsapp",
      to: "972501234567",
      type: "document",
      document: { id: "out1", caption: "החוזה", filename: "חוזה.pdf" },
    });
  });

  it("drops captions on audio and stickers", () => {
    expect(
      whatsappMediaBody("972501234567", { kind: "audio", mediaId: "a", caption: "x" }),
    ).toMatchObject({ audio: { id: "a" } });
    expect(
      whatsappMediaBody("972501234567", { kind: "sticker", mediaId: "s", caption: "x" }),
    ).toMatchObject({ sticker: { id: "s" } });
  });
});

describe("model input with images", () => {
  it("stays a plain string without images", () => {
    expect(toResponsesInput("שלום")).toBe("שלום");
    expect(toResponsesInput("שלום", [])).toBe("שלום");
  });

  it("adds input_image parts after the text", () => {
    expect(toResponsesInput("מה בתמונה?", ["data:image/jpeg;base64,AAA"])).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "מה בתמונה?" },
          { type: "input_image", image_url: "data:image/jpeg;base64,AAA", detail: "auto" },
        ],
      },
    ]);
  });
});

describe("attachment facts", () => {
  it("formats the new-files block and stays empty without files", () => {
    expect(formatNewAttachmentsBlock([])).toBe("");
    const block = formatNewAttachmentsBlock([{ attachment_id: A, kind: "image" }]);
    expect(block.startsWith(NEW_ATTACHMENTS_MARKER)).toBe(true);
    expect(block).toContain(A);
    expect(formatPendingAttachmentsContext([])).toBe("");
    expect(formatPendingAttachmentsContext([{ attachment_id: B, kind: "video" }])).toContain(B);
  });

  it("builds a chat ref from a row", () => {
    expect(toChatAttachmentRef({ id: A, kind: "image", fileName: "" })).toEqual({
      id: A,
      kind: "image",
      file_name: "",
    });
  });
});

describe("attachment ids on ACTION items", () => {
  it("strips link keys so they never become item data", () => {
    expect(
      splitItemAttachments({
        "שם פריט": "מיץ",
        attachment_ids: [A, A],
        detach_attachment_ids: [B],
      }),
    ).toEqual({ item: { "שם פריט": "מיץ" }, attach: [A], detach: [B] });
  });
});

describe("attach-only reminder updates", () => {
  const base: LlmReminderAction = {
    action: "update",
    item: "פגישה עם טל",
    time: "",
    date: "",
    text: "",
    ping: [],
  } as unknown as LlmReminderAction;

  it("is attach-only when only ids are present", () => {
    expect(isAttachmentOnlyReminderUpdate({ ...base, attachmentIds: [A] })).toBe(true);
    expect(isAttachmentOnlyReminderUpdate({ ...base, detachAttachmentIds: [A] })).toBe(true);
  });

  it("is a normal update when timing or text changes too", () => {
    expect(isAttachmentOnlyReminderUpdate(base)).toBe(false);
    expect(
      isAttachmentOnlyReminderUpdate({ ...base, attachmentIds: [A], time: "10:00" }),
    ).toBe(false);
    expect(
      isAttachmentOnlyReminderUpdate({ ...base, attachmentIds: [A], text: "שלום" }),
    ).toBe(false);
  });
});

describe("attachment storage", () => {
  it("builds a key from ids only, never the sender's file name", () => {
    expect(attachmentStorageKey("u1", A, "image/jpeg", new Date("2026-03-05T10:00:00Z"))).toBe(
      `u1/2026/03/${A}.jpg`,
    );
    expect(extensionForMime("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extensionForMime("application/x-unknown")).toBe("bin");
  });

  it("round-trips bytes and refuses keys outside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "workee-att-"));
    try {
      const storage = new LocalDiskStorage(root);
      await storage.put("u1/a.txt", Buffer.from("hi"));
      expect((await storage.read("u1/a.txt")).toString()).toBe("hi");
      await expect(storage.put("../escape.txt", Buffer.from("x"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("only renders script-free media inline", () => {
    expect(isInlineSafeMime("image/jpeg")).toBe(true);
    expect(isInlineSafeMime("application/pdf")).toBe(true);
    expect(isInlineSafeMime("image/svg+xml")).toBe(false);
    expect(isInlineSafeMime("text/html")).toBe(false);
  });
});

describe("GET /api/attachments/:id/content", () => {
  it("requires a session", async () => {
    const response = await request(createApp()).get(`/api/attachments/${A}/content`);
    expect(response.status).toBe(401);
  });
});
