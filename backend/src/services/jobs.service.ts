import { Prisma } from "@prisma/client";
import type { LlmJobAction, LlmListAction, LlmMessageBook } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { recordAuditEvent } from "./audit.service.js";
import { JOB_META_KEY, jobMetaFrom, type JobMeta } from "./job-meta.js";
import { toPlainJson } from "./llm-client.js";
import { scheduleSoon } from "./reminder-fire.js";
import {
  removeReminderAndLinkedWorkerTask,
  resolveReminderFireAt,
} from "./reminder.service.js";

const TASK_NAME_KEY = "שם מטלה";

export interface OpenJobRow {
  id: string;
  label: string;
  meta: JobMeta;
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
  }> = [];
  for (const row of live) {
    const data = asRecord(row.data);
    const meta = jobMetaFrom(data);
    if (meta?.kind !== "job") {
      continue;
    }
    openJobs.push({ id: row.id, meta, data });
  }
  const reuse = new Set(input.reuseJobIds ?? []);
  const created: OpenJobRow[] = [];
  for (const delivery of input.deliveries) {
    if (delivery.subjectId === input.asker.id) {
      continue;
    }
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
        },
      });
      if (!row?.id) {
        continue;
      }
      created.push({ id: row.id, label, meta });
      openJobs.push({ id: row.id, meta, data: { [TASK_NAME_KEY]: label, [JOB_META_KEY]: meta } });
      await recordAuditEvent({
        userId: input.userId,
        actorEmployeeId: input.asker.id,
        action: "job_open",
        entityType: "EmployeeListItem",
        entityId: row.id,
        summary: `open job: ${label}`,
        detail: { subjectId: delivery.subjectId, ask },
      });
    } catch {
      // A job that cannot be stored must not break the send that already happened.
    }
  }
  return created;
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
      jobs.push({ id: row.id, label: readLabel(row.data), meta });
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

export function formatOpenJobsContext(
  jobs: OpenJobRow[],
  viewerId: string,
): string {
  if (jobs.length === 0) {
    return "";
  }
  const rows = jobs.map((job) => ({
    job_id: job.id,
    asker: job.meta.askerName,
    subject: job.meta.subjectName,
    ask: job.meta.ask,
    task: job.label,
    viewer_is: job.meta.askerId === viewerId ? "asker" : "subject",
    state: job.meta.state,
    ...(job.meta.progress ? { progress: job.meta.progress } : {}),
    ...(job.meta.nudgeFireAt
      ? { reminder_at: job.meta.nudgeFireAt, raisable: false }
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
  }));
  return [
    "OPEN_JOBS:",
    "Jobs you still owe for these people. Only these exist — never invent a job. These ARE your work: when asked what you need to do, list them even if WORKER_SAVED_DATA looks empty.",
    "The same job also appears in WORKER_SAVED_DATA as a «לבדוק עם X: …» task line. Never read that label out loud — say it the way THIS speaker should hear it:",
    "viewer_is=subject → this speaker owes the answer. Speak to them in second person and name the asker: «עמית ביקש ממני לתאם איתך פגישת עבודה ליום שלישי» / «אני צריכה לבדוק מה שלומך (משימה מעמית)». Never say «לבדוק עם ערן» to ערן himself.",
    "viewer_is=asker → this speaker is waiting for it. Third person about the subject: «אני צריכה לבדוק עם ערן לתאם פגישת עבודה ליום שלישי (בשבילך)».",
    "raisable=false means a reminder clock is already set — wait for it, do not raise early. deferred=true means they said not now, with no clock: still raisable. Raise it at the start of a chat, when they switch topic, or once there is room after their own request. Do not raise it again in the same reply where they just said לא כרגע.",
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

async function closeJobRow(itemId: string): Promise<void> {
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

/** Create the follow-up clock plus its own nudge task row on the worker. */
async function openNudge(input: {
  userId: string;
  digitalEmployeeId: string;
  actorId: string;
  job: OpenJobRow;
  fireAt: Date;
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
      messageText: input.job.meta.askerName
        ? `${input.job.meta.askerName} מחכה לתשובה: ${input.job.meta.ask}`
        : input.job.meta.ask,
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
          needsBook: true,
          ...(action.date ? { bookDate: action.date } : {}),
          ...(action.time ? { bookTime: action.time } : {}),
        };
        const label = `לבדוק עם ${meta.subjectName}: ${proposed}`.trim();
        await rewriteJob(job.id, meta, label);
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
