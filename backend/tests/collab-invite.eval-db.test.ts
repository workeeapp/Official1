/**
 * Phase 2: a share or assign aimed at an unregistered contact phone is stored
 * on the invite and applied once, on the recipient's later explicit confirm.
 *
 * Real Prisma on workee_test. Model is stubbed. No WhatsApp send, no OpenAI.
 *
 * Run: npm run test:eval-db -- tests/collab-invite.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PublicEmployee } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import {
  confirmCollabInvite,
  readCollabInviteDecision,
} from "../src/services/collab-invite.service.js";
import { listEmployeesForUser } from "../src/services/employee.service.js";
import * as records from "../src/services/employee-records.service.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { phonesMatch } from "../src/utils/phone.js";
import {
  bindInboundToInvite,
  findPendingMessageInviteByPhone,
  INVITE_TOKEN_PREFIX,
} from "../src/services/whatsapp-invite.service.js";
import { resolveWhatsAppSpeaker } from "../src/services/whatsapp.service.js";

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
});

describe("share/assign invitation continuity (eval-db)", () => {
  const harnesses: HarnessAccount[] = [];
  const extraUserIds: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    const ids = userIds();
    if (ids.length > 0) {
      await prisma.whatsAppInvite.deleteMany({ where: { userId: { in: ids } } }).catch(
        () => undefined,
      );
      await prisma.chatMessage
        .deleteMany({ where: { conversation: { userId: { in: ids } } } })
        .catch(() => undefined);
      await prisma.chatConversation
        .deleteMany({ where: { userId: { in: ids } } })
        .catch(() => undefined);
      await prisma.tipProgress
        .deleteMany({ where: { employee: { userId: { in: ids } } } })
        .catch(() => undefined);
      await prisma.tip.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
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
        await destroyCreatedUser(userId);
      }
    }
  });

  function userIds(): string[] {
    return [...harnesses.map((account) => account.userId), ...extraUserIds];
  }

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

  function installStub(payload: unknown, sink?: { facts: string }) {
    setLlmClientForTests({
      async createConversation() {
        return `conv-${randomUUID()}`;
      },
      async createResponse(input) {
        if (sink) {
          sink.facts = input.liveFacts ?? "";
        }
        return { reply: JSON.stringify(payload), raw: {} };
      },
    });
  }

  async function openAsker(contactName: string, contactPhone: string) {
    const asker = await createHarnessAccount("טל", { digitalWorker: true });
    harnesses.push(asker);
    const askerPhone = await unusedPhone();
    await prisma.employee.update({
      where: { id: asker.employeeId },
      data: { phone: askerPhone },
    });
    await prisma.contact.create({
      data: {
        userId: asker.userId,
        ownerEmployeeId: asker.employeeId,
        name: contactName,
        phone: contactPhone,
      },
    });
    return asker;
  }

  async function deferItem(input: {
    asker: HarnessAccount;
    contactName: string;
    listType: "shopping" | "tasks";
    label: string;
    share: boolean;
  }) {
    installStub({
      responses: [{ text: "אשלח הזמנה.", buttons: [] }],
      metadata: {
        confirm: false,
        lists: [
          {
            action: "add",
            list_type: input.listType,
            list_name: "",
            items: [
              {
                [input.listType === "tasks" ? "שם משימה" : "שם פריט"]: input.label,
              },
            ],
            targets: input.share ? ["טל", input.contactName] : [input.contactName],
          },
        ],
      },
    });
    await sendChatMessage({
      userId: input.asker.userId,
      employeeId: input.asker.employeeId,
      digitalEmployeeId: input.asker.digitalEmployeeId!,
      message: input.share ? "תשתפי עם איש הקשר" : "תשימי על איש הקשר",
    });
    const invite = await prisma.whatsAppInvite.findFirst({
      where: { userId: input.asker.userId, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
    expect(invite?.payload).toBeTruthy();
    const payload = invite?.payload as { rowId?: string; kind?: string };
    expect(payload.kind).toBe(input.share ? "share" : "assign");
    expect(payload.rowId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const written = await rowsWithLabel(input.label);
    expect(written).toHaveLength(0);
    return { invite: invite!, rowId: payload.rowId! };
  }

  async function rowsWithLabel(label: string) {
    const rows = await prisma.employeeListItem.findMany({
      where: { deletedAt: null },
      include: { list: true },
    });
    return rows.filter((row) => JSON.stringify(row.data).includes(label));
  }

  async function recipientOf(phone: string): Promise<{
    userId: string;
    employeeId: string;
    digitalEmployeeId: string;
    employee: PublicEmployee;
  }> {
    const speaker = await resolveWhatsAppSpeaker(phone);
    extraUserIds.push(speaker.userId);
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

  it("does not treat confirm false as a decline", () => {
    expect(readCollabInviteDecision('{"metadata":{"confirm":false}}')).toEqual({
      acceptId: null,
      declineId: null,
    });
    expect(
      readCollabInviteDecision('{"metadata":{"confirm":true,"lists":[]}}'),
    ).toEqual({ acceptId: null, declineId: null });
  });

  it(
    "shares onto a new Lucy account only after an explicit confirm",
    async () => {
      const phone = await unusedPhone();
      const asker = await openAsker("נועה", phone);
      const label = `חלב-הזמנה-${randomUUID().slice(0, 8)}`;
      const { invite, rowId } = await deferItem({
        asker,
        contactName: "נועה",
        listType: "shopping",
        label,
        share: true,
      });
      const recipient = await recipientOf(phone);
      const facts = { facts: "" };
      installStub(
        {
          responses: [{ text: "ראיתי הזמנה.", buttons: [] }],
          metadata: { confirm: false, lists: [] },
        },
        facts,
      );
      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: "היי",
      });
      expect(facts.facts).toContain("COLLAB INVITE");
      expect(facts.facts).toContain(invite.id);
      expect(facts.facts).not.toContain("GUEST MODE");
      expect(await rowsWithLabel(label)).toHaveLength(0);
      const stillPending = await prisma.whatsAppInvite.findUnique({
        where: { id: invite.id },
      });
      expect(stillPending?.status).toBe("pending");

      installStub({
        responses: [{ text: "כן, תשימי את זה.", buttons: [] }],
        metadata: {
          confirm: false,
          collab_invite: invite.id,
          lists: [],
          filing: [],
          reminders: [],
          directory: [],
          jobs: [],
          messages: [],
        },
      });
      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: "כן",
      });
      const consumed = await prisma.whatsAppInvite.findUnique({
        where: { id: invite.id },
      });
      expect(consumed?.status).toBe("consumed");
      const rows = await rowsWithLabel(label);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(rowId);
      expect(rows[0]?.list.employeeId).toBe(asker.employeeId);
      expect(rows[0]?.visibleTo).toEqual(
        expect.arrayContaining([asker.employeeId, recipient.employeeId]),
      );
      expect(rows[0]?.list.employeeId).not.toBe(recipient.employeeId);

      installStub({
        responses: [{ text: "שוב כן.", buttons: [] }],
        metadata: { confirm: false, collab_invite: invite.id, lists: [] },
      });
      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: "כן שוב",
      });
      expect(await rowsWithLabel(label)).toHaveLength(1);
    },
    120_000,
  );

  it(
    "assigns onto the new account only after an explicit confirm",
    async () => {
      const phone = await unusedPhone();
      const asker = await openAsker("נועה", phone);
      const label = `משימה-הזמנה-${randomUUID().slice(0, 8)}`;
      const { invite, rowId } = await deferItem({
        asker,
        contactName: "נועה",
        listType: "tasks",
        label,
        share: false,
      });
      const recipient = await recipientOf(phone);
      const facts = { facts: "" };
      installStub(
        {
          responses: [{ text: "ראיתי הזמנה.", buttons: [] }],
          metadata: { confirm: false },
        },
        facts,
      );
      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: "היי",
      });
      expect(facts.facts).toContain(invite.id);
      expect(await rowsWithLabel(label)).toHaveLength(0);

      installStub({
        responses: [{ text: "אקח את זה.", buttons: [] }],
        metadata: { collab_invite: invite.id, lists: [] },
      });
      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: "כן",
      });
      const rows = await rowsWithLabel(label);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(rowId);
      expect(rows[0]?.list.employeeId).toBe(recipient.employeeId);
      expect(rows[0]?.addedById).toBe(asker.employeeId);
      const stored = await prisma.whatsAppInvite.findUnique({ where: { id: invite.id } });
      expect(stored?.status).toBe("consumed");
    },
    120_000,
  );

  it(
    "cancels on an explicit decline and leaves the row unwritten",
    async () => {
      const phone = await unusedPhone();
      const asker = await openAsker("נועה", phone);
      const label = `סירוב-${randomUUID().slice(0, 8)}`;
      const { invite } = await deferItem({
        asker,
        contactName: "נועה",
        listType: "shopping",
        label,
        share: true,
      });
      const recipient = await recipientOf(phone);
      installStub({
        responses: [{ text: "לא תודה.", buttons: [] }],
        metadata: { decline_invite: invite.id, confirm: false, lists: [] },
      });
      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: "לא",
      });
      const stored = await prisma.whatsAppInvite.findUnique({ where: { id: invite.id } });
      expect(stored?.status).toBe("cancelled");
      expect(await rowsWithLabel(label)).toHaveLength(0);
    },
    120_000,
  );

  it(
    "applies once under duplicate and concurrent confirms, and rolls back a failed insert",
    async () => {
      const phone = await unusedPhone();
      const asker = await openAsker("נועה", phone);
      const label = `כפול-${randomUUID().slice(0, 8)}`;
      const { invite, rowId } = await deferItem({
        asker,
        contactName: "נועה",
        listType: "shopping",
        label,
        share: true,
      });
      const recipient = await recipientOf(phone);
      const [first, second] = await Promise.all([
        confirmCollabInvite({
          inviteId: invite.id,
          recipient: recipient.employee,
          sharedLists: [],
        }),
        confirmCollabInvite({
          inviteId: invite.id,
          recipient: recipient.employee,
          sharedLists: [],
        }),
      ]);
      expect([first, second].sort()).toEqual(["consumed", "lost"]);
      const rows = await rowsWithLabel(label);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(rowId);
      const again = await confirmCollabInvite({
        inviteId: invite.id,
        recipient: recipient.employee,
        sharedLists: [],
      });
      expect(again).toBe("lost");
      expect(await rowsWithLabel(label)).toHaveLength(1);

      const rollbackPhone = await unusedPhone();
      const rollbackAsker = await openAsker("נועה", rollbackPhone);
      const rollbackLabel = `רולבק-${randomUUID().slice(0, 8)}`;
      const deferred = await deferItem({
        asker: rollbackAsker,
        contactName: "נועה",
        listType: "shopping",
        label: rollbackLabel,
        share: true,
      });
      const rollbackRecipient = await recipientOf(rollbackPhone);
      const spy = vi
        .spyOn(records, "applyEmployeeRecords")
        .mockRejectedValueOnce(new Error("insert_failed"));
      const rolled = await confirmCollabInvite({
        inviteId: deferred.invite.id,
        recipient: rollbackRecipient.employee,
        sharedLists: [],
      });
      expect(rolled).toBe("rolled_back");
      spy.mockRestore();
      const pending = await prisma.whatsAppInvite.findUnique({
        where: { id: deferred.invite.id },
      });
      expect(pending?.status).toBe("pending");
      expect(await rowsWithLabel(rollbackLabel)).toHaveLength(0);
      const retried = await confirmCollabInvite({
        inviteId: deferred.invite.id,
        recipient: rollbackRecipient.employee,
        sharedLists: [],
      });
      expect(retried).toBe("consumed");
      const restored = await rowsWithLabel(rollbackLabel);
      expect(restored).toHaveLength(1);
      expect(restored[0]?.id).toBe(deferred.rowId);
    },
    180_000,
  );

  it(
    "does not apply for the wrong phone, a guest, a null or invalid payload, or an unrelated confirm",
    async () => {
      const phone = await unusedPhone();
      const asker = await openAsker("נועה", phone);
      const label = `זר-${randomUUID().slice(0, 8)}`;
      const { invite, rowId } = await deferItem({
        asker,
        contactName: "נועה",
        listType: "shopping",
        label,
        share: true,
      });
      const strangerAccount = await createHarnessAccount("דני", { digitalWorker: true });
      harnesses.push(strangerAccount);
      const strangerPhone = await unusedPhone();
      await prisma.employee.update({
        where: { id: strangerAccount.employeeId },
        data: { phone: strangerPhone },
      });
      const strangers = await listEmployeesForUser(strangerAccount.userId);
      const stranger = strangers.find((row) => row.id === strangerAccount.employeeId)!;
      const wrong = await confirmCollabInvite({
        inviteId: invite.id,
        recipient: stranger,
        sharedLists: [],
      });
      expect(wrong).toBe("lost");
      expect(
        (await prisma.whatsAppInvite.findUnique({ where: { id: invite.id } }))?.status,
      ).toBe("pending");

      const otherId = randomUUID();
      const recipient = await recipientOf(phone);
      installStub({
        responses: [{ text: "משהו אחר.", buttons: [] }],
        metadata: { collab_invite: otherId, lists: [] },
      });
      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: "מה השעה",
      });
      expect(
        (await prisma.whatsAppInvite.findUnique({ where: { id: invite.id } }))?.status,
      ).toBe("pending");

      const personalLabel = `פרטי-נפרד-${randomUUID().slice(0, 8)}`;
      installStub({
        responses: [{ text: "גם חלב וגם הזמנה.", buttons: [] }],
        metadata: {
          collab_invite: invite.id,
          lists: [
            {
              action: "add",
              list_type: "shopping",
              list_name: "",
              items: [{ "שם פריט": personalLabel }],
              targets: [],
            },
          ],
        },
      });
      await sendChatMessage({
        userId: recipient.userId,
        employeeId: recipient.employeeId,
        digitalEmployeeId: recipient.digitalEmployeeId,
        message: "תוסיפי חלב לי",
      });
      expect(
        (await prisma.whatsAppInvite.findUnique({ where: { id: invite.id } }))?.status,
      ).toBe("pending");
      expect(await rowsWithLabel(label)).toHaveLength(0);
      expect(await rowsWithLabel(personalLabel)).toHaveLength(1);

      const guestPhone = await unusedPhone();
      const guestLabel = `אורח-${randomUUID().slice(0, 8)}`;
      const guestAsker = await openAsker("נועה", guestPhone);
      const guestInvite = await deferItem({
        asker: guestAsker,
        contactName: "נועה",
        listType: "shopping",
        label: guestLabel,
        share: true,
      });
      const guest = await prisma.employee.create({
        data: {
          userId: guestAsker.userId,
          kind: "human",
          name: "אורח",
          surname: "",
          isGuest: true,
          phone: guestPhone,
        },
      });
      installStub({
        responses: [{ text: "כן.", buttons: [] }],
        metadata: { collab_invite: guestInvite.invite.id, lists: [] },
      });
      await sendChatMessage({
        userId: guestAsker.userId,
        employeeId: guest.id,
        digitalEmployeeId: guestAsker.digitalEmployeeId!,
        message: "כן",
      });
      expect(
        (await prisma.whatsAppInvite.findUnique({ where: { id: guestInvite.invite.id } }))
          ?.status,
      ).toBe("pending");
      expect(await rowsWithLabel(guestLabel)).toHaveLength(0);

      const nullInvite = await prisma.whatsAppInvite.create({
        data: {
          token: `${INVITE_TOKEN_PREFIX}NULL${randomUUID().slice(0, 8).toUpperCase()}`,
          userId: asker.userId,
          askerEmployeeId: asker.employeeId,
          digitalEmployeeId: asker.digitalEmployeeId!,
          recipientPhone: phone,
          recipientLabel: "נועה",
          askSummary: "הודעה",
          draftText: "draft",
          status: "pending",
        },
      });
      const nullResult = await confirmCollabInvite({
        inviteId: nullInvite.id,
        recipient: recipient.employee,
        sharedLists: [],
      });
      expect(nullResult).toBe("lost");
      expect(
        (await prisma.whatsAppInvite.findUnique({ where: { id: nullInvite.id } }))?.status,
      ).toBe("pending");
      const messageInvite = await findPendingMessageInviteByPhone(phone);
      expect(messageInvite?.id).toBe(nullInvite.id);
      expect(await findPendingMessageInviteByPhone(phone)).not.toBeNull();

      const invalid = await prisma.whatsAppInvite.create({
        data: {
          token: `${INVITE_TOKEN_PREFIX}BAD${randomUUID().slice(0, 8).toUpperCase()}`,
          userId: asker.userId,
          askerEmployeeId: asker.employeeId,
          digitalEmployeeId: asker.digitalEmployeeId!,
          recipientPhone: phone,
          recipientLabel: "נועה",
          askSummary: "שבור",
          draftText: "draft",
          status: "pending",
          payload: { v: 1, kind: "share" },
        },
      });
      const invalidResult = await confirmCollabInvite({
        inviteId: invalid.id,
        recipient: recipient.employee,
        sharedLists: [],
      });
      expect(invalidResult).toBe("failed");
      expect(
        (await prisma.whatsAppInvite.findUnique({ where: { id: invalid.id } }))?.status,
      ).toBe("failed");
      const live = await prisma.employeeListItem.findUnique({ where: { id: rowId } });
      expect(live?.deletedAt ?? null).toBeNull();
      expect(await rowsWithLabel(label)).toHaveLength(0);
    },
    180_000,
  );

  it(
    "still applies immediately for a registered recipient",
    async () => {
      const partner = await createHarnessAccount("עמית", { digitalWorker: true });
      harnesses.push(partner);
      const partnerPhone = await unusedPhone();
      await prisma.employee.update({
        where: { id: partner.employeeId },
        data: { phone: partnerPhone },
      });
      const asker = await openAsker("עמית", partnerPhone);
      const label = `רשום-${randomUUID().slice(0, 8)}`;
      installStub({
        responses: [{ text: "שיתפתי עם עמית.", buttons: [] }],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              list_name: "",
              items: [{ "שם פריט": label }],
              targets: ["טל", "עמית"],
            },
          ],
        },
      });
      await sendChatMessage({
        userId: asker.userId,
        employeeId: asker.employeeId,
        digitalEmployeeId: asker.digitalEmployeeId!,
        message: "תשתפי את זה עם עמית",
      });
      const rows = await rowsWithLabel(label);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.list.employeeId).toBe(asker.employeeId);
      expect(rows[0]?.visibleTo).toEqual(
        expect.arrayContaining([asker.employeeId, partner.employeeId]),
      );
      const invites = await prisma.whatsAppInvite.findMany({
        where: { userId: asker.userId },
      });
      expect(invites.filter((row) => row.payload != null)).toHaveLength(0);
    },
    120_000,
  );

  it(
    "keeps a payload invite off the guest-registration path and off the wrong phone",
    async () => {
      const phone = await unusedPhone();
      const asker = await openAsker("נועה", phone);
      const { invite } = await deferItem({
        asker,
        contactName: "נועה",
        listType: "shopping",
        label: `פאזה1-${randomUUID().slice(0, 8)}`,
        share: true,
      });
      const otherPhone = await unusedPhone();
      const bound = await bindInboundToInvite({
        fromPhone: otherPhone,
        inboundText: `היי ${invite.token}`,
        currentUserId: asker.userId,
        currentEmployeeId: asker.employeeId,
      });
      expect(bound).toBeNull();
      const untouched = await prisma.whatsAppInvite.findUnique({ where: { id: invite.id } });
      expect(untouched?.status).toBe("pending");
      expect(untouched?.guestEmployeeId).toBeNull();
      expect(await findPendingMessageInviteByPhone(phone)).toBeNull();

      const legacy = await prisma.whatsAppInvite.create({
        data: {
          token: `${INVITE_TOKEN_PREFIX}LEG${randomUUID().slice(0, 8).toUpperCase()}`,
          userId: asker.userId,
          askerEmployeeId: asker.employeeId,
          digitalEmployeeId: asker.digitalEmployeeId!,
          recipientPhone: phone,
          recipientLabel: "נועה",
          askSummary: "לבדוק",
          draftText: "draft",
          status: "pending",
        },
      });
      const legacyFound = await findPendingMessageInviteByPhone(phone);
      expect(legacyFound?.id).toBe(legacy.id);
      expect(legacyFound?.payload).toBeNull();
    },
    120_000,
  );
});

async function destroyCreatedUser(userId: string): Promise<void> {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  await prisma.whatsAppInvite.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.reminder.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.chatConversation.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.tipProgress.deleteMany({ where: { employee: { userId } } }).catch(() => undefined);
  await prisma.tip.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.contact.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.contactBook.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.employeeList.deleteMany({ where: { employee: { userId } } }).catch(() => undefined);
  await prisma.employeeFiling.deleteMany({ where: { employee: { userId } } }).catch(() => undefined);
  await prisma.employee.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.team.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}
