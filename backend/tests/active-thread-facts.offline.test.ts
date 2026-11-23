import { describe, expect, it } from "vitest";
import {
  formatActiveThreadFacts,
  selectActiveThread,
} from "../src/services/active-thread-facts.js";
import type { JobMeta } from "../src/services/job-meta.js";
import type { OpenJobRow } from "../src/services/jobs.service.js";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import { composeTurnContext, type TurnContextParts } from "../src/services/chat.service.js";

const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASKER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_A = "11111111-1111-4111-8111-111111111111";
const ITEM_B = "22222222-2222-4222-8222-222222222222";
const ITEM_GONE = "33333333-3333-4333-8333-333333333333";

function job(meta: Partial<JobMeta> & Pick<JobMeta, "subjectId">): OpenJobRow {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    label: "לבדוק",
    meta: {
      kind: "job",
      askerId: ASKER,
      askerName: "עמית",
      subjectName: "טל",
      ask: "קנית חלב?",
      state: "open",
      createdAt: new Date().toISOString(),
      ...meta,
    },
  };
}

function snapshotWithTaskIds(ids: string[]): EmployeeRecordSnapshot {
  return {
    lists: [
      {
        list_type: "tasks",
        owner: "טל",
        scope: "personal",
        items: ids.map((id) => ({
          item_id: id,
          "שם משימה": `task-${id.slice(0, 8)}`,
        })),
      },
    ],
    filing: [],
  };
}

function emptyParts(
  overrides: Partial<TurnContextParts> = {},
): TurnContextParts {
  return {
    guestSpeaker: false,
    consultFrom: false,
    viewerId: VIEWER,
    addressGender: null,
    speakerSnapshot: { lists: [], filing: [] },
    workerSnapshot: null,
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
    ...overrides,
  };
}

describe("W2 Active Thread Facts", () => {
  it("raisable self-check becomes primary Active Thread", () => {
    const thread = selectActiveThread({
      viewerId: VIEWER,
      openJobs: [job({ subjectId: VIEWER, askerId: VIEWER, askerName: "טל" })],
    });
    expect(thread?.kind).toBe("open_job");
    expect(thread?.process).toBe("self_check");
    expect(thread?.item).toMatch(/חלב/);
    expect(thread?.waiting).toMatch(/raise_or_answer|continue/);
    expect(thread?.known.raisable).toBe(true);
  });

  it("overdue prefers live ESD titles; drops deleted ids", () => {
    const overdueJob = job({
      subjectId: VIEWER,
      askerId: VIEWER,
      askerName: "טל",
      overdueItemIds: [ITEM_A, ITEM_GONE],
      overdueTitles: ["לחם", "חלב-ישן"],
    });
    const thread = selectActiveThread({
      viewerId: VIEWER,
      openJobs: [overdueJob],
      speakerSnapshot: snapshotWithTaskIds([ITEM_A]),
    });
    expect(thread?.process).toBe("overdue_tasks");
    expect(thread?.open.join(" ")).toMatch(/לחם/);
    expect(thread?.open.join(" ")).not.toMatch(/חלב-ישן/);
    expect(thread?.known.overdue_item_ids).toEqual([ITEM_A]);
  });

  it("closed / empty openJobs → no Active Thread", () => {
    expect(
      selectActiveThread({ viewerId: VIEWER, openJobs: [] }),
    ).toBeNull();
    expect(
      formatActiveThreadFacts({ viewerId: VIEWER, openJobs: [] }),
    ).toBe("");
  });

  it("invite FI in_progress suppresses Active Thread (no FI duplicate)", () => {
    const thread = selectActiveThread({
      viewerId: VIEWER,
      openJobs: [job({ subjectId: VIEWER, askerId: VIEWER, askerName: "טל" })],
      inviteEngagement: "in_progress",
    });
    expect(thread).toBeNull();
  });

  it("non-raisable overdueOffered still keeps continuity thread", () => {
    const thread = selectActiveThread({
      viewerId: VIEWER,
      openJobs: [
        job({
          subjectId: VIEWER,
          askerId: VIEWER,
          askerName: "טל",
          overdueItemIds: [ITEM_A],
          overdueTitles: ["לחם"],
          overdueOffered: true,
        }),
      ],
      speakerSnapshot: snapshotWithTaskIds([ITEM_A]),
    });
    expect(thread?.known.raisable).toBe(false);
    expect(thread?.done).toContain("overdue_raised_this_conversation");
    expect(thread?.waiting).toBe("continue_open_ask");
  });

  it("numbered dump validated against ESD; stale lines dropped", () => {
    const thread = selectActiveThread({
      viewerId: VIEWER,
      openJobs: [],
      speakerSnapshot: snapshotWithTaskIds([ITEM_A]),
      lastNumberedDump: [
        { n: 1, id: ITEM_A, kind: "tasks", title_stem: "לחם" },
        { n: 2, id: ITEM_GONE, kind: "tasks", title_stem: "נעלם" },
      ],
    });
    expect(thread?.kind).toBe("numbered_dump");
    expect(thread?.open.join(" ")).toMatch(/לחם/);
    expect(thread?.open.join(" ")).not.toMatch(/נעלם/);
    expect(thread?.known.dropped_stale_lines).toBe(1);
  });

  it("all dump lines gone from ESD → no Active Thread", () => {
    expect(
      selectActiveThread({
        viewerId: VIEWER,
        openJobs: [],
        speakerSnapshot: snapshotWithTaskIds([]),
        lastNumberedDump: [
          { n: 1, id: ITEM_GONE, kind: "tasks", title_stem: "נעלם" },
        ],
      }),
    ).toBeNull();
  });

  it("composeTurnContext includes ACTIVE_THREAD once; no force tip", () => {
    const facts = formatActiveThreadFacts({
      viewerId: VIEWER,
      openJobs: [job({ subjectId: VIEWER, askerId: VIEWER, askerName: "טל" })],
    });
    expect(facts).toMatch(/ACTIVE_THREAD/);
    const composed = composeTurnContext(
      emptyParts({
        activeThreadFacts: facts,
        openJobs: [job({ subjectId: VIEWER, askerId: VIEWER, askerName: "טל" })],
      }),
    );
    expect(composed.match(/ACTIVE_THREAD/g)?.length).toBe(1);
    expect(composed).toMatch(/OPEN_JOBS/);
  });

  it("asker-only view scores below subject raisable when both open", () => {
    const subjectJob: OpenJobRow = {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      label: "subject",
      meta: {
        kind: "job",
        askerId: ASKER,
        askerName: "עמית",
        subjectId: VIEWER,
        subjectName: "טל",
        ask: "קנית ביצים?",
        state: "open",
        createdAt: new Date().toISOString(),
      },
    };
    const askerJob = job({
      subjectId: ASKER,
      askerId: VIEWER,
      askerName: "טל",
      subjectName: "עמית",
      ask: "מה עם הפגישה?",
    });
    const thread = selectActiveThread({
      viewerId: VIEWER,
      openJobs: [askerJob, subjectJob],
    });
    expect(thread?.job_id).toBe(subjectJob.id);
    expect(thread?.other_open_jobs).toBe(1);
  });

  it("snoozed job waits on clock; scheduled waits activation", () => {
    const snooze = selectActiveThread({
      viewerId: VIEWER,
      openJobs: [
        job({
          subjectId: VIEWER,
          askerId: VIEWER,
          askerName: "טל",
          nudgeFireAt: new Date(Date.now() + 60_000).toISOString(),
          nudgeAuto: false,
        }),
      ],
    });
    expect(snooze?.waiting).toBe("wait_snooze_clock");

    const scheduled = selectActiveThread({
      viewerId: VIEWER,
      openJobs: [
        job({
          subjectId: VIEWER,
          askerId: ASKER,
          pendingActivation: true,
        }),
      ],
    });
    expect(scheduled?.waiting).toBe("wait_scheduled_activation");
  });
});
