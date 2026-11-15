/**
 * Real Prisma settlement for a plain one-shot. Does not scan other due clocks.
 * workee_test only. WhatsApp is not called.
 */
import { afterAll, expect, it } from "vitest";
import { prisma } from "../src/database/prisma.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import {
  ONE_SHOT_DELIVERY_RETRY_MS,
  settleFiredReminder,
} from "../src/services/reminder-fire.js";

const account: { current: HarnessAccount | null } = { current: null };

afterAll(async () => {
  if (!account.current) return;
  await prisma.auditEvent
    .deleteMany({ where: { userId: account.current.userId } })
    .catch(() => undefined);
  await destroyHarnessAccount(account.current);
});

it("persists a failed one-shot as still active, then done only after success", async () => {
  account.current = await createHarnessAccount("עמית", { digitalWorker: true });
  const phone = `9725${String(Date.now()).slice(-8)}`;
  await prisma.employee.update({
    where: { id: account.current.employeeId },
    data: { phone },
  });
  const now = new Date("2026-11-15T10:00:00.000Z");
  const reminder = await prisma.reminder.create({
    data: {
      userId: account.current.userId,
      ownerId: account.current.employeeId,
      actorId: account.current.employeeId,
      itemKey: "תיק",
      itemLabel: "לקחת את התיק",
      listType: "tasks",
      fireAt: new Date("2026-11-15T09:00:00.000Z"),
      repeat: "once",
      pingIds: [account.current.employeeId],
      messageText: "לקחת את התיק",
      status: "active",
      sendStatus: "pending",
    },
  });
  const list = await prisma.employeeList.create({
    data: {
      employeeId: account.current.digitalEmployeeId!,
      listType: "tasks",
      name: "מטלות",
    },
  });
  const task = await prisma.employeeListItem.create({
    data: {
      listId: list.id,
      itemKey: "תיק",
      data: { text: "לקחת את התיק" },
      reminderId: reminder.id,
    },
  });
  await prisma.reminder.update({
    where: { id: reminder.id },
    data: { workerItemId: task.id },
  });

  await settleFiredReminder(
    {
      id: reminder.id,
      fireAt: reminder.fireAt,
      repeat: "once",
      occurrencesFired: 0,
      userId: account.current.userId,
      actorId: account.current.employeeId,
      itemLabel: reminder.itemLabel,
    },
    now,
    "failed",
    { retryWhenFailed: true },
  );

  const held = await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
  const heldTask = await prisma.employeeListItem.findUniqueOrThrow({ where: { id: task.id } });
  expect(held.status).toBe("active");
  expect(held.sendStatus).toBe("failed");
  expect(held.sentAt).toBeNull();
  expect(held.workerItemId).toBe(task.id);
  expect(held.occurrencesFired).toBe(1);
  expect(held.fireAt.getTime()).toBe(now.getTime() + ONE_SHOT_DELIVERY_RETRY_MS);
  expect(heldTask.deletedAt).toBeNull();

  await settleFiredReminder(
    {
      id: reminder.id,
      fireAt: held.fireAt,
      repeat: "once",
      occurrencesFired: held.occurrencesFired,
      userId: account.current.userId,
      actorId: account.current.employeeId,
      itemLabel: reminder.itemLabel,
    },
    new Date(now.getTime() + ONE_SHOT_DELIVERY_RETRY_MS),
    "sent",
  );

  const done = await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
  const doneTask = await prisma.employeeListItem.findUniqueOrThrow({ where: { id: task.id } });
  expect(done.status).toBe("done");
  expect(done.sendStatus).toBe("sent");
  expect(done.sentAt).not.toBeNull();
  expect(done.workerItemId).toBeNull();
  expect(doneTask.deletedAt).not.toBeNull();
});
