/**
 * GTFS generation staging / validation / activation — eval DB only.
 * Run: npm run test:eval-db -w backend -- tests/gtfs-ingest.eval-db.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  activateGeneration,
  createStagingGeneration,
  ingestParsedFeed,
  loadParsedFeedIntoStaging,
  markGenerationFailed,
  validateStagingGeneration,
  GtfsIngestError,
} from "../src/services/gtfs-ingest.js";
import { getActiveGenerationId } from "../src/services/gtfs-query.js";
import { buildMiniGtfsFeed } from "./gtfs-fixture.js";

const prisma = new PrismaClient();

describe("gtfs ingest generation safety (eval-db)", () => {
  beforeAll(() => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
    expect(process.env.WORKEE_DISABLE_REMINDER_FIRE).toBe("1");
  });

  beforeEach(async () => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    // CASCADE deletes child GTFS rows.
    await prisma.gtfsFeedGeneration.deleteMany({});
  });

  afterAll(async () => {
    await prisma.gtfsFeedGeneration.deleteMany({}).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("activates a valid staging feed and retires the previous active", async () => {
    const first = await ingestParsedFeed(prisma, buildMiniGtfsFeed(), {
      sourceLabel: "mini-1",
    });
    expect(await getActiveGenerationId(prisma)).toBe(first.generationId);

    const second = await ingestParsedFeed(prisma, buildMiniGtfsFeed(), {
      sourceLabel: "mini-2",
    });
    expect(await getActiveGenerationId(prisma)).toBe(second.generationId);

    const retired = await prisma.gtfsFeedGeneration.findUnique({
      where: { id: first.generationId },
    });
    expect(retired?.status).toBe("retired");
  });

  it("marks failed staging and leaves prior active untouched", async () => {
    const ok = await ingestParsedFeed(prisma, buildMiniGtfsFeed(), {
      sourceLabel: "keeper",
    });
    const stagingId = await createStagingGeneration(prisma, {
      sourceLabel: "broken",
    });
    await loadParsedFeedIntoStaging(prisma, stagingId, {
      ...buildMiniGtfsFeed(),
      stopTimes: [],
    });
    await expect(validateStagingGeneration(prisma, stagingId)).rejects.toBeInstanceOf(
      GtfsIngestError,
    );
    await markGenerationFailed(prisma, stagingId, "validation failed");

    const failed = await prisma.gtfsFeedGeneration.findUnique({
      where: { id: stagingId },
    });
    expect(failed?.status).toBe("failed");
    expect(await getActiveGenerationId(prisma)).toBe(ok.generationId);
  });

  it("ingestParsedFeed rolls failed load into failed status without activating", async () => {
    const ok = await ingestParsedFeed(prisma, buildMiniGtfsFeed(), {
      sourceLabel: "keeper2",
    });
    await expect(
      ingestParsedFeed(
        prisma,
        { ...buildMiniGtfsFeed(), stops: [], stopTimes: [] },
        { sourceLabel: "bad" },
      ),
    ).rejects.toBeInstanceOf(GtfsIngestError);

    const failed = await prisma.gtfsFeedGeneration.findFirst({
      where: { sourceLabel: "bad" },
    });
    expect(failed?.status).toBe("failed");
    expect(await getActiveGenerationId(prisma)).toBe(ok.generationId);
  });

  it("refuses activating a non-staging generation", async () => {
    const ok = await ingestParsedFeed(prisma, buildMiniGtfsFeed());
    await expect(activateGeneration(prisma, ok.generationId)).rejects.toBeInstanceOf(
      GtfsIngestError,
    );
  });

  it("accepts duplicate stop_code station+platform rows", async () => {
    const { generationId, counts } = await ingestParsedFeed(
      prisma,
      buildMiniGtfsFeed(),
    );
    expect(counts.stops).toBeGreaterThanOrEqual(4);
    const codes = await prisma.gtfsStop.findMany({
      where: { generationId, stopCode: "2007" },
    });
    expect(codes.length).toBe(3);
  });

  it("concurrent readers only see active during activation", async () => {
    const a = await ingestParsedFeed(prisma, buildMiniGtfsFeed(), {
      sourceLabel: "A",
    });
    const stagingId = await createStagingGeneration(prisma, {
      sourceLabel: "B",
    });
    await loadParsedFeedIntoStaging(prisma, stagingId, buildMiniGtfsFeed());
    await validateStagingGeneration(prisma, stagingId);

    const mid = await getActiveGenerationId(prisma);
    expect(mid).toBe(a.generationId);

    await activateGeneration(prisma, stagingId);
    expect(await getActiveGenerationId(prisma)).toBe(stagingId);
  });
});
