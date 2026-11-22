/**
 * Wave 1 Stage 2 — ProspectWriteGate, join commands, circuit breaker, asker cancel, dev tools.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  userFindUnique,
  userUpdateMany,
  messageCount,
  inviteFindMany,
  inviteUpdateMany,
  pendingCreate,
  pendingFindFirst,
  pendingUpdateMany,
  pendingProspectDeleteMany,
  employeeFindFirst,
  employeeFindMany,
  employeeUpdate,
  employeeUpdateMany,
  employeeDeleteMany,
  userDelete,
  auditCreate,
  auditDeleteMany,
  reminderDeleteMany,
  deliveryAttemptDeleteMany,
  pendingHighRiskDeleteMany,
  whatsAppInviteDeleteMany,
  chatMessageDeleteMany,
  chatConversationDeleteMany,
  contactDeleteMany,
  contactBookDeleteMany,
  missionDeleteMany,
  tipProgressDeleteMany,
  tipDeleteMany,
  employeeFilingDeleteMany,
  employeeListDeleteMany,
  attachmentDeleteMany,
  secretVaultDeleteMany,
  whatsAppInboundDeleteMany,
} = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdateMany: vi.fn(),
  messageCount: vi.fn(),
  inviteFindMany: vi.fn(),
  inviteUpdateMany: vi.fn(),
  pendingCreate: vi.fn(),
  pendingFindFirst: vi.fn(),
  pendingUpdateMany: vi.fn(),
  pendingProspectDeleteMany: vi.fn(),
  employeeFindFirst: vi.fn(),
  employeeFindMany: vi.fn(),
  employeeUpdate: vi.fn(),
  employeeUpdateMany: vi.fn(),
  employeeDeleteMany: vi.fn(),
  userDelete: vi.fn(),
  auditCreate: vi.fn(),
  auditDeleteMany: vi.fn(),
  reminderDeleteMany: vi.fn(),
  deliveryAttemptDeleteMany: vi.fn(),
  pendingHighRiskDeleteMany: vi.fn(),
  whatsAppInviteDeleteMany: vi.fn(),
  chatMessageDeleteMany: vi.fn(),
  chatConversationDeleteMany: vi.fn(),
  contactDeleteMany: vi.fn(),
  contactBookDeleteMany: vi.fn(),
  missionDeleteMany: vi.fn(),
  tipProgressDeleteMany: vi.fn(),
  tipDeleteMany: vi.fn(),
  employeeFilingDeleteMany: vi.fn(),
  employeeListDeleteMany: vi.fn(),
  attachmentDeleteMany: vi.fn(),
  secretVaultDeleteMany: vi.fn(),
  whatsAppInboundDeleteMany: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
      updateMany: userUpdateMany,
      delete: userDelete,
    },
    chatMessage: { count: messageCount, deleteMany: chatMessageDeleteMany },
    chatConversation: { deleteMany: chatConversationDeleteMany },
    whatsAppInvite: {
      findMany: inviteFindMany,
      updateMany: inviteUpdateMany,
      deleteMany: whatsAppInviteDeleteMany,
    },
    pendingProspectAction: {
      create: pendingCreate,
      findFirst: pendingFindFirst,
      updateMany: pendingUpdateMany,
      deleteMany: pendingProspectDeleteMany,
    },
    employee: {
      findFirst: employeeFindFirst,
      findMany: employeeFindMany,
      update: employeeUpdate,
      updateMany: employeeUpdateMany,
      deleteMany: employeeDeleteMany,
    },
    auditEvent: { create: auditCreate, deleteMany: auditDeleteMany },
    reminder: { deleteMany: reminderDeleteMany },
    deliveryAttempt: { deleteMany: deliveryAttemptDeleteMany },
    pendingHighRiskConfirm: { deleteMany: pendingHighRiskDeleteMany },
    contact: { deleteMany: contactDeleteMany },
    contactBook: { deleteMany: contactBookDeleteMany },
    mission: { deleteMany: missionDeleteMany },
    tipProgress: { deleteMany: tipProgressDeleteMany },
    tip: { deleteMany: tipDeleteMany },
    employeeFiling: { deleteMany: employeeFilingDeleteMany },
    employeeList: { deleteMany: employeeListDeleteMany },
    attachment: { deleteMany: attachmentDeleteMany },
    secretVault: { deleteMany: secretVaultDeleteMany },
    whatsAppInbound: {
      deleteMany: whatsAppInboundDeleteMany,
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

const getEnvMock = vi.hoisted(() =>
  vi.fn(() => ({
    NODE_ENV: "development",
    DEV_TEST_PHONES: "972501111111",
    PROSPECT_MAX_INBOUND_MESSAGES: 15,
  })),
);
const isProductionMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("../src/config/env.js", () => ({
  getEnv: (...args: unknown[]) => getEnvMock(...args),
  isProduction: (...args: unknown[]) => isProductionMock(...args),
}));

vi.mock("../src/services/whatsapp-worker-sticky.js", () => ({
  clearWhatsAppWorkerSticky: vi.fn(),
}));

const confirmCollabInvite = vi.fn();
const findPendingCollabInvites = vi.fn();
const applyReminders = vi.fn();
const listEmployeesForUser = vi.fn();

vi.mock("../src/services/collab-invite.service.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/services/collab-invite.service.js")
  >();
  return {
    ...actual,
    confirmCollabInvite: (...args: unknown[]) => confirmCollabInvite(...args),
  };
});

vi.mock("../src/services/whatsapp-invite.service.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/services/whatsapp-invite.service.js")
  >();
  return {
    ...actual,
    findPendingCollabInvites: (...args: unknown[]) =>
      findPendingCollabInvites(...args),
  };
});

vi.mock("../src/services/reminder.service.js", () => ({
  applyReminders: (...args: unknown[]) => applyReminders(...args),
}));

vi.mock("../src/services/employee.service.js", () => ({
  listEmployeesForUser: (...args: unknown[]) => listEmployeesForUser(...args),
}));

vi.mock("../src/services/employee-records.service.js", () => ({
  applyEmployeeRecords: vi.fn(),
}));

vi.mock("../src/services/list-ops.service.js", () => ({
  applyListOps: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/services/contact.service.js", () => ({
  applyDirectoryActions: vi.fn(),
}));

vi.mock("../src/services/employee-targets.service.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/services/employee-targets.service.js")
  >();
  return {
    ...actual,
    planTargetedActions: () => ({ applications: [], relays: [] }),
  };
});

import { emptyLlmMetadata } from "@workee/shared";
import {
  applyProspectWriteGate,
  freeTextLooksLikeJoinConsent,
  formatProspectJoinOfferText,
  prospectJoinButtonLabel,
} from "../src/services/prospect-write-gate.js";
import {
  isExplicitJoinAcceptCommand,
  parseExplicitJoinPendingId,
  EXPLICIT_JOIN_ACCEPT_PREFIX,
} from "../src/services/pending-prospect-action.service.js";
import { acceptExplicitJoin } from "../src/services/consent-stage.service.js";
import { handleExplicitJoinAccept } from "../src/services/explicit-join.service.js";
import { prospectCircuitBreakerExceeded } from "../src/services/prospect-circuit-breaker.service.js";
import {
  messageLooksLikeAskerInviteCancel,
  tryCancelAskerPendingInvite,
} from "../src/services/asker-invite-cancel.service.js";
import {
  handleDevProspectTool,
  isDevTestPhoneAllowed,
  PHONE_BACKUP_SUFFIX,
} from "../src/services/prospect-dev-tools.service.js";

describe("ProspectWriteGate", () => {
  it("blocks durable writes and strips metadata", () => {
    const gated = applyProspectWriteGate({
      ...emptyLlmMetadata(),
      reminders: [{ action: "create", item: "לקחת תיק", when: "מחר 9:00" }],
    } as never);
    expect(gated.blocked).toBe(true);
    expect(gated.actionKind).toBe("reminder");
    expect(gated.metadata.reminders ?? []).toEqual([]);
    expect(gated.snapshot).toBeTruthy();
  });

  it("does not block chat-only turns", () => {
    const gated = applyProspectWriteGate(emptyLlmMetadata());
    expect(gated.blocked).toBe(false);
  });

  it("F28: blocks outbound messages and excludes them from join snapshot", () => {
    const gated = applyProspectWriteGate({
      ...emptyLlmMetadata(),
      messages: [{ targets: ["עמית"], text: "היי מה קורה" }],
    } as never);
    expect(gated.blocked).toBe(true);
    expect(gated.actionKind).toBe("message");
    expect(gated.metadata.messages ?? []).toEqual([]);
    const snap = gated.snapshot as { metadata?: { messages?: unknown[] } } | null;
    expect(snap?.metadata?.messages ?? []).toEqual([]);
  });

  it("formats join CTA without claiming saved", () => {
    const text = formatProspectJoinOfferText({
      actionKind: "reminder",
      summaryText: "לקחת תיק",
    });
    expect(text).toContain("בשמחה");
    expect(text).not.toMatch(/שמרתי|נשמר|בוצע/);
    expect(prospectJoinButtonLabel("reminder")).toBe("כן, תשמרי לי");
    expect(prospectJoinButtonLabel("assign_accept")).toBe("אישור והצטרפות");
  });

  it("free-text consent phrases are detected but must never join alone", () => {
    expect(freeTextLooksLikeJoinConsent("כן")).toBe(true);
    expect(freeTextLooksLikeJoinConsent("תאשרי")).toBe(true);
    expect(freeTextLooksLikeJoinConsent("תרשמי אותי")).toBe(true);
    expect(freeTextLooksLikeJoinConsent("מה השעה")).toBe(false);
    expect(isExplicitJoinAcceptCommand("כן")).toBe(false);
    expect(isExplicitJoinAcceptCommand(`${EXPLICIT_JOIN_ACCEPT_PREFIX}:abc`)).toBe(
      true,
    );
    expect(parseExplicitJoinPendingId(`${EXPLICIT_JOIN_ACCEPT_PREFIX}:abc`)).toBe(
      "abc",
    );
  });
});

describe("Explicit Join consent flip", () => {
  beforeEach(() => {
    userFindUnique.mockReset();
    userUpdateMany.mockReset();
    auditCreate.mockReset().mockResolvedValue({});
    pendingFindFirst.mockReset();
    pendingUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    confirmCollabInvite.mockReset();
    findPendingCollabInvites.mockReset().mockResolvedValue([]);
    applyReminders.mockReset().mockResolvedValue({ created: [], removed: [] });
    listEmployeesForUser.mockReset().mockResolvedValue([
      {
        id: "e1",
        userId: "u1",
        kind: "human",
        name: "טסט",
        surname: "",
        nickname: null,
        phone: "972501111111",
        email: null,
        isOwner: true,
      },
    ]);
  });

  it("flips consentPending false with audit", async () => {
    userFindUnique.mockResolvedValue({ consentPending: true });
    userUpdateMany.mockResolvedValue({ count: 1 });
    await expect(
      acceptExplicitJoin({ userId: "u1", actorEmployeeId: "e1" }),
    ).resolves.toBe("joined");
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: { id: "u1", consentPending: true },
      data: {
        consentPending: false,
        consentAcceptedAt: expect.any(Date),
      },
    });
  });

  it("does not join when already Member", async () => {
    userFindUnique.mockResolvedValue({ consentPending: false });
    await expect(acceptExplicitJoin({ userId: "u1" })).resolves.toBe(
      "already_member",
    );
    expect(userUpdateMany).not.toHaveBeenCalled();
  });

  it("executes pendingAction reminder after join", async () => {
    userFindUnique.mockResolvedValue({ consentPending: true });
    userUpdateMany.mockResolvedValue({ count: 1 });
    pendingFindFirst.mockResolvedValue({
      id: "p1",
      actionKind: "reminder",
      snapshot: {
        metadata: {
          reminders: [
            {
              action: "add",
              item: "לקחת תיק",
              listType: "tasks",
              date: "",
              time: "09:00",
              repeat: "once",
              ping: [],
              targets: [],
              text: "",
              inSeconds: null,
              everyCount: null,
              everyUnit: null,
              weekdays: null,
              confirmed: true,
              compose: false,
              composeSource: "",
              composeLookbackHours: 0,
              composePlace: "",
              reminderId: "",
            },
          ],
        },
      },
      summaryText: "לקחת תיק",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const out = await handleExplicitJoinAccept({
      userId: "u1",
      employeeId: "e1",
      digitalEmployeeId: "d1",
      joinCommand: `${EXPLICIT_JOIN_ACCEPT_PREFIX}:p1`,
      recipientPhone: "972501111111",
    });
    expect(out.ok).toBe(true);
    expect(out.joined).toBe(true);
    expect(out.spoken).toMatch(/בוצע|שמרתי/);
    expect(applyReminders).toHaveBeenCalled();
    expect(confirmCollabInvite).not.toHaveBeenCalled();
  });

  it("connects Share invites but never auto-accepts Assign", async () => {
    userFindUnique.mockResolvedValue({ consentPending: true });
    userUpdateMany.mockResolvedValue({ count: 1 });
    pendingFindFirst.mockResolvedValue({
      id: "p-assign",
      actionKind: "assign_accept",
      snapshot: { v: 1, type: "assign_accept", inviteId: "inv-assign" },
      summaryText: "אחריות",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const shareRowId = "11111111-1111-4111-8111-111111111111";
    const assignRowId = "22222222-2222-4222-8222-222222222222";
    const listAction = {
      action: "add",
      listType: "shopping",
      items: [{ item: "חלב" }],
    };
    findPendingCollabInvites.mockResolvedValue([
      {
        id: "inv-share",
        payload: {
          v: 2,
          kind: "share",
          domain: "list",
          rowId: shareRowId,
          action: listAction,
          askSummary: "חלב",
        },
        status: "pending",
      },
      {
        id: "inv-assign",
        payload: {
          v: 2,
          kind: "assign",
          domain: "list",
          rowId: assignRowId,
          action: listAction,
          askSummary: "קניות",
        },
        status: "pending",
      },
    ]);
    confirmCollabInvite.mockResolvedValue("consumed");
    const out = await handleExplicitJoinAccept({
      userId: "u1",
      employeeId: "e1",
      digitalEmployeeId: "d1",
      joinCommand: `${EXPLICIT_JOIN_ACCEPT_PREFIX}:p-assign`,
      recipientPhone: "972501111111",
    });
    expect(out.ok).toBe(true);
    expect(out.rePresentAssignInviteId).toBe("inv-assign");
    expect(out.spoken).toMatch(/אשר|דחו|הצטרפת/);
    // Only Share rows are confirmed; Assign must not be silently accepted.
    expect(confirmCollabInvite).toHaveBeenCalledTimes(1);
    expect(confirmCollabInvite.mock.calls[0]![0]).toMatchObject({
      inviteId: "inv-share",
      recipientIsProspect: false,
    });
  });

  it("F30: Join replay does not treat Join as Class V — foreign remind is not applied", async () => {
    userFindUnique.mockResolvedValue({ consentPending: true });
    userUpdateMany.mockResolvedValue({ count: 1 });
    pendingFindFirst.mockResolvedValue({
      id: "p-foreign",
      actionKind: "reminder",
      snapshot: {
        metadata: {
          reminders: [
            {
              action: "add",
              item: "תזכיר לעמית",
              listType: "tasks",
              date: "",
              time: "10:00",
              repeat: "once",
              ping: ["עמית"],
              targets: [],
              text: "היי",
              inSeconds: null,
              everyCount: null,
              everyUnit: null,
              weekdays: null,
              confirmed: true,
              compose: false,
              composeSource: "",
              composeLookbackHours: 0,
              composePlace: "",
              reminderId: "",
            },
          ],
        },
      },
      summaryText: "תזכיר לעמית",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const out = await handleExplicitJoinAccept({
      userId: "u1",
      employeeId: "e1",
      digitalEmployeeId: "d1",
      joinCommand: `${EXPLICIT_JOIN_ACCEPT_PREFIX}:p-foreign`,
      recipientPhone: "972501111111",
    });
    expect(out.ok).toBe(true);
    expect(out.joined).toBe(true);
    expect(applyReminders).not.toHaveBeenCalled();
    expect(out.spoken).not.toMatch(/שמרתי/);
    expect(out.spoken).toMatch(/הצטרפת|אישור נוסף|נסחו/);
  });

  it("F30: Join still replays personal self-reminder after Gate", async () => {
    applyReminders.mockClear();
    userFindUnique.mockResolvedValue({ consentPending: true });
    userUpdateMany.mockResolvedValue({ count: 1 });
    pendingFindFirst.mockResolvedValue({
      id: "p-self",
      actionKind: "reminder",
      snapshot: {
        metadata: {
          reminders: [
            {
              action: "add",
              item: "לקחת תיק",
              listType: "tasks",
              date: "",
              time: "09:00",
              repeat: "once",
              ping: [],
              targets: [],
              text: "",
              inSeconds: null,
              everyCount: null,
              everyUnit: null,
              weekdays: null,
              confirmed: true,
              compose: false,
              composeSource: "",
              composeLookbackHours: 0,
              composePlace: "",
              reminderId: "",
            },
          ],
        },
      },
      summaryText: "לקחת תיק",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const out = await handleExplicitJoinAccept({
      userId: "u1",
      employeeId: "e1",
      digitalEmployeeId: "d1",
      joinCommand: `${EXPLICIT_JOIN_ACCEPT_PREFIX}:p-self`,
      recipientPhone: "972501111111",
    });
    expect(out.ok).toBe(true);
    expect(out.joined).toBe(true);
    expect(applyReminders).toHaveBeenCalled();
    expect(out.spoken).toMatch(/בוצע|שמרתי/);
  });
});

describe("Prospect circuit breaker", () => {
  it("trips at inbound threshold", async () => {
    messageCount.mockResolvedValue(15);
    await expect(prospectCircuitBreakerExceeded("u1")).resolves.toBe(true);
    messageCount.mockResolvedValue(3);
    await expect(prospectCircuitBreakerExceeded("u1")).resolves.toBe(false);
  });
});

describe("Asker invite cancel NL", () => {
  beforeEach(() => {
    inviteFindMany.mockReset();
    inviteUpdateMany.mockReset();
    auditCreate.mockReset().mockResolvedValue({});
  });

  it("detects cancel phrasing and cancels asker-owned pending invite", async () => {
    expect(messageLooksLikeAskerInviteCancel("תבטלי את השיתוף ששלחתי לאבא")).toBe(
      true,
    );
    inviteFindMany.mockResolvedValue([
      {
        id: "inv-1",
        token: "WRK-INV-X",
        userId: "u1",
        askerEmployeeId: "a1",
        digitalEmployeeId: "d1",
        recipientPhone: "972502222222",
        recipientLabel: "אבא",
        askSummary: "חלב",
        draftText: "d",
        status: "pending",
        guestEmployeeId: null,
        payload: { v: 2 },
        createdAt: new Date(),
      },
    ]);
    inviteUpdateMany.mockResolvedValue({ count: 1 });
    const out = await tryCancelAskerPendingInvite({
      userId: "u1",
      askerEmployeeId: "a1",
      message: "תבטלי את השיתוף ששלחתי לאבא",
    });
    expect(out.cancelled).toBe(true);
    expect(out.notice).toContain("אבא");
    expect(inviteUpdateMany).toHaveBeenCalled();
  });
});

describe("Dev /as-prospect, /reset-me, /reset-cold", () => {
  beforeEach(() => {
    employeeFindFirst.mockReset();
    employeeFindMany.mockReset();
    employeeUpdate.mockReset();
    employeeUpdateMany.mockReset();
    employeeDeleteMany.mockReset();
    userDelete.mockReset();
    reminderDeleteMany.mockReset();
    pendingProspectDeleteMany.mockReset();
    deliveryAttemptDeleteMany.mockReset();
    pendingHighRiskDeleteMany.mockReset();
    whatsAppInviteDeleteMany.mockReset();
    chatMessageDeleteMany.mockReset();
    chatConversationDeleteMany.mockReset();
    contactDeleteMany.mockReset();
    contactBookDeleteMany.mockReset();
    missionDeleteMany.mockReset();
    tipProgressDeleteMany.mockReset();
    tipDeleteMany.mockReset();
    employeeFilingDeleteMany.mockReset();
    employeeListDeleteMany.mockReset();
    attachmentDeleteMany.mockReset();
    secretVaultDeleteMany.mockReset();
    auditDeleteMany.mockReset();
    whatsAppInboundDeleteMany.mockReset();
    whatsAppInboundDeleteMany.mockResolvedValue({ count: 1 });
    employeeFindMany.mockResolvedValue([{ id: "e-temp" }]);
    for (const fn of [
      reminderDeleteMany,
      pendingProspectDeleteMany,
      deliveryAttemptDeleteMany,
      pendingHighRiskDeleteMany,
      whatsAppInviteDeleteMany,
      chatMessageDeleteMany,
      chatConversationDeleteMany,
      contactDeleteMany,
      contactBookDeleteMany,
      missionDeleteMany,
      tipProgressDeleteMany,
      tipDeleteMany,
      employeeFilingDeleteMany,
      employeeListDeleteMany,
      attachmentDeleteMany,
      secretVaultDeleteMany,
      auditDeleteMany,
      employeeUpdateMany,
      employeeDeleteMany,
      userDelete,
    ]) {
      fn.mockResolvedValue({ count: 1 });
    }
  });

  it("allows only DEV_TEST_PHONES outside production", () => {
    expect(isDevTestPhoneAllowed("972501111111")).toBe(true);
    expect(isDevTestPhoneAllowed("972509999999")).toBe(false);
  });

  it("renames phone to _backup on /as-prospect", async () => {
    employeeFindFirst
      .mockResolvedValueOnce({
        id: "e1",
        userId: "u1",
        phone: "972501111111",
      })
      .mockResolvedValueOnce(null); // no backup conflict
    employeeUpdate.mockResolvedValue({});
    const out = await handleDevProspectTool({
      phone: "972501111111",
      text: "/as-prospect",
    });
    expect(out.handled).toBe(true);
    expect(out.reply).toContain(PHONE_BACKUP_SUFFIX);
    expect(employeeUpdate).toHaveBeenCalledWith({
      where: { id: "e1" },
      data: { phone: `972501111111${PHONE_BACKUP_SUFFIX}` },
    });
  });

  it("ignores /as-prospect for non-allowlisted phones", async () => {
    const out = await handleDevProspectTool({
      phone: "972509999999",
      text: "/as-prospect",
    });
    expect(out.handled).toBe(false);
  });

  it("clears WhatsApp 24h inbound window on /reset-cold", async () => {
    const out = await handleDevProspectTool({
      phone: "972501111111",
      text: "/reset-cold",
    });
    expect(out.handled).toBe(true);
    expect(out.reply).toMatch(/reset-cold/i);
    expect(out.reply).toMatch(/Cold|חלון 24/i);
    expect(whatsAppInboundDeleteMany).toHaveBeenCalled();
  });

  it("clears WhatsApp 24h inbound window on /restore-me after phone restore", async () => {
    employeeFindFirst
      .mockResolvedValueOnce({
        id: "e-bak",
        userId: "u-bak",
        phone: `972501111111${PHONE_BACKUP_SUFFIX}`,
      })
      .mockResolvedValueOnce(null); // no temp prospect on digits
    employeeUpdate.mockResolvedValue({});
    const out = await handleDevProspectTool({
      phone: "972501111111",
      text: "/restore-me",
    });
    expect(out.handled).toBe(true);
    expect(out.reply).toContain("972501111111");
    expect(out.reply).toMatch(/ללא מחיקת נתונים|שוחזר/i);
    expect(out.reply).toMatch(/חלון 24|Cold/i);
    expect(whatsAppInboundDeleteMany).toHaveBeenCalled();
    expect(employeeDeleteMany).not.toHaveBeenCalled();
    expect(reminderDeleteMany).not.toHaveBeenCalled();
  });

  it("restore-me / reset-me unlink temp Prospect phone without deleting rows", async () => {
    employeeFindFirst
      .mockResolvedValueOnce({
        id: "e-bak",
        userId: "u-bak",
        phone: `972501111111${PHONE_BACKUP_SUFFIX}`,
      })
      .mockResolvedValueOnce({
        id: "e-temp",
        userId: "u-temp",
        phone: "972501111111",
      });
    employeeUpdate.mockResolvedValue({});

    const out = await handleDevProspectTool({
      phone: "972501111111",
      text: "/reset-me",
    });

    expect(out.handled).toBe(true);
    expect(out.reply).toMatch(/שוחזר|restore-me/i);
    expect(out.reply).toMatch(/ללא מחיקת נתונים/);
    expect(out.reply).not.toMatch(/נכשל/);
    // Temp holder is unlinked (phone null) — never deleted.
    expect(employeeUpdate).toHaveBeenCalledWith({
      where: { id: "e-temp" },
      data: { phone: null },
    });
    expect(employeeUpdate).toHaveBeenCalledWith({
      where: { id: "e-bak" },
      data: { phone: "972501111111" },
    });
    expect(employeeDeleteMany).not.toHaveBeenCalled();
    expect(reminderDeleteMany).not.toHaveBeenCalled();
    expect(employeeListDeleteMany).not.toHaveBeenCalled();
    expect(userDelete).not.toHaveBeenCalled();
    expect(whatsAppInboundDeleteMany).toHaveBeenCalled();
  });

  it("ignores /as-prospect, /restore-me, /reset-me, and /reset-cold in production", async () => {
    isProductionMock.mockReturnValue(true);
    getEnvMock.mockReturnValue({
      NODE_ENV: "production",
      DEV_TEST_PHONES: "972501111111",
      PROSPECT_MAX_INBOUND_MESSAGES: 15,
    });
    try {
      expect(isDevTestPhoneAllowed("972501111111")).toBe(false);
      await expect(
        handleDevProspectTool({ phone: "972501111111", text: "/as-prospect" }),
      ).resolves.toEqual({ handled: false, reply: "" });
      await expect(
        handleDevProspectTool({ phone: "972501111111", text: "/restore-me" }),
      ).resolves.toEqual({ handled: false, reply: "" });
      await expect(
        handleDevProspectTool({ phone: "972501111111", text: "/reset-me" }),
      ).resolves.toEqual({ handled: false, reply: "" });
      await expect(
        handleDevProspectTool({ phone: "972501111111", text: "/reset-cold" }),
      ).resolves.toEqual({ handled: false, reply: "" });
    } finally {
      isProductionMock.mockReturnValue(false);
      getEnvMock.mockReturnValue({
        NODE_ENV: "development",
        DEV_TEST_PHONES: "972501111111",
        PROSPECT_MAX_INBOUND_MESSAGES: 15,
      });
    }
  });
});
