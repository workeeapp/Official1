import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { attachmentCreate, recordAudit } = vi.hoisted(() => ({
  attachmentCreate: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    attachment: {
      create: attachmentCreate,
    },
  },
}));

vi.mock("../src/services/audit.service.js", () => ({
  recordAuditEvent: recordAudit,
}));

vi.mock("../src/config/env.js", () => ({
  getEnv: () => ({
    NODE_ENV: "test",
    OPENAI_API_KEY: "",
    TRANSCRIBE_MODEL: "gpt-4o-mini-transcribe",
    UPLOADS_DIR: "",
  }),
}));

import {
  formatNewAttachmentsBlock,
  ingestUploadedBytes,
  toAttachmentFact,
} from "../src/services/attachment.service.js";
import {
  setTranscriberForTests,
  transcribeAudio,
} from "../src/services/attachment-understanding.js";
import { LocalDiskStorage, setAttachmentStorageForTests } from "../src/services/attachment-storage.js";
import {
  toResponsesCreateBody,
  toResponsesInput,
} from "../src/services/llm-client.js";

describe("transcribeAudio statuses", () => {
  beforeEach(() => {
    setTranscriberForTests(null);
  });

  it("returns empty for zero-length audio without calling an override API", async () => {
    await expect(
      transcribeAudio({ bytes: Buffer.alloc(0), mimeType: "audio/ogg" }),
    ).resolves.toEqual({ text: "", status: "empty" });
  });

  it("returns unavailable when OpenAI key is missing / NODE_ENV=test", async () => {
    await expect(
      transcribeAudio({ bytes: Buffer.from("x"), mimeType: "audio/ogg" }),
    ).resolves.toEqual({ text: "", status: "unavailable" });
  });

  it("maps override ok / empty / error", async () => {
    setTranscriberForTests(async () => ({ text: "שלום", status: "ok" }));
    await expect(
      transcribeAudio({ bytes: Buffer.from("x"), mimeType: "audio/ogg" }),
    ).resolves.toEqual({ text: "שלום", status: "ok" });

    setTranscriberForTests(async () => ({ text: "", status: "empty" }));
    await expect(
      transcribeAudio({ bytes: Buffer.from("x"), mimeType: "audio/ogg" }),
    ).resolves.toEqual({ text: "", status: "empty" });

    setTranscriberForTests(async () => ({ text: "", status: "error" }));
    await expect(
      transcribeAudio({ bytes: Buffer.from("x"), mimeType: "audio/ogg" }),
    ).resolves.toEqual({ text: "", status: "error" });
  });
});

describe("attachment facts transcript_status", () => {
  it("includes status only for audio when set; omits for legacy null and images", () => {
    expect(
      toAttachmentFact({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "audio",
        fileName: "v.ogg",
        caption: "",
        transcript: "",
        transcriptStatus: "error",
      } as never, true),
    ).toMatchObject({
      kind: "audio",
      voice_note: true,
      transcript_status: "error",
    });

    expect(
      toAttachmentFact({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        kind: "audio",
        fileName: "",
        caption: "",
        transcript: "היי",
        transcriptStatus: "ok",
      } as never),
    ).toMatchObject({
      transcript: "היי",
      transcript_status: "ok",
    });

    // Legacy row: null status → no transcript_status in facts.
    expect(
      toAttachmentFact({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        kind: "audio",
        fileName: "",
        caption: "",
        transcript: "",
        transcriptStatus: null,
      } as never),
    ).not.toHaveProperty("transcript_status");

    expect(
      toAttachmentFact({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        kind: "image",
        fileName: "a.jpg",
        caption: "",
        transcript: "",
        transcriptStatus: "ok",
      } as never),
    ).not.toHaveProperty("transcript_status");
  });

  it("formats all four statuses into the new-attachments block for audio", () => {
    for (const status of ["ok", "empty", "unavailable", "error"] as const) {
      const block = formatNewAttachmentsBlock([
        {
          attachment_id: "11111111-1111-4111-8111-111111111111",
          kind: "audio",
          transcript_status: status,
          voice_note: true,
        },
      ]);
      expect(block).toContain(`"transcript_status":"${status}"`);
    }
  });
});

describe("createResponse boundary carries transcript_status", () => {
  it("puts transcript_status=error into the Responses input string for audio", () => {
    const fact = toAttachmentFact(
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "audio",
        fileName: "note.ogg",
        caption: "",
        transcript: "",
        transcriptStatus: "error",
      } as never,
      true,
    );
    const message = [
      "עמית: [הודעת קול]",
      formatNewAttachmentsBlock([fact]),
    ].join("\n\n");
    const responsesInput = toResponsesInput(message, []);
    expect(typeof responsesInput).toBe("string");
    expect(responsesInput).toContain('"transcript_status":"error"');
    expect(responsesInput).toContain('"voice_note":true');

    const body = toResponsesCreateBody({
      conversationId: "conv_test",
      message,
      model: "gpt-4.1-mini",
      temperature: 0.2,
    });
    expect(body.input).toBe(responsesInput);
    expect(String(body.input)).toContain('"transcript_status":"error"');
  });

  it("legacy null status still omits transcript_status at the same boundary", () => {
    const fact = toAttachmentFact({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      kind: "audio",
      fileName: "",
      caption: "",
      transcript: "",
      transcriptStatus: null,
    } as never);
    const message = formatNewAttachmentsBlock([fact]);
    const responsesInput = toResponsesInput(message, []);
    expect(String(responsesInput)).not.toContain("transcript_status");
  });
});

describe("ingestUploadedBytes STT error is non-fatal", () => {
  let root = "";

  beforeEach(async () => {
    attachmentCreate.mockReset();
    recordAudit.mockReset();
    root = await mkdtemp(join(tmpdir(), "workee-stt-"));
    setAttachmentStorageForTests(new LocalDiskStorage(root));
    setTranscriberForTests(async () => ({ text: "", status: "error" }));
    attachmentCreate.mockImplementation(async ({ data }: { data: unknown }) => data);
  });

  afterEach(async () => {
    setTranscriberForTests(null);
    setAttachmentStorageForTests(null);
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores the file and persists transcriptStatus=error when STT fails", async () => {
    const row = await ingestUploadedBytes({
      userId: "11111111-1111-4111-8111-111111111111",
      uploaderId: "22222222-2222-4222-8222-222222222222",
      bytes: Buffer.from("ogg-bytes"),
      mimeType: "audio/ogg",
      fileName: "note.ogg",
    });
    expect(row).toBeTruthy();
    expect(attachmentCreate).toHaveBeenCalled();
    const data = attachmentCreate.mock.calls[0]?.[0]?.data as {
      transcript: string;
      transcriptStatus: string;
      kind: string;
    };
    expect(data.kind).toBe("audio");
    expect(data.transcript).toBe("");
    expect(data.transcriptStatus).toBe("error");
  });
});
