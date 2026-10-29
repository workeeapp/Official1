import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  inviteCreate,
  inviteFindFirst,
  inviteUpdate,
  employeeFindUnique,
  employeeUpdate,
  ensureGuestLucy,
} = vi.hoisted(() => ({
  inviteCreate: vi.fn(),
  inviteFindFirst: vi.fn(),
  inviteUpdate: vi.fn(),
  employeeFindUnique: vi.fn(),
  employeeUpdate: vi.fn(),
  ensureGuestLucy: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    whatsAppInvite: {
      create: inviteCreate,
      findFirst: inviteFindFirst,
      update: inviteUpdate,
    },
    employee: {
      findUnique: employeeFindUnique,
      update: employeeUpdate,
    },
  },
}));

vi.mock("../src/services/employee.service.js", () => ({
  ensureGuestLucy,
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
  buildWhatsAppComposeUrl,
  createWhatsAppInvite,
  formatColdInviteNotice,
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
    ensureGuestLucy.mockReset();
  });

  it("parses WRK-INV tokens from inbound text", () => {
    expect(parseInviteToken("hello WRK-INV-ABCDEF12 world")).toBe(
      `${INVITE_TOKEN_PREFIX}ABCDEF12`,
    );
    expect(parseInviteToken("no token here")).toBeNull();
  });

  it("builds wa.me compose URLs and father drafts with business link", () => {
    const url = buildWhatsAppComposeUrl(
      "972549595333",
      "היי אבא",
    );
    expect(url).toMatch(/^https:\/\/wa\.me\/972549595333\?text=/);
    expect(decodeURIComponent(url.split("text=")[1]!)).toContain("היי אבא");

    const { draftText, businessUrl } = buildFatherInviteDraft({
      askerName: "עמית",
      askSummary: "מתי אתה מתכנן להגיע",
      token: `${INVITE_TOKEN_PREFIX}ABCD1234`,
    });
    expect(draftText).toContain("היי, כאן לוסי");
    expect(draftText).toContain("עמית");
    expect(draftText).toContain("מתי אתה מתכנן להגיע");
    expect(businessUrl).toMatch(/^https:\/\/wa\.me\/972501111111\?text=/);
    expect(draftText).toContain(businessUrl!);
  });

  it("formats cold invite notice for the asker", () => {
    const notice = formatColdInviteNotice({
      recipientLabel: "אבא",
      draftText: "טיוטה",
    });
    expect(notice).toContain("אבא");
    expect(notice).toContain("שלח בוואטסאפ");
    expect(notice).toContain("«טיוטה»");
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

  it("binds inbound guest onto the invite asker account", async () => {
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
    });
    inviteUpdate.mockResolvedValue({});
    employeeUpdate.mockResolvedValue({});
    employeeFindUnique.mockResolvedValue({
      name: "עמית",
      nickname: "עמית",
    });

    const bound = await bindInboundToInvite({
      fromPhone: "972549595333",
      inboundText: `${INVITE_TOKEN_PREFIX}TESTTOKEN1\nשלום`,
      currentUserId: "wrong-user",
      currentEmployeeId: "guest-emp",
    });

    expect(bound).not.toBeNull();
    expect(bound!.userId).toBe("asker-user");
    expect(bound!.employeeId).toBe("guest-emp");
    expect(bound!.context.askSummary).toBe("מתי אתה מגיע");
    expect(employeeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "guest-emp" },
        data: expect.objectContaining({ userId: "asker-user", isGuest: true }),
      }),
    );
    expect(ensureGuestLucy).toHaveBeenCalledWith("asker-user");
  });

  it("formats PENDING_INVITE context for לוסי-אורח", () => {
    const text = formatPendingInviteContext({
      inviteId: "inv-1",
      token: `${INVITE_TOKEN_PREFIX}X`,
      askerName: "עמית",
      askSummary: "מתי אתה מגיע",
      recipientLabel: "אבא",
    });
    expect(text).toContain("PENDING_INVITE");
    expect(text).toContain("עמית");
    expect(text).toContain("מתי אתה מגיע");
    expect(text).toContain("register");
  });

  it("uses pure-send wording when expectsReply is false", () => {
    const { draftText } = buildFatherInviteDraft({
      askerName: "עמית",
      askSummary: "מה שלומך?",
      token: `${INVITE_TOKEN_PREFIX}SEND0001`,
      expectsReply: false,
    });
    expect(draftText).toContain("ביקש שאעביר לך");
    expect(draftText).toContain("מה שלומך?");
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
    expect(draftText).toContain("כתוב למספר העסק");
    const compose = buildWhatsAppComposeUrl("972549595333", draftText);
    expect(compose).toMatch(/^https:\/\/wa\.me\/972549595333\?text=/);
  });

  it("builds שמור באנשי קשר button command", () => {
    const button = saveContactReplyButton("אחותי", "972549595333");
    expect(button.label).toBe(SAVE_CONTACT_BUTTON_LABEL);
    expect(button.command).toBe("שמור את אחותי באנשי הקשר 972549595333");
  });
});
