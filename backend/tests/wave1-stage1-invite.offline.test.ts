/**
 * Wave 1 Stage 1 — invite lifecycle helpers (offline, no DB).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  inviteUpdateMany,
  inviteFindUnique,
} = vi.hoisted(() => ({
  inviteUpdateMany: vi.fn(),
  inviteFindUnique: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    whatsAppInvite: {
      updateMany: inviteUpdateMany,
      findUnique: inviteFindUnique,
    },
  },
}));

vi.mock("../src/config/env.js", () => ({
  getEnv: () => ({
    WHATSAPP_DISPLAY_PHONE: "972501111111",
    NODE_ENV: "test",
  }),
}));

import {
  buildFatherInviteDraft,
  cancelPendingInviteByAsker,
  formatAskerPendingNotice,
  formatColdInviteNotice,
  inviteIsPastTtl,
  INVITE_TTL_MS,
  lazyExpireInvite,
} from "../src/services/whatsapp-invite.service.js";
import {
  buildCollabInvitePayloadV2,
  inviteValueTextFromPayload,
  parseCollabInvitePayload,
  shouldOfferCollabAcceptDecline,
} from "../src/services/collab-invite.service.js";

const ROW_ID = "11111111-1111-4111-8111-111111111111";

describe("Wave 1 Stage 1 payload v2", () => {
  it("parses legacy v1 payloads", () => {
    const parsed = parseCollabInvitePayload({
      v: 1,
      kind: "share",
      domain: "list",
      rowId: ROW_ID,
      action: {
        action: "add",
        listType: "shopping",
        items: [{ name: "חלב" }],
      },
    });
    expect(parsed?.v).toBe(1);
    expect(parsed?.intentKind).toBe("share");
    expect(parsed?.contentRef).toEqual({ type: "list_item", id: ROW_ID });
  });

  it("writes and parses v2 with intentKind + contentRef", () => {
    const payload = buildCollabInvitePayloadV2({
      kind: "assign",
      domain: "list",
      rowId: ROW_ID,
      action: {
        action: "add",
        listType: "tasks",
        items: [{ name: "לקחת תיק" }],
      },
    });
    const parsed = parseCollabInvitePayload(payload);
    expect(parsed?.v).toBe(2);
    expect(parsed?.intentKind).toBe("assign");
    expect(parsed?.requireRecipientAck).toBe(true);
    expect(parsed?.contentRef).toEqual({ type: "list_item", id: ROW_ID });
  });

  it("rejects v2 contentRef that does not bind to rowId", () => {
    expect(
      parseCollabInvitePayload({
        v: 2,
        intentKind: "share",
        kind: "share",
        domain: "list",
        rowId: ROW_ID,
        contentRef: {
          type: "list_item",
          id: "22222222-2222-4222-8222-222222222222",
        },
        action: {
          action: "add",
          listType: "shopping",
          items: [{ name: "חלב" }],
        },
      }),
    ).toBeNull();
  });
});

describe("Wave 1 Stage 1 drafts + ממתין", () => {
  it("builds intent-specific Lucy drafts", () => {
    const share = buildFatherInviteDraft({
      askerName: "עמית",
      askSummary: "חלב",
      token: "WRK-INV-ABCDEF12",
      intentKind: "share",
    });
    expect(share.draftText).toContain("לשתף איתך");
    const assign = buildFatherInviteDraft({
      askerName: "עמית",
      askSummary: "לקחת תיק",
      token: "WRK-INV-ABCDEF12",
      intentKind: "assign",
    });
    expect(assign.draftText).toContain("אחריות");
  });

  it("asker notices say ממתין and never claim done", () => {
    const notice = formatAskerPendingNotice({
      recipientLabel: "אבא",
      intentKind: "share",
    });
    expect(notice).toContain("ממתין");
    expect(notice).not.toMatch(/נשלח|שיתפתי|הוטל|בוצע/);
    const cold = formatColdInviteNotice({
      recipientLabel: "אבא",
      draftText: "טיוטה",
      intentKind: "assign",
    });
    expect(cold).toContain("ממתין");
  });

  it("extracts scoped invite value from payload", () => {
    const parsed = parseCollabInvitePayload(
      buildCollabInvitePayloadV2({
        kind: "share",
        domain: "list",
        rowId: ROW_ID,
        action: {
          action: "add",
          listType: "shopping",
          items: [{ name: "חלב" }],
        },
      }),
    )!;
    expect(inviteValueTextFromPayload(parsed)).toContain("חלב");
  });
});

describe("Wave 1 Stage 1 TTL + asker cancel", () => {
  beforeEach(() => {
    inviteUpdateMany.mockReset();
  });

  it("detects past TTL", () => {
    const created = new Date(Date.now() - INVITE_TTL_MS - 1000);
    expect(inviteIsPastTtl(created)).toBe(true);
    expect(inviteIsPastTtl(new Date())).toBe(false);
  });

  it("lazy-expires a stale pending invite", async () => {
    inviteUpdateMany.mockResolvedValue({ count: 1 });
    const createdAt = new Date(Date.now() - INVITE_TTL_MS - 1000);
    await expect(
      lazyExpireInvite({ id: "inv-1", status: "pending", createdAt }),
    ).resolves.toBe(true);
    expect(inviteUpdateMany).toHaveBeenCalledWith({
      where: { id: "inv-1", status: "pending" },
      data: { status: "expired" },
    });
  });

  it("asker cancel flips pending → cancelled", async () => {
    inviteUpdateMany.mockResolvedValue({ count: 1 });
    await expect(
      cancelPendingInviteByAsker({
        inviteId: "inv-1",
        userId: "user-1",
        askerEmployeeId: "asker-1",
      }),
    ).resolves.toBe("cancelled");
    inviteUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      cancelPendingInviteByAsker({
        inviteId: "inv-1",
        userId: "user-1",
        askerEmployeeId: "asker-1",
      }),
    ).resolves.toBe("lost");
  });
});

describe("Wave 1 Stage 1 present vs accept routing", () => {
  it("Assign always offers Accept/Decline", () => {
    expect(
      shouldOfferCollabAcceptDecline({
        kind: "assign",
        recipientIsProspect: true,
      }),
    ).toBe(true);
  });

  it("Prospect Share is present-only (no Accept)", () => {
    expect(
      shouldOfferCollabAcceptDecline({
        kind: "share",
        recipientIsProspect: true,
      }),
    ).toBe(false);
  });

  it("Member Share may Accept", () => {
    expect(
      shouldOfferCollabAcceptDecline({
        kind: "share",
        recipientIsProspect: false,
      }),
    ).toBe(true);
  });
});
