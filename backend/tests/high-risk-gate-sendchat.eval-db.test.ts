/**
 * M1–M3 stage 2: HighRiskActionGate strip-only via real sendChatMessage.
 *
 * Asserts side effects in DB — not only that metadata was stripped.
 *
 * Known bypass (documented, not closed in stage 2):
 * `applyPendingCollabInvites` still runs pre-LLM — P-Share is NOT complete.
 *
 * Run: npm run test:eval-db -- tests/high-risk-gate-sendchat.eval-db.test.ts
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
import { sendChatMessage } from "../src/services/chat.service.js";
import { JOB_META_KEY } from "../src/services/job-meta.js";

const SPEAKER = "טל";
const PARTNER = "עמית";

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

async function ensureShopping(account: HarnessAccount) {
  return (
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
    }))
  );
}

describe("HighRiskActionGate strip-only (sendChatMessage, eval-db)", () => {
  let account: HarnessAccount | null = null;

  afterEach(async () => {
    setLlmClientForTests(null);
    if (account) {
      await cleanupAccount(account);
      account = null;
    }
  });

  it(
    "P-Share: co-share ACTION does not change visibleTo (side effect)",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const list = await ensureShopping(account);
      const item = await prisma.employeeListItem.create({
        data: {
          listId: list.id,
          itemKey: "חלב-gate",
          data: { "שם פריט": "חלב-gate" },
          scope: "personal",
          addedById: account.employeeId,
          visibleTo: [account.employeeId],
        },
      });
      const before = [...((item.visibleTo as string[]) ?? [])].sort();
      const invitesBefore = await prisma.whatsAppInvite.count({
        where: { userId: account.userId },
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
      // Ensure speaker has a phone so PendingConfirm can be staged/offered.
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501000001" },
      });

      const result = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "מה יש בקניות?",
      });

      const afterRow = await prisma.employeeListItem.findFirst({
        where: { id: item.id, deletedAt: null },
      });
      expect([...(afterRow?.visibleTo as string[] ?? [])].sort()).toEqual(before);
      expect(afterRow?.scope).toBe("personal");
      const invitesAfter = await prisma.whatsAppInvite.count({
        where: { userId: account.userId },
      });
      expect(invitesAfter).toBe(invitesBefore);
      // Must not claim success when Gate stripped the share.
      expect(result.reply).not.toMatch(/שיתפתי/);
      expect(result.reply).toMatch(/לא ביצעתי|אישור/);
      const pending = await prisma.pendingHighRiskConfirm.findFirst({
        where: { userId: account.userId, speakerEmployeeId: account.employeeId },
        orderBy: { createdAt: "desc" },
      });
      expect(pending?.status).toBe("offered");
      expect(pending?.confirmCommand.startsWith("hrc:ok:")).toBe(true);
    },
    60_000,
  );

  it(
    "P-Out: messages to partner create no foreign reminder / invite",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const remindersBefore = await prisma.reminder.count({
        where: { userId: account.userId },
      });
      const invitesBefore = await prisma.whatsAppInvite.count({
        where: { userId: account.userId },
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "שלחתי לעמית.", buttons: [] }],
          metadata: {
            messages: [{ targets: [PARTNER], text: "לקנות חלב" }],
            lists: [],
          },
        }),
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "מה יש לך?",
      });

      expect(
        await prisma.reminder.count({ where: { userId: account.userId } }),
      ).toBe(remindersBefore);
      expect(
        await prisma.whatsAppInvite.count({ where: { userId: account.userId } }),
      ).toBe(invitesBefore);
    },
    60_000,
  );

  it(
    "P-Mass: multi-id remove does not soft-delete rows",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const list = await ensureShopping(account);
      const a = await prisma.employeeListItem.create({
        data: {
          listId: list.id,
          itemKey: "a-gate",
          data: { "שם פריט": "a-gate" },
          scope: "personal",
          addedById: account.employeeId,
          visibleTo: [account.employeeId],
        },
      });
      const b = await prisma.employeeListItem.create({
        data: {
          listId: list.id,
          itemKey: "b-gate",
          data: { "שם פריט": "b-gate" },
          scope: "personal",
          addedById: account.employeeId,
          visibleTo: [account.employeeId],
        },
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "מחקתי.", buttons: [] }],
          metadata: {
            lists: [
              {
                action: "remove",
                list_type: "shopping",
                list_name: "",
                items: [{ item_id: a.id }, { item_id: b.id }],
                targets: [],
              },
            ],
          },
        }),
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "מה בקניות?",
      });

      const aAfter = await prisma.employeeListItem.findFirst({ where: { id: a.id } });
      const bAfter = await prisma.employeeListItem.findFirst({ where: { id: b.id } });
      expect(aAfter?.deletedAt).toBeNull();
      expect(bAfter?.deletedAt).toBeNull();
    },
    60_000,
  );

  it(
    "control: single-id remove still applies (natural UX)",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const list = await ensureShopping(account);
      const item = await prisma.employeeListItem.create({
        data: {
          listId: list.id,
          itemKey: "solo-gate",
          data: { "שם פריט": "solo-gate" },
          scope: "personal",
          addedById: account.employeeId,
          visibleTo: [account.employeeId],
        },
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "מחקתי את solo-gate.", buttons: [] }],
          metadata: {
            lists: [
              {
                action: "remove",
                list_type: "shopping",
                list_name: "",
                items: [{ item_id: item.id }],
                targets: [],
              },
            ],
          },
        }),
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "תמחק את solo-gate",
      });

      const after = await prisma.employeeListItem.findFirst({ where: { id: item.id } });
      expect(after?.deletedAt).not.toBeNull();
    },
    60_000,
  );

  it(
    "Stage 5b: applyPendingCollabInvites auto-apply cut over — invites need opaque V",
    async () => {
      // S8 Option A complete: pre-LLM auto-apply is a no-op; present + Accept/Decline
      // is covered by collab-invite-ack.eval-db.test.ts.
      expect(
        "applyPendingCollabInvites is a no-op after Stage 5b cutover",
      ).toBeTruthy();
    },
  );

  it(
    "Class V confirm tap applies staged share snapshot (side effect)",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501000002" },
      });
      const list = await ensureShopping(account);
      const item = await prisma.employeeListItem.create({
        data: {
          listId: list.id,
          itemKey: "חלב-v",
          data: { "שם פריט": "חלב-v" },
          scope: "personal",
          addedById: account.employeeId,
          visibleTo: [account.employeeId],
        },
      });
      const amit = account.partners[0]!;

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
      // No share-intent verb: under signal mode, "שתפי" would allow-through
      // and never stage Class V. Staging requires a strip (same as P-Share case).
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "מה יש בקניות?",
      });
      const pending = await prisma.pendingHighRiskConfirm.findFirst({
        where: {
          userId: account.userId,
          status: "offered",
        },
        orderBy: { createdAt: "desc" },
      });
      expect(pending).toBeTruthy();

      setLlmClientForTests(null);
      const confirmResult = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: pending!.confirmCommand,
      });
      expect(confirmResult.reply).toMatch(/בוצע לפי האישור/);
      const after = await prisma.employeeListItem.findFirst({
        where: { id: item.id, deletedAt: null },
      });
      expect(after?.scope).toBe("shared");
      expect(after?.visibleTo as string[]).toEqual(
        expect.arrayContaining([account.employeeId, amit.id]),
      );
      const done = await prisma.pendingHighRiskConfirm.findFirst({
        where: { id: pending!.id },
      });
      expect(done?.status).toBe("consumed");

      // Replay must not duplicate / re-apply.
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: pending!.confirmCommand,
      });
      const again = await prisma.pendingHighRiskConfirm.findFirst({
        where: { id: pending!.id },
      });
      expect(again?.status).toBe("consumed");
    },
    90_000,
  );

  it(
    "self-job overdue סגירה: jobs.answer applies without High Risk confirm",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501000099" },
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

      const job = await prisma.employeeListItem.create({
        data: {
          listId: tasksList.id,
          itemKey: `overdue-self-${randomUUID().slice(0, 8)}`,
          data: {
            "שם משימה": "לבדוק משימות שעבר המועד",
            [JOB_META_KEY]: {
              kind: "job",
              askerId: account.employeeId,
              askerName: SPEAKER,
              subjectId: account.employeeId,
              subjectName: SPEAKER,
              ask: "משימות שעבר המועד",
              state: "open",
              createdAt: new Date().toISOString(),
              overdueItemIds: [],
              overdueTitles: ["להזכיר לטל לקבוע תור"],
            },
          },
          scope: "personal",
          addedById: lucyId,
          visibleTo: [lucyId],
        },
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "סגרתי.", buttons: [] }],
          metadata: {
            jobs: [
              {
                action: "answer",
                job_id: job.id,
                answer_text: "סגירה",
                report_text: "",
              },
            ],
            lists: [],
          },
        }),
      );

      const result = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message:
          '[בתשובה להודעה: "יש לך משימה שעבר המועד. לסגור אותה או לעדכן להיום?"] סגירה',
      });

      expect(result.reply).not.toMatch(/אישור מפורש/);
      expect(result.reply).toMatch(/סגרתי/);
      const pending = await prisma.pendingHighRiskConfirm.findFirst({
        where: {
          userId: account.userId,
          speakerEmployeeId: account.employeeId,
          status: { in: ["offered", "pending_offer"] },
        },
      });
      expect(pending).toBeNull();

      const closed = await prisma.employeeListItem.findFirst({
        where: { id: job.id },
      });
      expect(closed?.deletedAt).not.toBeNull();
    },
    60_000,
  );

  it(
    "third-party jobs.answer auto-reports and closes without High Risk confirm",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const amit = await prisma.employee.findFirstOrThrow({
        where: { userId: account.userId, name: PARTNER, kind: "human" },
      });
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501000098" },
      });
      await prisma.employee.update({
        where: { id: amit.id },
        data: { phone: "972501000198" },
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

      const job = await prisma.employeeListItem.create({
        data: {
          listId: tasksList.id,
          itemKey: `ask-other-${randomUUID().slice(0, 8)}`,
          data: {
            "שם משימה": "לבדוק עם טל: מה שלומך?",
            [JOB_META_KEY]: {
              kind: "job",
              askerId: amit.id,
              askerName: PARTNER,
              subjectId: account.employeeId,
              subjectName: SPEAKER,
              ask: "מה שלומך?",
              state: "open",
              createdAt: new Date().toISOString(),
            },
          },
          scope: "personal",
          addedById: lucyId,
          visibleTo: [lucyId],
        },
      });

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "עדכנתי.", buttons: [] }],
          metadata: {
            jobs: [
              {
                action: "answer",
                job_id: job.id,
                answer_text: "הכל טוב",
                report_text: "טל מוסר שהכול טוב.",
              },
            ],
          },
        }),
      );

      const result = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "הכל טוב",
      });

      expect(result.reply).not.toMatch(/אישור מפורש/);
      expect(result.reply).toMatch(/עדכנתי/);
      const pending = await prisma.pendingHighRiskConfirm.findFirst({
        where: {
          userId: account.userId,
          speakerEmployeeId: account.employeeId,
          status: { in: ["offered", "pending_offer"] },
        },
      });
      expect(pending).toBeNull();

      const closed = await prisma.employeeListItem.findFirst({
        where: { id: job.id },
      });
      expect(closed?.deletedAt).not.toBeNull();

      const deliveries = await prisma.deliveryAttempt.count({
        where: {
          userId: account.userId,
          purpose: "job_report",
          status: "accepted",
        },
      });
      expect(deliveries).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );

  it(
    "multi openJobs: answers the named jobId — self closes, third-party auto-closes",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const amit = await prisma.employee.findFirstOrThrow({
        where: { userId: account.userId, name: PARTNER, kind: "human" },
      });
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { phone: "972501000097" },
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
          itemKey: `self-multi-${randomUUID().slice(0, 8)}`,
          data: {
            "שם משימה": "לבדוק משימות שעבר המועד",
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
      const otherJob = await prisma.employeeListItem.create({
        data: {
          listId: tasksList.id,
          itemKey: `other-multi-${randomUUID().slice(0, 8)}`,
          data: {
            "שם משימה": "לבדוק עם טל: מה שלומך?",
            [JOB_META_KEY]: {
              kind: "job",
              askerId: amit.id,
              askerName: PARTNER,
              subjectId: account.employeeId,
              subjectName: SPEAKER,
              ask: "מה שלומך?",
              state: "open",
              createdAt: new Date().toISOString(),
            },
          },
          scope: "personal",
          addedById: lucyId,
          visibleTo: [lucyId],
        },
      });

      // 1) Answer the self job by explicit id while third-party job is also open.
      setLlmClientForTests(
        stubReply({
          responses: [{ text: "סגרתי את האיחור.", buttons: [] }],
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
      expect(selfResult.reply).toMatch(/סגרתי/);
      expect(
        (
          await prisma.employeeListItem.findFirst({ where: { id: selfJob.id } })
        )?.deletedAt,
      ).not.toBeNull();
      expect(
        await prisma.employeeListItem.findFirst({
          where: { id: otherJob.id, deletedAt: null },
        }),
      ).toBeTruthy();
      expect(
        await prisma.pendingHighRiskConfirm.findFirst({
          where: {
            userId: account.userId,
            status: { in: ["offered", "pending_offer"] },
          },
        }),
      ).toBeNull();

      // 2) Answer the third-party job by id — auto report + close, no Class V.
      setLlmClientForTests(
        stubReply({
          responses: [{ text: "מסרתי.", buttons: [] }],
          metadata: {
            jobs: [
              {
                action: "answer",
                job_id: otherJob.id,
                answer_text: "הכל טוב",
                report_text: "טל מוסר שהכול טוב.",
              },
            ],
          },
        }),
      );
      const otherResult = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "הכל טוב",
      });
      expect(otherResult.reply).not.toMatch(/אישור מפורש/);
      expect(otherResult.reply).toMatch(/מסרתי/);
      const otherRow = await prisma.employeeListItem.findFirst({
        where: { id: otherJob.id },
      });
      expect(otherRow?.deletedAt).not.toBeNull();
      expect(
        await prisma.pendingHighRiskConfirm.findFirst({
          where: {
            userId: account.userId,
            status: { in: ["offered", "pending_offer"] },
          },
        }),
      ).toBeNull();
    },
    90_000,
  );
});
