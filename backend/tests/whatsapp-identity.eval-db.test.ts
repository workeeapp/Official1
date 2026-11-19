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
  parseLlmReply,
} from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { buildLucyInstructions, sendChatMessage } from "../src/services/chat.service.js";
import {
  applyEmployeeRecords,
  getEmployeeRecordSnapshot,
} from "../src/services/employee-records.service.js";
import {
  createEmployeeForUser,
  listEmployeesForUser,
} from "../src/services/employee.service.js";
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
import { handleExplicitJoinAccept } from "../src/services/explicit-join.service.js";
import { EXPLICIT_JOIN_ACCEPT_PREFIX } from "../src/services/pending-prospect-action.service.js";

function explicitJoinCommandFromReply(reply: string): string | null {
  const parsed = parseLlmReply(reply);
  const buttons = [
    ...(parsed.buttons ?? []),
    ...parsed.responseBubbles.flatMap((bubble) => bubble.buttons ?? []),
  ];
  return (
    buttons.find((button) =>
      button.command.startsWith(EXPLICIT_JOIN_ACCEPT_PREFIX),
    )?.command ?? null
  );
}

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
      expect(employees.some((row) => row.name === GUEST_LUCY_NAME)).toBe(false);
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
    "shows a new independent user's own lists and clocks on the next chat turn",
    async () => {
      const phone = await unusedPhone();
      const speaker = await resolveWhatsAppSpeaker(phone);
      extraUserIds.push(speaker.userId);
      const human = await prisma.employee.findUniqueOrThrow({
        where: { id: speaker.employeeId },
      });
      expect(human.isGuest).toBe(false);
      expect(human.name).toBe("אורח");
      expect(human.nickname ?? "").toMatch(/^אורח/);

      const employees = await listEmployeesForUser(speaker.userId);
      const lucy = employees.find((row) => row.protected === true);
      expect(lucy?.name).toBe("לוסי");
      const itemName = `חלב-עצמאי-${phone.slice(-4)}`;
      const clockName = `שעון-עצמאי-${phone.slice(-4)}`;
      const seen: Array<{ instructions: string; liveFacts: string }> = [];
      let turn = 0;
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
          turn += 1;
          if (turn === 1) {
            return {
              reply: JSON.stringify({
                responses: [{ text: "שמרתי." }],
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
                  reminders: [
                    {
                      action: "add",
                      item: clockName,
                      date: "2031-06-15",
                      time: "09:00",
                      ping: [human.name],
                      text: clockName,
                    },
                  ],
                },
              }),
              raw: {},
            };
          }
          return {
            reply: JSON.stringify({
              responses: [{ text: "הנה מה ששמור." }],
              metadata: {},
            }),
            raw: {},
          };
        },
      });

      const gated = await sendChatMessage({
        userId: speaker.userId,
        employeeId: speaker.employeeId,
        digitalEmployeeId: lucy!.id,
        message: "תוסיפי חלב לקניות ותזכירי לי",
      });
      // Wave 1 Stage 2: ProspectWriteGate blocks durable saves until Explicit Join.
      expect(
        await prisma.employeeListItem.findFirst({
          where: {
            deletedAt: null,
            list: { employeeId: speaker.employeeId, deletedAt: null },
          },
        }),
      ).toBeNull();
      expect(
        await prisma.reminder.findFirst({
          where: {
            ownerId: speaker.employeeId,
            status: "active",
            itemLabel: clockName,
          },
        }),
      ).toBeNull();
      const joinCommand = explicitJoinCommandFromReply(gated.reply);
      expect(joinCommand).toBeTruthy();
      expect(parseLlmReply(gated.reply).response).toMatch(/בשמחה|אשרי/);
      expect(parseLlmReply(gated.reply).response).not.toMatch(/נרשמת|registration/i);

      const joined = await handleExplicitJoinAccept({
        userId: speaker.userId,
        employeeId: speaker.employeeId,
        digitalEmployeeId: lucy!.id,
        joinCommand: joinCommand!,
        recipientPhone: phone,
      });
      expect(joined.ok).toBe(true);
      expect(joined.joined).toBe(true);
      expect(joined.spoken).toMatch(/בוצע|שמרתי/);

      const savedItem = await prisma.employeeListItem.findFirst({
        where: {
          deletedAt: null,
          list: { employeeId: speaker.employeeId, deletedAt: null },
        },
      });
      const savedClock = await prisma.reminder.findFirst({
        where: {
          ownerId: speaker.employeeId,
          status: "active",
          itemLabel: clockName,
        },
      });
      expect(savedItem).toBeTruthy();
      expect(JSON.stringify(savedItem?.data)).toContain(itemName);
      expect(savedClock?.id).toBeTruthy();

      await sendChatMessage({
        userId: speaker.userId,
        employeeId: speaker.employeeId,
        digitalEmployeeId: lucy!.id,
        message: "מה שמור לי?",
      });

      expect(seen).toHaveLength(2);
      const next = seen[1]!;
      expect(next.instructions).not.toContain("GUEST MODE");
      expect(next.liveFacts).not.toContain("GUEST MODE");
      expect(next.liveFacts).toContain(itemName);
      expect(next.liveFacts).toContain(clockName);
      expect(next.liveFacts).toContain(savedClock!.id);
    },
    120_000,
  );

  it(
    "a guest sees their own lists and clocks and not another member's private list",
    async () => {
      const host = await createHarnessAccount("מארח", { digitalWorker: true });
      harnesses.push(host);
      const phone = await unusedPhone();
      const shell = await createEmployeeForUser(
        host.userId,
        {
          kind: "human",
          name: "אורח",
          surname: "",
          nickname: `אורח …${phone.slice(-4)}`,
          email: null,
          phone,
          isOwner: false,
        },
        { isGuest: true },
      );
      expect(shell.isGuest).toBe(true);
      const privateItem = `פרטי-מעטפת-${phone.slice(-4)}`;
      const privateClock = `שעון-מעטפת-${phone.slice(-4)}`;
      await prisma.employeeList.create({
        data: {
          employeeId: shell.id,
          listType: "shopping",
          name: "",
          scope: "personal",
          items: {
            create: {
              itemKey: privateItem,
              data: { "שם פריט": privateItem },
            },
          },
        },
      });
      await prisma.reminder.create({
        data: {
          userId: host.userId,
          ownerId: shell.id,
          actorId: shell.id,
          itemKey: privateClock,
          itemLabel: privateClock,
          listType: "shopping",
          fireAt: new Date("2031-06-15T06:00:00.000Z"),
          pingIds: [shell.id],
        },
      });
      const siblingItem = `פרטי-אח-${phone.slice(-4)}`;
      await prisma.employeeList.create({
        data: {
          employeeId: host.employeeId,
          listType: "shopping",
          name: "",
          scope: "personal",
          items: {
            create: {
              itemKey: siblingItem,
              data: { "שם פריט": siblingItem },
            },
          },
        },
      });

      const snapshot = await getEmployeeRecordSnapshot(shell.id);
      const blob = JSON.stringify(snapshot);
      expect(blob).toContain(privateItem);
      expect(blob).toContain(privateClock);
      expect(blob).not.toContain(siblingItem);

      const employees = await listEmployeesForUser(host.userId);
      const lucy = employees.find((row) => row.protected === true);
      const guestPublic = employees.find((row) => row.id === shell.id);
      const guestInstructions = buildLucyInstructions({
        digital: lucy!,
        employees,
        speaker: guestPublic!.name,
        speakerIsOwner: false,
        guestSpeaker: true,
        pendingInvite: null,
        consultFrom: "",
      });
      const memberInstructions = buildLucyInstructions({
        digital: lucy!,
        employees,
        speaker: guestPublic!.name,
        speakerIsOwner: false,
        guestSpeaker: false,
        pendingInvite: null,
        consultFrom: "",
      });
      expect(guestInstructions).toBe(memberInstructions);
      expect(guestInstructions).toContain("FULL catalog");
      expect(guestInstructions).not.toContain("GUEST MODE");
      expect(guestInstructions).not.toContain("לוסי-אורח");
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
      // Member: bind keeps account, but no Prospect opening context.
      expect(byToken?.context).toBeNull();
      expect(byToken?.invite.askSummary).toBe("רשימת הקניות המשותפת");

      const byPhone = await bindInboundToInvite({
        fromPhone: phone,
        inboundText: "מה נשמע",
        currentUserId: danny.userId,
        currentEmployeeId: danny.employeeId,
      });
      // Already consumed — must not stick on later inbounds.
      expect(byPhone).toBeNull();

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
      // Registered Member: message invite is consumed so it cannot stick.
      expect(inviteAfter.status).toBe("consumed");
      expect(inviteAfter.consumedAt).toBeTruthy();
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
      const lucy = employees.find(
        (row) => row.protected === true && row.kind === "digital",
      );
      expect(guestPublic && isGuestEmployee(guestPublic)).toBe(true);
      expect(lucy?.name).toBe("לוסי");

      const registeredBefore = await prisma.employee.findUniqueOrThrow({
        where: { id: registered.employeeId },
      });
      const registeredResult = await registerGuestMember({
        hostUserId: host.userId,
        guest: guestPublic!,
        digital: lucy!,
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
    "still assigns across two independent accounts and a guest can mutate their own list",
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
      const ownMeta = emptyLlmMetadata();
      ownMeta.lists.push({
        action: "add",
        listType: "shopping",
        listName: "",
        items: [{ "שם פריט": `חלב-אורח-${guestPhone.slice(-4)}` }],
        targets: [],
      });
      const own = planTargetedActions({
        actor: guestPublic!,
        employees: [...askerEmployees, guestPublic!],
        metadata: ownMeta,
      });
      expect(own.guestMutationBlocked).toBe(false);
      expect(own.applications.map((row) => row.employeeId)).toEqual([guest.id]);
      await applyEmployeeRecords(guest.id, ownMeta, undefined, guest.id);
      const guestSaved = await prisma.employeeListItem.findFirst({
        where: {
          deletedAt: null,
          list: { employeeId: guest.id, deletedAt: null },
          itemKey: { contains: guestPhone.slice(-4) },
        },
      });
      expect(guestSaved).toBeTruthy();
      const siblingPrivate = `פרטי-מארח-${guestPhone.slice(-4)}`;
      await prisma.employeeList.create({
        data: {
          employeeId: asker.employeeId,
          listType: "shopping",
          name: "",
          scope: "personal",
          items: {
            create: {
              itemKey: siblingPrivate,
              data: { "שם פריט": siblingPrivate },
            },
          },
        },
      });
      const guestSnapshot = await getEmployeeRecordSnapshot(guest.id);
      expect(JSON.stringify(guestSnapshot)).not.toContain(siblingPrivate);
      const siblingRow = await prisma.employeeListItem.findFirstOrThrow({
        where: { itemKey: siblingPrivate, deletedAt: null },
      });
      const steal = emptyLlmMetadata();
      steal.lists.push({
        action: "remove",
        listType: "shopping",
        listName: "",
        items: [{ item_id: siblingRow.id }],
        targets: [],
      });
      await applyEmployeeRecords(
        asker.employeeId,
        steal,
        undefined,
        guest.id,
      );
      const siblingAfter = await prisma.employeeListItem.findUniqueOrThrow({
        where: { id: siblingRow.id },
      });
      expect(siblingAfter.deletedAt).toBeNull();
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
      expect(bound?.context?.askerName).toBe("טל");
      expect(bound?.context?.askSummary).toBe(summary);

      const guestLucy = await prisma.employee.findFirst({
        where: {
          userId: { in: [asker.userId, created.userId] },
          kind: "digital",
          OR: [{ name: GUEST_LUCY_NAME }, { nickname: GUEST_LUCY_NAME }],
        },
      });
      expect(guestLucy).toBeNull();

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
      // Prospect can chat + see invite value; personal save waits for Explicit Join.
      expect(
        await prisma.employeeListItem.findFirst({
          where: {
            deletedAt: null,
            list: { employeeId: created.employeeId, deletedAt: null },
          },
        }),
      ).toBeNull();
      const joinCommand = explicitJoinCommandFromReply(sent.reply);
      expect(joinCommand).toBeTruthy();
      expect(parseLlmReply(sent.reply).response).toMatch(/בשמחה|אשרי/);

      const joined = await handleExplicitJoinAccept({
        userId: created.userId,
        employeeId: created.employeeId,
        digitalEmployeeId: lucy!.id,
        joinCommand: joinCommand!,
        recipientPhone: phone,
      });
      expect(joined.ok).toBe(true);
      expect(joined.spoken).toMatch(/בוצע|שמרתי/);

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
      const userAfter = await prisma.user.findUniqueOrThrow({
        where: { id: created.userId },
      });
      expect(userAfter.consentPending).toBe(false);
    },
    120_000,
  );

  it(
    "Member pending invite: no opening onboarding; Prospect keeps invite path; reminder stays owned",
    async () => {
      const asker = await createHarnessAccount("מיכל", { digitalWorker: true });
      const member = await createHarnessAccount("טל", { digitalWorker: true });
      harnesses.push(asker, member);

      const memberPhone = await unusedPhone();
      await prisma.employee.update({
        where: { id: member.employeeId },
        data: { phone: memberPhone },
      });
      await prisma.user.update({
        where: { id: member.userId },
        data: { consentPending: false },
      });

      const memberInvite = await prisma.whatsAppInvite.create({
        data: {
          token: `${INVITE_TOKEN_PREFIX}MEMNOOB01`,
          userId: asker.userId,
          askerEmployeeId: asker.employeeId,
          digitalEmployeeId: asker.digitalEmployeeId!,
          recipientPhone: memberPhone,
          recipientLabel: "טל",
          askSummary: "לעדכן אותי",
          draftText: "draft",
          status: "pending",
        },
      });

      const memberBound = await bindInboundToInvite({
        fromPhone: memberPhone,
        inboundText: "תבדקי איתי עוד שעה אם שילמתי ארנונה",
        currentUserId: member.userId,
        currentEmployeeId: member.employeeId,
      });
      expect(memberBound?.context).toBeNull();
      expect(memberBound?.invite.status).toBe("consumed");

      const memberInviteAfter = await prisma.whatsAppInvite.findUniqueOrThrow({
        where: { id: memberInvite.id },
      });
      expect(memberInviteAfter.status).toBe("consumed");
      expect(memberInviteAfter.guestEmployeeId).toBe(member.employeeId);

      const rebound = await bindInboundToInvite({
        fromPhone: memberPhone,
        inboundText: "עוד משהו",
        currentUserId: member.userId,
        currentEmployeeId: member.employeeId,
      });
      expect(rebound).toBeNull();

      const memberLucy = (await listEmployeesForUser(member.userId)).find(
        (row) => row.protected === true,
      );
      expect(memberLucy).toBeTruthy();

      const seenMember: Array<{ liveFacts: string; instructions: string }> = [];
      vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
      vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue(
        "sent" as never,
      );
      vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
      vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);
      setLlmClientForTests({
        async createConversation() {
          return `conv-member-${randomUUID()}`;
        },
        async createResponse(input) {
          seenMember.push({
            liveFacts: input.liveFacts ?? "",
            instructions: input.instructions,
          });
          return {
            reply: JSON.stringify({
              responses: [{ text: "סגור, אבדוק איתך בעוד שעה." }],
              metadata: {
                reminders: [
                  {
                    action: "add",
                    item: "שילמת ארנונה?",
                    date: "2031-11-20",
                    time: "10:30",
                    ping: ["טל"],
                    text: "שילמת ארנונה?",
                  },
                ],
              },
            }),
            raw: {},
          };
        },
      });

      // Even if a stale context were passed, Member must not get Invite Opening.
      const memberTurn = await sendChatMessage({
        userId: member.userId,
        employeeId: member.employeeId,
        digitalEmployeeId: memberLucy!.id,
        message: "תבדקי איתי עוד שעה אם שילמתי ארנונה",
        pendingInvite: {
          inviteId: memberInvite.id,
          token: memberInvite.token,
          askerName: "מיכל",
          askSummary: "לעדכן אותי",
          recipientLabel: "טל",
        },
      });
      expect(seenMember).toHaveLength(1);
      // Opening block must be absent (catalog tip text may still mention הרשמה).
      expect(seenMember[0]!.liveFacts).not.toContain("INVITE CONTEXT");
      expect(seenMember[0]!.liveFacts).not.toContain("zero signup friction");
      expect(seenMember[0]!.liveFacts).not.toContain("PENDING_INVITE");
      expect(seenMember[0]!.instructions).not.toContain("GUEST MODE");
      expect(memberTurn.reply).not.toMatch(/בלי הרשמה|בלי להירשם/);

      const reminder = await prisma.reminder.findFirst({
        where: {
          userId: member.userId,
          ownerId: member.employeeId,
          itemLabel: "שילמת ארנונה?",
          status: "active",
        },
        orderBy: { createdAt: "desc" },
      });
      expect(reminder).toBeTruthy();
      expect(reminder!.userId).toBe(member.userId);
      expect(reminder!.ownerId).toBe(member.employeeId);
      expect(reminder!.actorId).toBe(member.employeeId);

      // Prospect path unchanged: opening context + invite stays pending.
      const prospectPhone = await unusedPhone();
      const prospect = await resolveWhatsAppSpeaker(prospectPhone);
      extraUserIds.push(prospect.userId);
      const prospectUser = await prisma.user.findUniqueOrThrow({
        where: { id: prospect.userId },
      });
      expect(prospectUser.consentPending).toBe(true);

      const prospectInvite = await prisma.whatsAppInvite.create({
        data: {
          token: `${INVITE_TOKEN_PREFIX}PROSKEEP1`,
          userId: asker.userId,
          askerEmployeeId: asker.employeeId,
          digitalEmployeeId: asker.digitalEmployeeId!,
          recipientPhone: prospectPhone,
          recipientLabel: "אורח",
          askSummary: "לעדכן אותי",
          draftText: "draft",
          status: "pending",
        },
      });
      const prospectBound = await bindInboundToInvite({
        fromPhone: prospectPhone,
        inboundText: "היי",
        currentUserId: prospect.userId,
        currentEmployeeId: prospect.employeeId,
      });
      expect(prospectBound?.context).toBeTruthy();
      expect(prospectBound?.context?.askSummary).toBe("לעדכן אותי");
      expect(prospectBound?.context?.askerName).toBe("מיכל");
      const prospectInviteAfter = await prisma.whatsAppInvite.findUniqueOrThrow({
        where: { id: prospectInvite.id },
      });
      expect(prospectInviteAfter.status).toBe("pending");

      const prospectLucy = (await listEmployeesForUser(prospect.userId)).find(
        (row) => row.protected === true,
      );
      const seenProspect: string[] = [];
      setLlmClientForTests({
        async createConversation() {
          return `conv-prospect-${randomUUID()}`;
        },
        async createResponse(input) {
          seenProspect.push(input.liveFacts ?? "");
          return {
            reply: JSON.stringify({
              responses: [{ text: "היי, מיכל הזמינה אותך." }],
              metadata: {},
            }),
            raw: {},
          };
        },
      });
      await sendChatMessage({
        userId: prospect.userId,
        employeeId: prospect.employeeId,
        digitalEmployeeId: prospectLucy!.id,
        message: "היי",
        pendingInvite: prospectBound!.context!,
      });
      expect(seenProspect[0]).toContain("INVITE CONTEXT");
      expect(seenProspect[0]).toContain("מיכל");
      expect(seenProspect[0]).toContain("לעדכן אותי");
    },
    180_000,
  );
});

async function destroyCreatedUser(userId: string): Promise<void> {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  await prisma.pendingProspectAction.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.pendingHighRiskConfirm.deleteMany({ where: { userId } }).catch(() => undefined);
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
