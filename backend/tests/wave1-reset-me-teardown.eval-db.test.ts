/**
 * Regression: /reset-me must purge a temp Prospect that already has
 * reminders (actor Restrict), assigned task lists, pending outbound rows,
 * and a WhatsAppInbound window — without FK errors.
 *
 * Run: npm run test:eval-db -- tests/wave1-reset-me-teardown.eval-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/database/prisma.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { resetEnvCache } from "../src/config/env.js";
import {
  handleDevProspectTool,
  PHONE_BACKUP_SUFFIX,
  purgeDevUserAccount,
} from "../src/services/prospect-dev-tools.service.js";
import { phonesMatch } from "../src/utils/phone.js";

const PHONE = "972500000091";

const harnesses: HarnessAccount[] = [];
const extraUserIds: string[] = [];

async function cleanupPhone(phone: string): Promise<void> {
  const humans = await prisma.employee.findMany({
    where: { phone: { not: null }, kind: "human" },
    select: { id: true, userId: true, phone: true },
  });
  const hits = humans.filter(
    (row) =>
      row.phone &&
      (phonesMatch(row.phone, phone) ||
        row.phone === `${phone}${PHONE_BACKUP_SUFFIX}` ||
        row.phone.endsWith(PHONE_BACKUP_SUFFIX)),
  );
  for (const hit of hits) {
    await purgeDevUserAccount(hit.userId).catch(() => undefined);
  }
  await prisma.whatsAppInbound
    .deleteMany({ where: { phone: { contains: phone.slice(-9) } } })
    .catch(() => undefined);
}

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
});

afterAll(async () => {
  for (const id of [...extraUserIds]) {
    await purgeDevUserAccount(id).catch(() => undefined);
  }
  extraUserIds.length = 0;
  while (harnesses.length > 0) {
    const account = harnesses.pop();
    if (account) {
      await purgeDevUserAccount(account.userId).catch(async () => {
        await destroyHarnessAccount(account).catch(() => undefined);
      });
    }
  }
  await cleanupPhone(PHONE);
  process.env.DEV_TEST_PHONES = process.env.DEV_TEST_PHONES ?? "";
  resetEnvCache();
});

describe("Wave 1 /reset-me teardown (eval-db)", () => {
  it("purges temp Prospect with reminders, tasks, pending outbound, and inbound", async () => {
    await cleanupPhone(PHONE);
    process.env.DEV_TEST_PHONES = PHONE;
    process.env.NODE_ENV = "test";
    resetEnvCache();

    const member = await createHarnessAccount("טל-reset", { digitalWorker: true });
    harnesses.push(member);
    await prisma.user.update({
      where: { id: member.userId },
      data: { consentPending: false },
    });
    await prisma.employee.update({
      where: { id: member.employeeId },
      data: { phone: PHONE },
    });

    const asProspect = await handleDevProspectTool({
      phone: PHONE,
      text: "/as-prospect",
    });
    expect(asProspect.handled).toBe(true);
    expect(asProspect.reply).toMatch(/_backup|as-prospect/i);

    const temp = await createHarnessAccount("Prospect-reset", { digitalWorker: true });
    harnesses.push(temp);
    extraUserIds.push(temp.userId);
    await prisma.user.update({
      where: { id: temp.userId },
      data: { consentPending: true },
    });
    await prisma.employee.update({
      where: { id: temp.employeeId },
      data: { phone: PHONE },
    });

    // Reminder with actor Restrict — this is what broke LIVE /reset-me.
    await prisma.reminder.create({
      data: {
        userId: temp.userId,
        ownerId: temp.employeeId,
        actorId: temp.employeeId,
        itemKey: "תיק-reset",
        itemLabel: "לקחת תיק",
        listType: "tasks",
        fireAt: new Date(Date.now() + 60_000),
        repeat: "once",
        pingIds: [temp.employeeId],
        messageText: "לקחת תיק",
        status: "active",
        sendStatus: "pending",
      },
    });

    const list = await prisma.employeeList.create({
      data: {
        employeeId: temp.digitalEmployeeId!,
        listType: "tasks",
        name: "מטלות",
      },
    });
    await prisma.employeeListItem.create({
      data: {
        listId: list.id,
        itemKey: "תיק-reset",
        data: { text: "לקחת תיק" },
        addedById: temp.employeeId,
      },
    });

    await prisma.deliveryAttempt.create({
      data: {
        userId: temp.userId,
        ledgerKey: `reset-me-teardown-${temp.userId}`,
        stepKey: "wa:notice",
        destination: PHONE,
        purpose: "asker_notice",
        status: "queued",
      },
    });

    await prisma.whatsAppInvite.create({
      data: {
        token: `WRK-INV-RESET${temp.userId.replace(/-/g, "").slice(0, 12)}`.slice(0, 32),
        userId: temp.userId,
        askerEmployeeId: temp.employeeId,
        digitalEmployeeId: temp.digitalEmployeeId!,
        recipientPhone: "972509999001",
        recipientLabel: "דני",
        askSummary: "שיתוף בדיקה",
        draftText: "טיוטה",
        status: "pending",
      },
    });

    await prisma.whatsAppInbound.upsert({
      where: { phone: PHONE },
      create: { phone: PHONE, lastInboundAt: new Date() },
      update: { lastInboundAt: new Date() },
    });

    const beforeReminders = await prisma.reminder.count({ where: { userId: temp.userId } });
    const beforeAttempts = await prisma.deliveryAttempt.count({
      where: { userId: temp.userId },
    });
    const beforeLists = await prisma.employeeList.count({
      where: { employeeId: temp.digitalEmployeeId! },
    });
    expect(beforeReminders).toBeGreaterThan(0);
    expect(beforeAttempts).toBeGreaterThan(0);
    expect(beforeLists).toBeGreaterThan(0);

    const resetMe = await handleDevProspectTool({
      phone: PHONE,
      text: "/reset-me",
    });
    expect(resetMe.handled).toBe(true);
    expect(resetMe.reply).toMatch(/שוחזר/);
    expect(resetMe.reply).not.toMatch(/נכשל/);
    expect(resetMe.reply).toMatch(/חלון 24|Cold/i);

    const restored = await prisma.employee.findUniqueOrThrow({
      where: { id: member.employeeId },
    });
    expect(restored.phone).toBe(PHONE);

    const tempUser = await prisma.user.findUnique({ where: { id: temp.userId } });
    expect(tempUser).toBeNull();
    expect(await prisma.reminder.count({ where: { userId: temp.userId } })).toBe(0);
    expect(await prisma.deliveryAttempt.count({ where: { userId: temp.userId } })).toBe(0);
    expect(
      await prisma.employeeList.count({ where: { employeeId: temp.digitalEmployeeId! } }),
    ).toBe(0);
    expect(await prisma.whatsAppInbound.findUnique({ where: { phone: PHONE } })).toBeNull();

    // Avoid double-delete in afterAll — temp already purged.
    const idx = harnesses.findIndex((h) => h.userId === temp.userId);
    if (idx >= 0) harnesses.splice(idx, 1);
    const extraIdx = extraUserIds.indexOf(temp.userId);
    if (extraIdx >= 0) extraUserIds.splice(extraIdx, 1);
  });
});
