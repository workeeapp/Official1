/**
 * Stage 5a — S8 Option A: present pending collab invite + opaque Accept/Decline.
 *
 * Requires WORKEE_COLLAB_INVITE_ACK=1 so auto-apply is skipped and the V path
 * is exercised. Stage 5b flips ack on permanently after this pack is green.
 *
 * Run: npm run test:eval-db -- tests/collab-invite-ack.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/database/prisma.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { parseCollabInvitePayload } from "../src/services/collab-invite.service.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { phonesMatch } from "../src/utils/phone.js";
import { createWhatsAppInvite } from "../src/services/whatsapp-invite.service.js";
import { listEmployeesForUser } from "../src/services/employee.service.js";
import { resolveWhatsAppSpeaker } from "../src/services/whatsapp.service.js";

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
});

describe("Stage 5a collab invite opaque Accept/Decline (eval-db)", () => {
  const harnesses: HarnessAccount[] = [];
  const extraUserIds: string[] = [];
  let prevAck: string | undefined;

  beforeEach(() => {
    prevAck = process.env.WORKEE_COLLAB_INVITE_ACK;
    process.env.WORKEE_COLLAB_INVITE_ACK = "1";
  });

  afterEach(async () => {
    if (prevAck === undefined) {
      delete process.env.WORKEE_COLLAB_INVITE_ACK;
    } else {
      process.env.WORKEE_COLLAB_INVITE_ACK = prevAck;
    }
    setLlmClientForTests(null);
    const ids = [...harnesses.map((h) => h.userId), ...extraUserIds];
    if (ids.length > 0) {
      await prisma.deliveryAttempt
        .deleteMany({ where: { userId: { in: ids } } })
        .catch(() => undefined);
      await prisma.pendingHighRiskConfirm
        .deleteMany({ where: { userId: { in: ids } } })
        .catch(() => undefined);
      await prisma.whatsAppInvite
        .deleteMany({ where: { userId: { in: ids } } })
        .catch(() => undefined);
      await prisma.chatMessage
        .deleteMany({ where: { conversation: { userId: { in: ids } } } })
        .catch(() => undefined);
      await prisma.chatConversation
        .deleteMany({ where: { userId: { in: ids } } })
        .catch(() => undefined);
    }
    while (harnesses.length > 0) {
      const account = harnesses.pop();
      if (account) {
        await destroyHarnessAccount(account);
      }
    }
    while (extraUserIds.length > 0) {
      const userId = extraUserIds.pop();
      if (userId) {
        await prisma.employee.deleteMany({ where: { userId } }).catch(() => undefined);
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      }
    }
  });

  async function unusedPhone(): Promise<string> {
    const rows = await prisma.employee.findMany({
      where: { phone: { not: null } },
      select: { phone: true },
    });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const phone = `97258${Math.floor(Math.random() * 1e7)
        .toString()
        .padStart(7, "0")}`;
      const taken = rows.some((row) => row.phone && phonesMatch(row.phone, phone));
      if (!taken) {
        return phone;
      }
    }
    throw new Error("could not allocate a non-colliding test phone");
  }

  function stubReply(payload: unknown) {
    setLlmClientForTests({
      async createConversation() {
        return `conv-${randomUUID()}`;
      },
      async createResponse() {
        return { reply: JSON.stringify(payload), raw: {} };
      },
    });
  }

  async function recipientOf(phone: string) {
    const speaker = await resolveWhatsAppSpeaker(phone);
    extraUserIds.push(speaker.userId);
    // Wave 1 C1-A: new WhatsApp accounts are Prospects. This pack exercises
    // Member Share Accept / Assign ack — promote to Member (Explicit Join later).
    await prisma.user.update({
      where: { id: speaker.userId },
      data: { consentPending: false },
    });
    const employees = await listEmployeesForUser(speaker.userId);
    const employee = employees.find((row) => row.id === speaker.employeeId);
    const lucy = employees.find((row) => row.protected === true);
    if (!employee || !lucy) {
      throw new Error("new account is missing its human or Lucy");
    }
    return {
      userId: speaker.userId,
      employeeId: speaker.employeeId,
      digitalEmployeeId: lucy.id,
      employee,
    };
  }

  async function seedShareInvite(label: string) {
    const phone = await unusedPhone();
    const asker = await createHarnessAccount("טל", { digitalWorker: true });
    harnesses.push(asker);
    const askerPhone = await unusedPhone();
    await prisma.employee.update({
      where: { id: asker.employeeId },
      data: { phone: askerPhone },
    });
    const rowId = randomUUID();
    const payload = {
      v: 1 as const,
      kind: "share" as const,
      domain: "list" as const,
      rowId,
      action: {
        action: "add" as const,
        listType: "shopping" as const,
        listName: "",
        items: [{ "שם פריט": label }],
        targets: [],
      },
    };
    expect(parseCollabInvitePayload(payload)).toBeTruthy();
    const created = await createWhatsAppInvite({
      userId: asker.userId,
      askerEmployeeId: asker.employeeId,
      digitalEmployeeId: asker.digitalEmployeeId!,
      askerName: "טל",
      recipientPhone: phone,
      recipientLabel: "נועה",
      askSummary: label,
      expectsReply: false,
      payload,
    });
    expect(created).toBeTruthy();
    return { phone, asker, invite: created!.invite, rowId, label };
  }

  async function rowsWithLabel(label: string) {
    const rows = await prisma.employeeListItem.findMany({
      where: { deletedAt: null },
      include: { list: true },
    });
    return rows.filter((row) => JSON.stringify(row.data).includes(label));
  }

  it(
    "presents pending invite with opaque Accept/Decline (not auto-applied)",
    async () => {
      const label = `חלב-5a-${randomUUID().slice(0, 8)}`;
      const seeded = await seedShareInvite(label);
      const recipient = await recipientOf(seeded.phone);

      stubReply({
        responses: [{ text: "יש הזמנה.", buttons: [] }],
        metadata: { lists: [] },
      });
      const present = await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: "היי",
      });

      expect(await rowsWithLabel(label)).toHaveLength(0);
      const pendingInvite = await prisma.whatsAppInvite.findUnique({
        where: { id: seeded.invite.id },
      });
      expect(pendingInvite?.status).toBe("pending");

      const offer = await prisma.pendingHighRiskConfirm.findFirst({
        where: {
          userId: recipient.userId,
          actionKind: "collab_invite",
          status: "offered",
        },
        orderBy: { createdAt: "desc" },
      });
      expect(offer).toBeTruthy();
      expect(present.reply).toMatch(/קבלי או דחי/);
      expect(present.reply).toContain(offer!.confirmCommand);
      expect(present.reply).toContain(offer!.cancelCommand);
    },
    90_000,
  );

  it(
    "Accept applies confirmCollabInvite exactly once; replay is inert",
    async () => {
      const label = `קבל-5a-${randomUUID().slice(0, 8)}`;
      const seeded = await seedShareInvite(label);
      const recipient = await recipientOf(seeded.phone);

      stubReply({
        responses: [{ text: "יש הזמנה.", buttons: [] }],
        metadata: { lists: [] },
      });
      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: "היי",
      });
      const offer = await prisma.pendingHighRiskConfirm.findFirst({
        where: {
          userId: recipient.userId,
          actionKind: "collab_invite",
          status: "offered",
        },
      });
      expect(offer).toBeTruthy();

      setLlmClientForTests(null);
      const accepted = await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: offer!.confirmCommand,
      });
      expect(accepted.reply).toMatch(/קיבלתי את ההזמנה/);
      expect(await rowsWithLabel(label)).toHaveLength(1);
      expect(
        (await prisma.whatsAppInvite.findUnique({ where: { id: seeded.invite.id } }))
          ?.status,
      ).toBe("consumed");
      expect(
        (await prisma.pendingHighRiskConfirm.findUnique({ where: { id: offer!.id } }))
          ?.status,
      ).toBe("consumed");

      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: offer!.confirmCommand,
      });
      expect(await rowsWithLabel(label)).toHaveLength(1);
      expect(
        (await prisma.pendingHighRiskConfirm.findUnique({ where: { id: offer!.id } }))
          ?.status,
      ).toBe("consumed");
    },
    120_000,
  );

  it(
    "Decline cancels invite exactly once; replay is inert",
    async () => {
      const label = `דחה-5a-${randomUUID().slice(0, 8)}`;
      const seeded = await seedShareInvite(label);
      const recipient = await recipientOf(seeded.phone);

      stubReply({
        responses: [{ text: "יש הזמנה.", buttons: [] }],
        metadata: { lists: [] },
      });
      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: "היי",
      });
      const offer = await prisma.pendingHighRiskConfirm.findFirst({
        where: {
          userId: recipient.userId,
          actionKind: "collab_invite",
          status: "offered",
        },
      });
      expect(offer).toBeTruthy();

      setLlmClientForTests(null);
      const declined = await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: offer!.cancelCommand,
      });
      expect(declined.reply).toMatch(/דחיתי את ההזמנה/);
      expect(await rowsWithLabel(label)).toHaveLength(0);
      expect(
        (await prisma.whatsAppInvite.findUnique({ where: { id: seeded.invite.id } }))
          ?.status,
      ).toBe("cancelled");

      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: offer!.cancelCommand,
      });
      expect(await rowsWithLabel(label)).toHaveLength(0);
      expect(
        (await prisma.whatsAppInvite.findUnique({ where: { id: seeded.invite.id } }))
          ?.status,
      ).toBe("cancelled");
    },
    120_000,
  );

  it(
    "expired / foreign-user / stale commands do not apply",
    async () => {
      const label = `dead-5a-${randomUUID().slice(0, 8)}`;
      const seeded = await seedShareInvite(label);
      const recipient = await recipientOf(seeded.phone);

      stubReply({
        responses: [{ text: "יש הזמנה.", buttons: [] }],
        metadata: { lists: [] },
      });
      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: "היי",
      });
      const offer = await prisma.pendingHighRiskConfirm.findFirst({
        where: {
          userId: recipient.userId,
          actionKind: "collab_invite",
          status: "offered",
        },
      });
      expect(offer).toBeTruthy();

      await prisma.pendingHighRiskConfirm.update({
        where: { id: offer!.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      setLlmClientForTests(null);
      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: offer!.confirmCommand,
      });
      expect(await rowsWithLabel(label)).toHaveLength(0);
      expect(
        (await prisma.whatsAppInvite.findUnique({ where: { id: seeded.invite.id } }))
          ?.status,
      ).toBe("pending");

      // Foreign user with same opaque string — no effect.
      const other = await createHarnessAccount("אחר", { digitalWorker: true });
      harnesses.push(other);
      await prisma.employee.update({
        where: { id: other.employeeId },
        data: { phone: await unusedPhone() },
      });
      await sendChatMessage({
        userId: other.userId,
        employeeId: other.employeeId,
        digitalEmployeeId: other.digitalEmployeeId!,
        message: offer!.confirmCommand,
      });
      expect(await rowsWithLabel(label)).toHaveLength(0);
      expect(
        (await prisma.whatsAppInvite.findUnique({ where: { id: seeded.invite.id } }))
          ?.status,
      ).toBe("pending");
    },
    120_000,
  );

  it(
    "parallel Accept attempts apply confirmCollabInvite once",
    async () => {
      const label = `מקביל-5a-${randomUUID().slice(0, 8)}`;
      const seeded = await seedShareInvite(label);
      const recipient = await recipientOf(seeded.phone);

      stubReply({
        responses: [{ text: "יש הזמנה.", buttons: [] }],
        metadata: { lists: [] },
      });
      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: "היי",
      });
      const offer = await prisma.pendingHighRiskConfirm.findFirst({
        where: {
          userId: recipient.userId,
          actionKind: "collab_invite",
          status: "offered",
        },
      });
      expect(offer).toBeTruthy();

      setLlmClientForTests(null);
      const [a, b] = await Promise.all([
        sendChatMessage({
          userId: recipient.userId,
          employeeId: recipient.employeeId,
          digitalEmployeeId: recipient.digitalEmployeeId,
          message: offer!.confirmCommand,
        }),
        sendChatMessage({
          userId: recipient.userId,
          employeeId: recipient.employeeId,
          digitalEmployeeId: recipient.digitalEmployeeId,
          message: offer!.confirmCommand,
        }),
      ]);
      expect([a.reply, b.reply].some((r) => /קיבלתי את ההזמנה/.test(r))).toBe(
        true,
      );
      expect(await rowsWithLabel(label)).toHaveLength(1);
      expect(
        (await prisma.whatsAppInvite.findUnique({ where: { id: seeded.invite.id } }))
          ?.status,
      ).toBe("consumed");
    },
    120_000,
  );

  it(
    "model collab_invite metadata alone does not accept under ack mode",
    async () => {
      const label = `מודל-5a-${randomUUID().slice(0, 8)}`;
      const seeded = await seedShareInvite(label);
      const recipient = await recipientOf(seeded.phone);

      stubReply({
        responses: [{ text: "מאשרת.", buttons: [] }],
        metadata: {
          collab_invite: seeded.invite.id,
          lists: [],
        },
      });
      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: "מאשר",
      });
      expect(await rowsWithLabel(label)).toHaveLength(0);
      expect(
        (await prisma.whatsAppInvite.findUnique({ where: { id: seeded.invite.id } }))
          ?.status,
      ).toBe("pending");
    },
    90_000,
  );
});
