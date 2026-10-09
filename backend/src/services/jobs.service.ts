import { Prisma } from "@prisma/client";
import {
  JOB_URGENCIES,
  JOB_URGENCY_POLICY,
  legacyRepeatFor,
  parseJobUrgency,
  serializeRecurrence,
  type JobUrgency,
  type LlmJobAction,
  type LlmListAction,
  type LlmMessageBook,
  type Recurrence,
} from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { recordAuditEvent } from "./audit.service.js";
import { JOB_META_KEY, jobMetaFrom, type JobMeta } from "./job-meta.js";
import { toPlainJson } from "./llm-client.js";
import { scheduleSoon } from "./reminder-fire.js";
import {
  formatJerusalemDateTime,
  removeReminderAndLinkedWorkerTask,
  resolveRecurringFireAt,
  resolveReminderFireAt,
} from "./reminder.service.js";

const TASK_NAME_KEY = "שם מטלה";
const TASK_DATE_KEY = "תאריך לביצוע";
const TASK_TIME_KEY = "שעה לביצוע";

export interface OpenJobRow {
  id: string;
  label: string;
  meta: JobMeta;
  urgency?: JobUrgency;
}

function urgencyRank(urgency: JobUrgency): number {
  return JOB_URGENCIES.indexOf(urgency);
}

export interface JobReport {
  employeeId: string;
  text: string;
}

export interface JobApplyResult {
  reports: JobReport[];
  answered: string[];
  closed: string[];
  snoozed: Array<{ jobId: string; fireAt: Date }>;
  cleared: string[];
  /** Job ids this turn marked progress — a later relay may reuse that row. */
  progressed: string[];
  /** Asks the speaker must choose among when a job action had no job_id. */
  askWhich: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readLabel(data: unknown): string {
  const record = asRecord(data);
  for (const key of [TASK_NAME_KEY, "name", "task", "item_name"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return toPlainJson(value) as Prisma.InputJsonValue;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 255);
}

function asksMatch(left: string, right: string): boolean {
  const a = normalizeKey(left);
  const b = normalizeKey(right);
  return Boolean(a) && a === b;
}

function bookFields(book: LlmMessageBook | undefined): Partial<JobMeta> {
  if (!book) {
    return {};
  }
  return {
    needsBook: true,
    bookDate: book.date,
    bookTime: book.time,
    ...(book.title.trim() ? { bookTitle: book.title.trim() } : {}),
  };
}

/** Same two people, either direction — used only to skip an identical ask. */
function samePeople(
  leftAsker: string,
  leftSubject: string,
  rightAsker: string,
  rightSubject: string,
): boolean {
  return (
    (leftAsker === rightAsker && leftSubject === rightSubject) ||
    (leftAsker === rightSubject && leftSubject === rightAsker)
  );
}

async function tasksListIdFor(employeeId: string): Promise<string | null> {
  const existing = await prisma.employeeList.findFirst({
    where: { employeeId, listType: "tasks", name: "", deletedAt: null },
  });
  if (existing) {
    return existing.id;
  }
  const created = await prisma.employeeList.create({
    data: { employeeId, listType: "tasks", name: "" },
  });
  return created?.id ?? null;
}

/**
 * Open one job per relayed question the asker expects an answer to.
 * Several jobs may be open for the same two people; only an identical ask
 * is skipped. A job this turn already progressed may reuse that row.
 * The row lives on the digital worker and is visible to both people.
 */
export async function createJobsFromRelays(input: {
  userId: string;
  digitalEmployeeId: string;
  asker: { id: string; name: string };
  deliveries: Array<{
    subjectId: string;
    subjectName: string;
    text: string;
    ask: string;
    urgency?: JobUrgency;
    book?: LlmMessageBook;
  }>;
  reuseJobIds?: string[];
}): Promise<OpenJobRow[]> {
  if (input.deliveries.length === 0) {
    return [];
  }
  const listId = await tasksListIdFor(input.digitalEmployeeId);
  if (!listId) {
    return [];
  }
  const live = await prisma.employeeListItem.findMany({
    where: { listId, deletedAt: null },
  });
  const openJobs: Array<{
    id: string;
    meta: JobMeta;
    data: Record<string, unknown>;
    urgency: JobUrgency;
  }> = [];
  for (const row of live) {
    const data = asRecord(row.data);
    const meta = jobMetaFrom(data);
    if (meta?.kind !== "job") {
      continue;
    }
    openJobs.push({ id: row.id, meta, data, urgency: parseJobUrgency(row.urgency) });
  }
  const reuse = new Set(input.reuseJobIds ?? []);
  const created: OpenJobRow[] = [];
  for (const delivery of input.deliveries) {
    const urgency = delivery.urgency ?? "normal";
    const ask = (delivery.ask.trim() || delivery.text.trim()).replace(/[.!]+$/, "");
    const duplicate = openJobs.find(
      (job) =>
        asksMatch(job.meta.ask, ask) &&
        samePeople(
          job.meta.askerId,
          job.meta.subjectId,
          input.asker.id,
          delivery.subjectId,
        ),
    );
    if (duplicate) {
      await escalateJob({
        userId: input.userId,
        digitalEmployeeId: input.digitalEmployeeId,
        actorId: input.asker.id,
        job: duplicate,
        urgency,
      });
      continue;
    }
    const reusable = openJobs.filter(
      (job) =>
        reuse.has(job.id) &&
        job.meta.askerId === input.asker.id &&
        job.meta.subjectId === delivery.subjectId,
    );
    if (reusable.length === 1) {
      const existing = reusable[0];
      const label = `לבדוק עם ${delivery.subjectName}: ${ask}`.trim();
      const nextMeta: JobMeta = {
        ...existing.meta,
        ask,
        ...bookFields(delivery.book),
      };
      try {
        await prisma.employeeListItem.update({
          where: { id: existing.id },
          data: {
            itemKey: normalizeKey(label),
            data: toJsonValue({
              ...existing.data,
              [TASK_NAME_KEY]: label,
              [JOB_META_KEY]: nextMeta,
            }),
          },
        });
        existing.meta = nextMeta;
        existing.data = {
          ...existing.data,
          [TASK_NAME_KEY]: label,
          [JOB_META_KEY]: existing.meta,
        };
      } catch {
        /* keep the existing row */
      }
      await escalateJob({
        userId: input.userId,
        digitalEmployeeId: input.digitalEmployeeId,
        actorId: input.asker.id,
        job: existing,
        urgency,
      });
      continue;
    }
    const label = `לבדוק עם ${delivery.subjectName}: ${ask}`.trim();
    const meta: JobMeta = {
      kind: "job",
      askerId: input.asker.id,
      askerName: input.asker.name,
      subjectId: delivery.subjectId,
      subjectName: delivery.subjectName,
      ask,
      state: "open",
      createdAt: new Date().toISOString(),
      ...bookFields(delivery.book),
    };
    try {
      const row = await prisma.employeeListItem.create({
        data: {
          listId,
          itemKey: normalizeKey(label),
          data: toJsonValue({ [TASK_NAME_KEY]: label, [JOB_META_KEY]: meta }),
          scope: "shared",
          addedById: input.asker.id,
          visibleTo: toJsonValue([input.asker.id, delivery.subjectId]),
          urgency,
        },
      });
      if (!row?.id) {
        continue;
      }
      const job: OpenJobRow = { id: row.id, label, meta, urgency };
      const chained = await startFollowUps({
        userId: input.userId,
        digitalEmployeeId: input.digitalEmployeeId,
        actorId: input.asker.id,
        job,
      });
      created.push(chained);
      openJobs.push({
        id: row.id,
        meta: chained.meta,
        data: { [TASK_NAME_KEY]: label, [JOB_META_KEY]: chained.meta },
        urgency,
      });
      await recordAuditEvent({
        userId: input.userId,
        actorEmployeeId: input.asker.id,
        action: "job_open",
        entityType: "EmployeeListItem",
        entityId: row.id,
        summary: `open job: ${label}`,
        detail: { subjectId: delivery.subjectId, ask, urgency },
      });
    } catch {
      // A job that cannot be stored must not break the send that already happened.
    }
  }
  return created;
}

function jerusalemDateAndTime(fireAt: Date): { date: string; time: string } {
  const wall = formatJerusalemDateTime(fireAt);
  return { date: wall.slice(0, 10), time: wall.slice(11, 16) };
}

function resolveScheduledJobFireAt(input: {
  inSeconds?: number | null;
  date?: string;
  time?: string;
  recurrence?: Recurrence;
  now?: Date;
}): { fireAt: Date; recurrence?: Recurrence } | null {
  const now = input.now ?? new Date();
  if (input.recurrence) {
    return resolveRecurringFireAt(
      input.recurrence,
      input.date ?? "",
      input.time ?? "",
      now,
      input.inSeconds,
    );
  }
  const fireAt = resolveReminderFireAt(
    input.date ?? "",
    input.time ?? "",
    now,
    input.inSeconds,
    null,
  );
  return fireAt ? { fireAt } : null;
}

/**
 * Deferred check-with: save Lucy's לבדוק task with תאריך/שעה + linked Reminder.
 * No WhatsApp and no urgency follow-ups until the clock fires.
 */
export async function createScheduledJobsFromRelays(input: {
  userId: string;
  digitalEmployeeId: string;
  asker: { id: string; name: string };
  deliveries: Array<{
    subjectId: string;
    subjectName: string;
    text: string;
    ask: string;
    urgency?: JobUrgency;
    book?: LlmMessageBook;
    inSeconds?: number | null;
    date?: string;
    time?: string;
    recurrence?: Recurrence;
  }>;
  now?: Date;
}): Promise<OpenJobRow[]> {
  if (input.deliveries.length === 0) {
    return [];
  }
  const listId = await tasksListIdFor(input.digitalEmployeeId);
  if (!listId) {
    return [];
  }
  const now = input.now ?? new Date();
  const created: OpenJobRow[] = [];
  for (const delivery of input.deliveries) {
    const resolved = resolveScheduledJobFireAt({
      inSeconds: delivery.inSeconds,
      date: delivery.date,
      time: delivery.time,
      recurrence: delivery.recurrence,
      now,
    });
    if (!resolved) {
      continue;
    }
    const urgency = delivery.urgency ?? "normal";
    const ask = (delivery.ask.trim() || delivery.text.trim()).replace(/[.!]+$/, "");
    const label = `לבדוק עם ${delivery.subjectName}: ${ask}`.trim();
    const { date, time } = jerusalemDateAndTime(resolved.fireAt);
    const meta: JobMeta = {
      kind: "job",
      askerId: input.asker.id,
      askerName: input.asker.name,
      subjectId: delivery.subjectId,
      subjectName: delivery.subjectName,
      ask,
      state: "open",
      createdAt: now.toISOString(),
      pendingActivation: true,
      activateText: delivery.text.trim().slice(0, 4096),
      ...bookFields(delivery.book),
    };
    try {
      const row = await prisma.employeeListItem.create({
        data: {
          listId,
          itemKey: normalizeKey(label),
          data: toJsonValue({
            [TASK_NAME_KEY]: label,
            [TASK_DATE_KEY]: date,
            [TASK_TIME_KEY]: time,
            [JOB_META_KEY]: meta,
          }),
          scope: "shared",
          addedById: input.asker.id,
          visibleTo: toJsonValue([input.asker.id, delivery.subjectId]),
          urgency,
        },
      });
      if (!row?.id) {
        continue;
      }
      const recurrenceJson = resolved.recurrence
        ? (serializeRecurrence(resolved.recurrence) as Prisma.InputJsonValue)
        : undefined;
      const reminder = await prisma.reminder.create({
        data: {
          userId: input.userId,
          ownerId: delivery.subjectId,
          actorId: input.asker.id,
          itemKey: normalizeKey(label),
          itemLabel: label.slice(0, 255),
          listType: "tasks",
          fireAt: resolved.fireAt,
          repeat: resolved.recurrence
            ? legacyRepeatFor(resolved.recurrence)
            : "once",
          ...(recurrenceJson
            ? { recurrence: recurrenceJson, occurrencesFired: 0 }
            : {}),
          pingIds: toJsonValue([delivery.subjectId]),
          messageText: (delivery.text.trim() || ask).slice(0, 4096),
          workerItemId: row.id,
        },
      });
      if (reminder?.id) {
        await prisma.employeeListItem.update({
          where: { id: row.id },
          data: { reminderId: reminder.id },
        });
        scheduleSoon(resolved.fireAt);
      }
      created.push({ id: row.id, label, meta, urgency });
      await recordAuditEvent({
        userId: input.userId,
        actorEmployeeId: input.asker.id,
        action: "job_schedule",
        entityType: "EmployeeListItem",
        entityId: row.id,
        summary: `schedule job: ${label}`,
        detail: {
          subjectId: delivery.subjectId,
          ask,
          urgency,
          fireAt: resolved.fireAt.toISOString(),
        },
      });
    } catch {
      // A deferred job that cannot be stored must not break the chat turn.
    }
  }
  return created;
}

/**
 * Clock fired for a deferred check-with: clear תאריך/שעה, mark the job live,
 * and start urgency follow-ups. WhatsApp was already sent by reminder-fire.
 * Returns true when the worker task must be kept (not soft-deleted).
 */
export async function activateScheduledJob(input: {
  userId: string;
  workerItemId: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const row = await prisma.employeeListItem.findUnique({
    where: { id: input.workerItemId },
    include: { list: { select: { employeeId: true } } },
  });
  if (!row || row.deletedAt) {
    return false;
  }
  const data = asRecord(row.data);
  const meta = jobMetaFrom(data);
  if (meta?.kind !== "job") {
    return false;
  }
  if (!meta.pendingActivation) {
    // Already live (e.g. recurring re-fire while still open) — keep the row.
    return true;
  }
  const nextData = { ...data };
  delete nextData[TASK_DATE_KEY];
  delete nextData[TASK_TIME_KEY];
  const { pendingActivation: _pending, ...restMeta } = meta;
  const nextMeta: JobMeta = {
    ...restMeta,
    kind: "job",
    ...(meta.activateText ? { activateText: meta.activateText } : {}),
  };
  await prisma.employeeListItem.update({
    where: { id: row.id },
    data: {
      data: toJsonValue({
        ...nextData,
        [JOB_META_KEY]: nextMeta,
      }),
    },
  });
  const urgency = parseJobUrgency(row.urgency);
  await startFollowUps({
    userId: input.userId,
    digitalEmployeeId: row.list.employeeId,
    actorId: meta.askerId,
    job: { id: row.id, meta: nextMeta, urgency },
    now,
  });
  await recordAuditEvent({
    userId: input.userId,
    actorEmployeeId: meta.askerId,
    action: "job_activate",
    entityType: "EmployeeListItem",
    entityId: row.id,
    summary: `activate job: ${readLabel(row.data)}`,
  });
  return true;
}

/**
 * Close the live job the asker holds on a subject once the subject's answer is in
 * hand (a consulted digital worker answers inside the asker's own turn).
 */
export async function answerOpenJobForPair(input: {
  userId: string;
  digitalEmployeeId: string;
  askerId: string;
  subjectId: string;
  answer: string;
}): Promise<string | null> {
  const listId = await tasksListIdFor(input.digitalEmployeeId);
  if (!listId) {
    return null;
  }
  const live = await prisma.employeeListItem.findMany({
    where: { listId, deletedAt: null },
  });
  const matches = (live ?? []).filter((item) => {
    const meta = jobMetaFrom(item.data);
    return (
      meta?.kind === "job" &&
      meta.askerId === input.askerId &&
      meta.subjectId === input.subjectId
    );
  });
  const row = matches.sort((left, right) => {
    const leftAt = left.createdAt instanceof Date ? left.createdAt.getTime() : 0;
    const rightAt = right.createdAt instanceof Date ? right.createdAt.getTime() : 0;
    return rightAt - leftAt;
  })[0];
  const meta = row ? jobMetaFrom(row.data) : null;
  if (!row || !meta) {
    return null;
  }
  await sweepNudge(meta, input.userId, input.askerId);
  await closeJobRow(row.id);
  await recordAuditEvent({
    userId: input.userId,
    actorEmployeeId: input.subjectId,
    action: "job_answer",
    entityType: "EmployeeListItem",
    entityId: row.id,
    summary: `answer job: ${readLabel(row.data)}`,
    detail: { answer: input.answer },
  });
  return row.id;
}

/** Live jobs on this worker that the viewer is part of (asker or subject). */
export async function listOpenJobsForViewer(input: {
  digitalEmployeeId: string;
  viewerId: string;
}): Promise<OpenJobRow[]> {
  if (!prisma.employeeListItem?.findMany) {
    return [];
  }
  try {
    const rows = await prisma.employeeListItem.findMany({
      where: {
        deletedAt: null,
        list: { employeeId: input.digitalEmployeeId, listType: "tasks" },
      },
      orderBy: { createdAt: "asc" },
    });
    const jobs: OpenJobRow[] = [];
    for (const row of rows ?? []) {
      const meta = jobMetaFrom(row.data);
      if (!meta || meta.kind !== "job") {
        continue;
      }
      if (meta.askerId !== input.viewerId && meta.subjectId !== input.viewerId) {
        continue;
      }
      jobs.push({
        id: row.id,
        label: readLabel(row.data),
        meta,
        urgency: parseJobUrgency(row.urgency),
      });
    }
    return jobs;
  } catch {
    return [];
  }
}

export function meetingListsForAnswers(
  jobs: OpenJobRow[],
  actions: LlmJobAction[],
): LlmListAction[] {
  const byId = new Map(jobs.map((job) => [job.id, job] as const));
  const lists: LlmListAction[] = [];
  for (const action of actions) {
    if (action.action !== "answer") {
      continue;
    }
    const job = byId.get(action.jobId);
    if (!job?.meta.needsBook || !job.meta.bookDate || !job.meta.bookTime) {
      continue;
    }
    const targets = [job.meta.askerName, job.meta.subjectName].filter(Boolean);
    lists.push({
      action: "add",
      listType: "tasks",
      listName: "",
      targets,
      items: [
        {
          "שם מטלה": job.meta.bookTitle || "פגישה",
          "תאריך לביצוע": job.meta.bookDate,
          "שעה לביצוע": job.meta.bookTime,
          "יום שלם": false,
        },
      ],
    });
  }
  return lists;
}

/** A clock still ahead of us; one that already fired must not hold the job back. */
function pendingClock(meta: JobMeta, now: Date): string | null {
  if (!meta.nudgeFireAt) {
    return null;
  }
  const at = Date.parse(meta.nudgeFireAt);
  return Number.isFinite(at) && at > now.getTime() ? meta.nudgeFireAt : null;
}

function urgencyFields(job: OpenJobRow, clock: string | null): Record<string, unknown> {
  const urgency = job.urgency ?? "normal";
  if (urgency === "normal") {
    return {};
  }
  const policy = JOB_URGENCY_POLICY[urgency];
  const sent = job.meta.autoNudgesSent ?? 0;
  return {
    urgency,
    follow_ups_sent: sent,
    follow_ups_left: Math.max(0, policy.autoNudges - sent),
    ...(clock && job.meta.nudgeAuto ? { next_follow_up_at: clock } : {}),
  };
}

export function formatOpenJobsContext(
  jobs: OpenJobRow[],
  viewerId: string,
  now: Date = new Date(),
): string {
  if (jobs.length === 0) {
    return "";
  }
  const rows = jobs.map((job) => {
    const clock = pendingClock(job.meta, now);
    const snoozed = Boolean(clock && !job.meta.nudgeAuto);
    const scheduled = Boolean(job.meta.pendingActivation);
    return {
      job_id: job.id,
      asker: job.meta.askerName,
      subject: job.meta.subjectName,
      ask: job.meta.ask,
      task: job.label,
      viewer_is:
        job.meta.askerId === job.meta.subjectId &&
        job.meta.subjectId === viewerId
          ? "subject"
          : job.meta.askerId === viewerId
            ? "asker"
            : "subject",
      state: job.meta.state,
      ...urgencyFields(job, clock),
      ...(job.meta.progress ? { progress: job.meta.progress } : {}),
      ...(scheduled
        ? { scheduled: true, raisable: false }
        : snoozed
          ? { reminder_at: clock, raisable: false }
          : {
              ...(job.meta.deferredAt ? { deferred: true } : {}),
              raisable: job.meta.subjectId === viewerId,
            }),
      ...(job.meta.needsBook
        ? {
            book_on_yes: true,
            ...(job.meta.bookDate ? { book_date: job.meta.bookDate } : {}),
            ...(job.meta.bookTime ? { book_time: job.meta.bookTime } : {}),
            ...(job.meta.bookTitle ? { book_title: job.meta.bookTitle } : {}),
          }
        : {}),
      opened_at: job.meta.createdAt,
    };
  });
  return [
    "OPEN_JOBS:",
    "Jobs you still owe for these people. Only these exist — never invent a job. These ARE your work: when asked what you need to do/check (מה את צריכה לעשות / לברר / מה יש לך / מה פתוח אצלך), list EVERY row — including scheduled=true — even if WORKER_SAVED_DATA looks empty. That ask is INVENTORY: do not RAISE; phrase each from ask; scheduled=true → say it is scheduled / not yet due.",
    "The same job also appears in WORKER_SAVED_DATA as a «לבדוק עם X: …» task line. Never read that label out loud — say it the way THIS speaker should hear it:",
    "viewer_is=subject → this speaker owes the answer. Speak to them in second person and name the asker: «עמית ביקש ממני לתאם איתך פגישת עבודה ליום שלישי» / «אני צריכה לבדוק מה שלומך (משימה מעמית)». Never say «לבדוק עם ערן» to ערן himself. Self-job (asker===subject) → their own check in second person: «רצית שאבדוק איתך אם קנית שוקו — קנית?» — never «עמית ביקש ממני…», «<name> מחכה לתשובה», or first-person ask copy (הכנתי / קניתי). On INVENTORY do not append the live question — list the check only.",
    "viewer_is=asker → this speaker is waiting for it. Third person about the subject: «אני צריכה לבדוק עם ערן לתאם פגישת עבודה ליום שלישי (בשבילך)».",
    "raisable=false means a reminder clock is already set — wait for it, do not raise early. scheduled=true means a deferred check is waiting for its clock — do not ask yet; the server will send at fire; still list it on INVENTORY. deferred=true means they said not now, with no clock: still raisable. Raise only when not answering an inventory ask, at the start of a chat, when they switch topic, or once there is room after their own request. Do not raise it again in the same reply where they just said לא כרגע.",
    "urgency (only when not normal): urgent / very_urgent — the server sends the subject follow-ups on its own (follow_ups_sent / follow_ups_left / next_follow_up_at); never schedule them yourself. viewer_is=subject: urgent → raise it FIRST, before answering their own request, and say it is urgent («עמית ביקש בדחיפות…»); on «לא כרגע» with no time, offer a short snooze once («אזכיר לך בעוד חצי שעה?»). very_urgent → raise it first in EVERY reply while it is open, even right after «לא כרגע» (one short line), and say it is very urgent. viewer_is=asker asking about it → say how many follow-ups went out and whether more are coming («שלחתי לערן 2 תזכורות, ואמשיך לנדנד»); when follow_ups_left=0 say he still has not answered.",
    "Answer / decline / progress / counter / snooze / close a job with metadata.jobs using its job_id. Never omit job_id. Never open a second task row for the same job. counter flips who must answer and keeps this one job.",
    "book_on_yes=true: the person who must answer is approving a meeting/call slot. כן / מאשר / אוקיי / קבע → jobs.answer AND lists add list_type=tasks, targets=[asker, subject], item שם מטלה=book_title (or פגישה) with תאריך לביצוע=book_date and שעה לביצוע=book_time. The server also saves that meeting from these fields when you forget the list.",
    JSON.stringify(rows),
  ].join("\n");
}

async function sweepNudge(meta: JobMeta, userId: string, actorId: string): Promise<void> {
  if (meta.nudgeReminderId) {
    await removeReminderAndLinkedWorkerTask({
      id: meta.nudgeReminderId,
      workerItemId: meta.nudgeItemId ?? null,
      userId,
      actorEmployeeId: actorId,
    });
    return;
  }
  if (meta.nudgeItemId) {
    await prisma.employeeListItem.updateMany({
      where: { id: meta.nudgeItemId, deletedAt: null },
      data: { deletedAt: new Date(), reminderId: null },
    });
  }
}

async function rewriteJob(itemId: string, meta: JobMeta, label: string): Promise<void> {
  const row = await prisma.employeeListItem.findUnique({ where: { id: itemId } });
  if (!row) {
    return;
  }
  const data = asRecord(row.data);
  await prisma.employeeListItem.update({
    where: { id: itemId },
    data: {
      itemKey: normalizeKey(label),
      data: toJsonValue({
        ...data,
        [TASK_NAME_KEY]: label,
        [JOB_META_KEY]: meta,
      }),
    },
  });
}

async function patchJobMeta(itemId: string, meta: JobMeta): Promise<void> {
  const row = await prisma.employeeListItem.findUnique({ where: { id: itemId } });
  if (!row) {
    return;
  }
  const data = asRecord(row.data);
  await prisma.employeeListItem.update({
    where: { id: itemId },
    data: { data: toJsonValue({ ...data, [JOB_META_KEY]: meta }) },
  });
}

/**
 * Soft-delete a finished job, or — when a recurring schedule clock is still
 * active — reset the same row to pendingActivation with the next תאריך/שעה.
 */
async function closeJobRow(itemId: string): Promise<void> {
  const row =
    typeof prisma.employeeListItem.findUnique === "function"
      ? await prisma.employeeListItem.findUnique({ where: { id: itemId } })
      : null;
  if (row?.deletedAt) {
    return;
  }
  if (row) {
    const data = asRecord(row.data);
    const meta = jobMetaFrom(data);
    if (meta?.kind === "job" && row.reminderId && prisma.reminder?.findUnique) {
      const reminder = await prisma.reminder.findUnique({
        where: { id: row.reminderId },
      });
      if (
        reminder &&
        reminder.status === "active" &&
        reminder.fireAt.getTime() > Date.now()
      ) {
        const { date, time } = jerusalemDateAndTime(reminder.fireAt);
        const {
          deferredAt: _d,
          nudgeReminderId: _nr,
          nudgeItemId: _ni,
          nudgeFireAt: _nf,
          nudgeAuto: _na,
          autoNudgesSent: _as,
          progress: _p,
          ...base
        } = meta;
        const nextMeta: JobMeta = {
          ...base,
          kind: "job",
          state: "open",
          pendingActivation: true,
          ...(meta.activateText ? { activateText: meta.activateText } : {}),
        };
        await prisma.employeeListItem.update({
          where: { id: itemId },
          data: {
            data: toJsonValue({
              ...data,
              [TASK_DATE_KEY]: date,
              [TASK_TIME_KEY]: time,
              [JOB_META_KEY]: nextMeta,
            }),
            urgency: row.urgency,
          },
        });
        return;
      }
    }
  }
  await prisma.employeeListItem.updateMany({
    where: { id: itemId, deletedAt: null },
    data: { deletedAt: new Date(), reminderId: null },
  });
}

function fireAtFrom(action: LlmJobAction): Date | null {
  if (!action.time && !(typeof action.in === "number" && action.in > 0)) {
    return null;
  }
  return resolveReminderFireAt("", action.time, new Date(), action.in, null);
}

function addReport(
  result: JobApplyResult,
  speakerId: string,
  employeeId: string,
  text: string,
): void {
  const body = text.trim();
  if (!body || employeeId === speakerId) {
    return;
  }
  result.reports.push({ employeeId, text: body });
}

function spokenEchoes(response: string, body: string, extra: string): boolean {
  const spoken = response.trim();
  const quoted = body.trim();
  if (!spoken || !quoted) {
    return false;
  }
  if (spoken === quoted) {
    return true;
  }
  return spoken.includes(quoted) && spoken.length <= quoted.length + extra.length + 8;
}

/**
 * The speaker must not hear a line that was written for someone else:
 * the relay body (ask), or the report that the server delivers to the asker.
 */
export function correctMisaddressedJobReply(input: {
  response: string;
  relays: Array<{ targetName: string; text: string }>;
  reports: Array<{ toName: string; text: string }>;
}): string | null {
  const spoken = input.response.trim();
  if (!spoken) {
    return null;
  }
  const report = input.reports.find(
    (row) => row.toName.trim() && spokenEchoes(spoken, row.text, row.toName),
  );
  if (report) {
    return `אעדכן את ${report.toName.trim()}.`;
  }
  const relay = input.relays.find(
    (row) => row.targetName.trim() && spokenEchoes(spoken, row.text, row.targetName),
  );
  if (relay) {
    return `שלחתי ל${relay.targetName.trim()}.`;
  }
  return null;
}

function defaultReport(job: OpenJobRow, outcome: string, said: string): string {
  const quoted = job.meta.ask ? ` בקשר ל«${job.meta.ask}»` : "";
  const detail = said.trim() ? `: ${said.trim()}` : "";
  return `${job.meta.subjectName} ${outcome}${detail}${quoted}`;
}

type NudgeableJob = Pick<OpenJobRow, "id" | "meta" | "urgency">;

function nudgeText(job: NudgeableJob): string {
  const self = job.meta.askerId === job.meta.subjectId;
  const base = self
    ? job.meta.ask
    : job.meta.askerName
      ? `${job.meta.askerName} מחכה לתשובה: ${job.meta.ask}`
      : job.meta.ask;
  const label = JOB_URGENCY_POLICY[job.urgency ?? "normal"].label;
  return label ? `${label} — ${base}` : base;
}

/** Create the follow-up clock plus its own nudge task row on the worker. */
async function openNudge(input: {
  userId: string;
  digitalEmployeeId: string;
  actorId: string;
  job: NudgeableJob;
  fireAt: Date;
  auto?: boolean;
}): Promise<{ reminderId: string; itemId: string } | null> {
  const listId = await tasksListIdFor(input.digitalEmployeeId);
  if (!listId) {
    return null;
  }
  const label = `להזכיר ל${input.job.meta.subjectName} ${input.job.meta.ask}`.trim();
  const item = await prisma.employeeListItem.create({
    data: {
      listId,
      itemKey: normalizeKey(label),
      data: toJsonValue({
        [TASK_NAME_KEY]: label,
        [JOB_META_KEY]: {
          kind: "nudge",
          askerId: input.job.meta.askerId,
          askerName: input.job.meta.askerName,
          subjectId: input.job.meta.subjectId,
          subjectName: input.job.meta.subjectName,
          ask: input.job.meta.ask,
          state: "open",
          createdAt: new Date().toISOString(),
          jobItemId: input.job.id,
          ...(input.auto ? { auto: true } : {}),
        } satisfies JobMeta,
      }),
      scope: "shared",
      addedById: input.actorId,
      visibleTo: toJsonValue([input.job.meta.askerId, input.job.meta.subjectId]),
    },
  });
  if (!item?.id) {
    return null;
  }
  const reminder = await prisma.reminder.create({
    data: {
      userId: input.userId,
      ownerId: input.job.meta.subjectId,
      actorId: input.actorId,
      itemKey: normalizeKey(label),
      itemLabel: label.slice(0, 255),
      listType: "tasks",
      fireAt: input.fireAt,
      repeat: "once",
      pingIds: toJsonValue([input.job.meta.subjectId]),
      messageText: nudgeText(input.job),
    },
  });
  if (!reminder?.id) {
    return null;
  }
  await prisma.employeeListItem.update({
    where: { id: item.id },
    data: { reminderId: reminder.id },
  });
  await prisma.reminder.update({
    where: { id: reminder.id },
    data: { workerItemId: item.id },
  });
  scheduleSoon(input.fireAt);
  return { reminderId: reminder.id, itemId: item.id };
}

/**
 * Schedule the next urgency follow-up when the job's policy still has one left.
 * Returns the job with its meta updated (unchanged when nothing was scheduled).
 */
async function startFollowUps<T extends NudgeableJob>(input: {
  userId: string;
  digitalEmployeeId: string;
  actorId: string;
  job: T;
  now?: Date;
}): Promise<T> {
  const policy = JOB_URGENCY_POLICY[input.job.urgency ?? "normal"];
  const sent = input.job.meta.autoNudgesSent ?? 0;
  if (sent >= policy.autoNudges || policy.intervalSeconds <= 0) {
    return input.job;
  }
  const fireAt = new Date((input.now ?? new Date()).getTime() + policy.intervalSeconds * 1000);
  try {
    const nudge = await openNudge({
      userId: input.userId,
      digitalEmployeeId: input.digitalEmployeeId,
      actorId: input.actorId,
      job: input.job,
      fireAt,
      auto: true,
    });
    if (!nudge) {
      return input.job;
    }
    const meta: JobMeta = {
      ...input.job.meta,
      nudgeReminderId: nudge.reminderId,
      nudgeItemId: nudge.itemId,
      nudgeFireAt: fireAt.toISOString(),
      nudgeAuto: true,
    };
    await patchJobMeta(input.job.id, meta);
    return { ...input.job, meta };
  } catch {
    // A follow-up that cannot be scheduled must not break the send that already happened.
    return input.job;
  }
}

/** Raise an open job's urgency when the asker repeats it more urgently. */
async function escalateJob(input: {
  userId: string;
  digitalEmployeeId: string;
  actorId: string;
  job: { id: string; meta: JobMeta; urgency: JobUrgency };
  urgency: JobUrgency;
}): Promise<void> {
  if (urgencyRank(input.urgency) <= urgencyRank(input.job.urgency)) {
    return;
  }
  try {
    await prisma.employeeListItem.update({
      where: { id: input.job.id },
      data: { urgency: input.urgency },
    });
  } catch {
    return;
  }
  input.job.urgency = input.urgency;
  // A snooze the subject asked for stays; an older follow-up is replaced by the faster cadence.
  if (input.job.meta.nudgeReminderId && !input.job.meta.nudgeAuto) {
    return;
  }
  await sweepNudge(input.job.meta, input.userId, input.actorId);
  const cleared: JobMeta = {
    ...input.job.meta,
    nudgeReminderId: undefined,
    nudgeItemId: undefined,
    nudgeFireAt: undefined,
    nudgeAuto: undefined,
    autoNudgesSent: undefined,
  };
  const next = await startFollowUps({
    userId: input.userId,
    digitalEmployeeId: input.digitalEmployeeId,
    actorId: input.actorId,
    job: { ...input.job, meta: cleared },
  });
  if (next.meta === cleared) {
    await patchJobMeta(input.job.id, cleared);
  }
  input.job.meta = next.meta;
}

function exhaustedNotice(job: NudgeableJob, sent: number): string {
  const quoted = job.meta.ask ? ` על «${job.meta.ask}»` : "";
  const tail = job.urgency === "very_urgent" ? " כדאי להתקשר אליו ישירות." : "";
  return `${job.meta.subjectName} עדיין לא ענה${quoted} — שלחתי לו ${sent} תזכורות.${tail}`;
}

/** Tell the asker the follow-ups ran out, through the regular one-shot clock delivery. */
async function notifyAskerExhausted(input: {
  userId: string;
  job: NudgeableJob;
  sent: number;
  now: Date;
}): Promise<void> {
  const text = exhaustedNotice(input.job, input.sent);
  const label = `עדכון: ${input.job.meta.subjectName} לא ענה`;
  await prisma.reminder.create({
    data: {
      userId: input.userId,
      ownerId: input.job.meta.askerId,
      actorId: input.job.meta.askerId,
      itemKey: normalizeKey(label),
      itemLabel: label.slice(0, 255),
      listType: "tasks",
      fireAt: input.now,
      repeat: "once",
      pingIds: toJsonValue([input.job.meta.askerId]),
      messageText: text,
    },
  });
  scheduleSoon(input.now);
}

/**
 * A job's nudge clock just fired. Clear the spent clock off the job so it is raisable
 * again, then run the job's urgency policy: schedule the next follow-up, or tell the
 * asker the follow-ups ran out.
 */
export async function continueJobAfterNudge(input: {
  userId: string;
  nudgeItemId: string;
  nudge: JobMeta;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const jobItemId = input.nudge.jobItemId;
  if (input.nudge.kind !== "nudge" || !jobItemId) {
    return;
  }
  const row = await prisma.employeeListItem.findUnique({
    where: { id: jobItemId },
    include: { list: { select: { employeeId: true } } },
  });
  if (!row || row.deletedAt) {
    return;
  }
  const meta = jobMetaFrom(row.data);
  if (meta?.kind !== "job") {
    return;
  }
  // A newer clock already replaced this one.
  if (meta.nudgeItemId && meta.nudgeItemId !== input.nudgeItemId) {
    return;
  }
  const urgency = parseJobUrgency(row.urgency);
  const sent = (meta.autoNudgesSent ?? 0) + (input.nudge.auto ? 1 : 0);
  const cleared: JobMeta = {
    ...meta,
    nudgeReminderId: undefined,
    nudgeItemId: undefined,
    nudgeFireAt: undefined,
    nudgeAuto: undefined,
    ...(sent > 0 ? { autoNudgesSent: sent } : {}),
  };
  const job: NudgeableJob = { id: row.id, meta: cleared, urgency };
  const next = await startFollowUps({
    userId: input.userId,
    digitalEmployeeId: row.list.employeeId,
    actorId: meta.askerId,
    job,
    now,
  });
  if (next.meta !== cleared) {
    return;
  }
  await patchJobMeta(row.id, cleared);
  const policy = JOB_URGENCY_POLICY[urgency];
  // Self-check: no separate asker to notify when follow-ups run out.
  if (
    input.nudge.auto &&
    policy.autoNudges > 0 &&
    sent >= policy.autoNudges &&
    meta.askerId !== meta.subjectId
  ) {
    await notifyAskerExhausted({ userId: input.userId, job, sent, now });
  }
}

/**
 * Run the lifecycle actions the model emitted for jobs it was shown this turn.
 * Reports back to the asker are returned for delivery by the caller.
 */
function slotText(action: LlmJobAction): string {
  const words = action.answerText.trim();
  if (words) {
    return words;
  }
  const clock = action.time.trim();
  const day = action.date?.trim() ?? "";
  return [day, clock ? `בשעה ${clock}` : ""].filter(Boolean).join(" ");
}

function withJobId(
  action: LlmJobAction,
  jobs: OpenJobRow[],
  speakerId: string,
): { action: LlmJobAction; choices: string[] } {
  if (action.jobId.trim()) {
    return { action, choices: [] };
  }
  const owed = jobs.filter((job) => job.meta.subjectId === speakerId);
  if (owed.length === 1) {
    return { action: { ...action, jobId: owed[0].id }, choices: [] };
  }
  if (owed.length > 1) {
    return {
      action,
      choices: owed.map((job) => job.meta.ask || job.label).filter(Boolean),
    };
  }
  return { action, choices: [] };
}

export async function applyJobActions(input: {
  userId: string;
  digitalEmployeeId: string;
  speaker: { id: string; name: string };
  actions: LlmJobAction[];
  jobs: OpenJobRow[];
}): Promise<JobApplyResult> {
  const result: JobApplyResult = {
    reports: [],
    answered: [],
    closed: [],
    snoozed: [],
    cleared: [],
    progressed: [],
    askWhich: [],
  };
  if (input.actions.length === 0 || input.jobs.length === 0) {
    return result;
  }
  const byId = new Map(input.jobs.map((job) => [job.id, job] as const));
  const handled = new Set<string>();
  for (const raw of input.actions) {
    const bound = withJobId(raw, input.jobs, input.speaker.id);
    if (bound.choices.length > 0) {
      for (const choice of bound.choices) {
        if (!result.askWhich.includes(choice)) {
          result.askWhich.push(choice);
        }
      }
      continue;
    }
    const action = bound.action;
    const job = byId.get(action.jobId);
    if (!job || handled.has(`${action.action}:${action.jobId}`)) {
      continue;
    }
    handled.add(`${action.action}:${action.jobId}`);
    const speakerIsAsker = job.meta.askerId === input.speaker.id;
    try {
      if (action.action === "answer" || action.action === "decline") {
        await sweepNudge(job.meta, input.userId, input.speaker.id);
        await closeJobRow(job.id);
        result.answered.push(job.id);
        addReport(
          result,
          input.speaker.id,
          job.meta.askerId,
          action.reportText.trim() ||
            defaultReport(
              job,
              action.action === "answer" ? "מוסר" : "לא יכול",
              action.answerText,
            ),
        );
        await recordAuditEvent({
          userId: input.userId,
          actorEmployeeId: input.speaker.id,
          action: `job_${action.action}`,
          entityType: "EmployeeListItem",
          entityId: job.id,
          summary: `${action.action} job: ${job.label}`,
          detail: { answer: action.answerText },
        });
        continue;
      }
      if (action.action === "progress") {
        await patchJobMeta(job.id, {
          ...job.meta,
          state: "progress",
          progress: action.answerText,
        });
        result.progressed.push(job.id);
        continue;
      }
      if (action.action === "counter") {
        const proposed = slotText(action);
        if (!proposed) {
          continue;
        }
        await sweepNudge(job.meta, input.userId, input.speaker.id);
        const meta: JobMeta = {
          ...job.meta,
          askerId: job.meta.subjectId,
          askerName: job.meta.subjectName,
          subjectId: job.meta.askerId,
          subjectName: job.meta.askerName,
          ask: proposed,
          state: "open",
          progress: undefined,
          deferredAt: undefined,
          nudgeReminderId: undefined,
          nudgeItemId: undefined,
          nudgeFireAt: undefined,
          nudgeAuto: undefined,
          autoNudgesSent: undefined,
          needsBook: true,
          ...(action.date ? { bookDate: action.date } : {}),
          ...(action.time ? { bookTime: action.time } : {}),
        };
        const label = `לבדוק עם ${meta.subjectName}: ${proposed}`.trim();
        await rewriteJob(job.id, meta, label);
        // The other side now owes the answer; the same urgency chases them.
        await startFollowUps({
          userId: input.userId,
          digitalEmployeeId: input.digitalEmployeeId,
          actorId: input.speaker.id,
          job: { id: job.id, meta, urgency: job.urgency },
        });
        addReport(
          result,
          input.speaker.id,
          meta.subjectId,
          action.reportText.trim() ||
            `${input.speaker.name} רוצה לשנות את המועד ל${proposed}. האם לאשר?`,
        );
        await recordAuditEvent({
          userId: input.userId,
          actorEmployeeId: input.speaker.id,
          action: "job_counter",
          entityType: "EmployeeListItem",
          entityId: job.id,
          summary: `counter job: ${label}`,
          detail: { ask: proposed },
        });
        continue;
      }
      if (action.action === "snooze") {
        const fireAt = fireAtFrom(action);
        if (!fireAt) {
          // No clock named — hold off until they bring it up again.
          await patchJobMeta(job.id, {
            ...job.meta,
            deferredAt: new Date().toISOString(),
          });
          continue;
        }
        await sweepNudge(job.meta, input.userId, input.speaker.id);
        const nudge = await openNudge({
          userId: input.userId,
          digitalEmployeeId: input.digitalEmployeeId,
          actorId: input.speaker.id,
          job,
          fireAt,
        });
        if (!nudge) {
          continue;
        }
        await patchJobMeta(job.id, {
          ...job.meta,
          deferredAt: undefined,
          nudgeReminderId: nudge.reminderId,
          nudgeItemId: nudge.itemId,
          nudgeFireAt: fireAt.toISOString(),
          nudgeAuto: undefined,
        });
        result.snoozed.push({ jobId: job.id, fireAt });
        continue;
      }
      if (action.action === "clear_clock") {
        await sweepNudge(job.meta, input.userId, input.speaker.id);
        result.cleared.push(job.id);
        // Whoever opened the job may end it by cancelling its clock; anyone
        // else only drops the reminder and leaves the job open.
        if (speakerIsAsker) {
          await closeJobRow(job.id);
          result.closed.push(job.id);
          continue;
        }
        await patchJobMeta(job.id, {
          ...job.meta,
          nudgeReminderId: undefined,
          nudgeItemId: undefined,
          nudgeFireAt: undefined,
          nudgeAuto: undefined,
        });
        continue;
      }
      // close
      await sweepNudge(job.meta, input.userId, input.speaker.id);
      await closeJobRow(job.id);
      result.closed.push(job.id);
      const other = speakerIsAsker ? job.meta.subjectId : job.meta.askerId;
      addReport(
        result,
        input.speaker.id,
        other,
        action.reportText.trim() ||
          `${input.speaker.name} ביטל את הבקשה${job.meta.ask ? ` בקשר ל«${job.meta.ask}»` : ""}.`,
      );
      await recordAuditEvent({
        userId: input.userId,
        actorEmployeeId: input.speaker.id,
        action: "job_close",
        entityType: "EmployeeListItem",
        entityId: job.id,
        summary: `close job: ${job.label}`,
      });
    } catch {
      // Never let one job action break the rest of the turn.
    }
  }
  return result;
}

/** Drop the follow-up clock when a job row is removed through lists.remove. */
export async function sweepJobNudgesForRemovedItems(input: {
  userId: string;
  actorId: string;
  itemIds: string[];
}): Promise<void> {
  if (input.itemIds.length === 0 || !prisma.employeeListItem?.findMany) {
    return;
  }
  try {
    const rows = await prisma.employeeListItem.findMany({
      where: { id: { in: input.itemIds } },
    });
    for (const row of rows ?? []) {
      const meta = jobMetaFrom(row.data);
      if (meta?.kind === "job") {
        await sweepNudge(meta, input.userId, input.actorId);
      }
    }
  } catch {
    // Sweeping is best-effort cleanup.
  }
}
