import { describe, expect, it } from "vitest";
import {
  buildColdFiCandidate,
  buildInviteFiCandidate,
  buildMemberFiCandidate,
  fiActSucceeded,
  fiColdOpportunityKey,
  fiInviteOpportunityKey,
  fiMemberOpportunityKey,
  injectFiInviteDirectPresentBubble,
  injectFiOfferBubble,
  resolveFiPhase,
  resolveInviteFiDirectPresent,
} from "../src/services/first-interaction.js";

const EMP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INVITE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const pendingInvite = {
  inviteId: INVITE,
  token: "WEE-TEST",
  askerName: "מיכל",
  askSummary: "להביא לחם",
  recipientLabel: "דני",
};

describe("First Interaction Stage 1 — phase + Value", () => {
  it("invited prospect → invite_act with no soft show-Offer candidate", () => {
    const { phase, candidate } = resolveFiPhase({
      isProspect: true,
      pendingInvite,
      hasPersonalRecords: false,
      suppressKeys: new Set(),
      employeeId: EMP,
    });
    expect(phase).toBe("invite_act");
    expect(candidate).toBeNull();
  });

  it("invite direct present shows item + act taps (no כן/לא Offer)", () => {
    const resolved = resolveInviteFiDirectPresent({
      invite: pendingInvite,
      collabInvites: [
        {
          inviteId: INVITE,
          askerName: "מיכל",
          askSummary: "להביא לחם",
          kind: "assign",
        },
      ],
    });
    expect(resolved.status).toBe("present");
    if (resolved.status !== "present") {
      return;
    }
    expect(resolved.present.opportunityKey).toBe(fiInviteOpportunityKey(INVITE));
    expect(resolved.present.text).toMatch(/מאת מיכל/);
    expect(resolved.present.text).toMatch(/להביא לחם/);
    expect(resolved.present.text).not.toMatch(/רוצה שאראה/);
    expect(resolved.present.buttons.some((b) => b.label === "סמן כבוצע")).toBe(
      true,
    );
    expect(resolved.present.buttons.some((b) => b.label === "כן")).toBe(false);
  });

  it("invite unavailable when title is empty/generic", () => {
    const resolved = resolveInviteFiDirectPresent({
      invite: {
        ...pendingInvite,
        askSummary: "פריט",
      },
      collabInvites: [
        {
          inviteId: INVITE,
          askerName: "מיכל",
          askSummary: "פריט",
          kind: "share",
          inviteValueText: "unavailable",
        },
      ],
    });
    expect(resolved.status).toBe("unavailable");
  });

  it("cold prospect → fi_first_try without capability list", () => {
    const { phase, candidate } = resolveFiPhase({
      isProspect: true,
      pendingInvite: null,
      hasPersonalRecords: false,
      suppressKeys: new Set(),
      employeeId: EMP,
    });
    expect(phase).toBe("cold_first_try");
    expect(candidate?.kind).toBe("fi_first_try");
    expect(candidate?.opportunityKey).toBe(fiColdOpportunityKey(EMP));
    expect(candidate?.text).not.toMatch(/משימות.*קניות.*תזכורות/);
  });

  it("new member → fi_member_first_save", () => {
    const { phase, candidate } = resolveFiPhase({
      isProspect: false,
      pendingInvite: null,
      hasPersonalRecords: false,
      suppressKeys: new Set(),
      employeeId: EMP,
    });
    expect(phase).toBe("member_first_save");
    expect(candidate?.kind).toBe("fi_member_first_save");
    expect(candidate?.opportunityKey).toBe(fiMemberOpportunityKey(EMP));
  });

  it("returning user with ESD records → done (no FI)", () => {
    const returning = resolveFiPhase({
      isProspect: false,
      pendingInvite: null,
      hasPersonalRecords: true,
      suppressKeys: new Set(),
      employeeId: EMP,
    });
    expect(returning.phase).toBe("done");
    expect(returning.candidate).toBeNull();
  });

  it("suppressed opportunityKey → done", () => {
    const key = fiColdOpportunityKey(EMP);
    const { phase, candidate } = resolveFiPhase({
      isProspect: true,
      pendingInvite: null,
      hasPersonalRecords: false,
      suppressKeys: new Set([key]),
      employeeId: EMP,
    });
    expect(phase).toBe("done");
    expect(candidate).toBeNull();
  });

  it("invite Value is mutate only — dump/present is not Value", () => {
    expect(
      fiActSucceeded({
        kind: "fi_invite_act",
        listMutations: [],
        reminderSavedCount: 0,
        dumpReplaced: true,
      }),
    ).toBe(false);
    expect(
      fiActSucceeded({
        kind: "fi_invite_act",
        listMutations: [{ action: "remove" }],
        reminderSavedCount: 0,
      }),
    ).toBe(true);
    expect(
      fiActSucceeded({
        kind: "fi_member_first_save",
        listMutations: [{ action: "add" }],
        reminderSavedCount: 0,
      }),
    ).toBe(true);
  });

  it("injects invite present once; soft offer inject unchanged for cold", () => {
    const resolved = resolveInviteFiDirectPresent({ invite: pendingInvite });
    expect(resolved.status).toBe("present");
    if (resolved.status !== "present") {
      return;
    }
    const bubbles = injectFiInviteDirectPresentBubble(
      [{ text: "היי" }],
      resolved.present,
    );
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]?.text).toMatch(/מאת מיכל/);
    const again = injectFiInviteDirectPresentBubble(bubbles, resolved.present);
    expect(again).toHaveLength(1);

    const cold = buildColdFiCandidate({ employeeId: EMP });
    const soft = injectFiOfferBubble([{ text: "היי" }], cold);
    expect(soft).toHaveLength(2);
  });

  it("legacy invite soft builder still exists for reference", () => {
    expect(buildInviteFiCandidate({ invite: pendingInvite }).kind).toBe(
      "fi_invite_act",
    );
    expect(buildMemberFiCandidate({ employeeId: EMP }).kind).toBe(
      "fi_member_first_save",
    );
  });
});
