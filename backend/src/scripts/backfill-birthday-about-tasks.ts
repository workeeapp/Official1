/**
 * One-time ops: for existing birthday (and similar) yearly clocks that were
 * saved as ping-only, set about_ids from the label and create a soft-linked
 * all-day yearly tasks row on the clock owner — matching the new product shape
 * (standing event + linked ping with about).
 *
 * Run once after the about_ids schema is live. Not wired into chat/startup/refresh.
 *
 *   npx tsx src/scripts/backfill-birthday-about-tasks.ts
 *   npx tsx src/scripts/backfill-birthday-about-tasks.ts --dry-run
 */
import {
  formatJerusalemDateTime,
  formatRecurrenceHe,
  parseRecurrence,
  serializeRecurrence,
  type Recurrence,
} from "@workee/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import {
  RECURRENCE_DISPLAY_KEY,
  RECURRENCE_META_KEY,
} from "../services/list-recurrence.js";

function isDryRun(): boolean {
  return process.argv.includes("--dry-run");
}

/** Labels that name a person the clock is about (birthday / anniversary style). */
const ABOUT_LABEL =
  /^(?:יום\s+ההולדת|יום\s+הולדת|הולדת|יום\s+הנישואין|נישואין|אזכרה|יום\s+זיכרון)\s+של\s+(.+)$/u;

function extractAboutName(label: string): string | null {
  const trimmed = label.trim().replace(/\s+/g, " ");
  const match = ABOUT_LABEL.exec(trimmed);
  if (!match?.[1]) {
    return null;
  }
  return match[1].trim() || null;
}

function isBirthdayLike(label: string, recurrence: unknown): boolean {
  if (extractAboutName(label)) {
    return true;
  }
  const rule = parseRecurrence(recurrence);
  return Boolean(rule && rule.freq === "yearly" && /הולדת|נישואין|אזכרה|זיכרון/u.test(label));
}

function normalizePerson(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function matchHumanId(
  name: string,
  humans: Array<{ id: string; name: string; nickname: string | null }>,
): string | null {
  const needle = normalizePerson(name);
  if (!needle) {
    return null;
  }
  const hits = humans.filter((row) => {
    const nick = row.nickname ? normalizePerson(row.nickname) : "";
    const first = normalizePerson(row.name);
    return nick === needle || first === needle;
  });
  return hits.length === 1 ? hits[0]!.id : null;
}

function allDayYearlyRule(recurrence: unknown): Recurrence | null {
  const parsed = parseRecurrence(recurrence);
  if (!parsed || parsed.freq !== "yearly") {
    return null;
  }
  const { time: _t, endTime: _e, ...rest } = parsed;
  return rest;
}

async function tasksListIdFor(employeeId: string, dryRun: boolean): Promise<string | null> {
  const existing = await prisma.employeeList.findFirst({
    where: { employeeId, listType: "tasks", name: "", deletedAt: null },
  });
  if (existing) {
    return existing.id;
  }
  if (dryRun) {
    return `dry-run-tasks-${employeeId}`;
  }
  const created = await prisma.employeeList.create({
    data: { employeeId, listType: "tasks", name: "" },
  });
  return created.id;
}

async function main(): Promise<void> {
  const dryRun = isDryRun();
  const active = await prisma.reminder.findMany({
    where: { status: "active" },
    select: {
      id: true,
      itemLabel: true,
      itemKey: true,
      recurrence: true,
      fireAt: true,
      aboutIds: true,
      ownerId: true,
      userId: true,
    },
  });

  const candidates = active.filter((row) =>
    isBirthdayLike(row.itemLabel || row.itemKey, row.recurrence),
  );
  console.log(
    `Active clocks: ${active.length}; birthday-like: ${candidates.length}${dryRun ? " (dry-run)" : ""}`,
  );
  if (candidates.length === 0) {
    return;
  }

  const linked = await prisma.employeeListItem.findMany({
    where: {
      linkedReminderId: { in: candidates.map((row) => row.id) },
      deletedAt: null,
    },
    select: { linkedReminderId: true },
  });
  const alreadyLinked = new Set(
    linked
      .map((row) => row.linkedReminderId)
      .filter((id): id is string => Boolean(id)),
  );

  const userIds = [...new Set(candidates.map((row) => row.userId))];
  const humans = await prisma.employee.findMany({
    where: { userId: { in: userIds }, kind: "human" },
    select: { id: true, userId: true, name: true, nickname: true },
  });
  const humansByUser = new Map<string, typeof humans>();
  for (const row of humans) {
    const list = humansByUser.get(row.userId) ?? [];
    list.push(row);
    humansByUser.set(row.userId, list);
  }

  let aboutSet = 0;
  let tasksCreated = 0;
  let skippedAbout = 0;
  let skippedTask = 0;

  for (const clock of candidates) {
    const label = (clock.itemLabel || clock.itemKey).trim();
    const existingAbout = Array.isArray(clock.aboutIds)
      ? clock.aboutIds.map(String).filter(Boolean)
      : [];
    let aboutIds = existingAbout;

    if (aboutIds.length === 0) {
      const aboutName = extractAboutName(label);
      if (!aboutName) {
        skippedAbout += 1;
        console.log(`[skip about] no name in label: ${label} (${clock.id})`);
      } else {
        const match = matchHumanId(aboutName, humansByUser.get(clock.userId) ?? []);
        if (!match) {
          skippedAbout += 1;
          console.log(
            `[skip about] no unique human "${aboutName}" for: ${label} (${clock.id})`,
          );
        } else {
          aboutIds = [match];
          if (dryRun) {
            console.log(
              `[dry-run] would set about_ids=[${match}] on ${clock.id} (${label})`,
            );
          } else {
            await prisma.reminder.update({
              where: { id: clock.id },
              data: { aboutIds },
            });
            console.log(`Set about_ids=[${match}] on ${clock.id} (${label})`);
          }
          aboutSet += 1;
        }
      }
    } else {
      console.log(`about already set on ${clock.id} (${label})`);
    }

    if (alreadyLinked.has(clock.id)) {
      skippedTask += 1;
      console.log(`[skip task] already soft-linked: ${label} (${clock.id})`);
      continue;
    }

    const rule = allDayYearlyRule(clock.recurrence);
    if (!rule) {
      skippedTask += 1;
      console.log(`[skip task] not yearly recurrence: ${label} (${clock.id})`);
      continue;
    }

    const dateYmd = formatJerusalemDateTime(clock.fireAt).slice(0, 10);
    const meta = { ...serializeRecurrence(rule), start: dateYmd };
    const data: Record<string, unknown> = {
      "שם משימה": label.slice(0, 255),
      "תאריך לביצוע": dateYmd,
      "יום שלם": true,
      [RECURRENCE_META_KEY]: meta,
      [RECURRENCE_DISPLAY_KEY]: formatRecurrenceHe(rule),
    };

    const listId = await tasksListIdFor(clock.ownerId, dryRun);
    if (!listId) {
      skippedTask += 1;
      console.log(`[skip task] no tasks list for owner ${clock.ownerId}`);
      continue;
    }

    if (dryRun) {
      console.log(
        `[dry-run] would create all-day task on owner ${clock.ownerId} linked to ${clock.id} (${label}) date=${dateYmd}`,
      );
    } else {
      await prisma.employeeListItem.create({
        data: {
          listId,
          itemKey: label.slice(0, 255),
          data: data as Prisma.InputJsonValue,
          scope: "personal",
          addedById: clock.ownerId,
          linkedReminderId: clock.id,
        },
      });
      console.log(
        `Created all-day task linked to ${clock.id} (${label}) date=${dateYmd}`,
      );
    }
    tasksCreated += 1;
  }

  console.log(
    `${dryRun ? "Would set" : "Set"} about: ${aboutSet}; ${dryRun ? "would create" : "created"} tasks: ${tasksCreated}; skip about: ${skippedAbout}; skip task: ${skippedTask}`,
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
