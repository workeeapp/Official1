import { describe, expect, it } from "vitest";
import {
  composeTurnContext,
  type TurnContextParts,
} from "../src/services/chat.service.js";
import {
  PROSPECT_GOALS_BRIEF_MAX_CHARS,
  PROSPECT_GOALS_MARKER,
  formatProspectGoalsBrief,
  prospectGoalsBriefLooksLikePlaybook,
  prospectGoalsBriefViolatesBudget,
  shouldInjectProspectGoalsBrief,
} from "../src/services/prospect-goals-brief.js";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";

const snapshot = (name: string): EmployeeRecordSnapshot => ({
  lists: [
    {
      list_type: "custom",
      list_name: name,
      owner: "טל",
      scope: "personal",
      items: [],
    },
  ],
  filing: [],
});

function parts(over: Partial<TurnContextParts> = {}): TurnContextParts {
  return {
    guestSpeaker: false,
    consultFrom: false,
    viewerId: "viewer-1",
    addressGender: "male",
    speakerSnapshot: snapshot("רשימת-דובר"),
    workerSnapshot: snapshot("רשימת-לוסי"),
    speakerContacts: [],
    contactBookShare: null,
    teamSchedules: [],
    recentOutbound: [],
    openJobs: [],
    activeMissionsBlock: "",
    lastNumberedDump: [],
    pendingAttachments: [],
    pendingLocation: null,
    lastLiveLocation: null,
    pendingInvite: null,
    tipsContext: "",
    ...over,
  };
}

describe("prospect goals brief (Slice 1)", () => {
  it("B1: Prospect brief appears in composed context", () => {
    expect(shouldInjectProspectGoalsBrief({ isProspect: true })).toBe(true);
    const brief = formatProspectGoalsBrief();
    const text = composeTurnContext(
      parts({ prospectGoalsBrief: brief, tipsContext: "TIPS" }),
    );
    expect(text).toContain(PROSPECT_GOALS_MARKER);
    expect(text).toContain("conversational goals, not a script");
    expect(text.indexOf(PROSPECT_GOALS_MARKER)).toBeLessThan(text.indexOf("TIPS"));
  });

  it("B2: Member path does not inject brief", () => {
    expect(shouldInjectProspectGoalsBrief({ isProspect: false })).toBe(false);
    const text = composeTurnContext(parts({ prospectGoalsBrief: "" }));
    expect(text).not.toContain(PROSPECT_GOALS_MARKER);
  });

  it("B3: brief stays within budget and is not a playbook", () => {
    const brief = formatProspectGoalsBrief();
    expect(prospectGoalsBriefViolatesBudget(brief)).toBe(false);
    expect(brief.length).toBeLessThanOrEqual(PROSPECT_GOALS_BRIEF_MAX_CHARS);
    expect(prospectGoalsBriefLooksLikePlaybook(brief)).toBe(false);
    expect(brief.split("\n").length).toBeLessThanOrEqual(12);
  });
});
