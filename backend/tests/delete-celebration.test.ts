import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const {
  attachmentFindFirst,
  attachmentCreate,
  storageRead,
  storagePut,
} = vi.hoisted(() => ({
  attachmentFindFirst: vi.fn(),
  attachmentCreate: vi.fn(),
  storageRead: vi.fn(),
  storagePut: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    attachment: {
      findFirst: attachmentFindFirst,
      create: attachmentCreate,
    },
  },
}));

vi.mock("../src/services/attachment-storage.js", () => ({
  getAttachmentStorage: () => ({
    read: storageRead,
    put: storagePut,
    getStream: vi.fn(),
  }),
  setAttachmentStorageForTests: vi.fn(),
  attachmentStorageKey: (userId: string, id: string) => `${userId}/${id}.png`,
  extensionForMime: () => ".png",
}));

vi.mock("../src/services/whatsapp-log.js", () => ({
  recordWhatsAppEvent: vi.fn(),
}));

vi.mock("../src/services/llm-client.js", () => ({
  getLlmClient: () => ({
    createConversation: vi.fn(async () => "conv-celebration"),
    createResponse: vi.fn(async () => ({
      reply: JSON.stringify({
        encouragement: "כל הכבוד טל!",
        tip: "תשמור על הקצב",
        scene_prompt:
          "holding grocery bags while walking out of a garage workshop",
      }),
      raw: {},
      usage: {
        responseId: "r1",
        model: "gpt-test",
        inputTokens: 10,
        outputTokens: 20,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 30,
        raw: {},
      },
    })),
  }),
  extractUsage: () => null,
}));

vi.mock("../src/config/llm.js", () => ({
  loadLlmConfig: () => ({
    model: "gpt-test",
    temperature: 0.7,
    systemMessage: "",
    reasoningEffort: "none",
  }),
}));

vi.mock("../src/config/env.js", () => ({
  getEnv: () => ({
    OPENAI_API_KEY: undefined,
    UPLOADS_DIR: ".data/uploads",
  }),
}));

vi.mock("../src/services/audit.service.js", () => ({
  recordAuditEvent: vi.fn(),
}));

import {
  buildCelebrationImagePrompt,
  CELEBRATION_COPY_MODEL,
  CELEBRATION_IMAGE_MODEL,
  CELEBRATION_IMAGE_QUALITY,
  CELEBRATION_IMAGE_SIZE,
  CELEBRATION_STYLE_BIBLE,
  collectCelebrationRemoves,
  overlayCelebrationHebrew,
  parseCelebrationCopy,
  runDeleteCelebration,
  setCelebrationImageGenForTests,
  wrapComicLines,
} from "../src/services/delete-celebration.js";

describe("delete celebration", () => {
  beforeEach(() => {
    attachmentFindFirst.mockReset();
    attachmentCreate.mockReset();
    storageRead.mockReset();
    storagePut.mockReset();
    setCelebrationImageGenForTests(null);
  });

  it("uses the cheap image + copy stack", () => {
    expect(CELEBRATION_IMAGE_MODEL).toBe("gpt-image-1-mini");
    expect(CELEBRATION_IMAGE_QUALITY).toBe("low");
    expect(CELEBRATION_IMAGE_SIZE).toBe("1024x1024");
    expect(CELEBRATION_COPY_MODEL).toBe("gpt-4.1-mini");
  });

  it("collects only shopping/tasks removes and keeps every label", () => {
    const removes = collectCelebrationRemoves([
      { action: "remove", listType: "shopping", itemLabel: "חלב" },
      { action: "remove", listType: "tasks", itemLabel: "מוסך" },
      { action: "remove", listType: "custom", itemLabel: "אל תחגוג" },
      { action: "add", listType: "shopping", itemLabel: "לחם" },
      { action: "remove", listType: "shopping", itemLabel: "שוקולד" },
    ]);
    expect(removes).toEqual([
      { itemLabel: "חלב", listType: "shopping" },
      { itemLabel: "מוסך", listType: "tasks" },
      { itemLabel: "שוקולד", listType: "shopping" },
    ]);
  });

  it("always prepends the style bible to the scene prompt", () => {
    const prompt = buildCelebrationImagePrompt("waving with milk and bread");
    expect(prompt.startsWith(CELEBRATION_STYLE_BIBLE)).toBe(true);
    expect(prompt).toContain("waving with milk and bread");
    expect(CELEBRATION_STYLE_BIBLE).toMatch(/no text/i);
    expect(CELEBRATION_STYLE_BIBLE).toMatch(/comic-book|cartoon|superhero/i);
    expect(CELEBRATION_STYLE_BIBLE).toMatch(/likeness/i);
  });

  it("parses celebration JSON copy", () => {
    expect(
      parseCelebrationCopy(
        '{"encouragement":"כל הכבוד!","tip":"","scene_prompt":"smiling with bags"}',
      ),
    ).toEqual({
      encouragement: "כל הכבוד!",
      tip: "",
      scene_prompt: "smiling with bags",
    });
    expect(parseCelebrationCopy("not json")).toBeNull();
  });

  it("wraps long Hebrew so overlay lines stay short", () => {
    expect(wrapComicLines("כל הכבוד טל על הרשימה!", 14)).toEqual([
      "כל הכבוד טל על",
      "הרשימה!",
    ]);
    expect(wrapComicLines("קצר", 14)).toEqual(["קצר"]);
  });

  it("overlays Hebrew onto a PNG buffer", async () => {
    const base = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 3,
        background: { r: 200, g: 180, b: 160 },
      },
    })
      .png()
      .toBuffer();
    const out = await overlayCelebrationHebrew({
      imageBytes: base,
      encouragement: "כל הכבוד טל על הרשימה הארוכה הזאת!",
      tip: "טיפ קצר להמשך היום",
    });
    expect(out.length).toBeGreaterThan(base.length / 2);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(256);
    expect(meta.format).toBe("png");
  });

  it("skips when there is no profile attachment", async () => {
    const result = await runDeleteCelebration({
      userId: "u1",
      uploaderId: "e1",
      profileAttachmentId: "",
      removes: [{ itemLabel: "חלב", listType: "shopping" }],
      speakerName: "טל",
    });
    expect(result).toBeNull();
    expect(attachmentFindFirst).not.toHaveBeenCalled();
  });

  it("runs once with all labels and stores one attachment (mocked image API)", async () => {
    const avatar = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 120, g: 100, b: 90 },
      },
    })
      .png()
      .toBuffer();
    attachmentFindFirst.mockResolvedValue({
      id: "att-profile",
      userId: "u1",
      storageKey: "u1/att-profile.png",
      mimeType: "image/png",
      kind: "image",
      deletedAt: null,
    });
    storageRead.mockResolvedValue(avatar);
    storagePut.mockResolvedValue(undefined);
    attachmentCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      caption: data.caption ?? "",
      transcript: "",
      transcriptStatus: null,
      waInboundMediaId: "",
      waOutboundMediaId: "",
      waOutboundUploadedAt: null,
      deletedAt: null,
      createdAt: new Date(),
    }));

    let genCalls = 0;
    setCelebrationImageGenForTests(async ({ prompt }) => {
      genCalls += 1;
      expect(prompt.startsWith(CELEBRATION_STYLE_BIBLE)).toBe(true);
      expect(prompt).toMatch(/garage/i);
      const bytes = await sharp({
        create: {
          width: 128,
          height: 128,
          channels: 3,
          background: { r: 240, g: 220, b: 200 },
        },
      })
        .png()
        .toBuffer();
      return { bytes };
    });

    const result = await runDeleteCelebration({
      userId: "u1",
      uploaderId: "e1",
      profileAttachmentId: "att-profile",
      removes: [
        { itemLabel: "חלב", listType: "shopping" },
        { itemLabel: "לחם", listType: "shopping" },
        { itemLabel: "מוסך", listType: "tasks" },
      ],
      speakerName: "טל",
      addressGender: "male",
    });

    expect(genCalls).toBe(1);
    expect(result).not.toBeNull();
    expect(result!.ref.kind).toBe("image");
    expect(result!.encouragement).toContain("טל");
    expect(attachmentCreate).toHaveBeenCalledTimes(1);
  });
});
