import { describe, expect, it } from "vitest";
import { formatCollabInviteContext } from "../src/services/collab-invite.service.js";
import {
  formatInviteFollowUpContext,
  formatInviteOpeningContext,
} from "../src/services/whatsapp-invite.service.js";

const invite = {
  inviteId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  token: "WEE-TEST",
  askerName: "מיכל",
  askSummary: "להביא לחם דגנים",
  recipientLabel: "דני",
};

describe("Invite FI follow-up context blocks", () => {
  it("first exposure asks to present; follow-up forbids re-present and invent", () => {
    const first = formatInviteOpeningContext(invite);
    expect(first).toMatch(/first exposure/i);
    expect(first).toMatch(/presents this activity/i);

    const follow = formatInviteFollowUpContext(invite);
    expect(follow).toMatch(/follow-up/i);
    expect(follow).toMatch(/already presented/i);
    expect(follow).toMatch(/FORBIDDEN/);
    expect(follow).toMatch(/invent/i);
    expect(follow).not.toMatch(/First reply: warm Hebrew greeting that clearly presents/);
  });

  it("collab follow_up mode keeps INVITE_VALUE without first-exposure present", () => {
    const first = formatCollabInviteContext(
      [
        {
          inviteId: invite.inviteId,
          askerName: "מיכל",
          askSummary: "להביא לחם דגנים",
          kind: "share",
          inviteValueText: "להביא לחם דגנים — מכולת",
        },
      ],
      { mode: "first" },
    );
    expect(first).toMatch(/First exposure/);
    expect(first).toMatch(/INVITE_VALUE/);

    const follow = formatCollabInviteContext(
      [
        {
          inviteId: invite.inviteId,
          askerName: "מיכל",
          askSummary: "להביא לחם דגנים",
          kind: "share",
          inviteValueText: "להביא לחם דגנים — מכולת",
        },
      ],
      { mode: "follow_up" },
    );
    expect(follow).toMatch(/follow-up/i);
    expect(follow).toMatch(/INVITE_VALUE/);
    expect(follow).toMatch(/FORBIDDEN inventing/);
    expect(follow).not.toMatch(/First exposure/);
  });
});
