/**
 * M3: inbound WhatsApp media download retries transient failures only — at most
 * two retries after the initial attempt — and nothing is stored until the
 * download succeeds, so a retry can never create a duplicate attachment.
 * Offline: fetch, env, storage, Prisma and audit are mocked; no network, no DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const created: unknown[] = [];
const stored: string[] = [];

vi.mock("../src/config/env.js", () => ({
  getEnv: () => ({
    WHATSAPP_ACCESS_TOKEN: "test-token",
    WHATSAPP_PHONE_NUMBER_ID: "test-phone",
    NODE_ENV: "test",
  }),
  resetEnvCache: () => undefined,
}));
vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    attachment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
    },
  },
}));
vi.mock("../src/services/audit.service.js", () => ({
  recordAuditEvent: vi.fn(async () => undefined),
}));
vi.mock("../src/services/attachment-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/attachment-storage.js")>();
  return {
    ...actual,
    getAttachmentStorage: () => ({
      put: async (key: string) => {
        stored.push(key);
      },
      read: async () => Buffer.alloc(0),
    }),
  };
});

const { ingestInboundMedia } = await import("../src/services/attachment.service.js");
const {
  downloadWhatsAppMediaWithRetry,
  MEDIA_RETRY_DELAYS_MS,
  MediaFetchError,
  MediaTooLargeError,
  setMediaRetrySleepForTests,
} = await import("../src/services/whatsapp-media.js");

type Step = { status: number } | "network";

/** fetch stub: each media attempt = meta call (GET /{id}) then file call (GET url). */
function stubFetch(metaSteps: Step[], fileSteps: Step[] = [], bytes = Buffer.from("%PDF-ticket")) {
  const calls = { meta: 0, file: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const isFile = url.startsWith("https://media.example/");
      const steps = isFile ? fileSteps : metaSteps;
      const index = isFile ? calls.file++ : calls.meta++;
      const step = steps[index] ?? { status: 200 };
      if (step === "network") throw new TypeError("fetch failed");
      if (step.status !== 200) return new Response("err", { status: step.status });
      return isFile
        ? new Response(bytes, { status: 200 })
        : Response.json({ url: "https://media.example/file", mime_type: "application/pdf", sha256: "h" });
    }),
  );
  return calls;
}

const doc = {
  kind: "document" as const,
  mediaId: "media-1",
  mimeType: "application/pdf",
  caption: "",
  fileName: "ticket-1.pdf",
  voice: false,
};
const ingest = () => ingestInboundMedia({ userId: "u1", uploaderId: "e1", media: doc });

describe("WhatsApp media download retry", () => {
  const sleeps: number[] = [];
  beforeEach(() => {
    created.length = 0;
    stored.length = 0;
    sleeps.length = 0;
    setMediaRetrySleepForTests(async (ms) => {
      sleeps.push(ms);
    });
  });
  afterEach(() => {
    setMediaRetrySleepForTests(null);
    vi.unstubAllGlobals();
  });

  it("backoff: two retries after the initial attempt", () => {
    expect([...MEDIA_RETRY_DELAYS_MS]).toEqual([500, 2_000]);
  });

  it("transient 503 then success → stored once, one attachment row", async () => {
    const calls = stubFetch([{ status: 503 }]);
    const row = await ingest();
    expect(row).toBeTruthy();
    expect(calls.meta).toBe(2);
    expect(calls.file).toBe(1);
    expect(sleeps).toEqual([500]);
    expect(created).toHaveLength(1);
    expect(stored).toHaveLength(1);
  });

  it("network error on the file body, then success → one attachment row", async () => {
    const calls = stubFetch([], ["network"]);
    expect(await ingest()).toBeTruthy();
    expect(calls.meta).toBe(2);
    expect(calls.file).toBe(2);
    expect(created).toHaveLength(1);
    expect(stored).toHaveLength(1);
  });

  it("429 twice then success uses both retries", async () => {
    const calls = stubFetch([{ status: 429 }, { status: 429 }]);
    expect(await ingest()).toBeTruthy();
    expect(calls.meta).toBe(3);
    expect(sleeps).toEqual([500, 2_000]);
    expect(created).toHaveLength(1);
  });

  it("transient failure on all three attempts → no attachment, no stored file, exactly 3 attempts", async () => {
    const calls = stubFetch([{ status: 500 }, { status: 502 }, { status: 504 }, { status: 200 }]);
    expect(await ingest()).toBeNull();
    expect(calls.meta).toBe(3);
    expect(calls.file).toBe(0);
    expect(created).toHaveLength(0);
    expect(stored).toHaveLength(0);
  });

  it("permanent 404 / 403 is not retried", async () => {
    for (const status of [400, 401, 403, 404]) {
      sleeps.length = 0;
      const calls = stubFetch([{ status }]);
      expect(await ingest()).toBeNull();
      expect(calls.meta).toBe(1);
      expect(sleeps).toEqual([]);
    }
    expect(created).toHaveLength(0);
    expect(stored).toHaveLength(0);
  });

  it("a file over the size cap is not retried", async () => {
    stubFetch([], [], Buffer.alloc(11));
    await expect(downloadWhatsAppMediaWithRetry("media-1", 10)).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(sleeps).toEqual([]);
  });

  it("classification: 408/425/429/5xx and network errors are transient; other 4xx are not", async () => {
    for (const [step, transient] of [
      [{ status: 408 }, true],
      [{ status: 425 }, true],
      [{ status: 429 }, true],
      [{ status: 503 }, true],
      ["network", true],
      [{ status: 404 }, false],
      [{ status: 410 }, false],
    ] as Array<[Step, boolean]>) {
      // Always failing: transient → 3 attempts; permanent → 1.
      const calls = stubFetch([step, step, step]);
      const error = await downloadWhatsAppMediaWithRetry("media-1", 1_000).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MediaFetchError);
      expect((error as InstanceType<typeof MediaFetchError>).transient).toBe(transient);
      expect(calls.meta).toBe(transient ? 3 : 1);
    }
  });
});
