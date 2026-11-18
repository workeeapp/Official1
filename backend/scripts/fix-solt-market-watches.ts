/**
 * One-shot ops: fix the two SOLT target-arrival watches that were persisted as
 * gte + daily level. Dry-run by default. Pass --apply to write (transaction).
 *
 * Usage (from backend/):
 *   npx tsx scripts/fix-solt-market-watches.ts
 *   npx tsx scripts/fix-solt-market-watches.ts --apply
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { legacyRepeatFor, serializeRecurrence } from "@workee/shared";
import { baselineShaForWatch } from "../src/services/compose-condition.js";
import { fetchQuote } from "../src/services/market.js";

loadDotenv({ path: resolve(process.cwd(), "../.env") });
loadDotenv({ path: resolve(process.cwd(), ".env") });

const TARGETS = [
  {
    id: "ca9e6145-efbc-48ff-b45d-809c35256c9d",
    expectedValue: 20,
  },
  {
    id: "51a042de-60e5-40ee-b29a-6cc0fe0bda4d",
    expectedValue: 10,
  },
] as const;

const INTERVAL_RECURRENCE = {
  freq: "interval" as const,
  interval: 5,
  unit: "minutes" as const,
};

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient();

type Cond = { type?: string; op?: string; value?: number };

function asCond(raw: unknown): Cond | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Cond;
}

async function main() {
  const ids = TARGETS.map((t) => t.id);
  const rows = await prisma.reminder.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      itemLabel: true,
      status: true,
      composePlace: true,
      composeSource: true,
      composeCondition: true,
      watchOnce: true,
      recurrence: true,
      repeat: true,
      fireAt: true,
      lastReportSha: true,
      pingIds: true,
      ownerId: true,
      composeAspects: true,
    },
  });

  if (rows.length !== TARGETS.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    throw new Error(`Expected ${TARGETS.length} rows; missing: ${missing.join(", ")}`);
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const diffs: Array<Record<string, unknown>> = [];

  for (const target of TARGETS) {
    const row = byId.get(target.id)!;
    const cond = asCond(row.composeCondition);
    if (cond?.type !== "market_price") {
      throw new Error(`${target.id}: compose_condition.type is not market_price`);
    }
    if (Number(cond.value) !== target.expectedValue) {
      throw new Error(
        `${target.id}: expected value ${target.expectedValue}, got ${cond.value}`,
      );
    }

    const place =
      String(row.composePlace ?? "")
        .split(",")[0]
        ?.trim() || "SOLT";
    let livePrice: number | null = null;
    try {
      const quote = await fetchQuote(place);
      livePrice =
        quote?.price != null && Number.isFinite(quote.price) ? quote.price : null;
    } catch (err) {
      console.warn(`quote fetch failed for ${place}:`, err);
    }

    const nextCondition = {
      type: "market_price" as const,
      op: "lte" as const,
      value: target.expectedValue,
    };
    const nextSha =
      livePrice != null
        ? baselineShaForWatch({
            condition: nextCondition,
            facts: { marketPrice: livePrice },
          })
        : "market:above";
    const nextFireAt = new Date(Date.now() + 5 * 60 * 1000);
    const nextRecurrence = serializeRecurrence(INTERVAL_RECURRENCE);
    const nextRepeat = legacyRepeatFor(INTERVAL_RECURRENCE);

    diffs.push({
      id: target.id,
      itemLabel: row.itemLabel,
      livePrice,
      before: {
        composeCondition: row.composeCondition,
        watchOnce: row.watchOnce,
        recurrence: row.recurrence,
        repeat: row.repeat,
        fireAt: row.fireAt.toISOString(),
        lastReportSha: row.lastReportSha,
      },
      after: {
        composeCondition: nextCondition,
        watchOnce: true,
        recurrence: nextRecurrence,
        repeat: nextRepeat,
        fireAt: nextFireAt.toISOString(),
        lastReportSha: nextSha,
      },
      notes: [
        "No WhatsApp send in this script",
        "Baseline sha stamped from live quote (or market:above fallback)",
        "Edge watch_once:true — next poll quiet while price still above threshold",
      ],
    });
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? "APPLY" : "DRY_RUN",
        count: diffs.length,
        diffs,
      },
      null,
      2,
    ),
  );

  if (!apply) {
    console.error(
      "\nDry-run only. Re-run with --apply to update these two rows in a transaction.",
    );
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const diff of diffs) {
      const id = String(diff.id);
      const after = diff.after as {
        composeCondition: Cond;
        watchOnce: boolean;
        recurrence: Record<string, unknown>;
        repeat: string;
        fireAt: string;
        lastReportSha: string | null;
      };
      await tx.reminder.update({
        where: { id },
        data: {
          composeCondition: after.composeCondition,
          watchOnce: true,
          recurrence: after.recurrence,
          repeat: after.repeat,
          fireAt: new Date(after.fireAt),
          lastReportSha: (after.lastReportSha ?? "market:above").slice(0, 64),
          // Keep status active; do not mark sent / do not touch lastComposedText.
        },
      });
    }
  });

  const verified = await prisma.reminder.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      composeCondition: true,
      watchOnce: true,
      recurrence: true,
      repeat: true,
      fireAt: true,
      lastReportSha: true,
      status: true,
    },
  });
  console.log("\nVERIFIED_AFTER_APPLY:");
  console.log(JSON.stringify(verified, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
