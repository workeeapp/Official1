/**
 * One-shot ID-only repairs (no title/key matching):
 * 1. Clear soft-links whose linkedReminderId points at a non-active clock.
 * 2. Known Skazi task uuid → active clock uuid map.
 * 3. Birthday tasks on clock 64c4bb39… → event day 9 May (clock stays 8 May 13:00).
 *
 *   npx tsx src/scripts/repair-soft-link-and-birthday-dates.ts
 *   npx tsx src/scripts/repair-soft-link-and-birthday-dates.ts --dry-run
 */
import {
  formatRecurrenceHe,
  serializeRecurrence,
  type Recurrence,
} from "@workee/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import {
  RECURRENCE_DISPLAY_KEY,
  RECURRENCE_META_KEY,
} from "../services/list-recurrence.js";

const BIRTHDAY_CLOCK = "64c4bb39-fb75-4650-b4d2-01c7f6bd73f4";

/** Known stale soft-links: task id → live active reminder id. */
const SKAZI_RELINK: Record<string, string> = {
  "fa82585f-0953-46ca-8b76-17fd9cc1661a": "0de85677-ffdc-4037-a1bf-2ee0847d4103",
  "b7aa5686-0893-467a-832a-1824f38c6e03": "dcc1e566-9281-440b-b533-8d8b13135367",
};

function isDryRun(): boolean {
  return process.argv.includes("--dry-run");
}

async function main(): Promise<void> {
  const dryRun = isDryRun();

  const linked = await prisma.employeeListItem.findMany({
    where: { linkedReminderId: { not: null }, deletedAt: null },
    select: { id: true, linkedReminderId: true },
  });
  const remIds = [
    ...new Set(
      linked
        .map((row) => row.linkedReminderId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const rems = await prisma.reminder.findMany({
    where: { id: { in: remIds } },
    select: { id: true, status: true },
  });
  const statusById = new Map(rems.map((row) => [row.id, row.status]));
  let cleared = 0;
  for (const row of linked) {
    const status = statusById.get(row.linkedReminderId!);
    if (status === "active") {
      continue;
    }
    if (dryRun) {
      console.log(
        `[dry-run] clear soft-link on item ${row.id} (was ${row.linkedReminderId}, status=${status ?? "missing"})`,
      );
    } else {
      await prisma.employeeListItem.update({
        where: { id: row.id },
        data: { linkedReminderId: null },
      });
    }
    cleared += 1;
  }
  console.log(`${dryRun ? "Would clear" : "Cleared"} stale soft-links: ${cleared}`);

  let relinked = 0;
  for (const [itemId, reminderId] of Object.entries(SKAZI_RELINK)) {
    const clock = await prisma.reminder.findUnique({
      where: { id: reminderId },
      select: { id: true, status: true },
    });
    if (!clock || clock.status !== "active") {
      console.log(`[skip] active clock missing for ${itemId} → ${reminderId}`);
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] relink item ${itemId} → ${reminderId}`);
    } else {
      await prisma.employeeListItem.update({
        where: { id: itemId },
        data: { linkedReminderId: reminderId },
      });
    }
    relinked += 1;
  }
  console.log(`${dryRun ? "Would relink" : "Relinked"} known rows: ${relinked}`);

  const birthdayTasks = await prisma.employeeListItem.findMany({
    where: { linkedReminderId: BIRTHDAY_CLOCK, deletedAt: null },
    select: { id: true, data: true },
  });
  const rule: Recurrence = {
    freq: "yearly",
    interval: 1,
    month: 5,
    monthDay: 9,
  };
  let birthdayFixed = 0;
  for (const row of birthdayTasks) {
    const prev = (row.data ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {
      ...prev,
      "שם מטלה":
        (typeof prev["שם מטלה"] === "string" && prev["שם מטלה"]) ||
        "יום ההולדת של עמית",
      "תאריך לביצוע": "2027-05-09",
      "יום שלם": true,
      [RECURRENCE_META_KEY]: {
        ...serializeRecurrence(rule),
        start: "2027-05-09",
      },
      [RECURRENCE_DISPLAY_KEY]: formatRecurrenceHe(rule),
    };
    if (dryRun) {
      console.log(`[dry-run] birthday task ${row.id} → event 2027-05-09`);
    } else {
      await prisma.employeeListItem.update({
        where: { id: row.id },
        data: { data: data as Prisma.InputJsonValue },
      });
    }
    birthdayFixed += 1;
  }
  console.log(
    `${dryRun ? "Would fix" : "Fixed"} birthday task dates: ${birthdayFixed}`,
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
