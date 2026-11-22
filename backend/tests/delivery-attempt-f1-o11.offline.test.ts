/**
 * F1 reminder-fire + O11 invite-continuation DeliveryAttempt ledger (offline).
 * NODE_ENV is not "test" so fireDueReminders runs the production body.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  NODE_ENV: "development" as string,
  WHATSAPP_ACCESS_TOKEN: "not-a-real-token",
}));

type LedgerRow = {
  id: string;
  userId: string;
  ledgerKey: string;
  stepKey: string;
  destination: string;
  purpose: string;
  status: string;
  lastError: string | null;
};

const {
  reminderFindMany,
  reminderUpdate,
  reminderUpdateMany,
  reminderFindUnique,
  reminderFindFirst,
  reminderCreate,
  itemUpdateMany,
  itemUpdate,
  itemFindMany,
  itemFindUnique,
  chatConversationFindUnique,
  deliveryAttemptFindUnique,
  deliveryAttemptCreate,
  deliveryAttemptUpdate,
  deliveryAttemptUpdateMany,
  ledger,
  noticeClocks,
} = vi.hoisted(() => {
  const ledger = new Map<string, LedgerRow>();
  const noticeClocks: Array<Record<string, unknown>> = [];
  return {
    ledger,
    noticeClocks,
    reminderFindMany: vi.fn(),
    reminderUpdate: vi.fn(),
    reminderUpdateMany: vi.fn(),
    reminderFindUnique: vi.fn(),
    reminderFindFirst: vi.fn(async () => null),
    reminderCreate: vi.fn(async (args: { data: Record<string, unknown> }) => {
      const row = { id: `notice-${noticeClocks.length + 1}`, ...args.data };
      noticeClocks.push(row);
      return row;
    }),
    itemUpdateMany: vi.fn(),
    itemUpdate: vi.fn(),
    itemFindMany: vi.fn(),
    itemFindUnique: vi.fn(async () => null),
    chatConversationFindUnique: vi.fn(),
    deliveryAttemptFindUnique: vi.fn(
      async (args: { where: { ledgerKey: string } }) =>
        ledger.get(args.where.ledgerKey) ?? null,
    ),
    deliveryAttemptCreate: vi.fn(
      async (args: { data: Omit<LedgerRow, "id" | "lastError"> & { lastError?: null } }) => {
        if (ledger.has(args.data.ledgerKey)) {
          throw new Error("Unique constraint failed on ledger_key");
        }
        const row: LedgerRow = {
          id: `da-${ledger.size + 1}`,
          lastError: null,
          ...args.data,
        };
        ledger.set(row.ledgerKey, row);
        return row;
      },
    ),
    deliveryAttemptUpdate: vi.fn(
      async (args: { where: { id: string }; data: Partial<LedgerRow> }) => {
        for (const row of ledger.values()) {
          if (row.id === args.where.id) {
            Object.assign(row, args.data);
            return row;
          }
        }
        throw new Error("DeliveryAttempt not found");
      },
    ),
    deliveryAttemptUpdateMany: vi.fn(
      async (args: {
        where: { id: string; status?: { in: string[] } };
        data: Partial<LedgerRow>;
      }) => {
        for (const row of ledger.values()) {
          if (row.id !== args.where.id) continue;
          const allowed = args.where.status?.in;
          if (allowed && !allowed.includes(row.status)) {
            return { count: 0 };
          }
          Object.assign(row, args.data);
          return { count: 1 };
        }
        return { count: 0 };
      },
    ),
  };
});

const sendWhatsAppButtons = vi.hoisted(() => vi.fn());
const sendWhatsAppText = vi.hoisted(() => vi.fn());
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
      findFirst: reminderFindFirst,
      create: reminderCreate,
      delete: vi.fn(),
    },
    employeeListItem: {
      updateMany: itemUpdateMany,
      update: itemUpdate,
      findMany: itemFindMany,
      findUnique: itemFindUnique,
    },
    chatConversation: {
      findUnique: chatConversationFindUnique,
    },
    chatMessage: { create: vi.fn() },
    deliveryAttempt: {
      findUnique: deliveryAttemptFindUnique,
      create: deliveryAttemptCreate,
      update: deliveryAttemptUpdate,
      updateMany: deliveryAttemptUpdateMany,
    },
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
  sendWhatsAppText,
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

import { fireDueReminders } from "../src/services/reminder-fire.js";
import { deliverO11WhatsApp } from "../src/services/o11-whatsapp-delivery.js";
import {
  buildDeliveryLedgerKey,
  decideDeliverySend,
} from "../src/services/delivery-attempt.service.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
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
  highRiskAuthorizedAt: Date | null;
};

let clocks: Clock[];

function clock(partial: Partial<Clock> = {}): Clock {
  return {
    id: "clock-1",
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
    highRiskAuthorizedAt: null,
    ...partial,
  };
}

function wireReminderStore(): void {
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
  itemUpdateMany.mockResolvedValue({ count: 0 });
  itemUpdate.mockResolvedValue({ id: "task-1", data: {} });
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
      name: "טל",
      surname: "",
      nickname: "טל",
      email: null,
      phone: "0501111111",
      addressGender: null,
    },
    {
      id: OTHER,
      userId: USER,
      kind: "human",
      isProtected: false,
      isOwner: false,
      name: "עמית",
      surname: "",
      nickname: "עמית",
      email: null,
      phone: "0502222222",
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
}

describe("Stage 6 fire-time suppress", () => {
  beforeEach(() => {
    env.NODE_ENV = "development";
    env.WHATSAPP_ACCESS_TOKEN = "not-a-real-token";
    ledger.clear();
    noticeClocks.length = 0;
    clocks = [];
    wireReminderStore();
    reminderFindFirst.mockResolvedValue(null);
    reminderCreate.mockClear();
    itemFindUnique.mockResolvedValue(null);
    sendWhatsAppButtons.mockReset().mockResolvedValue("sent");
  });

  it("suppresses unauthorized legacy foreign clocks and schedules one asker notice", async () => {
    clocks = [
      clock({
        pingIds: [OTHER],
        highRiskAuthorizedAt: null,
        messageText: "תביא חלב",
        itemLabel: "תביא חלב",
      }),
    ];
    await fireDueReminders(new Date(DUE.getTime() + 60_000));
    expect(sendWhatsAppButtons).not.toHaveBeenCalled();
    expect(clocks[0]?.status).toBe("done");
    expect(clocks[0]?.sendStatus).toBe("failed");
    expect(reminderCreate).toHaveBeenCalledTimes(1);
    expect(reminderCreate.mock.calls[0][0].data.pingIds).toEqual([ACTOR]);
    expect(reminderCreate.mock.calls[0][0].data.itemKey).toContain("כשל_מסירה:");
    expect(
      [...ledger.values()].some((row) => row.purpose === "reminder_fail_notice"),
    ).toBe(true);
  });

  it("does not create a fail notice when ledger is already sending (no Reminder row)", async () => {
    const sourceId = "clock-sending";
    const ledgerKey = buildDeliveryLedgerKey({
      sourceKey: `reminder:${sourceId}`,
      destination: "0501111111",
      purpose: "reminder_fail_notice",
    });
    ledger.set(ledgerKey, {
      id: "da-stuck-sending",
      userId: USER,
      ledgerKey,
      stepKey: `reminder_fail_notice:0501111111`,
      destination: "0501111111",
      purpose: "reminder_fail_notice",
      status: "sending",
      lastError: null,
    });
    clocks = [
      clock({
        id: sourceId,
        pingIds: [OTHER],
        highRiskAuthorizedAt: null,
        messageText: "תביא חלב",
        itemLabel: "תביא חלב",
      }),
    ];
    await fireDueReminders(new Date(DUE.getTime() + 60_000));
    expect(reminderCreate).not.toHaveBeenCalled();
    expect(ledger.get(ledgerKey)?.status).toBe("sending");
  });

  it("does not create a fail notice when ledger is already unknown (no Reminder row)", async () => {
    const sourceId = "clock-unknown";
    const ledgerKey = buildDeliveryLedgerKey({
      sourceKey: `reminder:${sourceId}`,
      destination: "0501111111",
      purpose: "reminder_fail_notice",
    });
    ledger.set(ledgerKey, {
      id: "da-stuck-unknown",
      userId: USER,
      ledgerKey,
      stepKey: `reminder_fail_notice:0501111111`,
      destination: "0501111111",
      purpose: "reminder_fail_notice",
      status: "unknown",
      lastError: null,
    });
    clocks = [
      clock({
        id: sourceId,
        pingIds: [OTHER],
        highRiskAuthorizedAt: null,
        messageText: "תביא חלב",
        itemLabel: "תביא חלב",
      }),
    ];
    await fireDueReminders(new Date(DUE.getTime() + 60_000));
    expect(reminderCreate).not.toHaveBeenCalled();
    expect(ledger.get(ledgerKey)?.status).toBe("unknown");
  });

  it("does not create a fail notice when Reminder with same itemKey already exists", async () => {
    reminderFindFirst.mockResolvedValue({ id: "notice-existing" });
    clocks = [
      clock({
        pingIds: [OTHER],
        highRiskAuthorizedAt: null,
        messageText: "תביא חלב",
        itemLabel: "תביא חלב",
      }),
    ];
    await fireDueReminders(new Date(DUE.getTime() + 60_000));
    expect(reminderCreate).not.toHaveBeenCalled();
  });

  it("completes fail-notice attempt to accepted and skips on replay", async () => {
    clocks = [
      clock({
        pingIds: [OTHER],
        highRiskAuthorizedAt: null,
        messageText: "תביא חלב",
        itemLabel: "תביא חלב",
      }),
    ];
    await fireDueReminders(new Date(DUE.getTime() + 60_000));
    expect(reminderCreate).toHaveBeenCalledTimes(1);
    const noticeAttempt = [...ledger.values()].find(
      (row) => row.purpose === "reminder_fail_notice",
    );
    expect(noticeAttempt?.status).toBe("accepted");

    reminderFindFirst.mockResolvedValue({ id: "notice-1" });
    reminderCreate.mockClear();
    clocks = [
      clock({
        id: "clock-1",
        status: "active",
        sendStatus: "pending",
        fireAt: DUE,
        pingIds: [OTHER],
        highRiskAuthorizedAt: null,
        messageText: "תביא חלב",
        itemLabel: "תביא חלב",
      }),
    ];
    await fireDueReminders(new Date(DUE.getTime() + 60_000));
    expect(reminderCreate).not.toHaveBeenCalled();
  });

  it("fires authorized foreign clocks", async () => {
    clocks = [
      clock({
        pingIds: [OTHER],
        highRiskAuthorizedAt: new Date("2026-11-18T08:00:00.000Z"),
        messageText: "תביא חלב",
        itemLabel: "תביא חלב",
      }),
    ];
    await fireDueReminders(new Date(DUE.getTime() + 60_000));
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(1);
    expect(clocks[0]?.status).toBe("done");
    expect(clocks[0]?.sendStatus).toBe("sent");
    expect(reminderCreate).not.toHaveBeenCalled();
  });

  it("still fires personal clocks without a marker", async () => {
    clocks = [clock({ pingIds: [ACTOR], highRiskAuthorizedAt: null })];
    await fireDueReminders(new Date(DUE.getTime() + 60_000));
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(1);
    expect(clocks[0]?.status).toBe("done");
    expect(clocks[0]?.sendStatus).toBe("sent");
  });

  it("fires Lucy-actor Job clocks without suppress (no highRisk stamp)", async () => {
    itemFindUnique.mockResolvedValue({
      data: {
        __job: {
          kind: "nudge",
          askerId: ACTOR,
          askerName: "טל",
          subjectId: OTHER,
          subjectName: "עמית",
          ask: "מה שלומך?",
          state: "open",
          createdAt: "2026-11-15T09:00:00.000Z",
        },
      },
    });
    clocks = [
      clock({
        actorId: LUCY,
        ownerId: OTHER,
        pingIds: [OTHER],
        highRiskAuthorizedAt: null,
        messageText: "טל מחכה לתשובה: מה שלומך?",
        itemLabel: "להזכיר לעמית מה שלומך?",
      }),
    ];
    await fireDueReminders(new Date(DUE.getTime() + 60_000));
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(1);
    const sentText = String(sendWhatsAppButtons.mock.calls[0][1] ?? "");
    expect(sentText).toContain("טל מחכה לתשובה");
    expect(sentText).not.toMatch(/מאת לוסי/);
    expect(clocks[0]?.sendStatus).toBe("sent");
    expect(reminderCreate).not.toHaveBeenCalled();
  });
});

describe("F1 reminder-fire DeliveryAttempt ledger", () => {
  beforeEach(() => {
    env.NODE_ENV = "development";
    env.WHATSAPP_ACCESS_TOKEN = "not-a-real-token";
    ledger.clear();
    clocks = [clock()];
    wireReminderStore();
    sendWhatsAppButtons.mockReset().mockResolvedValue("sent");
  });

  it("records a ledger entry and skips Graph on retry after accepted settle crash", async () => {
    let droppedAcceptedWrite = false;
    reminderUpdate.mockImplementation(
      async (args: { where: { id: string }; data: Partial<Clock> }) => {
        if (args.data.sendStatus === "accepted" && !droppedAcceptedWrite) {
          droppedAcceptedWrite = true;
          throw new Error("process crashed after Graph accept");
        }
        const row = clocks.find((item) => item.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      },
    );

    const first = new Date(DUE.getTime() + 60_000);
    await expect(fireDueReminders(first)).rejects.toThrow(
      /crashed after Graph accept/,
    );
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(1);
    expect(ledger.size).toBe(1);
    const row = [...ledger.values()][0]!;
    expect(row.status).toBe("accepted");
    expect(row.purpose).toBe("reminder_fire");
    expect(
      buildDeliveryLedgerKey({
        sourceKey: `reminder:${clocks[0]!.id}`,
        destination: "0501111111",
        purpose: "reminder_fire",
      }),
    ).toBe(row.ledgerKey);

    await fireDueReminders(new Date(first.getTime() + 30_000));
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(1);

    await fireDueReminders(new Date(first.getTime() + 120_000));
    expect(sendWhatsAppButtons).toHaveBeenCalledTimes(1);
    expect(clocks[0]?.status).toBe("done");
    expect(clocks[0]?.sendStatus).toBe("sent");
  });
});

describe("O11 continueInvite DeliveryAttempt ledger", () => {
  beforeEach(() => {
    ledger.clear();
    sendWhatsAppText.mockReset().mockResolvedValue("sent");
  });

  it("writes a ledger entry and suppresses duplicate guest WhatsApp on replay", async () => {
    const inviteId = "44444444-4444-4444-8444-444444444444";
    await deliverO11WhatsApp({
      userId: USER,
      inviteId,
      destination: "0503333333",
      purpose: "o11_guest",
      text: "עמית שאל/ה: חלב?",
    });
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    expect(ledger.size).toBe(1);
    const row = [...ledger.values()][0]!;
    expect(row.status).toBe("accepted");
    expect(row.purpose).toBe("o11_guest");
    expect(row.ledgerKey).toBe(
      buildDeliveryLedgerKey({
        sourceKey: `invite:${inviteId}`,
        destination: "0503333333",
        purpose: "o11_guest",
      }),
    );

    await deliverO11WhatsApp({
      userId: USER,
      inviteId,
      destination: "0503333333",
      purpose: "o11_guest",
      text: "עמית שאל/ה: חלב?",
    });
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    expect(decideDeliverySend("accepted").action).toBe("skip");
  });

  it("suppresses asker WhatsApp replay with a distinct purpose key", async () => {
    const inviteId = "55555555-5555-4555-8555-555555555555";
    await deliverO11WhatsApp({
      userId: USER,
      inviteId,
      destination: "0501111111",
      purpose: "o11_asker",
      text: "עמית נרשם/ה לוורקי.",
    });
    await deliverO11WhatsApp({
      userId: USER,
      inviteId,
      destination: "0501111111",
      purpose: "o11_asker",
      text: "עמית נרשם/ה לוורקי.",
    });
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
  });
});
