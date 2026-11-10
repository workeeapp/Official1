/**
 * LIVE_FULL OPEN_JOBS seeding (offline): corpus shape + which askers become
 * harness partners. Seeding itself runs on the production path
 * (createJobsFromRelays) and is exercised by the `open-jobs` LIVE cases.
 */
import { describe, expect, it } from "vitest";
import { loadLiveFullCorpus } from "../src/eval/corpus.js";
import { openJobAskers } from "../src/eval/run-live-full-production.js";

describe("LIVE_FULL context.openJobs", () => {
  const corpus = loadLiveFullCorpus();
  const withJobs = corpus.cases.filter((row) => row.context?.openJobs?.length);

  it("the open-jobs cases carry well-formed jobs (asker + ask; urgency optional)", () => {
    expect(withJobs.map((row) => row.id).sort()).toEqual(
      [
        "oj-answer-closes-job",
        "oj-greeting-then-raise",
        "oj-meeting-counter-other-time",
        "oj-meeting-raise-asks-to-book",
        "oj-very-urgent-raise",
        "oj-self-check-raise-second-person",
        "oj-urgent-raise-with-own-request",
      ].sort(),
    );
    for (const row of withJobs) {
      for (const job of row.context!.openJobs!) {
        expect(job.asker.trim(), row.id).not.toBe("");
        expect(job.ask.trim(), row.id).not.toBe("");
        expect(["normal", "urgent", "very_urgent", undefined]).toContain(job.urgency);
        if (job.book) {
          expect(job.book.title.trim(), row.id).not.toBe("");
          expect(job.book.daysFromNow, row.id).toBeGreaterThan(0);
          expect(job.book.time, row.id).toMatch(/^\d{2}:\d{2}$/);
        }
      }
    }
  });

  it("askers other than the speaker become harness partners; a self-check adds none", () => {
    const byId = (id: string) => corpus.cases.find((row) => row.id === id)!;
    expect(openJobAskers(byId("oj-greeting-then-raise"), corpus.speaker)).toEqual(["עמית"]);
    expect(openJobAskers(byId("oj-self-check-raise-second-person"), corpus.speaker)).toEqual([]);
  });
});
