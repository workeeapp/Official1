/**
 * Job lifecycle: Local Answer vs External Report (answered_pending_report).
 *
 * Run: npm run test:eval-db -- tests/job-answer-report-lifecycle.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/database/prisma.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import {
  formatOpenJobsContext,
  listOpenJobsForViewer,
} from "../src/services/jobs.service.js";
import { JOB_META_KEY, jobMetaFrom } from "../src/services/job-meta.js";
import {
  sendChatMessage,
  setJobReportWhatsAppSendForTests,
} from "../src/services/chat.service.js";

const SPEAKER = "טל";
const PARTNER = "מיכל";

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
});

function stubReply(payload: unknown) {
  return {
    async createConversation() {
      return `conv-${randomUUID()}`;
    },
    async createResponse() {
      return { reply: JSON.stringify(payload), raw: {} };
    },
  };
}

async function cleanupAccount(account: HarnessAccount) {
  setJobReportWhatsAppSendForTests(null);
  await prisma.deliveryAttempt
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await prisma.pendingHighRiskConfirm
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await prisma.whatsAppInvite
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await prisma.reminder
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await prisma.chatMessage
    .deleteMany({ where: { conversation: { userId: account.userId } } })
    .catch(() => undefined);
  await prisma.chatConversation
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await destroyHarnessAccount(account);
}

async function ensureLucy(account: HarnessAccount): Promise<string> {
  const existing = await prisma.employee.findFirst({
    where: { userId: account.userId, kind: "digital" },
  });
  if (existing) return existing.id;
  const lucy = await prisma.employee.create({
    data: {
      userId: account.userId,
      kind: "digital",
      isProtected: true,
      name: "לוסי",
      surname: "",
      nickname: "לוסי",
      model: "gpt-4.1-mini",
      temperature: 0,
      instructions: "You manage lists. Reply in Hebrew.",
    },
  });
  return lucy.id;
}

async function ensurePartnerPhone(
  account: HarnessAccount,
  partnerName: string,
  phone: string,
) {
  const partner = await prisma.employee.findFirstOrThrow({
    where: { userId: account.userId, name: partnerName, kind: "human" },
  });
  await prisma.employee.update({
    where: { id: partner.id },
    data: { phone },
  });
  return partner;
}

async function seedThirdPartyJob(input: {
  account: HarnessAccount;
  lucyId: string;
  askerId: string;
  askerName: string;
  ask: string;
}) {
  const tasksList =
    (await prisma.employeeList.findFirst({
      where: {
        employeeId: input.lucyId,
        listType: "tasks",
        name: "",
        deletedAt: null,
      },
    })) ??
    (await prisma.employeeList.create({
      data: {
        employeeId: input.lucyId,
        listType: "tasks",
        name: "",
        scope: "personal",
        visibleTo: [input.lucyId],
      },
    }));

  return prisma.employeeListItem.create({
    data: {
      listId: tasksList.id,
      itemKey: `dinner-${randomUUID().slice(0, 8)}`,
      data: {
        "שם משימה": `לבדוק עם ${SPEAKER}: ${input.ask}`,
        [JOB_META_KEY]: {
          kind: "job",
          askerId: input.askerId,
          askerName: input.askerName,
          subjectId: input.account.employeeId,
          subjectName: SPEAKER,
          ask: input.ask,
          state: "open",
          createdAt: new Date().toISOString(),
        },
      },
      scope: "personal",
      addedById: input.lucyId,
      visibleTo: [input.lucyId],
    },
  });
}

function readJobMeta(data: unknown) {
  return jobMetaFrom(data);
}

describe("Job Local Answer / External Report lifecycle (sendChatMessage)", () => {
  let account: HarnessAccount | null = null;

  afterEach(async () => {
    setLlmClientForTests(null);
    setJobReportWhatsAppSendForTests(null);
    if (account) {
      await cleanupAccount(account);
      account = null;
    }
  });

  it(
    "answer + confirm → local then sent + closed",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const michal = await ensurePartnerPhone(
        account,
        PARTNER,
        "972501110001",
      );
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501110002" },
      });
      const job = await seedThirdPartyJob({
        account,
        lucyId,
        askerId: michal.id,
        askerName: PARTNER,
        ask: "מה אוכלים בערב?",
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "רשמתי.", buttons: [] }],
          metadata: {
            jobs: [
              {
                action: "answer",
                job_id: job.id,
                answer_text: "פסטה",
                report_text: "טל מוסר: פסטה.",
              },
            ],
          },
        }),
      );
      const offer = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "פסטה",
      });
      expect(offer.reply).toMatch(/אישור מפורש/);
      const afterAnswer = await prisma.employeeListItem.findFirstOrThrow({
        where: { id: job.id },
      });
      expect(afterAnswer.deletedAt).toBeNull();
      const metaPending = readJobMeta(afterAnswer.data)!;
      expect(metaPending.state).toBe("answered_pending_report");
      expect(metaPending.reportStatus).toBe("pending");
      expect(metaPending.answerText).toBe("פסטה");
      expect(metaPending.pendingReportText).toMatch(/פסטה/);

      const pending = await prisma.pendingHighRiskConfirm.findFirstOrThrow({
        where: { userId: account.userId, status: "offered" },
        orderBy: { createdAt: "desc" },
      });
      expect(metaPending.reportConfirmId).toBe(pending.id);

      setLlmClientForTests(null);
      const confirmed = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: pending.confirmCommand,
      });
      expect(confirmed.reply).toMatch(/בוצע לפי האישור/);

      const afterConfirm = await prisma.employeeListItem.findFirstOrThrow({
        where: { id: job.id },
      });
      expect(afterConfirm.deletedAt).not.toBeNull();
      const metaSent = readJobMeta(afterConfirm.data)!;
      expect(metaSent.answerText).toBe("פסטה");
      expect(metaSent.reportStatus).toBe("sent");
      expect(metaSent.reportHistory?.some((row) => row.status === "sent")).toBe(
        true,
      );

      const attempts = await prisma.deliveryAttempt.findMany({
        where: { userId: account.userId, purpose: "job_report" },
      });
      expect(attempts.some((row) => row.status === "accepted")).toBe(true);
    },
    90_000,
  );

  it(
    "answer + cancel → answer kept, report declined, not raisable",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const michal = await ensurePartnerPhone(
        account,
        PARTNER,
        "972501110011",
      );
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501110012" },
      });
      const job = await seedThirdPartyJob({
        account,
        lucyId,
        askerId: michal.id,
        askerName: PARTNER,
        ask: "מתי חוזרים?",
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "רשמתי.", buttons: [] }],
          metadata: {
            jobs: [
              {
                action: "answer",
                job_id: job.id,
                answer_text: "בשמונה",
                report_text: "טל מוסר: בשמונה.",
              },
            ],
          },
        }),
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "בשמונה",
      });
      const pending = await prisma.pendingHighRiskConfirm.findFirstOrThrow({
        where: { userId: account.userId, status: "offered" },
        orderBy: { createdAt: "desc" },
      });

      setLlmClientForTests(null);
      const cancelled = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: pending.cancelCommand,
      });
      expect(cancelled.reply).toMatch(/ביטלתי את הדיווח/);
      expect(cancelled.reply).toMatch(/התשובה נשמרה/);

      const row = await prisma.employeeListItem.findFirstOrThrow({
        where: { id: job.id, deletedAt: null },
      });
      const meta = readJobMeta(row.data)!;
      expect(meta.state).toBe("answered_pending_report");
      expect(meta.reportStatus).toBe("declined");
      expect(meta.answerText).toBe("בשמונה");
      expect(meta.reportConfirmId).toBeUndefined();

      const open = await listOpenJobsForViewer({
        digitalEmployeeId: lucyId,
        viewerId: account.employeeId,
      });
      const ctx = formatOpenJobsContext(open, account.employeeId);
      expect(ctx).toMatch(/answered_pending_report|report_status/);
      expect(ctx).toMatch(/"raisable":false/);
      expect(ctx).not.toMatch(
        new RegExp(`"job_id":"${job.id}"[\\s\\S]*?"raisable":true`),
      );
    },
    90_000,
  );

  it(
    "reopen conversation after cancel → still not raisable",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const michal = await ensurePartnerPhone(
        account,
        PARTNER,
        "972501110021",
      );
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501110022" },
      });
      const job = await seedThirdPartyJob({
        account,
        lucyId,
        askerId: michal.id,
        askerName: PARTNER,
        ask: "יש קינוח?",
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "רשמתי.", buttons: [] }],
          metadata: {
            jobs: [
              {
                action: "answer",
                job_id: job.id,
                answer_text: "כן, גלידה",
                report_text: "טל מוסר: כן, גלידה.",
              },
            ],
          },
        }),
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "כן גלידה",
      });
      const pending = await prisma.pendingHighRiskConfirm.findFirstOrThrow({
        where: { userId: account.userId, status: "offered" },
        orderBy: { createdAt: "desc" },
      });
      setLlmClientForTests(null);
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: pending.cancelCommand,
      });

      // Simulate reopen: wipe conversation needsContext / new conversation.
      await prisma.chatConversation.deleteMany({
        where: { userId: account.userId },
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "שלום, מה נשמע?", buttons: [] }],
          metadata: {},
        }),
      );
      const reopen = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "היי",
      });
      expect(reopen.reply).not.toMatch(/קינוח|גלידה|מיכל מחכה/);

      const open = await listOpenJobsForViewer({
        digitalEmployeeId: lucyId,
        viewerId: account.employeeId,
      });
      const row = open.find((j) => j.id === job.id);
      expect(row?.meta.state).toBe("answered_pending_report");
      expect(row?.meta.reportStatus).toBe("declined");
      const ctx = formatOpenJobsContext(open, account.employeeId);
      expect(ctx).toContain(job.id);
      expect(ctx).toMatch(/"raisable":false/);
    },
    90_000,
  );

  it(
    "double confirm → no second report / still sent once",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const michal = await ensurePartnerPhone(
        account,
        PARTNER,
        "972501110031",
      );
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501110032" },
      });
      const job = await seedThirdPartyJob({
        account,
        lucyId,
        askerId: michal.id,
        askerName: PARTNER,
        ask: "באים?",
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "רשמתי.", buttons: [] }],
          metadata: {
            jobs: [
              {
                action: "answer",
                job_id: job.id,
                answer_text: "כן",
                report_text: "טל מוסר שכן.",
              },
            ],
          },
        }),
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "כן",
      });
      const pending = await prisma.pendingHighRiskConfirm.findFirstOrThrow({
        where: { userId: account.userId, status: "offered" },
        orderBy: { createdAt: "desc" },
      });

      setLlmClientForTests(null);
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: pending.confirmCommand,
      });
      const firstAttempts = await prisma.deliveryAttempt.count({
        where: {
          userId: account.userId,
          purpose: "job_report",
          status: "accepted",
        },
      });
      expect(firstAttempts).toBe(1);

      const second = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: pending.confirmCommand,
      });
      expect(second.reply).toMatch(/כבר לא בתוקף|פג או שטופל/);

      const after = await prisma.deliveryAttempt.count({
        where: {
          userId: account.userId,
          purpose: "job_report",
          status: "accepted",
        },
      });
      expect(after).toBe(1);
      const row = await prisma.employeeListItem.findFirstOrThrow({
        where: { id: job.id },
      });
      expect(readJobMeta(row.data)?.reportStatus).toBe("sent");
    },
    90_000,
  );

  it(
    "WhatsApp certain failure → reportStatus=failed; recovery resends once",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const michal = await ensurePartnerPhone(
        account,
        PARTNER,
        "972501110041",
      );
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501110042" },
      });
      const job = await seedThirdPartyJob({
        account,
        lucyId,
        askerId: michal.id,
        askerName: PARTNER,
        ask: "הכל מוכן?",
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "רשמתי.", buttons: [] }],
          metadata: {
            jobs: [
              {
                action: "answer",
                job_id: job.id,
                answer_text: "מוכן",
                report_text: "טל מוסר שהכל מוכן.",
              },
            ],
          },
        }),
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "מוכן",
      });
      const pending = await prisma.pendingHighRiskConfirm.findFirstOrThrow({
        where: { userId: account.userId, status: "offered" },
        orderBy: { createdAt: "desc" },
      });

      setJobReportWhatsAppSendForTests(async () => ({
        skips: [{ label: PARTNER, reason: "failed" }],
        sentLabels: [],
      }));
      setLlmClientForTests(null);
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: pending.confirmCommand,
      });

      const failedRow = await prisma.employeeListItem.findFirstOrThrow({
        where: { id: job.id, deletedAt: null },
      });
      const failedMeta = readJobMeta(failedRow.data)!;
      expect(failedMeta.state).toBe("answered_pending_report");
      expect(failedMeta.reportStatus).toBe("failed");
      expect(failedMeta.answerText).toBe("מוכן");
      expect(
        await prisma.deliveryAttempt.count({
          where: {
            userId: account.userId,
            purpose: "job_report",
            status: "failed",
          },
        }),
      ).toBe(1);

      // Recovery: new answer staging + confirm with successful send.
      setJobReportWhatsAppSendForTests(null);
      setLlmClientForTests(
        stubReply({
          responses: [{ text: "רשמתי שוב.", buttons: [] }],
          metadata: {
            jobs: [
              {
                action: "answer",
                job_id: job.id,
                answer_text: "מוכן",
                report_text: "טל מוסר שהכל מוכן.",
              },
            ],
          },
        }),
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "תשלחי למיכל",
      });
      const retryPending = await prisma.pendingHighRiskConfirm.findFirstOrThrow({
        where: { userId: account.userId, status: "offered" },
        orderBy: { createdAt: "desc" },
      });
      setLlmClientForTests(null);
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: retryPending.confirmCommand,
      });

      const recovered = await prisma.employeeListItem.findFirstOrThrow({
        where: { id: job.id },
      });
      expect(recovered.deletedAt).not.toBeNull();
      expect(readJobMeta(recovered.data)?.reportStatus).toBe("sent");
      expect(
        await prisma.deliveryAttempt.count({
          where: {
            userId: account.userId,
            purpose: "job_report",
            status: "accepted",
          },
        }),
      ).toBe(1);
    },
    120_000,
  );

  it(
    "unknown delivery → must not auto-resend; answer kept",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const michal = await ensurePartnerPhone(
        account,
        PARTNER,
        "972501110051",
      );
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501110052" },
      });
      const job = await seedThirdPartyJob({
        account,
        lucyId,
        askerId: michal.id,
        askerName: PARTNER,
        ask: "יש לחם?",
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "רשמתי.", buttons: [] }],
          metadata: {
            jobs: [
              {
                action: "answer",
                job_id: job.id,
                answer_text: "כן",
                report_text: "טל מוסר שיש לחם.",
              },
            ],
          },
        }),
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "כן",
      });
      const pending = await prisma.pendingHighRiskConfirm.findFirstOrThrow({
        where: { userId: account.userId, status: "offered" },
        orderBy: { createdAt: "desc" },
      });

      // First confirm: mark attempt unknown mid-flight by pre-seeding ledger.
      await prisma.deliveryAttempt.create({
        data: {
          userId: account.userId,
          ledgerKey: `job:${job.id}:job_report:972501110051`,
          stepKey: "job_report:972501110051",
          destination: "972501110051",
          purpose: "job_report",
          status: "unknown",
        },
      });

      setLlmClientForTests(null);
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: pending.confirmCommand,
      });

      const row = await prisma.employeeListItem.findFirstOrThrow({
        where: { id: job.id, deletedAt: null },
      });
      const meta = readJobMeta(row.data)!;
      expect(meta.answerText).toBe("כן");
      expect(meta.reportStatus).toBe("unknown");
      expect(
        await prisma.deliveryAttempt.count({
          where: {
            userId: account.userId,
            purpose: "job_report",
            status: "accepted",
          },
        }),
      ).toBe(0);
    },
    90_000,
  );

  it(
    "regression: self-job closes without confirm; progress stays ungated",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501110062" },
      });
      const tasksList =
        (await prisma.employeeList.findFirst({
          where: {
            employeeId: lucyId,
            listType: "tasks",
            name: "",
            deletedAt: null,
          },
        })) ??
        (await prisma.employeeList.create({
          data: {
            employeeId: lucyId,
            listType: "tasks",
            name: "",
            scope: "personal",
            visibleTo: [lucyId],
          },
        }));
      const selfJob = await prisma.employeeListItem.create({
        data: {
          listId: tasksList.id,
          itemKey: `self-${randomUUID().slice(0, 8)}`,
          data: {
            "שם משימה": "סגירה",
            [JOB_META_KEY]: {
              kind: "job",
              askerId: account.employeeId,
              askerName: SPEAKER,
              subjectId: account.employeeId,
              subjectName: SPEAKER,
              ask: "משימות שעבר המועד",
              state: "open",
              createdAt: new Date().toISOString(),
            },
          },
          scope: "personal",
          addedById: lucyId,
          visibleTo: [lucyId],
        },
      });
      const michal = await ensurePartnerPhone(
        account,
        PARTNER,
        "972501110061",
      );
      const otherJob = await seedThirdPartyJob({
        account,
        lucyId,
        askerId: michal.id,
        askerName: PARTNER,
        ask: "מה המצב?",
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "סגרתי.", buttons: [] }],
          metadata: {
            jobs: [
              {
                action: "answer",
                job_id: selfJob.id,
                answer_text: "סגירה",
                report_text: "",
              },
            ],
          },
        }),
      );
      const selfResult = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "סגירה",
      });
      expect(selfResult.reply).not.toMatch(/אישור מפורש/);
      expect(
        (
          await prisma.employeeListItem.findFirst({
            where: { id: selfJob.id },
          })
        )?.deletedAt,
      ).not.toBeNull();

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "רשמתי התקדמות.", buttons: [] }],
          metadata: {
            jobs: [
              {
                action: "progress",
                job_id: otherJob.id,
                answer_text: "עדיין בודק",
                report_text: "",
              },
            ],
          },
        }),
      );
      const progressResult = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "עדיין בודק",
      });
      expect(progressResult.reply).not.toMatch(/אישור מפורש/);
      const progressed = await prisma.employeeListItem.findFirstOrThrow({
        where: { id: otherJob.id, deletedAt: null },
      });
      expect(readJobMeta(progressed.data)?.state).toBe("progress");
      expect(readJobMeta(progressed.data)?.progress).toBe("עדיין בודק");
    },
    90_000,
  );
});
