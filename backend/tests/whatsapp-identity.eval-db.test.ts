/**
 * Phase 1 identity: a new WhatsApp phone gets its own account, and an
 * invitation never rewrites userId or isGuest.
 *
 * Real Prisma on workee_test. No WhatsApp send, no OpenAI.
 *
 * Run: npm run test:eval-db -- tests/whatsapp-identity.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GUEST_LUCY_NAME,
  emptyLlmMetadata,
  isGuestEmployee,
} from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { buildLucyInstructions, sendChatMessage } from "../src/services/chat.service.js";
import { listEmployeesForUser } from "../src/services/employee.service.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import { planTargetedActions } from "../src/services/employee-targets.service.js";
import { registerGuestMember } from "../src/services/guest-register.service.js";
import { phonesMatch } from "../src/utils/phone.js";
import {
  bindInboundToInvite,
  INVITE_TOKEN_PREFIX,
} from "../src/services/whatsapp-invite.service.js";
import { resolveWhatsAppSpeaker } from "../src/services/whatsapp.service.js";

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
});

describe("WhatsApp independent identity (eval-db)", () => {
  const harnesses: HarnessAccount[] = [];
  const extraUserIds: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    await prisma.whatsAppInvite.deleteMany({
      where: {
        OR: [
          { userId: { in: userIds() } },
          { guestEmployeeId: { in: await employeeIds() } },
        ],
      },
    }).catch(() => undefined);
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
    return [
      ...harnesses.map((account) => account.userId),
      ...extraUserIds,
    ];
  }

  async function employeeIds(): Promise<string[]> {
    if (userIds().length === 0) {
      return [];
    }
    const rows = await prisma.employee.findMany({
      where: { userId: { in: userIds() } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async function unusedPhone(): Promise<string> {
    const rows = await prisma.employee.findMany({
      where: { phone: { not: null } },
      select: { phone: true },
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const phone = `97258${Math.floor(Math.random() * 1e7)
        .toString()
        .padStart(7, "0")}`;
      const taken = rows.some(
        (row) => row.phone && phonesMatch(row.phone, phone),
      );
      if (!taken) {
        return phone;
      }
    }
    throw new Error("could not allocate a non-colliding test phone");
  }

  it(
    "creates an independent owner account and normal Lucy for an unknown phone",
    async () => {
      const host = await createHarnessAccount("טל", { digitalWorker: true });
      harnesses.push(host);
      const phone = await unusedPhone();

      const speaker = await resolveWhatsAppSpeaker(phone);
      extraUserIds.push(speaker.userId);

      expect(speaker.userId).not.toBe(host.userId);
      const again = await resolveWhatsAppSpeaker(phone);
      expect(again).toEqual(speaker);

      const human = await prisma.employee.findUniqueOrThrow({
        where: { id: speaker.employeeId },
      });
      expect(human.userId).toBe(speaker.userId);
      expect(human.isGuest).toBe(false);
      expect(human.isOwner).toBe(true);
      expect(human.phone && phonesMatch(human.phone, phone)).toBe(true);
      expect(human.kind).toBe("human");

      const employees = await listEmployeesForUser(speaker.userId);
      const speakerPublic = employees.find((row) => row.id === human.id);
      const lucy = employees.find((row) => row.protected === true);
      expect(speakerPublic && isGuestEmployee(speakerPublic)).toBe(false);
      expect(lucy?.name).toBe("לוסי");
      expect(lucy?.kind).toBe("digital");

      const routed =
        speakerPublic && isGuestEmployee(speakerPublic)
          ? employees.find((row) => row.name === GUEST_LUCY_NAME)
          : employees.find((row) => row.protected);
      expect(routed?.id).toBe(lucy?.id);

      const instructions = buildLucyInstructions({
        digital: lucy!,
        employees,
        speaker: speakerPublic!.name,
        speakerIsOwner: speakerPublic!.isOwner === true,
        guestSpeaker: isGuestEmployee(speakerPublic!),
        pendingInvite: null,
        consultFrom: "",
      });
      expect(instructions).not.toContain("GUEST MODE");
      expect(instructions).toContain("OPEN JOBS RULES");
      expect(instructions).toContain("FULL catalog");

      const metadata = emptyLlmMetadata();
      metadata.lists.push({
        action: "add",
        listType: "shopping",
        listName: "",
        items: [{ שם: "חלב" }],
        targets: [],
      });
      const plan = planTargetedActions({
        actor: speakerPublic!,
        employees,
        metadata,
      });
      expect(plan.guestMutationBlocked).toBe(false);
      expect(plan.applications.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    "does not rewrite an existing user when an invite matches their phone",
    async () => {
      const asker = await createHarnessAccount("טל", { digitalWorker: true });
      const danny = await createHarnessAccount("דני", { digitalWorker: true });
      harnesses.push(asker, danny);
      const phone = await unusedPhone();
      await prisma.employee.update({
        where: { id: danny.employeeId },
        data: { phone, isGuest: false, isOwner: true },
      });

      const list = await prisma.employeeList.create({
        data: {
          employeeId: danny.employeeId,
          listType: "shopping",
          name: "",
          items: {
            create: { itemKey: "לחם", data: { שם: "לחם" } },
          },
        },
      });
      const reminder = await prisma.reminder.create({
        data: {
          userId: danny.userId,
          ownerId: danny.employeeId,
          actorId: danny.employeeId,
          itemKey: "לחם",
          itemLabel: "לחם",
          listType: "shopping",
          fireAt: new Date("2031-06-01T06:00:00.000Z"),
        },
      });
      const conversation = await prisma.chatConversation.create({
        data: {
          userId: danny.userId,
          employeeId: danny.employeeId,
          digitalEmployeeId: danny.digitalEmployeeId!,
          openaiConversationId: `eval-identity-${randomUUID()}`,
        },
      });
      const contact = await prisma.contact.create({
        data: {
          userId: danny.userId,
          ownerEmployeeId: danny.employeeId,
          name: "עמית",
          phone: "972501110099",
        },
      });

      const token = `${INVITE_TOKEN_PREFIX}DANNYSAFE1`;
      const invite = await prisma.whatsAppInvite.create({
        data: {
          token,
          userId: asker.userId,
          askerEmployeeId: asker.employeeId,
          digitalEmployeeId: asker.digitalEmployeeId!,
          recipientPhone: phone,
          recipientLabel: "דני",
          askSummary: "רשימת הקניות המשותפת",
          draftText: "draft",
          status: "pending",
        },
      });

      const before = await prisma.employee.findUniqueOrThrow({
        where: { id: danny.employeeId },
      });

      const byToken = await bindInboundToInvite({
        fromPhone: phone,
        inboundText: `${token}\nשלום`,
        currentUserId: danny.userId,
        currentEmployeeId: danny.employeeId,
      });
      expect(byToken?.userId).toBe(danny.userId);
      expect(byToken?.employeeId).toBe(danny.employeeId);
      expect(byToken?.context.askSummary).toBe("רשימת הקניות המשותפת");
      expect(byToken?.context.askerName).toBe("טל");

      const byPhone = await bindInboundToInvite({
        fromPhone: phone,
        inboundText: "מה נשמע",
        currentUserId: danny.userId,
        currentEmployeeId: danny.employeeId,
      });
      expect(byPhone?.userId).toBe(danny.userId);
      expect(byPhone?.employeeId).toBe(danny.employeeId);

      const resolved = await resolveWhatsAppSpeaker(phone);
      expect(resolved).toEqual({
        userId: danny.userId,
        employeeId: danny.employeeId,
      });

      const after = await prisma.employee.findUniqueOrThrow({
        where: { id: danny.employeeId },
      });
      expect(after.userId).toBe(before.userId);
      expect(after.isGuest).toBe(false);
      expect(after.isOwner).toBe(true);
      expect(after.phone).toBe(before.phone);

      const listAfter = await prisma.employeeList.findUniqueOrThrow({
        where: { id: list.id },
        include: { employee: true, items: true },
      });
      expect(listAfter.employeeId).toBe(danny.employeeId);
      expect(listAfter.employee.userId).toBe(danny.userId);
      expect(listAfter.items.map((item) => item.itemKey)).toEqual(["לחם"]);

      const reminderAfter = await prisma.reminder.findUniqueOrThrow({
        where: { id: reminder.id },
      });
      expect(reminderAfter.userId).toBe(danny.userId);
      expect(reminderAfter.ownerId).toBe(danny.employeeId);

      const conversationAfter = await prisma.chatConversation.findUniqueOrThrow({
        where: { id: conversation.id },
      });
      expect(conversationAfter.userId).toBe(danny.userId);
      expect(conversationAfter.employeeId).toBe(danny.employeeId);

      const contactAfter = await prisma.contact.findUniqueOrThrow({
        where: { id: contact.id },
      });
      expect(contactAfter.userId).toBe(danny.userId);
      expect(contactAfter.ownerEmployeeId).toBe(danny.employeeId);

      const inviteAfter = await prisma.whatsAppInvite.findUniqueOrThrow({
        where: { id: invite.id },
      });
      expect(inviteAfter.userId).toBe(asker.userId);
      expect(inviteAfter.guestEmployeeId).toBe(danny.employeeId);
      expect(inviteAfter.status).toBe("pending");
    },
    120_000,
  );

  it(
    "keeps guest registration on the host and does not reassign a registered user",
    async () => {
      const host = await createHarnessAccount("טל", { digitalWorker: true });
      const registered = await createHarnessAccount("דני", {
        digitalWorker: true,
      });
      harnesses.push(host, registered);
      const guestPhone = await unusedPhone();
      const registeredPhone = await unusedPhone();
      await prisma.employee.update({
        where: { id: registered.employeeId },
        data: { phone: registeredPhone, isGuest: false, isOwner: true },
      });
      const guest = await prisma.employee.create({
        data: {
          userId: host.userId,
          kind: "human",
          name: "אורח",
          surname: "",
          nickname: "אורח …1111",
          phone: guestPhone,
          isGuest: true,
          isOwner: false,
        },
      });
      const employees = await listEmployeesForUser(host.userId);
      const guestPublic = employees.find((row) => row.id === guest.id);
      const guestLucy = employees.find((row) => row.name === GUEST_LUCY_NAME);
      expect(guestPublic && isGuestEmployee(guestPublic)).toBe(true);
      expect(guestLucy).toBeTruthy();

      const registeredBefore = await prisma.employee.findUniqueOrThrow({
        where: { id: registered.employeeId },
      });
      const registeredResult = await registerGuestMember({
        hostUserId: host.userId,
        guest: guestPublic!,
        digital: guestLucy!,
        register: { name: "נועה", gender: "female" },
      });
      expect(registeredResult.ok).toBe(true);
      if (registeredResult.ok) {
        expect(registeredResult.userId).toBe(host.userId);
        expect(registeredResult.employeeId).toBe(guest.id);
      }
      const guestAfter = await prisma.employee.findUniqueOrThrow({
        where: { id: guest.id },
      });
      expect(guestAfter.userId).toBe(host.userId);
      expect(guestAfter.isGuest).toBe(false);
      expect(guestAfter.isOwner).toBe(false);
      expect(guestAfter.name).toBe("נועה");

      const registeredAfterRegister = await prisma.employee.findUniqueOrThrow({
        where: { id: registered.employeeId },
      });
      expect(registeredAfterRegister.userId).toBe(registeredBefore.userId);
      expect(registeredAfterRegister.isGuest).toBe(false);
      expect(registeredAfterRegister.isOwner).toBe(true);

      const token = `${INVITE_TOKEN_PREFIX}REGSAFE01`;
      await prisma.whatsAppInvite.create({
        data: {
          token,
          userId: host.userId,
          askerEmployeeId: host.employeeId,
          digitalEmployeeId: host.digitalEmployeeId!,
          recipientPhone: registeredPhone,
          recipientLabel: "דני",
          askSummary: "לבדוק אם קנה חלב",
          draftText: "draft",
          status: "pending",
        },
      });
      const bound = await bindInboundToInvite({
        fromPhone: registeredPhone,
        inboundText: token,
        currentUserId: registered.userId,
        currentEmployeeId: registered.employeeId,
      });
      expect(bound?.userId).toBe(registered.userId);
      expect(bound?.employeeId).toBe(registered.employeeId);

      const registeredAfterInvite = await prisma.employee.findUniqueOrThrow({
        where: { id: registered.employeeId },
      });
      expect(registeredAfterInvite.userId).toBe(registered.userId);
      expect(registeredAfterInvite.isGuest).toBe(false);
      const guestStill = await prisma.employee.findUniqueOrThrow({
        where: { id: guest.id },
      });
      expect(guestStill.userId).toBe(host.userId);

      const guestActor = (await listEmployeesForUser(host.userId)).find(
        (row) => row.id === guest.id,
      );
      const metadata = emptyLlmMetadata();
      metadata.lists.push({
        action: "add",
        listType: "shopping",
        listName: "",
        items: [{ שם: "חלב" }],
        targets: [],
      });
      expect(guestActor && isGuestEmployee(guestActor)).toBe(false);
    },
    120_000,
  );

  it(
    "still assigns across two independent accounts and still blocks a guest mutate",
    async () => {
      const asker = await createHarnessAccount("טל", { digitalWorker: true });
      harnesses.push(asker);
      const phone = await unusedPhone();
      const created = await resolveWhatsAppSpeaker(phone);
      extraUserIds.push(created.userId);
      await prisma.employee.update({
        where: { id: created.employeeId },
        data: { name: "דני", nickname: "דני" },
      });
      const askerEmployees = await listEmployeesForUser(asker.userId);
      const dannyEmployees = await listEmployeesForUser(created.userId);
      const actor = askerEmployees.find((row) => row.id === asker.employeeId);
      const partner = dannyEmployees.find((row) => row.id === created.employeeId);
      expect(actor?.isGuest).toBe(false);
      expect(partner?.isGuest).toBe(false);
      expect(partner?.id).toBe(created.employeeId);

      const metadata = emptyLlmMetadata();
      metadata.lists.push({
        action: "add",
        listType: "shopping",
        listName: "",
        items: [{ שם: "חלב" }],
        targets: ["דני"],
      });
      const assigned = planTargetedActions({
        actor: actor!,
        employees: askerEmployees,
        externalPartners: [partner!],
        metadata,
      });
      expect(assigned.guestMutationBlocked).toBe(false);
      expect(assigned.applications.map((row) => row.employeeId)).toContain(
        created.employeeId,
      );

      const guestPhone = await unusedPhone();
      const guest = await prisma.employee.create({
        data: {
          userId: asker.userId,
          kind: "human",
          name: "אורח",
          surname: "",
          nickname: "אורח …2222",
          phone: guestPhone,
          isGuest: true,
          isOwner: false,
        },
      });
      const guestPublic = (await listEmployeesForUser(asker.userId)).find(
        (row) => row.id === guest.id,
      );
      const blocked = planTargetedActions({
        actor: guestPublic!,
        employees: askerEmployees,
        metadata,
      });
      expect(blocked.guestMutationBlocked).toBe(true);
      expect(blocked.applications).toEqual([]);
      const guestRow = await prisma.employee.findUniqueOrThrow({
        where: { id: guest.id },
      });
      expect(guestRow.userId).toBe(asker.userId);
      expect(guestRow.isGuest).toBe(true);
      const partnerRow = await prisma.employee.findUniqueOrThrow({
        where: { id: created.employeeId },
      });
      expect(partnerRow.userId).toBe(created.userId);
      expect(partnerRow.isGuest).toBe(false);
    },
    120_000,
  );

  it(
    "a new account that opens an invite is not held behind registration",
    async () => {
      const asker = await createHarnessAccount("טל", { digitalWorker: true });
      harnesses.push(asker);
      const phone = await unusedPhone();
      const created = await resolveWhatsAppSpeaker(phone);
      extraUserIds.push(created.userId);
      const before = await prisma.employee.findUniqueOrThrow({
        where: { id: created.employeeId },
      });
      expect(before.userId).toBe(created.userId);
      expect(before.isGuest).toBe(false);

      const token = `${INVITE_TOKEN_PREFIX}OPENCTX01`;
      const summary = "רשימת הקניות המשותפת";
      await prisma.whatsAppInvite.create({
        data: {
          token,
          userId: asker.userId,
          askerEmployeeId: asker.employeeId,
          digitalEmployeeId: asker.digitalEmployeeId!,
          recipientPhone: phone,
          recipientLabel: "דני",
          askSummary: summary,
          draftText: "draft",
          status: "pending",
        },
      });
      const bound = await bindInboundToInvite({
        fromPhone: phone,
        inboundText: `${token}\nהיי`,
        currentUserId: created.userId,
        currentEmployeeId: created.employeeId,
      });
      expect(bound?.userId).toBe(created.userId);
      expect(bound?.context.askerName).toBe("טל");
      expect(bound?.context.askSummary).toBe(summary);

      const guestLucy = await prisma.employee.findFirst({
        where: {
          userId: asker.userId,
          kind: "digital",
          OR: [{ name: GUEST_LUCY_NAME }, { nickname: GUEST_LUCY_NAME }],
        },
      });
      expect(guestLucy?.userId).toBe(asker.userId);
      expect(guestLucy?.id).not.toBe(created.employeeId);

      const employees = await listEmployeesForUser(created.userId);
      const lucy = employees.find((row) => row.protected === true);
      const itemName = `מלפפון-${phone.slice(-4)}`;
      const seen: Array<{ instructions: string; liveFacts: string }> = [];
      vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
      vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue(
        "sent" as never,
      );
      vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
      vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);
      setLlmClientForTests({
        async createConversation() {
          return `conv-${randomUUID()}`;
        },
        async createResponse(input) {
          seen.push({
            instructions: input.instructions,
            liveFacts: input.liveFacts ?? "",
          });
          return {
            reply: JSON.stringify({
              responses: [{ text: "הוספתי את הפריט." }],
              metadata: {
                lists: [
                  {
                    action: "add",
                    list_type: "shopping",
                    list_name: "",
                    targets: [],
                    items: [{ "שם פריט": itemName }],
                  },
                ],
              },
            }),
            raw: {},
          };
        },
      });

      const sent = await sendChatMessage({
        userId: created.userId,
        employeeId: created.employeeId,
        digitalEmployeeId: lucy!.id,
        message: "תוסיפי את זה לקניות, וגם מה מזג האוויר?",
        pendingInvite: bound!.context,
      });

      expect(seen).toHaveLength(1);
      const turn = seen[0]!;
      expect(turn.instructions).toContain("OPEN JOBS RULES");
      expect(turn.instructions).toContain("FULL catalog");
      expect(turn.instructions).not.toContain("GUEST MODE");
      expect(turn.liveFacts).toContain("טל");
      expect(turn.liveFacts).toContain(summary);
      expect(turn.liveFacts).toContain("INVITE CONTEXT");
      expect(turn.liveFacts).not.toContain("MUST register");
      expect(turn.liveFacts).not.toContain("metadata.register");
      expect(turn.liveFacts).not.toContain("PENDING_INVITE");
      expect(sent.reply).not.toContain("נרשמת");

      const saved = await prisma.employeeListItem.findMany({
        where: {
          deletedAt: null,
          list: { employeeId: created.employeeId, deletedAt: null },
        },
      });
      expect(
        saved.some((row) => JSON.stringify(row.data).includes(itemName)),
      ).toBe(true);
      const onAsker = await prisma.employeeListItem.findMany({
        where: {
          deletedAt: null,
          list: { employeeId: asker.employeeId, deletedAt: null },
        },
      });
      expect(
        onAsker.some((row) => JSON.stringify(row.data).includes(itemName)),
      ).toBe(false);

      const after = await prisma.employee.findUniqueOrThrow({
        where: { id: created.employeeId },
      });
      expect(after.userId).toBe(created.userId);
      expect(after.isGuest).toBe(false);
      expect(after.isOwner).toBe(true);
    },
    120_000,
  );
});

async function destroyCreatedUser(userId: string): Promise<void> {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  await prisma.whatsAppInvite.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.reminder.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.chatConversation.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.tipProgress.deleteMany({
    where: { employee: { userId } },
  }).catch(() => undefined);
  await prisma.tip.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.contact.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.contactBook.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.attachmentLink.deleteMany({
    where: { attachment: { userId } },
  }).catch(() => undefined);
  await prisma.attachment.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.employeeList.deleteMany({
    where: { employee: { userId } },
  }).catch(() => undefined);
  await prisma.employeeFiling.deleteMany({
    where: { employee: { userId } },
  }).catch(() => undefined);
  await prisma.employee.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.team.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}
