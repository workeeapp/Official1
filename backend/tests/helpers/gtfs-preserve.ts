/**
 * GTFS eval-db fixtures must never destroy the validated MOT day-slice that
 * real-provider suites depend on (assertEvalDbAndGtfsUntouched).
 *
 * Regression (2026-11-04): gtfs-ingest / gtfs-query ran
 * `gtfsFeedGeneration.deleteMany({})` — a full eval-db run CASCADE-deleted the
 * day-slice, and 26 later suites failed closed in beforeAll.
 *
 * Contract: remember what existed before the file ran; between tests delete
 * ONLY generations this file created; afterAll restores every pre-existing
 * generation's status (ingest retires the previous active one).
 */
import type { PrismaClient } from "@prisma/client";

export type GtfsGenerationSnapshot = Array<{ id: string; status: string }>;

export async function snapshotGtfsGenerations(
  prisma: PrismaClient,
): Promise<GtfsGenerationSnapshot> {
  return prisma.gtfsFeedGeneration.findMany({
    select: { id: true, status: true },
  });
}

/** Delete generations created after the snapshot (CASCADE removes their rows). */
export async function deleteTestGtfsGenerations(
  prisma: PrismaClient,
  before: GtfsGenerationSnapshot,
): Promise<void> {
  await prisma.gtfsFeedGeneration.deleteMany({
    where: { id: { notIn: before.map((row) => row.id) } },
  });
}

/** Delete test generations, then put pre-existing ones back as they were. */
export async function restoreGtfsGenerations(
  prisma: PrismaClient,
  before: GtfsGenerationSnapshot,
): Promise<void> {
  await deleteTestGtfsGenerations(prisma, before);
  for (const row of before) {
    await prisma.gtfsFeedGeneration.update({
      where: { id: row.id },
      data: { status: row.status },
    });
  }
}
