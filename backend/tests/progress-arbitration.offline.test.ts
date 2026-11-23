import { describe, expect, it } from "vitest";
import type { JobMeta } from "../src/services/job-meta.js";
import {
  computeOpenJobRaisable,
  hasRaisableProgressCandidate,
  type OpenJobRow,
} from "../src/services/jobs.service.js";

const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASKER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

describe("W1 Progress Arbitration — raisable candidates", () => {
  it("subject open job is raisable; asker view is not", () => {
    const subjectJob = job({ subjectId: VIEWER });
    expect(computeOpenJobRaisable(subjectJob, VIEWER)).toBe(true);
    expect(computeOpenJobRaisable(subjectJob, ASKER)).toBe(false);
  });

  it("scheduled / snoozed jobs are not raisable", () => {
    expect(
      computeOpenJobRaisable(
        job({ subjectId: VIEWER, pendingActivation: true }),
        VIEWER,
      ),
    ).toBe(false);
    expect(
      computeOpenJobRaisable(
        job({
          subjectId: VIEWER,
          nudgeFireAt: new Date(Date.now() + 60_000).toISOString(),
          nudgeAuto: false,
        }),
        VIEWER,
      ),
    ).toBe(false);
  });

  it("overdue/stale already offered this conversation are not raisable", () => {
    expect(
      computeOpenJobRaisable(
        job({
          subjectId: VIEWER,
          overdueItemIds: ["x"],
          overdueOffered: true,
        }),
        VIEWER,
      ),
    ).toBe(false);
    expect(
      computeOpenJobRaisable(
        job({
          subjectId: VIEWER,
          overdueItemIds: ["x"],
          overdueOffered: false,
        }),
        VIEWER,
      ),
    ).toBe(true);
    expect(
      computeOpenJobRaisable(
        job({
          subjectId: VIEWER,
          staleUndatedItemIds: ["y"],
          staleOffered: true,
        }),
        VIEWER,
      ),
    ).toBe(false);
    expect(
      computeOpenJobRaisable(
        job({
          subjectId: VIEWER,
          staleUndatedItemIds: ["y"],
          staleOffered: false,
        }),
        VIEWER,
      ),
    ).toBe(true);
  });

  it("hasRaisableProgressCandidate aggregates open jobs", () => {
    expect(hasRaisableProgressCandidate([], VIEWER)).toBe(false);
    expect(
      hasRaisableProgressCandidate(
        [job({ subjectId: VIEWER, overdueItemIds: ["x"], overdueOffered: true })],
        VIEWER,
      ),
    ).toBe(false);
    expect(
      hasRaisableProgressCandidate([job({ subjectId: VIEWER })], VIEWER),
    ).toBe(true);
  });
});
