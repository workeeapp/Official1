/**
 * One-time ops: set linkedReminderId on human shopping/tasks rows for active
 * clocks that were saved without soft-link (REUSE regression residue).
 *
 * Run once, then discard — not wired into chat/startup/refresh.
 *
 *   npx tsx src/scripts/backfill-orphan-reminder-links.ts
 *   npx tsx src/scripts/backfill-orphan-reminder-links.ts --dry-run
 */
import { prisma } from "../database/prisma.js";
import {
  pairLinkedItemsToReminders,
  type LinkedItemRef,
} from "../services/reminder.service.js";

function isDryRun(): boolean {
  return process.argv.includes("--dry-run");
}

async function main(): Promise<void> {
  const dryRun = isDryRun();
  const active = await prisma.reminder.findMany({
    where: { status: "active" },
    select: { id: true, itemKey: true, userId: true },
  });
  if (active.length === 0) {
    console.log("No active reminders.");
    return;
  }

  const alreadyLinked = await prisma.employeeListItem.findMany({
    where: { linkedReminderId: { not: null }, deletedAt: null },
    select: { linkedReminderId: true },
  });
  const linkedClockIds = new Set(
    alreadyLinked
      .map((row) => row.linkedReminderId)
      .filter((id): id is string => Boolean(id)),
  );

  const orphans = active.filter((row) => !linkedClockIds.has(row.id));
  console.log(
    `Active clocks: ${active.length}; already soft-linked: ${linkedClockIds.size}; orphans: ${orphans.length}`,
  );
  if (orphans.length === 0) {
    return;
  }

  const userIds = [...new Set(orphans.map((row) => row.userId))];
  const liveRows = await prisma.employeeListItem.findMany({
    where: {
      deletedAt: null,
      list: {
        deletedAt: null,
        listType: { in: ["shopping", "tasks"] },
        employee: { userId: { in: userIds }, kind: "human" },
      },
    },
    select: {
      id: true,
      itemKey: true,
      data: true,
      list: { select: { employee: { select: { userId: true } } } },
    },
  });

  const liveByUser = new Map<string, LinkedItemRef[]>();
  for (const row of liveRows) {
    const userId = row.list.employee.userId;
    const data = (row.data ?? {}) as Record<string, unknown>;
    const itemLabel =
      (typeof data["שם מטלה"] === "string" && data["שם מטלה"].trim()) ||
      (typeof data["שם פריט"] === "string" && data["שם פריט"].trim()) ||
      (typeof data.name === "string" && data.name.trim()) ||
      row.itemKey;
    const list = liveByUser.get(userId) ?? [];
    list.push({ id: row.id, itemKey: row.itemKey, itemLabel });
    liveByUser.set(userId, list);
  }

  let linked = 0;
  let skippedAmbiguous = 0;
  let skippedNoMatch = 0;
  const usedItemIds = new Set<string>();

  for (const clock of orphans) {
    const candidates = (liveByUser.get(clock.userId) ?? []).filter(
      (item) => !usedItemIds.has(item.id),
    );
    const pairs = pairLinkedItemsToReminders(
      [{ id: clock.id, itemKey: clock.itemKey, itemLabel: clock.itemKey }],
      candidates,
    );
    if (pairs.length === 0) {
      skippedNoMatch += 1;
      continue;
    }
    // Exact-key pairing returns at most one pair per clock; still guard if
    // several live rows share the same key (take none — ambiguous).
    const sameKeyCount = candidates.filter(
      (item) =>
        item.itemKey.trim().toLowerCase().replace(/\s+/g, " ") ===
        clock.itemKey.trim().toLowerCase().replace(/\s+/g, " "),
    ).length;
    if (sameKeyCount !== 1) {
      skippedAmbiguous += 1;
      continue;
    }
    const pair = pairs[0]!;
    usedItemIds.add(pair.itemId);
    if (dryRun) {
      console.log(
        `[dry-run] would link item ${pair.itemId} <- reminder ${pair.reminderId} (${clock.itemKey})`,
      );
    } else {
      await prisma.employeeListItem.update({
        where: { id: pair.itemId },
        data: { linkedReminderId: pair.reminderId },
      });
      console.log(
        `Linked item ${pair.itemId} <- reminder ${pair.reminderId} (${clock.itemKey})`,
      );
    }
    linked += 1;
  }

  console.log(
    `${dryRun ? "Would link" : "Linked"}: ${linked}; no match: ${skippedNoMatch}; ambiguous: ${skippedAmbiguous}`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
