/**
 * Check-with answer: auto report + close (no PendingConfirm).
 * DeliveryAttempt job_report keyed by jobId for idempotency.
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
import { JOB_META_KEY, jobMetaFrom } from "../src/services/job-meta.js";
import {
  sendChatMessage,
  setJobReportWhatsAppSendForTests,
} from "../src/services/chat.service.js";
import {
  buildDeliveryLedgerKey,
  claimDeliverySend,
  completeDeliveryAttempt,
} from "../src/services/delivery-attempt.service.js";

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
      itemKey: `cw-${randomUUID().slice(0, 8)}`,
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

describe("Check-with answer auto-report (sendChatMessage)", () => {
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
    "yes / free-text answer → auto report, job closed, no PendingConfirm",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const michal = await ensurePartnerPhone(
        account,
        PARTNER,
        "972501220001",
      );
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501220002" },
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
          responses: [{ text: "מסרתי למיכל.", buttons: [] }],
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
      const result = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "פסטה",
      });
      expect(result.reply).not.toMatch(/אישור מפורש/);
      expect(result.reply).toMatch(/מסרתי/);

      const closed = await prisma.employeeListItem.findFirstOrThrow({
        where: { id: job.id },
      });
      expect(closed.deletedAt).not.toBeNull();
      expect(
        await prisma.pendingHighRiskConfirm.findFirst({
          where: {
            userId: account.userId,
            status: { in: ["offered", "pending_offer"] },
          },
        }),
      ).toBeNull();

      const attempts = await prisma.deliveryAttempt.findMany({
        where: { userId: account.userId, purpose: "job_report" },
      });
      expect(attempts.some((row) => row.status === "accepted")).toBe(true);
      expect(
        attempts.some((row) =>
          row.ledgerKey.includes(`job:${job.id}:`),
        ),
      ).toBe(true);
    },
    90_000,
  );

  it(
    "double answer → no second job_report send",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const michal = await ensurePartnerPhone(
        account,
        PARTNER,
        "972501220011",
      );
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501220012" },
      });
      const job = await seedThirdPartyJob({
        account,
        lucyId,
        askerId: michal.id,
        askerName: PARTNER,
        ask: "באים?",
      });

      const answerStub = stubReply({
        responses: [{ text: "מסרתי.", buttons: [] }],
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
      });
      setLlmClientForTests(answerStub);
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "כן",
      });
      const first = await prisma.deliveryAttempt.count({
        where: {
          userId: account.userId,
          purpose: "job_report",
          status: "accepted",
        },
      });
      expect(first).toBe(1);

      // Second turn still emits answer on same job id (already closed).
      setLlmClientForTests(answerStub);
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "כן שוב",
      });
      const after = await prisma.deliveryAttempt.count({
        where: {
          userId: account.userId,
          purpose: "job_report",
          status: "accepted",
        },
      });
      expect(after).toBe(1);
    },
    90_000,
  );

  it(
    "WhatsApp certain failure → ledger failed; retry may send once",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const michal = await ensurePartnerPhone(
        account,
        PARTNER,
        "972501220021",
      );
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501220022" },
      });
      const job = await seedThirdPartyJob({
        account,
        lucyId,
        askerId: michal.id,
        askerName: PARTNER,
        ask: "הכל מוכן?",
      });

      setJobReportWhatsAppSendForTests(async () => ({
        skips: [{ label: PARTNER, reason: "failed" }],
        sentLabels: [],
      }));
      setLlmClientForTests(
        stubReply({
          responses: [{ text: "מסרתי.", buttons: [] }],
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

      // Job still closes atomically; ledger records certain failure.
      expect(
        (
          await prisma.employeeListItem.findFirstOrThrow({
            where: { id: job.id },
          })
        ).deletedAt,
      ).not.toBeNull();
      expect(
        await prisma.deliveryAttempt.count({
          where: {
            userId: account.userId,
            purpose: "job_report",
            status: "failed",
          },
        }),
      ).toBe(1);

      // Safe recovery: failed allows a later send with same job ledger key.
      setJobReportWhatsAppSendForTests(null);
      const { claimDeliverySend, completeDeliveryAttempt } = await import(
        "../src/services/delivery-attempt.service.js"
      );
      const claim = await claimDeliverySend({
        userId: account.userId,
        destination: "972501220021",
        purpose: "job_report",
        sourceKey: `job:${job.id}`,
      });
      expect(claim.maySend).toBe(true);
      if (claim.attemptId) {
        await completeDeliveryAttempt({
          attemptId: claim.attemptId,
          status: "accepted",
        });
      }
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
    90_000,
  );

  it(
    "unknown delivery → must not auto-resend",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const michal = await ensurePartnerPhone(
        account,
        PARTNER,
        "972501220031",
      );
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501220032" },
      });
      const job = await seedThirdPartyJob({
        account,
        lucyId,
        askerId: michal.id,
        askerName: PARTNER,
        ask: "יש לחם?",
      });

      const ledgerKey = buildDeliveryLedgerKey({
        sourceKey: `job:${job.id}`,
        destination: "972501220031",
        purpose: "job_report",
      });
      await prisma.deliveryAttempt.create({
        data: {
          userId: account.userId,
          ledgerKey,
          stepKey: "job_report:972501220031",
          destination: "972501220031",
          purpose: "job_report",
          status: "unknown",
        },
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "מסרתי.", buttons: [] }],
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

      expect(
        await prisma.deliveryAttempt.count({
          where: {
            userId: account.userId,
            purpose: "job_report",
            status: "accepted",
          },
        }),
      ).toBe(0);
      expect(
        await prisma.deliveryAttempt.count({
          where: {
            userId: account.userId,
            purpose: "job_report",
            status: "unknown",
          },
        }),
      ).toBe(1);
    },
    90_000,
  );

  it(
    "regression: self-job closes; progress ungated; share still Class V",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501220042" },
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
        "972501220041",
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
      expect(jobMetaFrom(progressed.data)?.state).toBe("progress");
      expect(jobMetaFrom(progressed.data)?.progress).toBe("עדיין בודק");

      const shopping =
        (await prisma.employeeList.findFirst({
          where: {
            employeeId: account.employeeId,
            listType: "shopping",
            name: "",
            deletedAt: null,
          },
        })) ??
        (await prisma.employeeList.create({
          data: {
            employeeId: account.employeeId,
            listType: "shopping",
            name: "",
            scope: "personal",
            visibleTo: [account.employeeId],
          },
        }));
      const item = await prisma.employeeListItem.create({
        data: {
          listId: shopping.id,
          itemKey: `חלב-${randomUUID().slice(0, 6)}`,
          data: { "שם פריט": "חלב" },
          scope: "personal",
          addedById: account.employeeId,
          visibleTo: [account.employeeId],
        },
      });
      setLlmClientForTests(
        stubReply({
          responses: [{ text: "שיתפתי.", buttons: [] }],
          metadata: {
            lists: [
              {
                action: "update",
                list_type: "shopping",
                list_name: "",
                items: [{ item_id: item.id }],
                targets: [SPEAKER, PARTNER],
              },
            ],
          },
        }),
      );
      // No share-intent verb → Class V still strips.
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "מה יש בקניות?",
      });
      const pending = await prisma.pendingHighRiskConfirm.findFirst({
        where: { userId: account.userId, status: "offered" },
        orderBy: { createdAt: "desc" },
      });
      expect(pending).toBeTruthy();
      expect(pending!.actionKind).toMatch(/share|assign/);
      const after = await prisma.employeeListItem.findFirstOrThrow({
        where: { id: item.id, deletedAt: null },
      });
      expect(after.scope).toBe("personal");
    },
    120_000,
  );

  it(
    "explicit lists.remove closes Check-with job without Class V answer path",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const michal = await ensurePartnerPhone(
        account,
        PARTNER,
        "972501220051",
      );
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501220052" },
      });
      const job = await seedThirdPartyJob({
        account,
        lucyId,
        askerId: michal.id,
        askerName: PARTNER,
        ask: "בטל את זה",
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "ביטלתי.", buttons: [] }],
          metadata: {
            lists: [
              {
                action: "remove",
                list_type: "tasks",
                list_name: "",
                items: [{ item_id: job.id }],
                targets: [],
              },
            ],
          },
        }),
      );
      const result = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "תבטלי את המשימה",
      });
      expect(result.reply).not.toMatch(/אישור מפורש/);
      expect(
        (
          await prisma.employeeListItem.findFirst({ where: { id: job.id } })
        )?.deletedAt,
      ).not.toBeNull();
      expect(
        await prisma.deliveryAttempt.count({
          where: { userId: account.userId, purpose: "job_report" },
        }),
      ).toBe(0);
    },
    90_000,
  );

  it(
    "race: parallel jobs.answer on same jobId → one job_report send only",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const michal = await ensurePartnerPhone(
        account,
        PARTNER,
        "972501220061",
      );
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501220062" },
      });
      const job = await seedThirdPartyJob({
        account,
        lucyId,
        askerId: michal.id,
        askerName: PARTNER,
        ask: "מירוץ?",
      });

      let graphSends = 0;
      setJobReportWhatsAppSendForTests(async () => {
        graphSends += 1;
        await new Promise((r) => setTimeout(r, 80));
        return { skips: [], sentLabels: [PARTNER] };
      });

      const payload = {
        responses: [{ text: "מסרתי.", buttons: [] }],
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
      };
      setLlmClientForTests(stubReply(payload));

      const [a, b] = await Promise.all([
        sendChatMessage({
          userId: account.userId,
          employeeId: account.employeeId,
          digitalEmployeeId: lucyId,
          message: "כן-A",
        }),
        sendChatMessage({
          userId: account.userId,
          employeeId: account.employeeId,
          digitalEmployeeId: lucyId,
          message: "כן-B",
        }),
      ]);
      expect(a.reply).toBeTruthy();
      expect(b.reply).toBeTruthy();

      expect(graphSends).toBe(1);

      const attempts = await prisma.deliveryAttempt.findMany({
        where: { userId: account.userId, purpose: "job_report" },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("accepted");
      expect(attempts[0]?.ledgerKey).toContain(`job:${job.id}:`);

      expect(
        (
          await prisma.employeeListItem.findFirstOrThrow({
            where: { id: job.id },
          })
        ).deletedAt,
      ).not.toBeNull();
    },
    90_000,
  );

  it(
    "race: parallel claimDeliverySend — accepted/unknown block; failed recovers once",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const jobId = `race-job-${randomUUID().slice(0, 8)}`;
      const destination = "972501220071";
      const sourceKey = `job:${jobId}`;

      const firstWave = await Promise.all(
        Array.from({ length: 8 }, () =>
          claimDeliverySend({
            userId: account!.userId,
            destination,
            purpose: "job_report",
            sourceKey,
          }),
        ),
      );
      const winners = firstWave.filter((row) => row.maySend);
      expect(winners).toHaveLength(1);
      expect(
        await prisma.deliveryAttempt.count({
          where: { userId: account.userId, purpose: "job_report" },
        }),
      ).toBe(1);

      await completeDeliveryAttempt({
        attemptId: winners[0]!.attemptId!,
        status: "accepted",
      });
      const afterAccepted = await Promise.all(
        Array.from({ length: 6 }, () =>
          claimDeliverySend({
            userId: account!.userId,
            destination,
            purpose: "job_report",
            sourceKey,
          }),
        ),
      );
      expect(afterAccepted.every((row) => !row.maySend)).toBe(true);
      expect(
        afterAccepted.every((row) => row.skipReason === "already_accepted"),
      ).toBe(true);

      await prisma.deliveryAttempt.updateMany({
        where: { userId: account.userId, purpose: "job_report" },
        data: { status: "unknown" },
      });
      const afterUnknown = await Promise.all(
        Array.from({ length: 6 }, () =>
          claimDeliverySend({
            userId: account!.userId,
            destination,
            purpose: "job_report",
            sourceKey,
          }),
        ),
      );
      expect(afterUnknown.every((row) => !row.maySend)).toBe(true);
      expect(
        afterUnknown.every((row) => row.skipReason === "in_flight_or_unknown"),
      ).toBe(true);

      await prisma.deliveryAttempt.updateMany({
        where: { userId: account.userId, purpose: "job_report" },
        data: { status: "failed" },
      });
      const recoverWave = await Promise.all(
        Array.from({ length: 8 }, () =>
          claimDeliverySend({
            userId: account!.userId,
            destination,
            purpose: "job_report",
            sourceKey,
          }),
        ),
      );
      const recoverWinners = recoverWave.filter((row) => row.maySend);
      expect(recoverWinners).toHaveLength(1);
      expect(
        await prisma.deliveryAttempt.count({
          where: {
            userId: account.userId,
            purpose: "job_report",
            status: "sending",
          },
        }),
      ).toBe(1);

      await completeDeliveryAttempt({
        attemptId: recoverWinners[0]!.attemptId!,
        status: "accepted",
      });
      const finalBlock = await Promise.all(
        Array.from({ length: 4 }, () =>
          claimDeliverySend({
            userId: account!.userId,
            destination,
            purpose: "job_report",
            sourceKey,
          }),
        ),
      );
      expect(finalBlock.every((row) => !row.maySend)).toBe(true);
    },
    60_000,
  );
});
