/**
 * An open job is an ordinary tasks row on the digital worker, so it already shows
 * up in WORKER_SAVED_DATA and is removable with lists.remove.
 * The bookkeeping below lives under a reserved key in that row's free-form data
 * and is stripped before the row reaches the model as saved data.
 *
 * Kept dependency-free so both the records snapshot and the jobs service can use it.
 */
export const JOB_META_KEY = "__job";

export type JobRowKind = "job" | "nudge";

export interface JobMeta {
  kind: JobRowKind;
  /** Who asked for the job (the person the answer is reported back to). */
  askerId: string;
  askerName: string;
  /** Who has to answer or act. */
  subjectId: string;
  subjectName: string;
  /** The asker's question in their own words, quoted when reporting back. */
  ask: string;
  state: "open" | "progress";
  createdAt: string;
  /** Model asked to hold off without naming a time. Still raised at the next opening. */
  deferredAt?: string;
  /** Active follow-up clock for this job (soft reference; no cascade onto the job). */
  nudgeReminderId?: string;
  nudgeItemId?: string;
  nudgeFireAt?: string;
  /** The active clock is an urgency follow-up, not a snooze the subject asked for. */
  nudgeAuto?: boolean;
  /** Urgency follow-ups already fired for this job. */
  autoNudgesSent?: number;
  /** Set on a nudge row: it was opened by the urgency policy. */
  auto?: boolean;
  /** Latest progress note, kept so the asker can be told where things stand. */
  progress?: string;
  /** Set on a nudge row: the job it belongs to. */
  jobItemId?: string;
  /** A counter-offer is waiting for approval. Answering it books the meeting. */
  needsBook?: boolean;
  /** YYYY-MM-DD captured on the counter. */
  bookDate?: string;
  /** HH:mm captured on the counter. */
  bookTime?: string;
  /** Meeting title saved on both lists when it is booked. */
  bookTitle?: string;
  /**
   * Deferred check-with: the job row exists on the worker with a future clock,
   * but the ask has not been sent yet. At fire the server clears this and opens
   * the job for real (WhatsApp + urgency follow-ups).
   */
  pendingActivation?: boolean;
  /** Ask body to send when a pending job activates (WhatsApp / chat). */
  activateText?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function jobMetaFrom(data: unknown): JobMeta | null {
  const meta = asRecord(asRecord(data)[JOB_META_KEY]);
  const kind =
    meta.kind === "nudge" ? "nudge" : meta.kind === "job" ? "job" : null;
  if (!kind) {
    return null;
  }
  const askerId = typeof meta.askerId === "string" ? meta.askerId : "";
  const subjectId = typeof meta.subjectId === "string" ? meta.subjectId : "";
  if (!askerId || !subjectId) {
    return null;
  }
  return {
    kind,
    askerId,
    askerName: typeof meta.askerName === "string" ? meta.askerName : "",
    subjectId,
    subjectName: typeof meta.subjectName === "string" ? meta.subjectName : "",
    ask: typeof meta.ask === "string" ? meta.ask : "",
    state: meta.state === "progress" ? "progress" : "open",
    createdAt:
      typeof meta.createdAt === "string"
        ? meta.createdAt
        : new Date().toISOString(),
    ...(typeof meta.deferredAt === "string"
      ? { deferredAt: meta.deferredAt }
      : {}),
    ...(typeof meta.nudgeReminderId === "string"
      ? { nudgeReminderId: meta.nudgeReminderId }
      : {}),
    ...(typeof meta.nudgeItemId === "string"
      ? { nudgeItemId: meta.nudgeItemId }
      : {}),
    ...(typeof meta.nudgeFireAt === "string"
      ? { nudgeFireAt: meta.nudgeFireAt }
      : {}),
    ...(meta.nudgeAuto === true ? { nudgeAuto: true } : {}),
    ...(typeof meta.autoNudgesSent === "number" && meta.autoNudgesSent > 0
      ? { autoNudgesSent: meta.autoNudgesSent }
      : {}),
    ...(meta.auto === true ? { auto: true } : {}),
    ...(typeof meta.progress === "string" ? { progress: meta.progress } : {}),
    ...(typeof meta.jobItemId === "string"
      ? { jobItemId: meta.jobItemId }
      : {}),
    ...(meta.needsBook === true ? { needsBook: true } : {}),
    ...(typeof meta.bookDate === "string" && meta.bookDate
      ? { bookDate: meta.bookDate }
      : {}),
    ...(typeof meta.bookTime === "string" && meta.bookTime
      ? { bookTime: meta.bookTime }
      : {}),
    ...(typeof meta.bookTitle === "string" && meta.bookTitle
      ? { bookTitle: meta.bookTitle }
      : {}),
    ...(meta.pendingActivation === true ? { pendingActivation: true } : {}),
    ...(typeof meta.activateText === "string" && meta.activateText
      ? { activateText: meta.activateText }
      : {}),
  };
}

/** Reserved job bookkeeping must never reach the model as list data. */
export function stripJobMeta(
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (!(JOB_META_KEY in data)) {
    return data;
  }
  const next = { ...data };
  delete next[JOB_META_KEY];
  return next;
}
