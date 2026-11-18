import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  inviteCreate,
  inviteFindFirst,
  inviteUpdate,
  employeeFindUnique,
  employeeUpdate,
} = vi.hoisted(() => ({
  inviteCreate: vi.fn(),
  inviteFindFirst: vi.fn(),
  inviteUpdate: vi.fn(),
  employeeFindUnique: vi.fn(),
  employeeUpdate: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    whatsAppInvite: {
      create: inviteCreate,
      findFirst: inviteFindFirst,
      update: inviteUpdate,
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    employee: {
      findUnique: employeeFindUnique,
      update: employeeUpdate,
    },
  },
}));

const envState = vi.hoisted(() => ({
  displayPhone: "972501111111" as string | undefined,
}));

vi.mock("../src/config/env.js", () => ({
  getEnv: () => ({
    WHATSAPP_DISPLAY_PHONE: envState.displayPhone,
    NODE_ENV: "test",
  }),
}));

import {
  bindInboundToInvite,
  buildFatherInviteDraft,
  buildWhatsAppBareUrl,
  buildWhatsAppComposeUrl,
  createWhatsAppInvite,
  formatColdInviteNotice,
  formatInviteDraftSummary,
  formatInviteOpeningContext,
  formatPendingInviteContext,
  parseInviteToken,
  saveContactReplyButton,
  INVITE_TOKEN_PREFIX,
  SAVE_CONTACT_BUTTON_LABEL,
} from "../src/services/whatsapp-invite.service.js";

describe("whatsapp invite helpers", () => {
  beforeEach(() => {
    envState.displayPhone = "972501111111";
    inviteCreate.mockReset();
    inviteFindFirst.mockReset();
    inviteUpdate.mockReset();
    employeeFindUnique.mockReset();
    employeeUpdate.mockReset();
  });

  it("parses WRK-INV tokens from inbound text", () => {
    expect(parseInviteToken("hello WRK-INV-ABCDEF12 world")).toBe(
      `${INVITE_TOKEN_PREFIX}ABCDEF12`,
    );
    expect(parseInviteToken("no token here")).toBeNull();
  });

  it("builds Lucy wa.me with contextual Guest ?text= prefill and real item title", () => {
    const compose = buildWhatsAppComposeUrl("972549595333", "היי אבא");
    expect(compose).toMatch(/^https:\/\/wa\.me\/972549595333\?text=/);

    const bare = buildWhatsAppBareUrl("972501111111");
    expect(bare).toBe("https://wa.me/972501111111");
    expect(bare).not.toContain("?");

    const { draftText, businessUrl } = buildFatherInviteDraft({
      askerName: "מיכל",
      askSummary: "להביא לחם דגנים",
      token: `${INVITE_TOKEN_PREFIX}ABCD1234`,
      intentKind: "assign",
    });
    expect(draftText).toContain("היי, כאן לוסי");
    expect(draftText).toContain("מיכל");
    expect(draftText).toContain("להביא לחם דגנים");
    expect(draftText).toMatch(/הוקצתה לך משימה ממיכל בלוסי:/);
    expect(draftText).not.toContain("לעדכן אותי");
    expect(draftText).not.toContain("Workee");
    expect(draftText).not.toContain("ביקש");
    expect(draftText).not.toContain("מבקש");
    expect(businessUrl).toMatch(/^https:\/\/wa\.me\/972501111111\?text=/);
    expect(draftText).toContain(businessUrl!);
    const openText = decodeURIComponent(
      businessUrl!.split("?text=")[1] ?? "",
    );
    expect(openText).toBe(
      "היי לוסי, נכנסתי לראות את המשימה «להביא לחם דגנים» ממיכל",
    );
    expect(formatInviteDraftSummary({
      askSummary: "להביא לחם דגנים",
      intentKind: "assign",
    })).toBe("משימה: להביא לחם דגנים");
  });

  it("formats cold invite notice without Meta jargon", () => {
    const notice = formatColdInviteNotice({
      recipientLabel: "טל",
      draftText: "טיוטה",
      intentKind: "assign",
      coldProspect: true,
    });
    expect(notice).toContain("טל");
    expect(notice).toContain("ממתין");
    expect(notice).toContain("שלח בוואטסאפ");
    expect(notice).toContain("«טיוטה»");
    expect(notice).not.toContain("אין חלון 24");
    expect(notice).not.toContain("מהעסק");
    expect(notice).not.toContain("Workee");
  });

  it("creates an invite row and compose URL", async () => {
    inviteCreate.mockResolvedValue({
      id: "inv-1",
      token: `${INVITE_TOKEN_PREFIX}TESTTOKEN1`,
      userId: "user-1",
      askerEmployeeId: "asker-1",
      digitalEmployeeId: "dig-1",
      recipientPhone: "972549595333",
      recipientLabel: "אבא",
      askSummary: "מתי אתה מגיע",
      draftText: "draft",
      status: "pending",
      guestEmployeeId: null,
      createdAt: new Date("2026-11-18T09:00:00.000Z"),
    });

    const created = await createWhatsAppInvite({
      userId: "user-1",
      askerEmployeeId: "asker-1",
      digitalEmployeeId: "dig-1",
      askerName: "עמית",
      recipientPhone: "972549595333",
      recipientLabel: "אבא",
      askSummary: "מתי אתה מגיע",
    });

    expect(created).not.toBeNull();
    expect(created!.composeUrl).toMatch(/^https:\/\/wa\.me\/972549595333/);
    expect(created!.notice).toContain("אבא");
    expect(inviteCreate).toHaveBeenCalledOnce();
  });

  it("binds an invite without moving the speaker onto the asker account", async () => {
    inviteFindFirst.mockResolvedValue({
      id: "inv-1",
      token: `${INVITE_TOKEN_PREFIX}TESTTOKEN1`,
      userId: "asker-user",
      askerEmployeeId: "asker-emp",
      digitalEmployeeId: "dig-1",
      recipientPhone: "972549595333",
      recipientLabel: "אבא",
      askSummary: "מתי אתה מגיע",
      draftText: "draft",
      status: "pending",
      guestEmployeeId: null,
      createdAt: new Date("2026-11-18T09:00:00.000Z"),
    });
    employeeFindUnique.mockResolvedValue({
      name: "עמית",
      nickname: null,
    });
    inviteUpdate.mockResolvedValue({});

    const bound = await bindInboundToInvite({
      fromPhone: "972549595333",
      inboundText: "היי",
      currentUserId: "prospect-user",
      currentEmployeeId: "prospect-emp",
    });
    expect(bound?.userId).toBe("prospect-user");
    expect(bound?.employeeId).toBe("prospect-emp");
    expect(bound?.context.askSummary).toContain("מתי");
  });

  it("invite opening context is a warm first-exposure welcome", () => {
    const text = formatInviteOpeningContext({
      inviteId: "i1",
      token: `${INVITE_TOKEN_PREFIX}ABCD1234`,
      askerName: "מיכל",
      askSummary: "להביא לחם דגנים",
      recipientLabel: "טל",
    });
    expect(text).toContain("מיכל");
    expect(text).toContain("להביא לחם דגנים");
    expect(text).toMatch(/warm|first exposure|greeting/i);
    expect(text).toMatch(/tasks|shopping|reminders|filings/i);
    expect(text).not.toContain("Workee");
    expect(text).not.toContain("metadata.register");
  });

  it("uses gender-safe send wording (no ביקש)", () => {
    const { draftText } = buildFatherInviteDraft({
      askerName: "מיכל",
      askSummary: "מה שלומך?",
      token: `${INVITE_TOKEN_PREFIX}SEND0001`,
      expectsReply: false,
    });
    expect(draftText).toContain("הודעה ממיכל בלוסי");
    expect(draftText).toContain("מה שלומך?");
    expect(draftText).not.toContain("ביקש");
    expect(draftText).not.toContain("לברר איתך");
  });

  it("builds recipient compose URL even without WHATSAPP_DISPLAY_PHONE", () => {
    envState.displayPhone = undefined;
    const { draftText, businessUrl } = buildFatherInviteDraft({
      askerName: "עמית",
      askSummary: "מה שלומך?",
      token: `${INVITE_TOKEN_PREFIX}NODISP01`,
      expectsReply: false,
    });
    expect(businessUrl).toBeNull();
    expect(draftText).toContain("לוסי");
    expect(draftText).not.toContain("Workee");
    const compose = buildWhatsAppComposeUrl("972549595333", draftText);
    expect(compose).toMatch(/^https:\/\/wa\.me\/972549595333\?text=/);
  });

  it("builds שמור באנשי קשר button command", () => {
    const button = saveContactReplyButton("אחותי", "972549595333");
    expect(button.label).toBe(SAVE_CONTACT_BUTTON_LABEL);
    expect(button.command).toBe("שמור את אחותי באנשי הקשר 972549595333");
  });

  it("keeps pending invite context for legacy guest shells", () => {
    const text = formatPendingInviteContext({
      inviteId: "i1",
      token: `${INVITE_TOKEN_PREFIX}ABCD1234`,
      askerName: "טל",
      askSummary: "רשימת הקניות המשותפת",
      recipientLabel: "אורח",
    });
    expect(text).toContain("טל");
    expect(text).toContain("רשימת הקניות המשותפת");
  });
});
