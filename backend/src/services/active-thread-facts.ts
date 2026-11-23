/**
 * W2 Active Thread Facts — compact live-progress block for follow-up turns.
 *
 * Pattern mirrors Invite FI follow-up: engine injects durable state each turn
 * so short replies / pauses / Lucy mid-messages / topic digressions do not lose
 * an open process. Facts are derived only from OPEN_JOBS + FI engagement +
 * ESD-validated dump lines — never invented from stale chat prose.
 */
import {
  computeOpenJobRaisable,
  type OpenJobRow,
} from "./jobs.service.js";
import type { JobMeta } from "./job-meta.js";
import type { EmployeeRecordSnapshot } from "./employee-records.service.js";
import type { LastNumberedDumpLine } from "./show-button-dump.js";
import { liveDumpRowIdsFromSnapshot } from "./show-button-dump.js";

export type FiInviteEngagementState = "none" | "in_progress" | "valued";

export type ActiveThreadInput = {
  viewerId: string;
  openJobs: OpenJobRow[];
  /** Open FI invite engagement — when in_progress, INVITE CONTEXT owns the thread. */
  inviteEngagement?: FiInviteEngagementState;
  speakerSnapshot?: EmployeeRecordSnapshot | null;
  lastNumberedDump?: LastNumberedDumpLine[];
  now?: Date;
};

export type ActiveThreadFact = {
  kind: "open_job" | "fi_invite" | "numbered_dump";
  process: string;
  item: string;
  done: string[];
  open: string[];
  waiting: string;
  known: Record<string, unknown>;
  job_id?: string;
  other_open_jobs?: number;
};

function pendingClock(meta: JobMeta, now: Date): string | null {
  if (!meta.nudgeFireAt) {
    return null;
  }
  const at = Date.parse(meta.nudgeFireAt);
  return Number.isFinite(at) && at > now.getTime() ? meta.nudgeFireAt : null;
}

function liveIdSet(
  snapshot: EmployeeRecordSnapshot | null | undefined,
): Set<string> | null {
  if (!snapshot) {
    return null;
  }
  return liveDumpRowIdsFromSnapshot(snapshot);
}

function filterLiveTitles(
  ids: string[] | undefined,
  titles: string[] | undefined,
  liveIds: Set<string> | null,
): { liveIds: string[]; liveTitles: string[]; dropped: number } {
  const idList = ids ?? [];
  const titleList = titles ?? [];
  const keptIds: string[] = [];
  const keptTitles: string[] = [];
  let dropped = 0;
  for (let i = 0; i < idList.length; i++) {
    const id = idList[i]!;
    if (liveIds && !liveIds.has(id)) {
      dropped += 1;
      continue;
    }
    keptIds.push(id);
    const title = titleList[i]?.trim();
    if (title) {
      keptTitles.push(title);
    }
  }
  return { liveIds: keptIds, liveTitles: keptTitles, dropped };
}

/** Score higher = better primary Active Thread for this viewer. */
function scoreJob(job: OpenJobRow, viewerId: string, now: Date): number {
  const meta = job.meta;
  if (meta.pendingActivation) {
    return 10;
  }
  const clock = pendingClock(meta, now);
  const snoozed = Boolean(clock && !meta.nudgeAuto);
  if (snoozed) {
    return 20;
  }
  const raisable = computeOpenJobRaisable(job, viewerId, now);
  const self = meta.askerId === meta.subjectId && meta.subjectId === viewerId;
  const subject = meta.subjectId === viewerId;
  const overdue = (meta.overdueItemIds?.length ?? 0) > 0;
  const stale = (meta.staleUndatedItemIds?.length ?? 0) > 0;
  if (raisable && overdue) {
    return 100;
  }
  if (raisable && stale) {
    return 95;
  }
  if (raisable && self) {
    return 90;
  }
  if (raisable && subject) {
    return 85;
  }
  if (raisable) {
    return 70;
  }
  // Still open for the viewer but not raisable (offered / clock) — continuity.
  if (subject || meta.askerId === viewerId) {
    return overdue || stale ? 55 : 40;
  }
  return 0;
}

function waitingFor(job: OpenJobRow, viewerId: string, now: Date): string {
  const meta = job.meta;
  if (meta.pendingActivation) {
    return "wait_scheduled_activation";
  }
  const clock = pendingClock(meta, now);
  if (clock && !meta.nudgeAuto) {
    return "wait_snooze_clock";
  }
  if (clock && meta.nudgeAuto) {
    return "wait_urgency_follow_up";
  }
  if (meta.needsBook && meta.subjectId === viewerId) {
    return "answer_book_yes_no";
  }
  if (meta.needsBook && meta.askerId === viewerId) {
    return "await_subject_book_answer";
  }
  if (
    (meta.overdueItemIds?.length ?? 0) > 0 &&
    !meta.overdueOffered &&
    computeOpenJobRaisable(job, viewerId, now)
  ) {
    return "raise_overdue_then_resolve";
  }
  if (
    (meta.staleUndatedItemIds?.length ?? 0) > 0 &&
    !meta.staleOffered &&
    computeOpenJobRaisable(job, viewerId, now)
  ) {
    return "raise_stale_then_resolve";
  }
  if (meta.subjectId === viewerId) {
    return computeOpenJobRaisable(job, viewerId, now)
      ? "raise_or_answer_open_ask"
      : "continue_open_ask";
  }
  if (meta.askerId === viewerId) {
    return "await_subject_or_status";
  }
  return "continue";
}

function buildJobThread(
  job: OpenJobRow,
  viewerId: string,
  now: Date,
  liveIds: Set<string> | null,
  otherOpen: number,
): ActiveThreadFact {
  const meta = job.meta;
  const done: string[] = [];
  const open: string[] = [];
  const known: Record<string, unknown> = {
    state: meta.state,
    raisable: computeOpenJobRaisable(job, viewerId, now),
    viewer_is:
      meta.askerId === meta.subjectId && meta.subjectId === viewerId
        ? "self"
        : meta.askerId === viewerId
          ? "asker"
          : "subject",
    asker: meta.askerName,
    subject: meta.subjectName,
  };

  if (meta.progress?.trim()) {
    done.push(`progress:${meta.progress.trim()}`);
  }
  if (meta.overdueOffered) {
    done.push("overdue_raised_this_conversation");
  }
  if (meta.staleOffered) {
    done.push("stale_raised_this_conversation");
  }
  if (meta.deferredAt) {
    done.push("subject_deferred");
  }

  const overdue = filterLiveTitles(
    meta.overdueItemIds,
    meta.overdueTitles,
    liveIds,
  );
  const stale = filterLiveTitles(
    meta.staleUndatedItemIds,
    meta.staleUndatedTitles,
    liveIds,
  );

  if (overdue.liveTitles.length > 0) {
    open.push(...overdue.liveTitles.map((t) => `overdue:${t}`));
    known.overdue_item_ids = overdue.liveIds;
    known.overdue_titles = overdue.liveTitles;
  } else if ((meta.overdueItemIds?.length ?? 0) > 0 && overdue.dropped > 0) {
    // All overdue rows gone from ESD — still an open job until closed, but no items.
    open.push("overdue_items_cleared_in_esd");
    known.overdue_items_dropped = overdue.dropped;
  }

  if (stale.liveTitles.length > 0) {
    open.push(...stale.liveTitles.map((t) => `stale:${t}`));
    known.stale_item_ids = stale.liveIds;
    known.stale_titles = stale.liveTitles;
  }

  const ask = meta.ask.trim();
  if (ask && overdue.liveTitles.length === 0 && stale.liveTitles.length === 0) {
    open.push(`ask:${ask}`);
  }

  if (meta.needsBook) {
    open.push("book_slot_pending");
    if (meta.bookDate) known.book_date = meta.bookDate;
    if (meta.bookTime) known.book_time = meta.bookTime;
    if (meta.bookEndTime) known.book_end_time = meta.bookEndTime;
    if (meta.bookTitle) known.book_title = meta.bookTitle;
  }

  const clock = pendingClock(meta, now);
  if (clock) {
    known.reminder_at = clock;
  }
  if (meta.pendingActivation) {
    known.scheduled = true;
  }

  let process = "open_job";
  if ((meta.overdueItemIds?.length ?? 0) > 0) {
    process = "overdue_tasks";
  } else if ((meta.staleUndatedItemIds?.length ?? 0) > 0) {
    process = "stale_undated_tasks";
  } else if (meta.needsBook) {
    process = "meeting_book";
  } else if (meta.askerId === meta.subjectId) {
    process = "self_check";
  } else if (meta.subjectId === viewerId) {
    process = "subject_check";
  } else {
    process = "asker_waiting";
  }

  return {
    kind: "open_job",
    process,
    item: ask || job.label,
    done,
    open,
    waiting: waitingFor(job, viewerId, now),
    known,
    job_id: job.id,
    ...(otherOpen > 0 ? { other_open_jobs: otherOpen } : {}),
  };
}

function buildDumpThread(
  lines: LastNumberedDumpLine[],
  liveIds: Set<string> | null,
): ActiveThreadFact | null {
  if (lines.length === 0) {
    return null;
  }
  const liveLines = lines.filter((line) => {
    const id = String(line.id ?? "").trim();
    if (!id) {
      return false;
    }
    // Snapshot present → ESD wins (drop stale dump ids, including empty ESD).
    if (liveIds && !liveIds.has(id)) {
      return false;
    }
    return true;
  });
  if (liveLines.length === 0) {
    return null;
  }
  const sample = liveLines
    .slice(0, 5)
    .map((line) => `${line.n}:${line.title_stem || line.id}`)
    .filter(Boolean);
  return {
    kind: "numbered_dump",
    process: "last_numbered_dump",
    item: `lines 1–${liveLines.length}`,
    done: ["dump_shown"],
    open: sample.map((s) => `line:${s}`),
    waiting: "line_index_or_next_action",
    known: {
      live_line_count: liveLines.length,
      dropped_stale_lines: lines.length - liveLines.length,
    },
  };
}

/**
 * Pick the single primary Active Thread for this turn.
 * Returns null when Invite FI follow-up owns the slot, or nothing is open.
 */
export function selectActiveThread(
  input: ActiveThreadInput,
): ActiveThreadFact | null {
  if (input.inviteEngagement === "in_progress") {
    // INVITE CONTEXT (follow-up) already carries the thread — no duplicate block.
    return null;
  }

  const now = input.now ?? new Date();
  const liveIds = liveIdSet(input.speakerSnapshot);
  const scored = input.openJobs
    .map((job) => ({ job, score: scoreJob(job, input.viewerId, now) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    const primary = scored[0]!.job;
    return buildJobThread(
      primary,
      input.viewerId,
      now,
      liveIds,
      Math.max(0, scored.length - 1),
    );
  }

  // No open job — ESD-validated dump can still anchor short follow-ups («3», «תמחק»).
  return buildDumpThread(input.lastNumberedDump ?? [], liveIds);
}

/**
 * Compact facts block. Empty string when there is no live Active Thread.
 */
export function formatActiveThreadFacts(input: ActiveThreadInput): string {
  const thread = selectActiveThread(input);
  if (!thread) {
    return "";
  }
  return [
    "ACTIVE_THREAD (live progress — follow-up continuity; already in flight):",
    JSON.stringify(thread),
    "Use THIS block + OPEN_JOBS / EMPLOYEE_SAVED_DATA / LAST_NUMBERED_DUMP for short follow-ups after a pause, Lucy mid-message, or topic digression.",
    "Live ESD / OPEN_JOBS win over older chat history. Absent job or dump line = gone — never resurrect.",
    "FORBIDDEN inventing missing fields; FORBIDDEN re-presenting as first exposure; FORBIDDEN forcing this thread when they clearly switched to a new unrelated topic (handle the new topic; return here when they resume).",
    "Do not invent a second FI / tip / raise from this block — raise/answer still follow OPEN_JOBS raisable rules.",
  ].join("\n");
}
