/**
 * Tal already sees Shani-owned «יום ההולדת של עמית» via pingIds
 * (8.5.2027 13:00 yearly). Do NOT create a second clock. Do NOT write
 * Shani's reminder or her task. Only ensure Tal has his own soft-linked
 * all-day yearly tasks row on that existing clock.
 *
 *   npx tsx src/scripts/ensure-tal-amit-birthday-task.ts
 */
import {
  formatJerusalemDateTime,
  formatRecurrenceHe,
  parseRecurrence,
  serializeRecurrence,
} from "@workee/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import {
  RECURRENCE_DISPLAY_KEY,
  RECURRENCE_META_KEY,
} from "../services/list-recurrence.js";

const TAL = "360a5898-6007-41fb-998a-dfde97a18062";
const AMIT = "92a318b9-ba1b-44fd-b2fc-e2341d11a7ae";
const CLOCK_ID = "64c4bb39-fb75-4650-b4d2-01c7f6bd73f4";
const LABEL = "יום ההולדת של עמית";

async function tasksListIdFor(employeeId: string): Promise<string> {
  const existing = await prisma.employeeList.findFirst({
    where: { employeeId, listType: "tasks", name: "", deletedAt: null },
  });
  if (existing) {
    return existing.id;
  }
  const created = await prisma.employeeList.create({
    data: { employeeId, listType: "tasks", name: "" },
  });
  return created.id;
}

function allDayRule(recurrence: unknown) {
  const parsed = parseRecurrence(recurrence);
  if (!parsed || parsed.freq !== "yearly") {
    return null;
  }
  const { time: _t, endTime: _e, ...rest } = parsed;
  return rest;
}

async function main(): Promise<void> {
  const clock = await prisma.reminder.findUnique({
    where: { id: CLOCK_ID },
    select: {
      id: true,
      ownerId: true,
      itemLabel: true,
      fireAt: true,
      recurrence: true,
      aboutIds: true,
      pingIds: true,
      status: true,
      updatedAt: true,
    },
  });
  if (!clock || clock.status !== "active") {
    throw new Error(`Active clock ${CLOCK_ID} not found`);
  }

  const pings = Array.isArray(clock.pingIds) ? clock.pingIds.map(String) : [];
  if (!pings.includes(TAL)) {
    throw new Error(`Clock ${CLOCK_ID} does not ping Tal — aborting`);
  }

  const about = Array.isArray(clock.aboutIds) ? clock.aboutIds.map(String) : [];
  if (!about.includes(AMIT)) {
    console.warn(
      `Clock about_ids missing Amit (${AMIT}); leaving reminder untouched per constraint.`,
    );
  }

  const shaniTaskBefore = await prisma.employeeListItem.findFirst({
    where: {
      linkedReminderId: CLOCK_ID,
      deletedAt: null,
      list: { employeeId: { not: TAL } },
    },
    select: {
      id: true,
      listId: true,
      itemKey: true,
      updatedAt: true,
    },
  });
  const clockBefore = { ...clock };

  const talTask = await prisma.employeeListItem.findFirst({
    where: {
      deletedAt: null,
      linkedReminderId: CLOCK_ID,
      list: { employeeId: TAL, listType: "tasks" },
    },
  });

  if (talTask) {
    console.log(`Tal task already linked: ${talTask.id}`);
  } else {
    const rule = allDayRule(clock.recurrence);
    if (!rule) {
      throw new Error("Clock is not yearly — cannot build all-day task");
    }
    const dateYmd = formatJerusalemDateTime(clock.fireAt).slice(0, 10);
    const data: Record<string, unknown> = {
      "שם משימה": LABEL,
      "תאריך לביצוע": dateYmd,
      "יום שלם": true,
      [RECURRENCE_META_KEY]: { ...serializeRecurrence(rule), start: dateYmd },
      [RECURRENCE_DISPLAY_KEY]: formatRecurrenceHe(rule),
    };
    const listId = await tasksListIdFor(TAL);
    const created = await prisma.employeeListItem.create({
      data: {
        listId,
        itemKey: LABEL,
        data: data as Prisma.InputJsonValue,
        scope: "personal",
        addedById: TAL,
        linkedReminderId: CLOCK_ID,
      },
    });
    console.log(
      `Created Tal all-day task ${created.id} soft-linked to existing clock ${CLOCK_ID} (${dateYmd})`,
    );
  }

  const clockAfter = await prisma.reminder.findUnique({
    where: { id: CLOCK_ID },
    select: {
      ownerId: true,
      aboutIds: true,
      pingIds: true,
      fireAt: true,
      updatedAt: true,
    },
  });
  const shaniTaskAfter = shaniTaskBefore
    ? await prisma.employeeListItem.findUnique({
        where: { id: shaniTaskBefore.id },
        select: { id: true, listId: true, updatedAt: true },
      })
    : null;

  const reminderUntouched =
    Boolean(clockAfter) &&
    clockAfter!.ownerId === clockBefore.ownerId &&
    JSON.stringify(clockAfter!.aboutIds) ===
      JSON.stringify(clockBefore.aboutIds) &&
    JSON.stringify(clockAfter!.pingIds) ===
      JSON.stringify(clockBefore.pingIds) &&
    clockAfter!.updatedAt.getTime() === clockBefore.updatedAt.getTime();

  const shaniTaskUntouched =
    !shaniTaskBefore ||
    (Boolean(shaniTaskAfter) &&
      shaniTaskAfter!.listId === shaniTaskBefore.listId &&
      shaniTaskAfter!.updatedAt.getTime() ===
        shaniTaskBefore.updatedAt.getTime());

  const talTaskFinal = await prisma.employeeListItem.findFirst({
    where: {
      deletedAt: null,
      linkedReminderId: CLOCK_ID,
      list: { employeeId: TAL },
    },
    select: { id: true, itemKey: true, data: true },
  });

  console.log(
    JSON.stringify(
      {
        reminderUntouched,
        shaniTaskUntouched,
        talTaskId: talTaskFinal?.id ?? null,
        label: clock.itemLabel,
        fireAt: clock.fireAt,
      },
      null,
      2,
    ),
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
