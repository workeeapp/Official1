/**
 * Offline fireDueReminders coverage for compose honesty.
 * NODE_ENV is forced off "test" so the early return in fireDueReminders does not skip.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  NODE_ENV: "development" as string,
  WHATSAPP_ACCESS_TOKEN: "",
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
  chatMessageCreate,
} = vi.hoisted(() => ({
  reminderFindMany: vi.fn(),
  reminderUpdate: vi.fn(),
  reminderUpdateMany: vi.fn(),
  reminderFindUnique: vi.fn(),
  itemUpdateMany: vi.fn(),
  itemUpdate: vi.fn(),
  itemFindMany: vi.fn(),
  chatConversationFindUnique: vi.fn(),
  chatMessageCreate: vi.fn(),
}));

const loadComposeFacts = vi.hoisted(() => vi.fn());
const composeScheduledOutbound = vi.hoisted(() => vi.fn());
const sendWhatsAppButtons = vi.hoisted(() => vi.fn());
const listEmployeesForUser = vi.hoisted(() => vi.fn());
const listReminderAttachments = vi.hoisted(() => vi.fn());
const activateScheduledJob = vi.hoisted(() => vi.fn());
const continueJobAfterNudge = vi.hoisted(() => vi.fn());
const fetchBusEtaWatch = vi.hoisted(() => vi.fn());
const fetchFlightEtaWatch = vi.hoisted(() => vi.fn());
const fetchFlightChangedWatch = vi.hoisted(() => vi.fn());

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
      create: vi.fn(),
    },
    chatMessage: {
      create: chatMessageCreate,
    },
  },
}));

vi.mock("../src/services/audit.service.js", () => ({
  recordAuditEvent: vi.fn(),
}));

vi.mock("../src/services/whatsapp-log.js", () => ({
  recordWhatsAppEvent: vi.fn(),
}));

vi.mock("../src/services/chat-events.service.js", () => ({
  publishChatEvent: vi.fn(),
}));

vi.mock("../src/services/llm-client.js", () => ({
  getLlmClient: () => ({ createConversation: vi.fn() }),
  rememberInModelConversation: vi.fn(),
}));

vi.mock("../src/services/employee.service.js", () => ({
  listEmployeesForUser: (...args: unknown[]) => listEmployeesForUser(...args),
}));

vi.mock("../src/services/compose-facts.js", () => ({
  loadComposeFacts: (...args: unknown[]) => loadComposeFacts(...args),
}));

vi.mock("../src/services/reminder-compose.js", () => ({
  composeScheduledOutbound: (...args: unknown[]) =>
    composeScheduledOutbound(...args),
}));

vi.mock("../src/services/whatsapp-send.js", () => ({
  sendWhatsAppButtons: (...args: unknown[]) => sendWhatsAppButtons(...args),
}));

vi.mock("../src/services/attachment.service.js", () => ({
  listReminderAttachments: (...args: unknown[]) =>
    listReminderAttachments(...args),
  toChatAttachmentRef: (row: { id: string }) => ({ id: row.id }),
  deliverAttachmentsToPhone: vi.fn(),
}));

vi.mock("../src/services/jobs.service.js", () => ({
  activateScheduledJob: (...args: unknown[]) => activateScheduledJob(...args),
  continueJobAfterNudge: (...args: unknown[]) => continueJobAfterNudge(...args),
}));

vi.mock("../src/services/routes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/routes.js")>();
  return {
    ...actual,
    fetchBusEtaWatch: (...args: unknown[]) => fetchBusEtaWatch(...args),
  };
});

vi.mock("../src/services/flights.js", () => ({
  fetchFlightEtaWatch: (...args: unknown[]) => fetchFlightEtaWatch(...args),
  fetchFlightChangedWatch: (...args: unknown[]) =>
    fetchFlightChangedWatch(...args),
  flightEtaThresholdMinutes: () => 60,
}));

vi.mock("../src/services/watch-expr.js", () => ({
  enrichEvalFactsForExpr: vi.fn(async (input: { factsBundle: unknown }) => ({
    evalFacts: {},
    factsBundle: input.factsBundle,
  })),
}));

vi.mock("../src/services/jewish.js", () => ({
  nextCandleLighting: vi.fn(),
}));

import {
  fireDueReminders,
  resolveComposeFireOutbound,
} from "../src/services/reminder-fire.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const LUCY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "22222222-2222-4222-8222-222222222222";
const BRIEF = "סכם את הקומיטים מאז אתמול — אל תשלח את המשפט הזה";

function employees() {
  return [
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
  ];
}

function baseReminder(overrides: Record<string, unknown> = {}) {
  return {
    id: "clock-compose-1",
    userId: USER,
    actorId: ACTOR,
    ownerId: ACTOR,
    pingIds: [ACTOR],
    messageText: BRIEF,
    itemLabel: "דוח מוצר",
    composeAtFire: true,
    composeSource: "git_log",
    composePlace: "",
    composeLookbackHours: 24,
    composeCondition: null,
    lastReportSha: "",
    lastComposedText: "",
    fireAt: new Date("2026-10-28T08:00:00.000Z"),
    status: "active",
    repeat: "once",
    recurrence: null,
    occurrencesFired: 0,
    watchOnce: true,
    scheduleAnchor: "",
    scheduleOffsetMinutes: 0,
    workerItemId: null,
    ...overrides,
  };
}

describe("fireDueReminders compose honesty", () => {
  beforeEach(() => {
    env.NODE_ENV = "development";
    env.WHATSAPP_ACCESS_TOKEN = "";
    reminderFindMany.mockReset();
    reminderUpdate.mockReset().mockResolvedValue({});
    reminderUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    reminderFindUnique.mockReset().mockResolvedValue({ workerItemId: null });
    itemUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    itemUpdate.mockReset().mockResolvedValue({});
    itemFindMany.mockReset().mockResolvedValue([]);
    chatConversationFindUnique.mockReset().mockResolvedValue(null);
    chatMessageCreate.mockReset();
    loadComposeFacts.mockReset();
    composeScheduledOutbound.mockReset();
    sendWhatsAppButtons.mockReset();
    listReminderAttachments.mockReset().mockResolvedValue([]);
    listEmployeesForUser.mockReset().mockResolvedValue(employees());
    activateScheduledJob.mockReset().mockResolvedValue(false);
    continueJobAfterNudge.mockReset();
    fetchBusEtaWatch.mockReset();
    fetchFlightEtaWatch.mockReset();
    fetchFlightChangedWatch.mockReset();
  });

  it("fact compose null/empty with no fixedBody: no chat/WA send, sendStatus failed", async () => {
    reminderFindMany.mockResolvedValue([baseReminder()]);
    loadComposeFacts.mockResolvedValue({
      kind: "git_log",
      facts: "commit: feat",
      factsLabel: "COMMITS",
    });
    composeScheduledOutbound.mockResolvedValue(null);

    await expect(fireDueReminders(new Date("2026-10-28T08:01:00.000Z"))).resolves.toBe(
      1,
    );

    expect(chatMessageCreate).not.toHaveBeenCalled();
    expect(sendWhatsAppButtons).not.toHaveBeenCalled();
    expect(listReminderAttachments).not.toHaveBeenCalled();
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "clock-compose-1" },
      data: expect.objectContaining({
        status: "done",
        sendStatus: "failed",
        sentAt: null,
      }),
    });
    const bodies = reminderUpdate.mock.calls.map(
      (call: [{ data?: { sendStatus?: string } }]) => call[0]?.data,
    );
    expect(bodies.some((d) => d && "messageText" in d)).toBe(false);
  });

  it("facts-loading throw: no chat/WA send, sendStatus failed", async () => {
    reminderFindMany.mockResolvedValue([baseReminder()]);
    loadComposeFacts.mockRejectedValue(new Error("git unavailable"));

    await expect(fireDueReminders(new Date("2026-10-28T08:01:00.000Z"))).resolves.toBe(
      1,
    );

    expect(composeScheduledOutbound).not.toHaveBeenCalled();
    expect(chatMessageCreate).not.toHaveBeenCalled();
    expect(sendWhatsAppButtons).not.toHaveBeenCalled();
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "clock-compose-1" },
      data: expect.objectContaining({
        status: "done",
        sendStatus: "failed",
        sentAt: null,
      }),
    });
  });

  it("recurring fact compose fail advances the clock without sending the brief", async () => {
    const fired = new Date("2026-10-08T16:00:00.000Z"); // Thu 19:00 Jerusalem
    reminderFindMany.mockResolvedValue([
      baseReminder({
        fireAt: fired,
        repeat: "weekdays:2,4",
        recurrence: {
          freq: "weekly",
          interval: 1,
          weekdays: [2, 4],
          time: "19:00",
        },
        occurrencesFired: 0,
      }),
    ]);
    loadComposeFacts.mockResolvedValue({
      kind: "saved_data",
      facts: "tasks: []",
      factsLabel: "DATA",
    });
    composeScheduledOutbound.mockResolvedValue("");

    await fireDueReminders(new Date(fired.getTime() + 60_000));

    expect(chatMessageCreate).not.toHaveBeenCalled();
    expect(sendWhatsAppButtons).not.toHaveBeenCalled();
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "clock-compose-1" },
      data: {
        fireAt: new Date("2026-10-13T16:00:00.000Z"),
        sendStatus: "failed",
        sentAt: null,
        occurrencesFired: 1,
      },
    });
  });

describe("bus_eta poll failure honesty (fireDueReminders path)", () => {
  function busEtaReminder(overrides: Record<string, unknown> = {}) {
    return baseReminder({
      id: "clock-bus-eta-1",
      messageText: "התראה על אוטובוס — אל תשלח את זה",
      itemLabel: "יציאה לקו 5",
      composeAtFire: true,
      composeSource: "",
      composeCondition: {
        type: "bus_eta",
        origin: "תחנה",
        destination: "יעד",
        line: "5",
        minutes_before: 10,
      },
      watchOnce: false,
      recurrence: {
        freq: "interval",
        interval: 2,
        unit: "minutes",
      },
      repeat: "interval",
      lastReportSha: "",
      ...overrides,
    });
  }

  it("successful ETA within threshold: sends Google-estimate body (not SIRI)", async () => {
    reminderFindMany.mockResolvedValue([busEtaReminder()]);
    loadComposeFacts.mockResolvedValue({ kind: "", facts: "", eval: {} });
    composeScheduledOutbound.mockResolvedValue(null);
    fetchBusEtaWatch.mockResolvedValue({
      ok: true,
      minutes: 3,
      fingerprint: "5|08:10|3|iso",
      leaveByText: "08:10",
    });
    chatConversationFindUnique.mockResolvedValue({
      id: "conv-bus-1",
      openaiConversationId: "oai-bus-1",
    });
    chatMessageCreate.mockResolvedValue({
      id: "msg-1",
      speaker: "לוסי",
      text: "x",
      createdAt: new Date("2026-10-28T08:01:00.000Z"),
    });

    await fireDueReminders(new Date("2026-10-28T08:01:00.000Z"));

    expect(fetchBusEtaWatch).toHaveBeenCalled();
    expect(chatMessageCreate).toHaveBeenCalled();
    const createdText = String(
      chatMessageCreate.mock.calls[0]?.[0]?.data?.text ?? "",
    );
    expect(createdText).toMatch(/משוער בעוד כ־3 דקות/);
    expect(createdText).toMatch(/הערכת Google/);
    expect(createdText).not.toMatch(/מגיע בעוד/);
    expect(createdText).not.toContain("אל תשלח");
  });

  it("transient poll failure: quiet-skip, no user message, streak stamped", async () => {
    reminderFindMany.mockResolvedValue([
      busEtaReminder({ lastReportSha: "" }),
    ]);
    loadComposeFacts.mockResolvedValue({ kind: "", facts: "", eval: {} });
    fetchBusEtaWatch.mockResolvedValue({
      ok: false,
      minutes: null,
      fingerprint: "",
      leaveByText: "",
    });

    await fireDueReminders(new Date("2026-10-28T08:01:00.000Z"));

    expect(chatMessageCreate).not.toHaveBeenCalled();
    expect(sendWhatsAppButtons).not.toHaveBeenCalled();
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "clock-bus-eta-1" },
      data: { lastReportSha: "bus_eta:poll_fail:1" },
    });
  });

  it("transient then recovery: successful poll after fail streak clears path to ETA body", async () => {
    reminderFindMany.mockResolvedValue([
      busEtaReminder({ lastReportSha: "bus_eta:poll_fail:2" }),
    ]);
    loadComposeFacts.mockResolvedValue({ kind: "", facts: "", eval: {} });
    composeScheduledOutbound.mockResolvedValue(null);
    fetchBusEtaWatch.mockResolvedValue({
      ok: true,
      minutes: 4,
      fingerprint: "5|08:12|4|iso",
      leaveByText: "08:12",
    });
    chatConversationFindUnique.mockResolvedValue({
      id: "conv-bus-1",
      openaiConversationId: "oai-bus-1",
    });
    chatMessageCreate.mockResolvedValue({
      id: "msg-2",
      speaker: "לוסי",
      text: "x",
      createdAt: new Date("2026-10-28T08:05:00.000Z"),
    });

    await fireDueReminders(new Date("2026-10-28T08:05:00.000Z"));

    const createdText = String(
      chatMessageCreate.mock.calls[0]?.[0]?.data?.text ?? "",
    );
    expect(createdText).toMatch(/משוער בעוד כ־4 דקות/);
    expect(createdText).not.toMatch(/לא הצלחתי לעדכן/);
  });

  it("persistent poll failures: one honesty notify, no invented ETA", async () => {
    reminderFindMany.mockResolvedValue([
      busEtaReminder({ lastReportSha: "bus_eta:poll_fail:2" }),
    ]);
    loadComposeFacts.mockResolvedValue({ kind: "", facts: "", eval: {} });
    composeScheduledOutbound.mockResolvedValue("should not win");
    fetchBusEtaWatch.mockResolvedValue({
      ok: false,
      minutes: null,
      fingerprint: "",
      leaveByText: "",
    });
    chatConversationFindUnique.mockResolvedValue({
      id: "conv-bus-1",
      openaiConversationId: "oai-bus-1",
    });
    chatMessageCreate.mockResolvedValue({
      id: "msg-3",
      speaker: "לוסי",
      text: "x",
      createdAt: new Date("2026-10-28T08:09:00.000Z"),
    });

    await fireDueReminders(new Date("2026-10-28T08:09:00.000Z"));

    expect(chatMessageCreate).toHaveBeenCalled();
    const createdText = String(
      chatMessageCreate.mock.calls[0]?.[0]?.data?.text ?? "",
    );
    expect(createdText).toMatch(/לא הצלחתי לעדכן/);
    expect(createdText).toMatch(/גוגל|Google/i);
    expect(createdText).not.toMatch(/משוער בעוד כ־\d+/);
    expect(createdText).not.toContain("should not win");
    expect(createdText).not.toContain("אל תשלח");
    const shaWrites = reminderUpdate.mock.calls
      .map((call: [{ data?: { lastReportSha?: string } }]) => call[0]?.data?.lastReportSha)
      .filter(Boolean);
    expect(shaWrites.some((s: string) => String(s).startsWith("bus_eta:poll_fail_notified"))).toBe(
      true,
    );
  });

  it("after honesty notify, further poll failures stay quiet", async () => {
    reminderFindMany.mockResolvedValue([
      busEtaReminder({
        lastReportSha: "bus_eta:poll_fail_notified:2026-10-28T08:09:00.000Z",
      }),
    ]);
    loadComposeFacts.mockResolvedValue({ kind: "", facts: "", eval: {} });
    fetchBusEtaWatch.mockResolvedValue({
      ok: false,
      minutes: null,
      fingerprint: "",
      leaveByText: "",
    });

    await fireDueReminders(new Date("2026-10-28T08:11:00.000Z"));

    expect(chatMessageCreate).not.toHaveBeenCalled();
  });

  it("usable poll with ETA above threshold: quiet-skip (not a poll failure)", async () => {
    reminderFindMany.mockResolvedValue([busEtaReminder()]);
    loadComposeFacts.mockResolvedValue({ kind: "", facts: "", eval: {} });
    fetchBusEtaWatch.mockResolvedValue({
      ok: true,
      minutes: 25,
      fingerprint: "5|08:40|25|iso",
      leaveByText: "08:40",
    });

    await fireDueReminders(new Date("2026-10-28T08:01:00.000Z"));

    expect(chatMessageCreate).not.toHaveBeenCalled();
    const shaWrites = reminderUpdate.mock.calls
      .map((call: [{ data?: { lastReportSha?: string } }]) => call[0]?.data?.lastReportSha)
      .filter(Boolean);
    expect(shaWrites.some((s: string) => String(s).startsWith("bus_eta:poll_fail"))).toBe(
      false,
    );
  });
});
});

describe("bus/flight condition-default must not regress to the brief", () => {
  it("when compose fails, preferConditionDefault uses ETA body not the brief", () => {
    const brief = "התראה על אוטובוס — אל תשלח את זה";
    const resolved = resolveComposeFireOutbound({
      brief,
      itemLabel: "יציאה",
      composed: null,
      kind: "routes",
    });
    expect(resolved.outcome).toBe("fail");

    // Mirror reminder-fire bus_eta honesty (Google estimate, not SIRI live).
    const conditionDefaultBody =
      "קו 5 משוער בעוד כ־3 דקות מ«תחנה» לכיוון «יעד» (הערכת Google, לא תחזית SIRI חיה) — זמן לצאת.";
    const preferConditionDefault =
      Boolean(conditionDefaultBody) &&
      (!resolved.body.trim() ||
        resolved.body.trim() === brief.trim() ||
        resolved.outcome === "fail");
    const outboundBody =
      preferConditionDefault && conditionDefaultBody
        ? conditionDefaultBody
        : resolved.outcome === "fail"
          ? brief
          : resolved.body;

    expect(preferConditionDefault).toBe(true);
    expect(outboundBody).toBe(conditionDefaultBody);
    expect(outboundBody).not.toContain("אל תשלח");
    expect(outboundBody).toContain("הערכת Google");
    expect(outboundBody).not.toMatch(/מגיע בעוד/);
  });
});
