/**
 * Wave 1 anti-abuse — SenderBlock + unacknowledged assign rate cap
 * =================================================================
 * Isolated eval-db ONLY (`workee_test` @ `:5436`). Never touches LIVE `:5435`.
 *
 * Run:
 *   npm run test:eval-db -- tests/wave1-sender-block-rate-cap-e2e.eval-db.test.ts
 *
 * ---------------------------------------------------------------------------
 * Business rules
 * ---------------------------------------------------------------------------
 * - SenderBlock(blockerPhone, blockedPhone): recipient can block an external
 *   asker via opaque `block_sender:<phone>` (or free-text «תחסמי את …»).
 * - After block: subsequent assign/notify from blocked → blocker is suppressed
 *   (neutral notice to asker; zero chat/push to blocker).
 * - Unacknowledged assign cap: max 3 pending assign invites from the same
 *   askerEmployeeId → same recipientPhone until acknowledged.
 *
 * ---------------------------------------------------------------------------
 * ASCII flow
 * ---------------------------------------------------------------------------
 *
 *  STEP A — Block then assign
 *  ┌────────┐  block_sender:<askerPhone>
 *  │ Recip  │ ──────────────────────────► Lucy
 *  └────────┘  DB: SenderBlock row
 *  ┌────────┐  תקצי assign to Recip
 *  │ Asker  │ ──────────────────────────► Lucy
 *  └────────┘  WA: neutral notice; DB: no new pending invite; Recip: 0 new msgs
 *
 *  STEP B — Pending assign rate cap
 *  ┌────────┐  3× cold assign (pending)
 *  │ Asker  │ ──────────────────────────► Lucy
 *  └────────┘  4th → ASSIGN_RATE_CAP_NOTICE; pending count stays 3
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { resolveWhatsAppSpeaker } from "../src/services/whatsapp.service.js";
import { listEmployeesForUser } from "../src/services/employee.service.js";
import { phonesMatch } from "../src/utils/phone.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import { randomUUID } from "node:crypto";
import {
  ASSIGN_RATE_CAP_NOTICE,
  BLOCK_SENDER_PREFIX,
  SENDER_BLOCKED_NEUTRAL_NOTICE,
  blockSenderCommand,
  countPendingAssignInvites,
  normalizeBlockPhone,
} from "../src/services/sender-block.service.js";
import { PHONE_BACKUP_SUFFIX } from "../src/services/prospect-dev-tools.service.js";

const ASKER_PHONE = "972500000201";
const RECIP_PHONE = "972500000202";
const CONTACT_NAME = "נועם";

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
const harnesses: HarnessAccount[] = [];
const extraUserIds: string[] = [];

function check(name: string, pass: boolean, detail = ""): void {
  checks.push({ name, pass, detail });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function visible(reply: string): string {
  const parsed = parseLlmReply(reply);
  return [parsed.response, ...parsed.responseBubbles.map((b) => b.text)]
    .filter(Boolean)
    .join("\n");
}

function stubLlm(payload: unknown) {
  setLlmClientForTests({
    async createConversation() {
      return `conv-${randomUUID()}`;
    },
    async createResponse() {
      return { reply: JSON.stringify(payload), raw: {} };
    },
  });
}

function confirmCommandFromReply(reply: string): string | null {
  const parsed = parseLlmReply(reply);
  const buttons = [
    ...(parsed.buttons ?? []),
    ...parsed.responseBubbles.flatMap((b) => b.buttons ?? []),
  ];
  return buttons.find((b) => b.command.startsWith("hrc:ok:"))?.command ?? null;
}

async function sendAssignWithOptionalConfirm(input: {
  userId: string;
  employeeId: string;
  digitalEmployeeId: string;
  message: string;
}): Promise<string> {
  let reply = (
    await sendChatMessage({
      userId: input.userId,
      employeeId: input.employeeId,
      digitalEmployeeId: input.digitalEmployeeId,
      message: input.message,
    })
  ).reply;
  const hr = confirmCommandFromReply(reply);
  if (hr) {
    setLlmClientForTests(null);
    reply = (
      await sendChatMessage({
        userId: input.userId,
        employeeId: input.employeeId,
        digitalEmployeeId: input.digitalEmployeeId,
        message: hr,
      })
    ).reply;
  }
  return reply;
}

async function destroyCreatedUser(userId: string): Promise<void> {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  await prisma.pendingProspectAction.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.pendingHighRiskConfirm.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.deliveryAttempt.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.whatsAppInvite.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.reminder.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.chatMessage
    .deleteMany({ where: { conversation: { userId } } })
    .catch(() => undefined);
  await prisma.chatConversation.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.contact.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.employeeList.deleteMany({ where: { employee: { userId } } }).catch(() => undefined);
  await prisma.tipProgress.deleteMany({ where: { employee: { userId } } }).catch(() => undefined);
  await prisma.tip.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.employee.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

async function cleanupPhone(phone: string): Promise<void> {
  const norm = normalizeBlockPhone(phone);
  await prisma.senderBlock
    .deleteMany({
      where: {
        OR: [{ blockerPhone: norm }, { blockedPhone: norm }],
      },
    })
    .catch(() => undefined);
  const humans = await prisma.employee.findMany({
    where: { phone: { not: null }, kind: "human" },
    select: { userId: true, phone: true },
  });
  for (const hit of humans) {
    if (
      hit.phone &&
      (phonesMatch(hit.phone, phone) ||
        hit.phone === `${phone}${PHONE_BACKUP_SUFFIX}`)
    ) {
      await destroyCreatedUser(hit.userId);
    }
  }
}

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(new URL(process.env.DATABASE_URL!).port).toBe("5436");
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
});

afterAll(async () => {
  setLlmClientForTests(null);
  vi.restoreAllMocks();
  for (const id of [...extraUserIds]) {
    await destroyCreatedUser(id);
  }
  while (harnesses.length) {
    const h = harnesses.pop();
    if (h) {
      await prisma.whatsAppInvite.deleteMany({ where: { userId: h.userId } }).catch(() => undefined);
      await destroyHarnessAccount(h);
    }
  }
  await cleanupPhone(ASKER_PHONE);
  await cleanupPhone(RECIP_PHONE);
});

describe("Wave 1 SenderBlock + assign rate cap E2E (eval-db)", () => {
  it(
    "blocks sender after Recipient block; caps 4th pending assign",
    async () => {
      console.log("\n========== SENDER BLOCK + RATE CAP E2E ==========\n");
      vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
      vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
      vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
      vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);

      await cleanupPhone(ASKER_PHONE);
      await cleanupPhone(RECIP_PHONE);

      // ——— Setup asker Member ———
      const asker = await createHarnessAccount("שירה", { digitalWorker: true });
      harnesses.push(asker);
      await prisma.user.update({
        where: { id: asker.userId },
        data: { consentPending: false },
      });
      await prisma.employee.update({
        where: { id: asker.employeeId },
        data: { phone: ASKER_PHONE },
      });
      await prisma.contact.create({
        data: {
          userId: asker.userId,
          ownerEmployeeId: asker.employeeId,
          name: CONTACT_NAME,
          phone: RECIP_PHONE,
        },
      });
      const askerDigital = asker.digitalEmployeeId!;

      // ——— Open recipient account ———
      const recipSpeaker = await resolveWhatsAppSpeaker(RECIP_PHONE);
      extraUserIds.push(recipSpeaker.userId);
      const recipLucy = (await listEmployeesForUser(recipSpeaker.userId)).find(
        (r) => r.protected === true,
      );
      if (!recipLucy) {
        throw new Error("recipient missing Lucy");
      }
      const recip = {
        userId: recipSpeaker.userId,
        employeeId: recipSpeaker.employeeId,
        digitalEmployeeId: recipLucy.id,
      };

      // ------------------------------------------------------------------
      // STEP A — GIVEN recipient has no block
      //          WHEN they send block_sender:<askerPhone>
      //          THEN SenderBlock row exists
      //          WHEN asker assigns again
      //          THEN neutral notice + zero new invite + zero new recip msgs
      // ------------------------------------------------------------------
      console.log("\n========== STEP A: Block then assign ==========");
      const blockCmd = blockSenderCommand(ASKER_PHONE);
      expect(blockCmd.startsWith(BLOCK_SENDER_PREFIX)).toBe(true);
      stubLlm({ responses: [{ text: "ignored", buttons: [] }], metadata: {} });
      const blockTurn = await sendChatMessage({
        userId: recip.userId,
        employeeId: recip.employeeId,
        digitalEmployeeId: recip.digitalEmployeeId,
        message: blockCmd,
      });
      console.log(`◀ Lucy → Recip\n  ${visible(blockTurn.reply)}`);
      const blockRow = await prisma.senderBlock.findFirst({
        where: {
          blockerPhone: normalizeBlockPhone(RECIP_PHONE),
          blockedPhone: normalizeBlockPhone(ASKER_PHONE),
        },
      });
      check("StepA SenderBlock persisted", Boolean(blockRow), blockRow?.id ?? "");

      const invitesBefore = await prisma.whatsAppInvite.count({
        where: { userId: asker.userId, recipientPhone: { contains: RECIP_PHONE.slice(-9) } },
      });
      const recipMsgsBefore = await prisma.chatMessage.count({
        where: { conversation: { userId: recip.userId }, author: "assistant" },
      });

      await prisma.whatsAppInbound
        .deleteMany({ where: { phone: { contains: RECIP_PHONE.slice(-9) } } })
        .catch(() => undefined);

      stubLlm({
        responses: [{ text: "הטלתי.", buttons: [] }],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "tasks",
              list_name: "",
              targets: [CONTACT_NAME],
              items: [{ "שם משימה": "משימה חסומה" }],
            },
          ],
        },
      });
      const blockedVisible = visible(
        await sendAssignWithOptionalConfirm({
          userId: asker.userId,
          employeeId: asker.employeeId,
          digitalEmployeeId: askerDigital,
          message: `תקצי ל${CONTACT_NAME} משימה חסומה`,
        }),
      );
      console.log(`◀ Lucy → Asker (blocked path)\n  ${blockedVisible.slice(0, 240)}`);
      check(
        "StepA asker sees neutral blocked notice",
        blockedVisible.includes(SENDER_BLOCKED_NEUTRAL_NOTICE),
        blockedVisible.slice(0, 160),
      );
      const invitesAfterBlock = await prisma.whatsAppInvite.count({
        where: { userId: asker.userId, recipientPhone: { contains: RECIP_PHONE.slice(-9) } },
      });
      check(
        "StepA no new WhatsAppInvite after block",
        invitesAfterBlock === invitesBefore,
        `before=${invitesBefore} after=${invitesAfterBlock}`,
      );
      const recipMsgsAfter = await prisma.chatMessage.count({
        where: { conversation: { userId: recip.userId }, author: "assistant" },
      });
      check(
        "StepA zero new assistant push to recipient",
        recipMsgsAfter === recipMsgsBefore,
        `before=${recipMsgsBefore} after=${recipMsgsAfter}`,
      );

      // Clear block so Step B can create pending assigns.
      await prisma.senderBlock.deleteMany({
        where: {
          blockerPhone: normalizeBlockPhone(RECIP_PHONE),
          blockedPhone: normalizeBlockPhone(ASKER_PHONE),
        },
      });
      await prisma.whatsAppInvite.updateMany({
        where: {
          userId: asker.userId,
          recipientPhone: { contains: RECIP_PHONE.slice(-9) },
          status: "pending",
        },
        data: { status: "cancelled" },
      });

      // ------------------------------------------------------------------
      // STEP B — GIVEN same asker→recipient
      //          WHEN 3 pending assigns succeed
      //          THEN 4th is rate-capped; pending count stays 3
      // ------------------------------------------------------------------
      console.log("\n========== STEP B: Unacknowledged assign rate cap ==========");
      await prisma.whatsAppInbound
        .deleteMany({ where: { phone: { contains: RECIP_PHONE.slice(-9) } } })
        .catch(() => undefined);

      for (let i = 1; i <= 3; i += 1) {
        stubLlm({
          responses: [{ text: `הטלתי ${i}.`, buttons: [] }],
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                targets: [CONTACT_NAME],
                items: [{ "שם משימה": `משימה ממתינה ${i}` }],
              },
            ],
          },
        });
        const text = visible(
          await sendAssignWithOptionalConfirm({
            userId: asker.userId,
            employeeId: asker.employeeId,
            digitalEmployeeId: askerDigital,
            message: `תקצי ל${CONTACT_NAME} משימה ממתינה ${i}`,
          }),
        );
        console.log(`◀ assign #${i}: ${text.slice(0, 120)}`);
        check(
          `StepB pending assign #${i} created (ממתין)`,
          /ממתין/.test(text) && !text.includes(ASSIGN_RATE_CAP_NOTICE),
          text.slice(0, 100),
        );
      }

      const pending3 = await countPendingAssignInvites({
        askerEmployeeId: asker.employeeId,
        recipientPhone: RECIP_PHONE,
      });
      check("StepB exactly 3 pending assigns", pending3 === 3, `count=${pending3}`);

      stubLlm({
        responses: [{ text: "הטלתי 4.", buttons: [] }],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "tasks",
              list_name: "",
              targets: [CONTACT_NAME],
              items: [{ "שם משימה": "משימה ממתינה 4" }],
            },
          ],
        },
      });
      const fourthText = visible(
        await sendAssignWithOptionalConfirm({
          userId: asker.userId,
          employeeId: asker.employeeId,
          digitalEmployeeId: askerDigital,
          message: `תקצי ל${CONTACT_NAME} משימה ממתינה 4`,
        }),
      );
      console.log(`◀ assign #4: ${fourthText.slice(0, 200)}`);
      check(
        "StepB 4th assign blocked by rate cap",
        fourthText.includes(ASSIGN_RATE_CAP_NOTICE),
        fourthText.slice(0, 160),
      );
      const pendingAfter = await countPendingAssignInvites({
        askerEmployeeId: asker.employeeId,
        recipientPhone: RECIP_PHONE,
      });
      check(
        "StepB pending count stays at 3 after 4th attempt",
        pendingAfter === 3,
        `count=${pendingAfter}`,
      );

      console.log("\n========== SUMMARY ==========");
      const pass = checks.filter((c) => c.pass).length;
      const fail = checks.filter((c) => !c.pass).length;
      checks.forEach((c, i) => {
        console.log(
          `| ${i + 1} | ${c.pass ? "PASS" : "FAIL"} | ${c.name}${c.detail ? ` (${c.detail.slice(0, 80)})` : ""} |`,
        );
      });
      console.log(`\nTOTAL: ${pass} PASS / ${fail} FAIL / ${checks.length} checks\n`);
      expect(fail, `${fail} checks failed`).toBe(0);
    },
    240_000,
  );
});
