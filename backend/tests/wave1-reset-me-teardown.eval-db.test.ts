/**
 * Regression: /restore-me (/reset-me alias) must restore a parked `_backup`
 * phone without deleting the real member's reminders/lists — and must only
 * unlink (phone=null) a temporary Prospect holding the live digits.
 *
 * Run: npm run test:eval-db -- tests/wave1-reset-me-teardown.eval-db.test.ts
 * (isolated workee_test — never LIVE)
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
} from "../src/services/prospect-dev-tools.service.js";
import { INVITE_TOKEN_PREFIX } from "../src/services/whatsapp-invite.service.js";
import { phonesMatch } from "../src/utils/phone.js";
import { Prisma } from "@prisma/client";

const PHONE = "972500000091";

const harnesses: HarnessAccount[] = [];

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
    const account = harnesses.find((h) => h.userId === hit.userId);
    if (account) {
      await destroyHarnessAccount(account).catch(() => undefined);
      const idx = harnesses.findIndex((h) => h.userId === hit.userId);
      if (idx >= 0) harnesses.splice(idx, 1);
    } else {
      // Test-only cleanup on eval DB — not used by production /restore-me.
      await prisma.employee.update({ where: { id: hit.id }, data: { phone: null } });
    }
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
  while (harnesses.length > 0) {
    const account = harnesses.pop();
    if (account) {
      await destroyHarnessAccount(account).catch(() => undefined);
    }
  }
  await cleanupPhone(PHONE);
  process.env.DEV_TEST_PHONES = process.env.DEV_TEST_PHONES ?? "";
  resetEnvCache();
});

describe("Wave 1 /restore-me phone-park (eval-db)", () => {
  it("restores parked member without deleting reminders/lists; unlinks temp Prospect only", async () => {
    await cleanupPhone(PHONE);
    process.env.DEV_TEST_PHONES = PHONE;
    process.env.NODE_ENV = "test";
    resetEnvCache();

    const member = await createHarnessAccount("טל-restore", { digitalWorker: true });
    harnesses.push(member);
    await prisma.user.update({
      where: { id: member.userId },
      data: { consentPending: false },
    });
    await prisma.employee.update({
      where: { id: member.employeeId },
      data: { phone: PHONE },
    });

    // Durable member data that must survive restore-me.
    await prisma.reminder.create({
      data: {
        userId: member.userId,
        ownerId: member.employeeId,
        actorId: member.employeeId,
        itemKey: "חלב-member",
        itemLabel: "לקנות חלב",
        listType: "tasks",
        fireAt: new Date(Date.now() + 60_000),
        repeat: "once",
        pingIds: [member.employeeId],
        messageText: "לקנות חלב",
        status: "active",
        sendStatus: "pending",
      },
    });
    const memberList = await prisma.employeeList.create({
      data: {
        employeeId: member.digitalEmployeeId!,
        listType: "tasks",
        name: "מטלות-member",
      },
    });
    await prisma.employeeListItem.create({
      data: {
        listId: memberList.id,
        itemKey: "חלב-member",
        data: { text: "לקנות חלב" },
        addedById: member.employeeId,
      },
    });

    const asProspect = await handleDevProspectTool({
      phone: PHONE,
      text: "/as-prospect",
    });
    expect(asProspect.handled).toBe(true);
    expect(asProspect.reply).toMatch(/_backup|as-prospect/i);

    const parked = await prisma.employee.findUniqueOrThrow({
      where: { id: member.employeeId },
    });
    expect(parked.phone).toBe(`${PHONE}${PHONE_BACKUP_SUFFIX}`);

    const temp = await createHarnessAccount("Prospect-restore", { digitalWorker: true });
    harnesses.push(temp);
    await prisma.user.update({
      where: { id: temp.userId },
      data: { consentPending: true },
    });
    await prisma.employee.update({
      where: { id: temp.employeeId },
      data: { phone: PHONE },
    });
    await prisma.reminder.create({
      data: {
        userId: temp.userId,
        ownerId: temp.employeeId,
        actorId: temp.employeeId,
        itemKey: "תיק-temp",
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

    await prisma.whatsAppInbound.upsert({
      where: { phone: PHONE },
      create: { phone: PHONE, lastInboundAt: new Date() },
      update: { lastInboundAt: new Date() },
    });

    // Sticky message invite + collab share on this phone (left from cold asker path).
    const messageInvite = await prisma.whatsAppInvite.create({
      data: {
        token: `${INVITE_TOKEN_PREFIX}RESTMSG01`,
        userId: member.userId,
        askerEmployeeId: member.employeeId,
        digitalEmployeeId: member.digitalEmployeeId!,
        recipientPhone: PHONE,
        recipientLabel: "טל",
        askSummary: "לעדכן אותי",
        draftText: "draft-message",
        status: "pending",
        guestEmployeeId: temp.employeeId,
      },
    });
    const shareInvite = await prisma.whatsAppInvite.create({
      data: {
        token: `${INVITE_TOKEN_PREFIX}RESTSHR01`,
        userId: member.userId,
        askerEmployeeId: member.employeeId,
        digitalEmployeeId: member.digitalEmployeeId!,
        recipientPhone: PHONE,
        recipientLabel: "טל",
        askSummary: "קניות משותפות",
        draftText: "draft-share",
        status: "pending",
        payload: {
          kind: "share",
          listType: "shopping",
          itemKeys: ["חלב"],
        } as Prisma.InputJsonValue,
      },
    });

    const restore = await handleDevProspectTool({
      phone: PHONE,
      text: "/restore-me",
    });
    expect(restore.handled).toBe(true);
    expect(restore.reply).toMatch(/שוחזר/);
    expect(restore.reply).toMatch(/ללא מחיקת נתונים/);
    expect(restore.reply).not.toMatch(/נכשל/);

    const restored = await prisma.employee.findUniqueOrThrow({
      where: { id: member.employeeId },
    });
    expect(restored.phone).toBe(PHONE);

    // Message invite consumed on Member restore; Share stays pending.
    const messageAfter = await prisma.whatsAppInvite.findUniqueOrThrow({
      where: { id: messageInvite.id },
    });
    expect(messageAfter.status).toBe("consumed");
    expect(messageAfter.consumedAt).toBeTruthy();
    const shareAfter = await prisma.whatsAppInvite.findUniqueOrThrow({
      where: { id: shareInvite.id },
    });
    expect(shareAfter.status).toBe("pending");

    // Real member durable data intact.
    expect(await prisma.reminder.count({ where: { userId: member.userId } })).toBeGreaterThan(0);
    expect(
      await prisma.employeeList.count({ where: { employeeId: member.digitalEmployeeId! } }),
    ).toBeGreaterThan(0);

    // Temp prospect still exists but phone unlinked — never purged.
    const tempUser = await prisma.user.findUnique({ where: { id: temp.userId } });
    expect(tempUser).not.toBeNull();
    const tempEmp = await prisma.employee.findUniqueOrThrow({
      where: { id: temp.employeeId },
    });
    expect(tempEmp.phone).toBeNull();
    expect(await prisma.reminder.count({ where: { userId: temp.userId } })).toBeGreaterThan(0);

    expect(await prisma.whatsAppInbound.findUnique({ where: { phone: PHONE } })).toBeNull();

    // Legacy alias behaves the same (re-park + restore).
    const asProspect2 = await handleDevProspectTool({
      phone: PHONE,
      text: "/as-prospect",
    });
    expect(asProspect2.handled).toBe(true);
    // Put temp back on digits so /reset-me has something to unlink.
    await prisma.employee.update({
      where: { id: temp.employeeId },
      data: { phone: PHONE },
    });
    const alias = await handleDevProspectTool({
      phone: PHONE,
      text: "/reset-me",
    });
    expect(alias.handled).toBe(true);
    expect(alias.reply).toMatch(/שוחזר|restore-me/);
    expect(alias.reply).toMatch(/ללא מחיקת נתונים/);
    const memberAgain = await prisma.employee.findUniqueOrThrow({
      where: { id: member.employeeId },
    });
    expect(memberAgain.phone).toBe(PHONE);
    expect(await prisma.reminder.count({ where: { userId: member.userId } })).toBeGreaterThan(0);
  });
});
