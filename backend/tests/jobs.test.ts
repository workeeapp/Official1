import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  itemCreate,
  itemUpdate,
  itemUpdateMany,
  itemFindMany,
  itemFindUnique,
  listFindFirst,
  listCreate,
  reminderCreate,
  reminderUpdate,
  reminderFindFirst,
  reminderDelete,
  auditCreate,
} = vi.hoisted(() => ({
  itemCreate: vi.fn(),
  itemUpdate: vi.fn(),
  itemUpdateMany: vi.fn(),
  itemFindMany: vi.fn(),
  itemFindUnique: vi.fn(),
  listFindFirst: vi.fn(),
  listCreate: vi.fn(),
  reminderCreate: vi.fn(),
  reminderUpdate: vi.fn(),
  reminderFindFirst: vi.fn(),
  reminderDelete: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    employeeList: { findFirst: listFindFirst, create: listCreate },
    employeeListItem: {
      create: itemCreate,
      update: itemUpdate,
      updateMany: itemUpdateMany,
      findMany: itemFindMany,
      findUnique: itemFindUnique,
    },
    reminder: {
      create: reminderCreate,
      update: reminderUpdate,
      findFirst: reminderFindFirst,
      delete: reminderDelete,
    },
    auditEvent: { create: auditCreate },
  },
}));

import {
  applyJobActions,
  correctMisaddressedJobReply,
  createJobsFromRelays,
  formatOpenJobsContext,
  listOpenJobsForViewer,
  meetingListsForAnswers,
  type OpenJobRow,
} from "../src/services/jobs.service.js";
import { JOB_META_KEY, jobMetaFrom, stripJobMeta } from "../src/services/job-meta.js";

const AMIT = "amit-id";
const ERAN = "eran-id";
const LUCY = "lucy-id";

function jobRow(overrides: Partial<OpenJobRow["meta"]> = {}): OpenJobRow {
  return {
    id: "job-1",
    label: "לבדוק עם ערן אם קנה חלב",
    meta: {
      kind: "job",
      askerId: AMIT,
      askerName: "עמית",
      subjectId: ERAN,
      subjectName: "ערן",
      ask: "אם קנית חלב?",
      state: "open",
      createdAt: "2026-10-02T10:00:00.000Z",
      ...overrides,
    },
  };
}

describe("job metadata", () => {
  it("reads a job row and hides the reserved key from saved data", () => {
    const data = {
      "שם מטלה": "לבדוק עם ערן אם קנה חלב",
      [JOB_META_KEY]: {
        kind: "job",
        askerId: AMIT,
        askerName: "עמית",
        subjectId: ERAN,
        subjectName: "ערן",
        ask: "אם קנית חלב?",
        state: "open",
        createdAt: "2026-10-02T10:00:00.000Z",
      },
    };
    expect(jobMetaFrom(data)?.subjectName).toBe("ערן");
    expect(stripJobMeta(data)).toEqual({
      "שם מטלה": "לבדוק עם ערן אם קנה חלב",
    });
  });

  it("ignores rows that are not jobs", () => {
    expect(jobMetaFrom({ "שם מטלה": "לקנות חלב" })).toBeNull();
    expect(jobMetaFrom({ [JOB_META_KEY]: { kind: "job" } })).toBeNull();
  });
});

describe("open jobs context", () => {
  it("tells the subject it is theirs to answer and quotes the original ask", () => {
    const block = formatOpenJobsContext([jobRow()], ERAN);
    expect(block).toContain("OPEN_JOBS:");
    expect(block).toContain('"viewer_is":"subject"');
    expect(block).toContain('"ask":"אם קנית חלב?"');
    expect(block).toContain('"raisable":true');
  });

  it("marks a scheduled job as not raisable and stays empty with no jobs", () => {
    const block = formatOpenJobsContext(
      [jobRow({ nudgeFireAt: "2026-10-02T16:10:00.000Z" })],
      ERAN,
    );
    expect(block).toContain('"raisable":false');
    expect(block).toContain('"reminder_at":"2026-10-02T16:10:00.000Z"');
    expect(formatOpenJobsContext([], ERAN)).toBe("");
  });

  it("keeps a no-clock deferral raisable for the subject", () => {
    const block = formatOpenJobsContext(
      [jobRow({ deferredAt: "2026-10-02T16:00:00.000Z", state: "open" })],
      ERAN,
    );
    expect(block).toContain('"deferred":true');
    expect(block).toContain('"raisable":true');
  });

  it("shows the asker they are waiting, not that they owe the answer", () => {
    const block = formatOpenJobsContext([jobRow()], AMIT);
    expect(block).toContain('"viewer_is":"asker"');
    expect(block).toContain('"raisable":false');
  });
});

describe("createJobsFromRelays", () => {
  beforeEach(() => {
    listFindFirst.mockReset();
    listCreate.mockReset();
    itemCreate.mockReset();
    itemUpdate.mockReset();
    itemFindMany.mockReset();
    auditCreate.mockReset();
    listFindFirst.mockResolvedValue({ id: "tasks-list" });
    itemFindMany.mockResolvedValue([]);
    itemCreate.mockResolvedValue({ id: "job-1" });
    auditCreate.mockResolvedValue({});
  });

  it("opens one shared job row on the worker, visible to both people", async () => {
    const created = await createJobsFromRelays({
      userId: "u1",
      digitalEmployeeId: LUCY,
      asker: { id: AMIT, name: "עמית" },
      deliveries: [
        {
          subjectId: ERAN,
          subjectName: "ערן",
          text: "עמית שואל אם קנית חלב?",
          ask: "אם קנית חלב?",
        },
      ],
    });
    expect(created).toHaveLength(1);
    const data = itemCreate.mock.calls[0][0].data;
    expect(data.listId).toBe("tasks-list");
    expect(data.scope).toBe("shared");
    expect(data.addedById).toBe(AMIT);
    expect(data.visibleTo).toEqual([AMIT, ERAN]);
    expect(data.data[JOB_META_KEY].ask).toBe("אם קנית חלב?");
    expect(data.data["שם מטלה"]).toContain("ערן");
  });

  it("falls back to the relayed text when the worker gave no ask summary", async () => {
    await createJobsFromRelays({
      userId: "u1",
      digitalEmployeeId: LUCY,
      asker: { id: AMIT, name: "עמית" },
      deliveries: [
        {
          subjectId: ERAN,
          subjectName: "ערן",
          text: "עמית מבקש לתאם פגישת עבודה ליום שלישי.",
          ask: "",
        },
      ],
    });
    const data = itemCreate.mock.calls[0][0].data;
    expect(data.data[JOB_META_KEY].ask).toBe("עמית מבקש לתאם פגישת עבודה ליום שלישי");
    expect(data.data["שם מטלה"]).toBe(
      "לבדוק עם ערן: עמית מבקש לתאם פגישת עבודה ליום שלישי",
    );
  });

  it("never opens a second job for the same asker and subject; updates the ask instead", async () => {
    itemFindMany.mockResolvedValue([
      {
        id: "job-1",
        data: {
          "שם מטלה": "לבדוק עם ערן: לתאם פגישה",
          [JOB_META_KEY]: {
            kind: "job",
            askerId: AMIT,
            askerName: "עמית",
            subjectId: ERAN,
            subjectName: "ערן",
            ask: "לתאם פגישה",
            state: "open",
            createdAt: "2026-10-02T10:00:00.000Z",
          },
        },
      },
    ]);
    const created = await createJobsFromRelays({
      userId: "u1",
      digitalEmployeeId: LUCY,
      asker: { id: AMIT, name: "עמית" },
      deliveries: [
        {
          subjectId: ERAN,
          subjectName: "ערן",
          text: "עמית מבקש לתאם איתך פגישה מחר ב-10:00.",
          ask: "לתאם פגישה מחר ב-10:00",
        },
      ],
    });
    expect(created).toEqual([]);
    expect(itemCreate).not.toHaveBeenCalled();
    expect(itemUpdate).toHaveBeenCalled();
    expect(itemUpdate.mock.calls[0][0].data.data[JOB_META_KEY].ask).toBe(
      "לתאם פגישה מחר ב-10:00",
    );
  });

  it("does not open a second job when the pair is already open in the other direction", async () => {
    itemFindMany.mockResolvedValue([
      {
        id: "job-1",
        data: {
          "שם מטלה": "לבדוק עם עמית: יום שלישי ב-15:00",
          [JOB_META_KEY]: {
            kind: "job",
            askerId: ERAN,
            askerName: "ערן",
            subjectId: AMIT,
            subjectName: "עמית",
            ask: "יום שלישי ב-15:00",
            state: "open",
            createdAt: "2026-10-02T10:00:00.000Z",
          },
        },
      },
    ]);
    const created = await createJobsFromRelays({
      userId: "u1",
      digitalEmployeeId: LUCY,
      asker: { id: AMIT, name: "עמית" },
      deliveries: [
        {
          subjectId: ERAN,
          subjectName: "ערן",
          text: "עמית מאשר?",
          ask: "יום שלישי ב-15:00",
        },
      ],
    });
    expect(created).toEqual([]);
    expect(itemCreate).not.toHaveBeenCalled();
    expect(itemUpdate).not.toHaveBeenCalled();
  });

  it("never opens a job on the asker themselves", async () => {
    const created = await createJobsFromRelays({
      userId: "u1",
      digitalEmployeeId: LUCY,
      asker: { id: AMIT, name: "עמית" },
      deliveries: [
        { subjectId: AMIT, subjectName: "עמית", text: "היי", ask: "היי" },
      ],
    });
    expect(created).toEqual([]);
    expect(itemCreate).not.toHaveBeenCalled();
  });
});

describe("listOpenJobsForViewer", () => {
  beforeEach(() => {
    itemFindMany.mockReset();
  });

  it("keeps job rows for the asker and subject and drops nudges and outsiders", async () => {
    itemFindMany.mockResolvedValue([
      {
        id: "job-1",
        data: {
          "שם מטלה": "לבדוק עם ערן אם קנה חלב",
          [JOB_META_KEY]: jobRow().meta,
        },
      },
      {
        id: "nudge-1",
        data: {
          "שם מטלה": "להזכיר לערן אם קנית חלב",
          [JOB_META_KEY]: { ...jobRow().meta, kind: "nudge", jobItemId: "job-1" },
        },
      },
      { id: "plain-1", data: { "שם מטלה": "לבדוק מייל" } },
    ]);
    const forSubject = await listOpenJobsForViewer({
      digitalEmployeeId: LUCY,
      viewerId: ERAN,
    });
    expect(forSubject.map((row) => row.id)).toEqual(["job-1"]);
    const forOutsider = await listOpenJobsForViewer({
      digitalEmployeeId: LUCY,
      viewerId: "someone-else",
    });
    expect(forOutsider).toEqual([]);
  });
});

describe("correctMisaddressedJobReply", () => {
  it("replaces a reply that is the line written to the other person", () => {
    expect(
      correctMisaddressedJobReply({
        response: "ערן, עמית שואל אם קנית חלב?",
        relays: [{ targetName: "ערן", text: "עמית שואל אם קנית חלב?" }],
        reports: [],
      }),
    ).toBe("שלחתי לערן.");
  });

  it("replaces a reply that is the report meant for the asker", () => {
    const report = "ערן מוסר שקנה חלב — בקשר לשאלה שביקשת ממני לשאול אותו «אם קנית חלב?»";
    expect(
      correctMisaddressedJobReply({
        response: report,
        relays: [],
        reports: [{ toName: "עמית", text: report }],
      }),
    ).toBe("אעדכן את עמית.");
  });

  it("leaves a real confirmation and a real ack alone", () => {
    expect(
      correctMisaddressedJobReply({
        response: "שלחתי לערן שאתה שואל אם קנית חלב.",
        relays: [{ targetName: "ערן", text: "עמית שואל אם קנית חלב?" }],
        reports: [],
      }),
    ).toBeNull();
    expect(
      correctMisaddressedJobReply({
        response: "אעדכן את עמית.",
        relays: [],
        reports: [
          {
            toName: "עמית",
            text: "ערן מוסר שקנה חלב — בקשר לשאלה «אם קנית חלב?»",
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("applyJobActions", () => {
  beforeEach(() => {
    itemCreate.mockReset();
    itemUpdate.mockReset();
    itemUpdateMany.mockReset();
    itemFindMany.mockReset();
    itemFindUnique.mockReset();
    listFindFirst.mockReset();
    reminderCreate.mockReset();
    reminderUpdate.mockReset();
    reminderFindFirst.mockReset();
    auditCreate.mockReset();
    listFindFirst.mockResolvedValue({ id: "tasks-list" });
    itemFindMany.mockResolvedValue([]);
    itemFindUnique.mockResolvedValue({
      id: "job-1",
      data: { "שם מטלה": "לבדוק עם ערן אם קנה חלב", [JOB_META_KEY]: jobRow().meta },
    });
    itemUpdate.mockResolvedValue({});
    itemUpdateMany.mockResolvedValue({ count: 1 });
    auditCreate.mockResolvedValue({});
  });

  it("closes an answered job and reports back to the asker", async () => {
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: ERAN, name: "ערן" },
      actions: [
        {
          action: "answer",
          jobId: "job-1",
          answerText: "כן, קניתי",
          reportText: "ערן מוסר שכן, הוא קנה חלב",
          time: "",
          in: null,
        },
      ],
      jobs: [jobRow()],
    });
    expect(result.answered).toEqual(["job-1"]);
    expect(result.reports).toEqual([
      { employeeId: AMIT, text: "ערן מוסר שכן, הוא קנה חלב" },
    ]);
    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: { id: "job-1", deletedAt: null },
      data: expect.objectContaining({ reminderId: null }),
    });
  });

  it("writes a plain report that quotes the ask when the model gave none", async () => {
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: ERAN, name: "ערן" },
      actions: [
        {
          action: "answer",
          jobId: "job-1",
          answerText: "הכל בסדר",
          reportText: "",
          time: "",
          in: null,
        },
      ],
      jobs: [jobRow()],
    });
    expect(result.reports[0].text).toBe(
      "ערן מוסר: הכל בסדר בקשר ל«אם קנית חלב?»",
    );
  });

  it("does not echo a progress report back to the asker who just spoke", async () => {
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: AMIT, name: "עמית" },
      actions: [
        {
          action: "progress",
          jobId: "job-1",
          answerText: "מחר ב-10",
          reportText: "עמית ביקש לתאם פגישה מחר ב־10:00; אני ממתינה לתשובתך.",
          time: "",
          in: null,
        },
      ],
      jobs: [jobRow()],
    });
    expect(result.reports).toEqual([]);
    expect(result.answered).toEqual([]);
  });

  it("keeps the job open on progress and stores the note", async () => {
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: ERAN, name: "ערן" },
      actions: [
        {
          action: "progress",
          jobId: "job-1",
          answerText: "אקנה מחר",
          reportText: "ערן מעדכן שיקנה מחר",
          time: "",
          in: null,
        },
      ],
      jobs: [jobRow()],
    });
    expect(result.answered).toEqual([]);
    expect(result.closed).toEqual([]);
    expect(result.reports).toEqual([]);
    const patched = itemUpdate.mock.calls[0][0].data.data[JOB_META_KEY];
    expect(patched.state).toBe("progress");
    expect(patched.progress).toBe("אקנה מחר");
  });

  it("flips who must answer on a counter and asks them to approve", async () => {
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: ERAN, name: "ערן" },
      actions: [
        {
          action: "counter",
          jobId: "job-1",
          answerText: "יום שלישי ב-15:00",
          reportText:
            "ערן רוצה לשנות את מועד הפגישה ליום שלישי בשעה 15:00. האם לאשר?",
          time: "15:00",
          date: "2026-10-06",
          in: null,
        },
      ],
      jobs: [jobRow({ ask: "לתאם פגישה ליום שלישי ב-11:00" })],
    });
    expect(result.closed).toEqual([]);
    expect(result.answered).toEqual([]);
    expect(result.reports).toEqual([
      {
        employeeId: AMIT,
        text: "ערן רוצה לשנות את מועד הפגישה ליום שלישי בשעה 15:00. האם לאשר?",
      },
    ]);
    const data = itemUpdate.mock.calls[0][0].data;
    const meta = data.data[JOB_META_KEY];
    expect(meta.askerId).toBe(ERAN);
    expect(meta.subjectId).toBe(AMIT);
    expect(meta.ask).toBe("יום שלישי ב-15:00");
    expect(meta.state).toBe("open");
    expect(meta.needsBook).toBe(true);
    expect(meta.bookDate).toBe("2026-10-06");
    expect(meta.bookTime).toBe("15:00");
    expect(data.data["שם מטלה"]).toBe("לבדוק עם עמית: יום שלישי ב-15:00");
  });

  it("applies a counter that omitted the job id when only one job is open", async () => {
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: ERAN, name: "ערן" },
      actions: [
        {
          action: "counter",
          jobId: "",
          answerText: "",
          reportText: "",
          time: "12:00",
          date: "2026-10-06",
          in: null,
        },
      ],
      jobs: [jobRow({ ask: "לתאם פגישה ביום ראשון ב-10:00" })],
    });
    expect(result.closed).toEqual([]);
    expect(result.reports[0]?.employeeId).toBe(AMIT);
    expect(result.reports[0]?.text).toContain("12:00");
    const meta = itemUpdate.mock.calls[0][0].data.data[JOB_META_KEY];
    expect(meta.subjectId).toBe(AMIT);
    expect(meta.askerId).toBe(ERAN);
    expect(meta.needsBook).toBe(true);
    expect(meta.bookDate).toBe("2026-10-06");
    expect(meta.bookTime).toBe("12:00");
  });

  it("binds a missing job id to the one task this speaker still owes, among several", async () => {
    const waiting = {
      ...jobRow({
        askerId: ERAN,
        askerName: "ערן",
        subjectId: AMIT,
        subjectName: "עמית",
        ask: "יום חמישי ב-16:00",
      }),
      id: "job-2",
    };
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: ERAN, name: "ערן" },
      actions: [
        {
          action: "counter",
          jobId: "",
          answerText: "",
          reportText: "",
          time: "12:00",
          date: "2026-10-06",
          in: null,
        },
      ],
      jobs: [jobRow({ ask: "יום ראשון ב-10:00" }), waiting],
    });
    expect(result.askWhich).toEqual([]);
    expect(result.reports[0]?.employeeId).toBe(AMIT);
    const meta = itemUpdate.mock.calls[0][0].data.data[JOB_META_KEY];
    expect(meta.ask).toContain("12:00");
    expect(meta.subjectName).toBe("עמית");
  });

  it("asks which task when this speaker owes more than one and the id is missing", async () => {
    const second = {
      ...jobRow({
        askerId: "yosi",
        askerName: "יוסי",
        subjectId: ERAN,
        subjectName: "ערן",
        ask: "פגישה ביום חמישי ב-16:00",
      }),
      id: "job-2",
    };
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: ERAN, name: "ערן" },
      actions: [
        {
          action: "counter",
          jobId: "",
          answerText: "יום שלישי ב-12:00",
          reportText: "",
          time: "12:00",
          date: "2026-10-06",
          in: null,
        },
      ],
      jobs: [jobRow({ ask: "יום ראשון ב-10:00" }), second],
    });
    expect(result.reports).toEqual([]);
    expect(result.askWhich).toEqual([
      "יום ראשון ב-10:00",
      "פגישה ביום חמישי ב-16:00",
    ]);
    expect(itemUpdate).not.toHaveBeenCalled();
  });

  it("saves the approved counter as a shared meeting for both people", () => {
    const lists = meetingListsForAnswers(
      [
        jobRow({
          ask: "יום שלישי ב-15:00",
          askerId: ERAN,
          askerName: "ערן",
          subjectId: AMIT,
          subjectName: "עמית",
          needsBook: true,
          bookDate: "2026-10-06",
          bookTime: "15:00",
        }),
      ],
      [
        {
          action: "answer",
          jobId: "job-1",
          answerText: "כן",
          reportText: "עמית מאשר",
          time: "",
          date: "",
          in: null,
        },
      ],
    );
    expect(lists).toEqual([
      {
        action: "add",
        listType: "tasks",
        listName: "",
        targets: ["ערן", "עמית"],
        items: [
          {
            "שם מטלה": "פגישה",
            "תאריך לביצוע": "2026-10-06",
            "שעה לביצוע": "15:00",
            "יום שלם": false,
          },
        ],
      },
    ]);
  });

  it("ignores a counter that names no new slot", async () => {
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: ERAN, name: "ערן" },
      actions: [
        {
          action: "counter",
          jobId: "job-1",
          answerText: "",
          reportText: "האם לאשר?",
          time: "",
          in: null,
        },
      ],
      jobs: [jobRow()],
    });
    expect(result.reports).toEqual([]);
    expect(itemUpdate).not.toHaveBeenCalled();
  });

  it("snoozes with a clock plus its own nudge task, linked both ways", async () => {
    itemCreate.mockResolvedValue({ id: "nudge-1" });
    reminderCreate.mockResolvedValue({ id: "clock-1" });
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: ERAN, name: "ערן" },
      actions: [
        {
          action: "snooze",
          jobId: "job-1",
          answerText: "",
          reportText: "",
          time: "",
          in: 600,
        },
      ],
      jobs: [jobRow()],
    });
    expect(result.snoozed).toHaveLength(1);
    const nudgeData = itemCreate.mock.calls[0][0].data;
    expect(nudgeData.data["שם מטלה"]).toContain("להזכיר לערן");
    expect(nudgeData.data[JOB_META_KEY].kind).toBe("nudge");
    expect(nudgeData.data[JOB_META_KEY].jobItemId).toBe("job-1");
    const clock = reminderCreate.mock.calls[0][0].data;
    expect(clock.ownerId).toBe(ERAN);
    expect(clock.pingIds).toEqual([ERAN]);
    expect(clock.repeat).toBe("once");
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "nudge-1" },
      data: { reminderId: "clock-1" },
    });
    expect(reminderUpdate).toHaveBeenCalledWith({
      where: { id: "clock-1" },
      data: { workerItemId: "nudge-1" },
    });
    // The job row itself must not be soft-deleted by scheduling a reminder.
    expect(itemUpdateMany).not.toHaveBeenCalled();
  });

  it("defers without a clock when no time was named", async () => {
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: ERAN, name: "ערן" },
      actions: [
        {
          action: "snooze",
          jobId: "job-1",
          answerText: "",
          reportText: "",
          time: "",
          in: null,
        },
      ],
      jobs: [jobRow()],
    });
    expect(result.snoozed).toEqual([]);
    expect(reminderCreate).not.toHaveBeenCalled();
    expect(
      itemUpdate.mock.calls[0][0].data.data[JOB_META_KEY].deferredAt,
    ).toBeTruthy();
  });

  it("leaves someone else's job open when the subject cancels only the clock", async () => {
    reminderFindFirst.mockResolvedValue(null);
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: ERAN, name: "ערן" },
      actions: [
        {
          action: "clear_clock",
          jobId: "job-1",
          answerText: "",
          reportText: "",
          time: "",
          in: null,
        },
      ],
      jobs: [jobRow({ nudgeReminderId: "clock-1", nudgeItemId: "nudge-1" })],
    });
    expect(result.cleared).toEqual(["job-1"]);
    expect(result.closed).toEqual([]);
    const patched = itemUpdate.mock.calls.at(-1)?.[0].data.data[JOB_META_KEY];
    expect(patched.nudgeReminderId).toBeUndefined();
  });

  it("closes the job when its own asker cancels the clock", async () => {
    reminderFindFirst.mockResolvedValue(null);
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: AMIT, name: "עמית" },
      actions: [
        {
          action: "clear_clock",
          jobId: "job-1",
          answerText: "",
          reportText: "",
          time: "",
          in: null,
        },
      ],
      jobs: [jobRow({ nudgeReminderId: "clock-1", nudgeItemId: "nudge-1" })],
    });
    expect(result.closed).toEqual(["job-1"]);
    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: { id: "job-1", deletedAt: null },
      data: expect.objectContaining({ reminderId: null }),
    });
  });

  it("tells the other person when a job is cancelled outright", async () => {
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: AMIT, name: "עמית" },
      actions: [
        {
          action: "close",
          jobId: "job-1",
          answerText: "",
          reportText: "",
          time: "",
          in: null,
        },
      ],
      jobs: [jobRow()],
    });
    expect(result.closed).toEqual(["job-1"]);
    expect(result.reports[0].employeeId).toBe(ERAN);
    expect(result.reports[0].text).toContain("עמית");
  });

  it("ignores actions for jobs that were not shown this turn", async () => {
    const result = await applyJobActions({
      userId: "u1",
      digitalEmployeeId: LUCY,
      speaker: { id: ERAN, name: "ערן" },
      actions: [
        {
          action: "answer",
          jobId: "unknown-job",
          answerText: "כן",
          reportText: "",
          time: "",
          in: null,
        },
      ],
      jobs: [jobRow()],
    });
    expect(result.reports).toEqual([]);
    expect(itemUpdateMany).not.toHaveBeenCalled();
  });
});
