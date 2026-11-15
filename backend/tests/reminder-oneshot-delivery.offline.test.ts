/**
 * Production fireDueReminders path for a plain one-shot.
 * NODE_ENV is not "test", so the ticker body actually runs. Prisma is in-memory.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  NODE_ENV: "development" as string,
  WHATSAPP_ACCESS_TOKEN: "not-a-real-token",
}));

const {
  reminderFindMany,
  reminderUpdate,
  reminderUpdateMany,
  reminderFindUnique,
  itemUpdateMany,
  itemUpdate,
  itemFindMany,
  chatConversationFindUnique,
} = vi.hoisted(() => ({
  reminderFindMany: vi.fn(),
  reminderUpdate: vi.fn(),
  reminderUpdateMany: vi.fn(),
  reminderFindUnique: vi.fn(),
  itemUpdateMany: vi.fn(),
  itemUpdate: vi.fn(),
  itemFindMany: vi.fn(),
  chatConversationFindUnique: vi.fn(),
}));

const sendWhatsAppButtons = vi.hoisted(() => vi.fn());
const listEmployeesForUser = vi.hoisted(() => vi.fn());
const listReminderAttachments = vi.hoisted(() => vi.fn());

vi.mock("../src/config/env.js", () => ({
  getEnv: () => env,
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: {
      findMany: reminderFindMany,
      update: reminderUpdate,
      updateMany: reminderUpdateMany,
      findUnique: reminderFindUnique,
      delete: vi.fn(),
    },
    employeeListItem: {
      updateMany: itemUpdateMany,
      update: itemUpdate,
      findMany: itemFindMany,
      findUnique: vi.fn(),
    },
    chatConversation: {
      findUnique: chatConversationFindUnique,
    },
    chatMessage: { create: vi.fn() },
  },
}));

vi.mock("../src/services/audit.service.js", () => ({
  recordAuditEvent: vi.fn(),
}));

vi.mock("../src/services/whatsapp-log.js", () => ({
  recordWhatsAppEvent: vi.fn(),
}));

vi.mock("../src/services/whatsapp-send.js", () => ({
  sendWhatsAppButtons,
}));

vi.mock("../src/services/employee.service.js", () => ({
  listEmployeesForUser,
}));

vi.mock("../src/services/attachment.service.js", () => ({
  listReminderAttachments,
  deliverAttachmentsToPhone: vi.fn(),
  toChatAttachmentRef: vi.fn(),
}));

vi.mock("../src/services/jobs.service.js", () => ({
  activateScheduledJob: vi.fn(async () => false),
  continueJobAfterNudge: vi.fn(),
}));

import {
  ONE_SHOT_DELIVERY_RETRY_MS,
  fireDueReminders,
} from "../src/services/reminder-fire.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const LUCY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "22222222-2222-4222-8222-222222222222";
const DUE = new Date("2026-11-15T10:00:00.000Z");

type Clock = {
  id: string;
  userId: string;
  actorId: string;
  ownerId: string;
  pingIds: string[];
  messageText: string;
  itemLabel: string;
  composeAtFire: boolean;
  fireAt: Date;
  status: string;
  sendStatus: string;
  sentAt: Date | null;
  repeat: string;
  recurrence: null;
  occurrencesFired: number;
  workerItemId: string | null;
};

let clocks: Clock[];

function clock(id = "clock-1"): Clock {
  return {
    id,
    userId: USER,
    actorId: ACTOR,
    ownerId: ACTOR,
    pingIds: [ACTOR],
    messageText: "לקחת את התיק",
    itemLabel: "לקחת את התיק",
    composeAtFire: false,
    fireAt: DUE,
    status: "active",
    sendStatus: "pending",
    sentAt: null,
    repeat: "once",
    recurrence: null,
    occurrencesFired: 0,
    workerItemId: "task-1",
  };
}

describe("one-shot reminder delivery", () => {
  beforeEach(() => {
    env.NODE_ENV = "development";
    env.WHATSAPP_ACCESS_TOKEN = "not-a-real-token";
    clocks = [clock()];
    reminderFindMany.mockImplementation(
      async (args: { where?: { fireAt?: { lte?: Date } } }) => {
        const now = args?.where?.fireAt?.lte ?? new Date(0);
        return clocks.filter(
          (row) => row.status === "active" && row.fireAt.getTime() <= now.getTime(),
        );
      },
    );
    reminderUpdate.mockImplementation(
      async (args: { where: { id: string }; data: Partial<Clock> }) => {
        const row = clocks.find((item) => item.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      },
    );
    reminderUpdateMany.mockImplementation(
      async (args: {
        where: { id: string; fireAt?: { lte?: Date } };
        data: Partial<Clock>;
      }) => {
        const now = args.where.fireAt?.lte ?? new Date(0);
        const row = clocks.find(
          (item) =>
            item.id === args.where.id &&
            item.status === "active" &&
            item.fireAt.getTime() <= now.getTime(),
        );
        if (!row) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
    );
    reminderFindUnique.mockResolvedValue({ workerItemId: "task-1" });
    itemUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    itemUpdate.mockReset().mockResolvedValue({ id: "task-1", data: {} });
    itemFindMany.mockResolvedValue([]);
    chatConversationFindUnique.mockResolvedValue(null);
    listReminderAttachments.mockResolvedValue([]);
    listEmployeesForUser.mockResolvedValue([
      {
        id: ACTOR,
        userId: USER,
        kind: "human",
        isProtected: false,
        isOwner: true,
        name: "עמית",
        surname: "",
        nickname: "עמית",
        email: null,
        phone: "0501111111",
        addressGender: null,
      },
      {
        id: LUCY,
        userId: USER,
        kind: "digital",
        isProtected: true,
        isOwner: false,
        name: "לוסי",
        surname: "",
        nickname: "לוסי",
        email: null,
        phone: null,
        addressGender: null,
      },
    ]);
    sendWhatsAppButtons.mockReset().mockResolvedValue("sent");
  });

  it("marks a successful one-shot done and does not send it again", async () => {
    await fireDueReminders(new Date(DUE.getTime() + 60_000));
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(1);
    expect(clocks[0]?.status).toBe("done");
    expect(clocks[0]?.sendStatus).toBe("sent");
    expect(clocks[0]?.sentAt).toBeInstanceOf(Date);
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });

    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date(DUE.getTime() + 180_000));
    expect(sendWhatsAppButtons).not.toHaveBeenCalled();
    expect(clocks[0]?.status).toBe("done");
  });

  it("keeps a failed delivery active and retries once, then completes", async () => {
    sendWhatsAppButtons.mockResolvedValueOnce("failed").mockResolvedValueOnce("sent");
    const first = new Date(DUE.getTime() + 60_000);
    await fireDueReminders(first);
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(1);
    expect(clocks[0]?.status).toBe("active");
    expect(clocks[0]?.sendStatus).toBe("failed");
    expect(clocks[0]?.sentAt).toBeNull();
    expect(clocks[0]?.workerItemId).toBe("task-1");
    expect(itemUpdate).not.toHaveBeenCalled();
    expect(clocks[0]?.fireAt.getTime()).toBe(first.getTime() + ONE_SHOT_DELIVERY_RETRY_MS);

    await fireDueReminders(new Date(first.getTime() + 30_000));
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(1);

    await fireDueReminders(new Date(first.getTime() + ONE_SHOT_DELIVERY_RETRY_MS));
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(2);
    expect(clocks[0]?.status).toBe("done");
    expect(clocks[0]?.sendStatus).toBe("sent");
  });

  it("finishes an accepted send without a second WhatsApp message", async () => {
    clocks[0]!.sendStatus = "accepted";
    clocks[0]!.sentAt = DUE;
    await fireDueReminders(new Date(DUE.getTime() + 60_000));
    expect(sendWhatsAppButtons).not.toHaveBeenCalled();
    expect(clocks[0]?.status).toBe("done");
    expect(clocks[0]?.sendStatus).toBe("sent");
  });

  it("sends a second time when WhatsApp accepted but accepted was not saved", async () => {
    let droppedAcceptedWrite = false;
    reminderUpdate.mockImplementation(
      async (args: { where: { id: string }; data: Partial<Clock> }) => {
        if (args.data.sendStatus === "accepted" && !droppedAcceptedWrite) {
          droppedAcceptedWrite = true;
          throw new Error("process crashed before accepted was saved");
        }
        const row = clocks.find((item) => item.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      },
    );
    const first = new Date(DUE.getTime() + 60_000);
    await expect(fireDueReminders(first)).rejects.toThrow(
      /crashed before accepted was saved/,
    );
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(1);
    expect(clocks[0]?.status).toBe("active");
    expect(clocks[0]?.sendStatus).toBe("pending");
    expect(clocks[0]?.fireAt.getTime()).toBe(first.getTime() + 120_000);

    await fireDueReminders(new Date(first.getTime() + 30_000));
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(1);

    await fireDueReminders(new Date(first.getTime() + 120_000));
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(2);
    expect(clocks[0]?.status).toBe("done");
    expect(clocks[0]?.sendStatus).toBe("sent");
  });

  it("delivers a clock that became due while the process was down", async () => {
    const started = new Date(DUE.getTime() + 30 * 60_000);
    expect(clocks[0]?.status).toBe("active");
    expect(clocks[0]!.fireAt.getTime()).toBeLessThan(started.getTime());
    await fireDueReminders(started);
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(1);
    expect(clocks[0]?.status).toBe("done");
    expect(clocks[0]?.sendStatus).toBe("sent");
    sendWhatsAppButtons.mockClear();
    await fireDueReminders(new Date(started.getTime() + 10_000));
    expect(sendWhatsAppButtons).not.toHaveBeenCalled();
  });
});
