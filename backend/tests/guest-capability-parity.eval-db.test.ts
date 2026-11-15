/**
 * Real guest (Employees.isGuest=true) on protected Lucy vs a regular member.
 * Actions go through sendChatMessage and the real apply path. The mission
 * executor's background wake is stopped so a create does not race the asserts.
 *
 * Run: npm run test:eval-db -- tests/guest-capability-parity.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GUEST_LUCY_NAME } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { getEmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import {
  listEmployeesForUser,
  toPublicEmployee,
} from "../src/services/employee.service.js";
import { formatAvailableTipsContext } from "../src/services/tips.service.js";
import { shareWorkerTaskWithPingRecipients } from "../src/services/reminder.service.js";
import { whatsAppDigitalForTurn } from "../src/services/whatsapp.service.js";
import { listActiveMissionsForChat } from "../src/services/mission.service.js";

vi.mock("../src/services/mission-runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/mission-runner.js")>();
  return {
    ...actual,
    scheduleMissionWake: () => undefined,
  };
});

const OWNER = "טל";
const MEMBER = "עמית";
const GUEST = "רותם";
const SHELL = "כרמל";

type Party = {
  id: string;
  name: string;
};

let account: HarnessAccount;
let lucyId = "";
let owner: Party;
let member: Party;
let guest: Party;
let shell: Party;
let phoneSeq = 7100000;

beforeAll(async () => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
  account = await createHarnessAccount(OWNER, { partners: [MEMBER] });
  owner = { id: account.employeeId, name: OWNER };
  member = { id: account.partners[0]!.id, name: MEMBER };
  const guestRow = await prisma.employee.create({
    data: {
      userId: account.userId,
      kind: "human",
      name: GUEST,
      surname: "",
      nickname: GUEST,
      isOwner: false,
      isGuest: true,
    },
  });
  const shellRow = await prisma.employee.create({
    data: {
      userId: account.userId,
      kind: "human",
      name: SHELL,
      surname: "",
      nickname: SHELL,
      isOwner: false,
      isGuest: true,
    },
  });
  guest = { id: guestRow.id, name: GUEST };
  shell = { id: shellRow.id, name: SHELL };
  await listEmployeesForUser(account.userId);
  const lucy = await prisma.employee.findFirst({
    where: { userId: account.userId, kind: "digital", isProtected: true },
  });
  if (!lucy) {
    throw new Error("protected Lucy was not created");
  }
  lucyId = lucy.id;
  await prisma.employee.create({
    data: {
      userId: account.userId,
      kind: "digital",
      name: GUEST_LUCY_NAME,
      surname: "",
      nickname: GUEST_LUCY_NAME,
      isProtected: false,
    },
  });
}, 120_000);

afterAll(async () => {
  setLlmClientForTests(null);
  vi.unstubAllGlobals();
  if (!account) {
    return;
  }
  await prisma.tipProgress
    .deleteMany({ where: { tip: { userId: account.userId } } })
    .catch(() => undefined);
  await prisma.tip
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await prisma.chatMessage
    .deleteMany({ where: { conversation: { userId: account.userId } } })
    .catch(() => undefined);
  await prisma.chatConversation
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await prisma.mission
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await prisma.auditEvent
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await destroyHarnessAccount(account);
});

function stubReply(payload: unknown) {
  return {
    async createConversation() {
      return `conv-${randomUUID()}`;
    },
    async createResponse() {
      return { reply: JSON.stringify(payload), raw: {} };
    },
  };
}

function nextPhone(): string {
  phoneSeq += 1;
  return `052${phoneSeq}`;
}

async function speak(speaker: Party, payload: unknown, message = "בדיקה") {
  setLlmClientForTests(stubReply(payload));
  return sendChatMessage({
    userId: account.userId,
    employeeId: speaker.id,
    digitalEmployeeId: lucyId,
    message,
  });
}

async function itemsTouching(label: string) {
  const rows = await prisma.employeeListItem.findMany({
    where: { list: { employee: { userId: account.userId } } },
    include: { list: true },
  });
  return rows.filter(
    (row) =>
      row.itemKey.includes(label) || JSON.stringify(row.data).includes(label),
  );
}

function liveOn(rows: Awaited<ReturnType<typeof itemsTouching>>, employeeId: string) {
  return rows.filter((row) => row.deletedAt == null && row.list.employeeId === employeeId);
}

function listPayload(
  action: "add" | "update" | "remove",
  listType: string,
  listName: string,
  item: Record<string, unknown>,
  targets: string[] = [],
) {
  return {
    responses: [{ text: "שמרתי." }],
    metadata: {
      lists: [
        {
          action,
          list_type: listType,
          list_name: listName,
          items: [item],
          targets,
        },
      ],
    },
  };
}

async function seedListItem(
  employeeId: string,
  listType: "shopping" | "tasks" | "custom",
  listName: string,
  label: string,
  field: string,
) {
  const list =
    (await prisma.employeeList.findFirst({
      where: { employeeId, listType, name: listName, deletedAt: null },
    })) ??
    (await prisma.employeeList.create({
      data: {
        employeeId,
        listType,
        name: listName,
        scope: "personal",
        visibleTo: [employeeId],
      },
    }));
  return prisma.employeeListItem.create({
    data: {
      listId: list.id,
      itemKey: label,
      data: { [field]: label },
      scope: "personal",
      addedById: employeeId,
      visibleTo: [employeeId],
    },
  });
}

describe("guest capability parity on protected Lucy", () => {
  it("shopping add, update, and remove stay on the speaker", async () => {
    for (const speaker of [member, guest]) {
      const label = `חלב-${speaker.name}`;
      const renamed = `גבינה-${speaker.name}`;
      await speak(
        speaker,
        listPayload("add", "shopping", "", { "שם פריט": label }),
      );
      let rows = await itemsTouching(label);
      const owned = liveOn(rows, speaker.id);
      expect(owned).toHaveLength(1);
      expect(owned[0]?.addedById).toBe(speaker.id);
      expect(liveOn(rows, owner.id)).toHaveLength(0);
      expect(liveOn(rows, speaker.id === guest.id ? member.id : guest.id)).toHaveLength(0);

      await speak(
        speaker,
        listPayload("update", "shopping", "", {
          item_id: owned[0]!.id,
          "שם פריט": renamed,
        }),
      );
      const updated = await prisma.employeeListItem.findUnique({
        where: { id: owned[0]!.id },
        include: { list: true },
      });
      expect(updated?.deletedAt).toBeNull();
      expect(updated?.list.employeeId).toBe(speaker.id);
      expect(JSON.stringify(updated?.data)).toContain(renamed);

      await speak(
        speaker,
        listPayload("remove", "shopping", "", { item_id: owned[0]!.id }),
      );
      const removed = await prisma.employeeListItem.findUnique({
        where: { id: owned[0]!.id },
      });
      expect(removed?.deletedAt).not.toBeNull();
      rows = await itemsTouching(renamed);
      expect(rows.filter((row) => row.deletedAt == null)).toHaveLength(0);
    }
  }, 90_000);

  it("custom list add and remove stay on the speaker", async () => {
    for (const speaker of [member, guest]) {
      const listName = `מתנות-${speaker.name}`;
      const label = `ספר-${speaker.name}`;
      await speak(
        speaker,
        listPayload("add", "custom", listName, { תיאור: label }),
      );
      const rows = await itemsTouching(label);
      const owned = liveOn(rows, speaker.id);
      expect(owned).toHaveLength(1);
      expect(owned[0]?.list.name).toBe(listName);
      expect(owned[0]?.list.listType).toBe("custom");
      expect(owned[0]?.addedById).toBe(speaker.id);
      expect(liveOn(rows, owner.id)).toHaveLength(0);

      await speak(
        speaker,
        listPayload("remove", "custom", listName, { item_id: owned[0]!.id }),
      );
      const removed = await prisma.employeeListItem.findUnique({
        where: { id: owned[0]!.id },
      });
      expect(removed?.deletedAt).not.toBeNull();
    }
  }, 90_000);

  it("task add, update, and remove stay on the speaker", async () => {
    for (const speaker of [member, guest]) {
      const label = `מטלה-${speaker.name}`;
      const renamed = `מטלה-חדשה-${speaker.name}`;
      await speak(
        speaker,
        listPayload("add", "tasks", "", { "שם משימה": label }),
      );
      const rows = await itemsTouching(label);
      const owned = liveOn(rows, speaker.id);
      expect(owned).toHaveLength(1);
      expect(owned[0]?.addedById).toBe(speaker.id);
      expect(liveOn(rows, owner.id)).toHaveLength(0);

      await speak(
        speaker,
        listPayload("update", "tasks", "", {
          item_id: owned[0]!.id,
          "שם משימה": renamed,
        }),
      );
      const updated = await prisma.employeeListItem.findUnique({
        where: { id: owned[0]!.id },
        include: { list: true },
      });
      expect(updated?.list.employeeId).toBe(speaker.id);
      expect(JSON.stringify(updated?.data)).toContain(renamed);

      await speak(
        speaker,
        listPayload("remove", "tasks", "", { item_id: owned[0]!.id }),
      );
      const removed = await prisma.employeeListItem.findUnique({
        where: { id: owned[0]!.id },
      });
      expect(removed?.deletedAt).not.toBeNull();
    }
  }, 90_000);

  it("reminder add, update, and cancel stay on the speaker", async () => {
    for (const speaker of [member, guest]) {
      const label = `שעון-${speaker.name}`;
      await speak(speaker, {
        responses: [{ text: "קבעתי." }],
        metadata: {
          reminders: [
            {
              action: "add",
              item: label,
              date: "2031-06-15",
              time: "09:00",
              ping: [speaker.name],
              text: label,
            },
          ],
        },
      });
      const created = await prisma.reminder.findFirst({
        where: { userId: account.userId, itemLabel: label, status: "active" },
      });
      expect(created?.ownerId).toBe(speaker.id);
      expect(created?.actorId).toBe(speaker.id);
      const others = await prisma.reminder.count({
        where: {
          userId: account.userId,
          itemLabel: label,
          ownerId: { not: speaker.id },
        },
      });
      expect(others).toBe(0);

      await speak(speaker, {
        responses: [{ text: "עדכנתי." }],
        metadata: {
          reminders: [
            {
              action: "update",
              reminder_id: created!.id,
              item: label,
              date: "2031-06-16",
              time: "11:30",
              ping: [speaker.name],
              text: label,
            },
          ],
        },
      });
      const updated = await prisma.reminder.findUnique({
        where: { id: created!.id },
      });
      expect(updated?.ownerId).toBe(speaker.id);
      expect(updated?.status).toBe("active");
      expect(updated?.fireAt.getTime()).not.toBe(created!.fireAt.getTime());

      await speak(speaker, {
        responses: [{ text: "ביטלתי." }],
        metadata: {
          reminders: [
            { action: "remove", reminder_id: created!.id, item: label },
          ],
        },
      });
      const cancelled = await prisma.reminder.findUnique({
        where: { id: created!.id },
      });
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.ownerId).toBe(speaker.id);
    }
  }, 90_000);

  it("a guest involved in a reminder change is notified", async () => {
    const label = "שעון-הודעה-לרותם";
    await speak(member, {
      responses: [{ text: "קבעתי." }],
      metadata: {
        reminders: [
          {
            action: "add",
            item: label,
            date: "2031-07-01",
            time: "08:00",
            ping: [guest.name],
            text: label,
          },
        ],
      },
    });
    const created = await prisma.reminder.findFirst({
      where: { userId: account.userId, itemLabel: label, status: "active" },
    });
    expect(created?.ownerId).toBe(member.id);
    expect(created?.pingIds).toEqual(expect.arrayContaining([guest.id]));

    await speak(member, {
      responses: [{ text: "ביטלתי." }],
      metadata: {
        reminders: [{ action: "remove", reminder_id: created!.id, item: label }],
      },
    });
    const notices = await prisma.chatMessage.findMany({
      where: { conversation: { userId: account.userId, employeeId: guest.id } },
    });
    expect(notices.some((row) => row.text.includes("בוטלה"))).toBe(true);
    expect(notices.some((row) => row.text.includes(label))).toBe(true);
  }, 90_000);

  it("filing add, update, remove, and co-share stay on the speaker", async () => {
    for (const speaker of [member, guest]) {
      const name = `קוד-${speaker.name}`;
      await speak(speaker, {
        responses: [{ text: "שמרתי." }],
        metadata: {
          filing: [
            {
              action: "add_filing",
              item_name: name,
              item_info: "1111",
              item_description: name,
              filing_id: "",
              targets: [],
            },
          ],
        },
      });
      const created = await prisma.employeeFiling.findFirst({
        where: { itemName: name, deletedAt: null },
      });
      expect(created?.employeeId).toBe(speaker.id);
      expect(created?.addedById).toBe(speaker.id);
      const elsewhere = await prisma.employeeFiling.count({
        where: {
          itemName: name,
          deletedAt: null,
          employeeId: { not: speaker.id },
        },
      });
      expect(elsewhere).toBe(0);

      await speak(speaker, {
        responses: [{ text: "עדכנתי." }],
        metadata: {
          filing: [
            {
              action: "update_filing",
              filing_id: created!.id,
              item_name: name,
              item_info: "2222",
              item_description: name,
              targets: [],
            },
          ],
        },
      });
      const updated = await prisma.employeeFiling.findUnique({
        where: { id: created!.id },
      });
      expect(updated?.employeeId).toBe(speaker.id);
      expect(updated?.itemInfo).toBe("2222");
      expect(updated?.deletedAt).toBeNull();

      await speak(speaker, {
        responses: [{ text: "מחקתי." }],
        metadata: {
          filing: [
            {
              action: "remove_filing",
              filing_id: created!.id,
              item_name: name,
              item_info: "",
              item_description: "",
              targets: [],
            },
          ],
        },
      });
      const removed = await prisma.employeeFiling.findUnique({
        where: { id: created!.id },
      });
      expect(removed?.deletedAt).not.toBeNull();
    }

    const sharedName = "קוד-משותף-רותם";
    await speak(guest, {
      responses: [{ text: "שיתפתי." }],
      metadata: {
        filing: [
          {
            action: "add_filing",
            item_name: sharedName,
            item_info: "9999",
            item_description: sharedName,
            filing_id: "",
            targets: [guest.name, member.name],
          },
        ],
      },
    });
    const shared = await prisma.employeeFiling.findMany({
      where: { itemName: sharedName, deletedAt: null },
    });
    expect(shared).toHaveLength(1);
    expect(shared[0]?.employeeId).toBe(guest.id);
    expect(shared[0]?.addedById).toBe(guest.id);
    expect(shared[0]?.scope).toBe("shared");
    expect(shared[0]?.visibleTo).toEqual(
      expect.arrayContaining([guest.id, member.id]),
    );
    expect(shared.some((row) => row.employeeId === member.id)).toBe(false);
  }, 120_000);

  it("contact add, update, and remove stay on the speaker book", async () => {
    for (const speaker of [member, guest]) {
      const name = `נועה-${speaker.name}`;
      const phone = nextPhone();
      const next = nextPhone();
      await speak(speaker, {
        responses: [{ text: "שמרתי." }],
        metadata: {
          directory: [
            {
              action: "add",
              name,
              phone,
              contact_id: "",
              targets: [],
            },
          ],
        },
      });
      const created = await prisma.contact.findFirst({
        where: { userId: account.userId, name },
      });
      expect(created?.ownerEmployeeId).toBe(speaker.id);
      expect(created?.addedById).toBe(speaker.id);
      const copies = await prisma.contact.count({
        where: {
          userId: account.userId,
          name,
          ownerEmployeeId: { not: speaker.id },
        },
      });
      expect(copies).toBe(0);

      await speak(speaker, {
        responses: [{ text: "עדכנתי." }],
        metadata: {
          directory: [
            {
              action: "update",
              name,
              phone: next,
              contact_id: created!.id,
              targets: [],
            },
          ],
        },
      });
      const updated = await prisma.contact.findUnique({
        where: { id: created!.id },
      });
      expect(updated?.ownerEmployeeId).toBe(speaker.id);
      expect(updated?.phone).toContain(next.slice(1));

      await speak(speaker, {
        responses: [{ text: "מחקתי." }],
        metadata: {
          directory: [
            {
              action: "remove",
              name,
              phone: "",
              contact_id: created!.id,
              targets: [],
            },
          ],
        },
      });
      const gone = await prisma.contact.findUnique({ where: { id: created!.id } });
      expect(gone).toBeNull();
    }
  }, 90_000);

  it("a message that expects a reply opens a job attributed to the speaker", async () => {
    for (const speaker of [member, guest]) {
      const ask = `אם קנית-${speaker.name}`;
      const subject = speaker.id === guest.id ? member : guest;
      await speak(speaker, {
        responses: [{ text: "שאלתי." }],
        metadata: {
          messages: [
            {
              targets: [subject.name],
              text: `${speaker.name} שואל ${ask}`,
              expects_reply: true,
              ask_summary: ask,
              urgency: "normal",
            },
          ],
        },
      });
      const jobs = await prisma.employeeListItem.findMany({
        where: {
          deletedAt: null,
          list: { employeeId: lucyId, listType: "tasks", deletedAt: null },
        },
      });
      const hit = jobs.filter((row) => JSON.stringify(row.data).includes(ask));
      expect(hit).toHaveLength(1);
      expect(hit[0]?.addedById).toBe(speaker.id);
      expect(hit[0]?.visibleTo).toEqual(
        expect.arrayContaining([speaker.id, subject.id]),
      );
      expect(hit[0]?.listId).toBeTruthy();
      const onOwner = await itemsTouching(ask);
      expect(liveOn(onOwner, owner.id)).toHaveLength(0);
    }
  }, 90_000);

  it("a guest ping recipient stays on the worker task visible_to", async () => {
    const list = await prisma.employeeList.create({
      data: {
        employeeId: lucyId,
        listType: "tasks",
        name: "worker-parity",
        scope: "personal",
        visibleTo: [lucyId],
      },
    });
    const item = await prisma.employeeListItem.create({
      data: {
        listId: list.id,
        itemKey: "להזכיר לרותם לבדוק",
        data: { "שם משימה": "להזכיר לרותם לבדוק" },
        scope: "personal",
        addedById: lucyId,
        visibleTo: [lucyId],
      },
    });
    await shareWorkerTaskWithPingRecipients({
      workerItemId: item.id,
      ownerId: lucyId,
      pingIds: [guest.id, "972509998877"],
    });
    const after = await prisma.employeeListItem.findUnique({
      where: { id: item.id },
    });
    expect(after?.scope).toBe("personal");
    expect(after?.visibleTo).toEqual(
      expect.arrayContaining([lucyId, guest.id]),
    );
    expect(after?.visibleTo).not.toEqual(
      expect.arrayContaining(["972509998877"]),
    );
  }, 30_000);

  it("mission create is owned by the speaker and hidden from the other member", async () => {
    const goal = "רותם מבקשת לבדוק מחיר";
    await speak(guest, {
      responses: [{ text: "פתחתי משימה." }],
      metadata: {
        missions: [
          {
            action: "create",
            goal,
            success_criteria: "השורה נשמרת על רותם",
          },
        ],
      },
    });
    const mission = await prisma.mission.findFirst({
      where: { userId: account.userId, goal },
    });
    expect(mission?.speakerId).toBe(guest.id);
    expect(mission?.orchestratorId).toBe(lucyId);
    expect(mission?.status).toBe("planning");
    const stolen = await prisma.mission.count({
      where: { userId: account.userId, goal, speakerId: { not: guest.id } },
    });
    expect(stolen).toBe(0);

    const guestPublic = toPublicEmployee(
      (await prisma.employee.findUnique({ where: { id: guest.id } }))!,
    );
    const memberPublic = toPublicEmployee(
      (await prisma.employee.findUnique({ where: { id: member.id } }))!,
    );
    const guestView = await listActiveMissionsForChat({
      userId: account.userId,
      speaker: guestPublic,
      seeAll: false,
    });
    const memberView = await listActiveMissionsForChat({
      userId: account.userId,
      speaker: memberPublic,
      seeAll: false,
    });
    expect(guestView.some((row) => row.mission_id === mission!.id)).toBe(true);
    expect(memberView.some((row) => row.mission_id === mission!.id)).toBe(false);

    await speak(member, {
      responses: [{ text: "ביטלתי." }],
      metadata: {
        missions: [{ action: "cancel", mission_id: mission!.id }],
      },
    });
    const still = await prisma.mission.findUnique({ where: { id: mission!.id } });
    expect(still?.status).toBe("planning");
    expect(still?.speakerId).toBe(guest.id);

    await speak(guest, {
      responses: [{ text: "ביטלתי." }],
      metadata: {
        missions: [{ action: "cancel", mission_id: mission!.id }],
      },
    });
    const cancelled = await prisma.mission.findUnique({
      where: { id: mission!.id },
    });
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.speakerId).toBe(guest.id);
  }, 90_000);

  it("in-account share and assign match a regular member", async () => {
    for (const speaker of [member, guest]) {
      const partner = speaker.id === guest.id ? member : owner;
      const sharedLabel = `שיתוף-${speaker.name}`;
      await speak(
        speaker,
        listPayload(
          "add",
          "shopping",
          "",
          { "שם פריט": sharedLabel },
          [speaker.name, partner.name],
        ),
      );
      const shared = await itemsTouching(sharedLabel);
      const live = shared.filter((row) => row.deletedAt == null);
      expect(live).toHaveLength(1);
      expect(live[0]?.list.employeeId).toBe(speaker.id);
      expect(live[0]?.addedById).toBe(speaker.id);
      expect(live[0]?.scope).toBe("shared");
      expect(live[0]?.visibleTo).toEqual(
        expect.arrayContaining([speaker.id, partner.id]),
      );

      const assignedLabel = `הטלה-${speaker.name}`;
      await speak(
        speaker,
        listPayload(
          "add",
          "tasks",
          "",
          { "שם משימה": assignedLabel },
          [partner.name],
        ),
      );
      const assigned = (await itemsTouching(assignedLabel)).filter(
        (row) => row.deletedAt == null,
      );
      expect(assigned).toHaveLength(1);
      expect(assigned[0]?.list.employeeId).toBe(partner.id);
      expect(assigned[0]?.addedById).toBe(speaker.id);
      expect(
        assigned.some((row) => row.list.employeeId === speaker.id),
      ).toBe(false);
    }

    const sharedWithGuest = "שיתוף-עם-רותם";
    await speak(
      member,
      listPayload(
        "add",
        "shopping",
        "",
        { "שם פריט": sharedWithGuest },
        [member.name, guest.name],
      ),
    );
    const guestSeat = (await itemsTouching(sharedWithGuest)).filter(
      (row) => row.deletedAt == null,
    );
    expect(guestSeat).toHaveLength(1);
    expect(guestSeat[0]?.list.employeeId).toBe(member.id);
    expect(guestSeat[0]?.addedById).toBe(member.id);
    expect(guestSeat[0]?.visibleTo).toEqual(
      expect.arrayContaining([member.id, guest.id]),
    );
  }, 120_000);

  it("another guest shell is not an assign target, for a guest or a member", async () => {
    for (const speaker of [member, guest]) {
      const label = `הטלה-למעטפת-${speaker.name}`;
      await speak(
        speaker,
        listPayload("add", "tasks", "", { "שם משימה": label }, [shell.name]),
      );
      const rows = (await itemsTouching(label)).filter(
        (row) => row.deletedAt == null,
      );
      expect(rows.filter((row) => row.list.employeeId === shell.id)).toHaveLength(
        0,
      );
    }
  }, 90_000);

  it("weather on protected Lucy runs for a guest and a member", async () => {
    const probes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        probes.push(url);
        if (url.includes("geocoding-api.open-meteo.com")) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  name: "תל אביב",
                  latitude: 32.08,
                  longitude: 34.78,
                  country: "Israel",
                  timezone: "Asia/Jerusalem",
                  admin1: "תל אביב",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("api.open-meteo.com/v1/forecast")) {
          return new Response(
            JSON.stringify({
              timezone: "Asia/Jerusalem",
              current: {
                time: "2026-11-15T10:00",
                temperature_2m: 25,
                relative_humidity_2m: 50,
                weather_code: 0,
                wind_speed_10m: 12,
                precipitation: 0,
              },
              daily: {
                time: ["2026-11-15"],
                weather_code: [0],
                temperature_2m_max: [28],
                temperature_2m_min: [18],
                precipitation_sum: [0],
              },
            }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );
    try {
      for (const speaker of [member, guest]) {
        const before = await prisma.employeeListItem.count({
          where: { list: { employeeId: owner.id } },
        });
        const result = await speak(speaker, {
          responses: [{ text: "" }],
          metadata: {
            weather: { place: "תל אביב", aspects: ["temp"] },
          },
        });
        expect(result.reply).toContain("25");
        expect(result.reply).not.toMatch(/רק לצפות|אורחים יכולים/);
        const after = await prisma.employeeListItem.count({
          where: { list: { employeeId: owner.id } },
        });
        expect(after).toBe(before);
      }
      expect(probes.some((url) => url.includes("api.open-meteo.com"))).toBe(
        true,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  }, 90_000);

  it("member tips are listed for a guest on protected Lucy, without guest_terms", async () => {
    const guestRow = await prisma.employee.findUnique({
      where: { id: guest.id },
    });
    const memberRow = await prisma.employee.findUnique({
      where: { id: member.id },
    });
    const guestTips = await formatAvailableTipsContext({
      userId: account.userId,
      speaker: toPublicEmployee(guestRow!),
      digitalEmployeeId: lucyId,
    });
    const memberTips = await formatAvailableTipsContext({
      userId: account.userId,
      speaker: toPublicEmployee(memberRow!),
      digitalEmployeeId: lucyId,
    });
    expect(guestTips).toContain("key=general_weather");
    expect(memberTips).toContain("key=general_weather");
    expect(guestTips).not.toContain("key=guest_terms");
    expect(guestTips).not.toContain("אפשר בעיקר לצפות");
    const guestTerms = await prisma.tip.findFirst({
      where: { userId: account.userId, key: "guest_terms" },
    });
    expect(guestTerms?.digitalEmployeeId).not.toBe(lucyId);
  }, 60_000);

  it("a sticky לוסי-אורח does not override protected Lucy", async () => {
    const digitals = (
      await prisma.employee.findMany({
        where: { userId: account.userId, kind: "digital" },
      })
    ).map(toPublicEmployee);
    const sticky = digitals.find((row) => row.name === GUEST_LUCY_NAME);
    const lucy = digitals.find((row) => row.protected);
    expect(sticky).toBeTruthy();
    expect(whatsAppDigitalForTurn(digitals, sticky)?.id).toBe(lucy?.id);
    const david = digitals.find((row) => row.id === lucyId);
    expect(whatsAppDigitalForTurn(digitals, david)?.id).toBe(lucyId);
  });

  it("a guest cannot read or change another person's private records", async () => {
    const listLabel = "פרטי-קניות-טל";
    const memberListLabel = "פרטי-קניות-עמית";
    const filingName = "פרטי-תיוק-טל";
    const memberFiling = "פרטי-תיוק-עמית";
    const contactName = "פרטי-איש-טל";
    const memberContact = "פרטי-איש-עמית";
    const clockGuest = "פרטי-שעון-טל-1";
    const clockMember = "פרטי-שעון-טל-2";

    const ownerItem = await seedListItem(
      owner.id,
      "shopping",
      "",
      listLabel,
      "שם פריט",
    );
    const memberItem = await seedListItem(
      member.id,
      "shopping",
      "",
      memberListLabel,
      "שם פריט",
    );
    const ownerFiling = await prisma.employeeFiling.create({
      data: {
        employeeId: owner.id,
        itemName: filingName,
        itemInfo: "סודי",
        addedById: owner.id,
        visibleTo: [owner.id],
      },
    });
    const memberFilingRow = await prisma.employeeFiling.create({
      data: {
        employeeId: member.id,
        itemName: memberFiling,
        itemInfo: "סודי",
        addedById: member.id,
        visibleTo: [member.id],
      },
    });
    const ownerContact = await prisma.contact.create({
      data: {
        userId: account.userId,
        ownerEmployeeId: owner.id,
        name: contactName,
        phone: nextPhone(),
        addedById: owner.id,
      },
    });
    const memberContactRow = await prisma.contact.create({
      data: {
        userId: account.userId,
        ownerEmployeeId: member.id,
        name: memberContact,
        phone: nextPhone(),
        addedById: member.id,
      },
    });
    const ownerClock = await prisma.reminder.create({
      data: {
        userId: account.userId,
        ownerId: owner.id,
        actorId: owner.id,
        itemKey: clockGuest,
        itemLabel: clockGuest,
        listType: "tasks",
        fireAt: new Date("2031-08-01T06:00:00.000Z"),
        pingIds: [owner.id],
        messageText: clockGuest,
      },
    });
    await prisma.reminder.create({
      data: {
        userId: account.userId,
        ownerId: owner.id,
        actorId: owner.id,
        itemKey: clockMember,
        itemLabel: clockMember,
        listType: "tasks",
        fireAt: new Date("2031-08-01T07:00:00.000Z"),
        pingIds: [owner.id],
        messageText: clockMember,
      },
    });

    const guestSnap = await getEmployeeRecordSnapshot(guest.id);
    const memberSnap = await getEmployeeRecordSnapshot(member.id);
    const guestJson = JSON.stringify(guestSnap);
    const memberJson = JSON.stringify(memberSnap);
    for (const secret of [listLabel, filingName, contactName, clockGuest]) {
      expect(guestJson).not.toContain(secret);
      expect(memberJson).not.toContain(secret);
    }
    expect(guestJson).not.toContain(memberListLabel);
    expect(guestJson).not.toContain(memberFiling);
    expect(guestJson).not.toContain(memberContact);

    await speak(
      guest,
      listPayload("remove", "shopping", "", { item_id: ownerItem.id }),
    );
    await speak(
      member,
      listPayload("remove", "shopping", "", { item_id: ownerItem.id }),
    );
    await speak(
      guest,
      listPayload("remove", "shopping", "", { item_id: memberItem.id }),
    );
    expect(
      (await prisma.employeeListItem.findUnique({ where: { id: ownerItem.id } }))
        ?.deletedAt,
    ).toBeNull();
    expect(
      (
        await prisma.employeeListItem.findUnique({ where: { id: memberItem.id } })
      )?.deletedAt,
    ).toBeNull();

    await speak(guest, {
      responses: [{ text: "מחקתי." }],
      metadata: {
        filing: [
          {
            action: "remove_filing",
            filing_id: ownerFiling.id,
            item_name: filingName,
            item_info: "",
            item_description: "",
            targets: [],
          },
        ],
      },
    });
    await speak(member, {
      responses: [{ text: "מחקתי." }],
      metadata: {
        filing: [
          {
            action: "remove_filing",
            filing_id: ownerFiling.id,
            item_name: filingName,
            item_info: "",
            item_description: "",
            targets: [],
          },
        ],
      },
    });
    await speak(guest, {
      responses: [{ text: "מחקתי." }],
      metadata: {
        filing: [
          {
            action: "remove_filing",
            filing_id: memberFilingRow.id,
            item_name: memberFiling,
            item_info: "",
            item_description: "",
            targets: [],
          },
        ],
      },
    });
    expect(
      (await prisma.employeeFiling.findUnique({ where: { id: ownerFiling.id } }))
        ?.deletedAt,
    ).toBeNull();
    expect(
      (
        await prisma.employeeFiling.findUnique({
          where: { id: memberFilingRow.id },
        })
      )?.deletedAt,
    ).toBeNull();

    await speak(guest, {
      responses: [{ text: "מחקתי." }],
      metadata: {
        directory: [
          {
            action: "remove",
            name: contactName,
            phone: "",
            contact_id: ownerContact.id,
            targets: [],
          },
        ],
      },
    });
    await speak(guest, {
      responses: [{ text: "מחקתי." }],
      metadata: {
        directory: [
          {
            action: "remove",
            name: memberContact,
            phone: "",
            contact_id: memberContactRow.id,
            targets: [],
          },
        ],
      },
    });
    expect(
      await prisma.contact.findUnique({ where: { id: ownerContact.id } }),
    ).not.toBeNull();
    expect(
      await prisma.contact.findUnique({ where: { id: memberContactRow.id } }),
    ).not.toBeNull();

    const foreign = await createHarnessAccount("זר");
    try {
      const foreignItem = await seedListItem(
        foreign.employeeId,
        "shopping",
        "",
        "זר-קניות",
        "שם פריט",
      );
      const foreignClock = await prisma.reminder.create({
        data: {
          userId: foreign.userId,
          ownerId: foreign.employeeId,
          actorId: foreign.employeeId,
          itemKey: "זר-שעון",
          itemLabel: "זר-שעון",
          listType: "tasks",
          fireAt: new Date("2031-09-01T06:00:00.000Z"),
          pingIds: [foreign.employeeId],
          messageText: "זר-שעון",
        },
      });
      await speak(
        guest,
        listPayload("remove", "shopping", "", { item_id: foreignItem.id }),
      );
      await speak(guest, {
        responses: [{ text: "ביטלתי." }],
        metadata: {
          reminders: [
            { action: "remove", reminder_id: foreignClock.id, item: "זר-שעון" },
          ],
        },
      });
      expect(
        (
          await prisma.employeeListItem.findUnique({
            where: { id: foreignItem.id },
          })
        )?.deletedAt,
      ).toBeNull();
      expect(
        (await prisma.reminder.findUnique({ where: { id: foreignClock.id } }))
          ?.status,
      ).toBe("active");
    } finally {
      await prisma.reminder
        .deleteMany({ where: { userId: foreign.userId } })
        .catch(() => undefined);
      await destroyHarnessAccount(foreign);
    }

    await speak(guest, {
      responses: [{ text: "ביטלתי." }],
      metadata: {
        reminders: [
          { action: "remove", reminder_id: ownerClock.id, item: clockGuest },
        ],
      },
    });
    const guestCancelled = await prisma.reminder.findUnique({
      where: { id: ownerClock.id },
    });
    const memberCancelled = await prisma.reminder.findFirst({
      where: { userId: account.userId, itemLabel: clockMember },
    });
    await speak(member, {
      responses: [{ text: "ביטלתי." }],
      metadata: {
        reminders: [
          {
            action: "remove",
            reminder_id: memberCancelled!.id,
            item: clockMember,
          },
        ],
      },
    });
    const memberAfter = await prisma.reminder.findUnique({
      where: { id: memberCancelled!.id },
    });
    expect(guestCancelled?.status).toBe(memberAfter?.status);
    expect(guestCancelled?.status).toBe("cancelled");
  }, 120_000);
});
