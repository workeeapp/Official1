/**
 * Wave 1 PLG Prospect onboarding — live E2E simulation on workee_test.
 *
 * Exercises the same production chat pipeline as WhatsApp inbound
 * (`resolveWhatsAppSpeaker` → `sendChatMessage` / Explicit Join / Class V),
 * stubs LLM + WA outbound, prints a readable transcript.
 *
 * Run: npm run test:eval-db -- tests/wave1-plg-prospect-e2e.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { resetEnvCache } from "../src/config/env.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { handleExplicitJoinAccept } from "../src/services/explicit-join.service.js";
import {
  handleDevProspectTool,
  isDevTestPhoneAllowed,
  PHONE_BACKUP_SUFFIX,
} from "../src/services/prospect-dev-tools.service.js";
import { EXPLICIT_JOIN_ACCEPT_PREFIX } from "../src/services/pending-prospect-action.service.js";
import {
  parseCollabInvitePayload,
} from "../src/services/collab-invite.service.js";
import {
  createWhatsAppInvite,
  formatAskerPendingNotice,
} from "../src/services/whatsapp-invite.service.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { listEmployeesForUser } from "../src/services/employee.service.js";
import { resolveWhatsAppSpeaker } from "../src/services/whatsapp.service.js";
import { phonesMatch } from "../src/utils/phone.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";

const ASKER_PHONE = "972500000011";
const PROSPECT_PHONE = "972500000022";
const CONTACT_NAME = "דני";
const PRIVATE_ITEM = "סוד-פרטי-אל-תדליף";
const SHARE_ITEM = "לחם-שיתוף-PLG";
const REMINDER_ITEM = "לקנות חלב";
const ASSIGN_TASK = "להוציא את הכלב";

type Check = { name: string; pass: boolean; detail: string };
type Bubble = { who: string; direction: "in" | "out"; text: string; buttons?: string[] };

const checks: Check[] = [];
const transcript: Bubble[] = [];
const harnesses: HarnessAccount[] = [];
const extraUserIds: string[] = [];

function check(name: string, pass: boolean, detail = ""): void {
  checks.push({ name, pass, detail });
  const mark = pass ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function sayIn(who: string, text: string): void {
  transcript.push({ who, direction: "in", text });
  console.log(`\n▶ ${who} → Lucy\n  ${text}`);
}

function sayOut(who: string, reply: string): void {
  const parsed = parseLlmReply(reply);
  const buttons = [
    ...(parsed.buttons ?? []),
    ...parsed.responseBubbles.flatMap((b) => b.buttons ?? []),
  ].map((b) => `${b.label} ⟶ ${b.command}`);
  const text = parsed.response.trim() || reply.slice(0, 240);
  transcript.push({ who, direction: "out", text, buttons });
  console.log(`◀ Lucy → ${who}\n  ${text}`);
  if (buttons.length) {
    console.log(`  [buttons] ${buttons.join(" | ")}`);
  }
}

function joinCommandFromReply(reply: string): string | null {
  const parsed = parseLlmReply(reply);
  const buttons = [
    ...(parsed.buttons ?? []),
    ...parsed.responseBubbles.flatMap((b) => b.buttons ?? []),
  ];
  return (
    buttons.find((b) => b.command.startsWith(EXPLICIT_JOIN_ACCEPT_PREFIX))
      ?.command ?? null
  );
}

function confirmCommandFromReply(reply: string): string | null {
  const parsed = parseLlmReply(reply);
  const buttons = [
    ...(parsed.buttons ?? []),
    ...parsed.responseBubbles.flatMap((b) => b.buttons ?? []),
  ];
  return buttons.find((b) => b.command.startsWith("hrc:ok:"))?.command ?? null;
}

function stubLlm(payload: unknown, sink?: { facts: string; calls: number }) {
  setLlmClientForTests({
    async createConversation() {
      return `conv-${randomUUID()}`;
    },
    async createResponse(input) {
      if (sink) {
        sink.facts = input.liveFacts ?? "";
        sink.calls += 1;
      }
      return { reply: JSON.stringify(payload), raw: {} };
    },
  });
}

async function cleanupPhone(phone: string): Promise<void> {
  const humans = await prisma.employee.findMany({
    where: { phone: { not: null }, kind: "human" },
    select: { id: true, userId: true, phone: true },
  });
  const hits = humans.filter(
    (row) =>
      row.phone &&
      (phonesMatch(row.phone, phone) ||
        row.phone === `${phone}${PHONE_BACKUP_SUFFIX}` ||
        row.phone.endsWith(PHONE_BACKUP_SUFFIX)),
  );
  for (const hit of hits) {
    await destroyCreatedUser(hit.userId);
  }
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
  await prisma.contactBook.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.employeeList.deleteMany({ where: { employee: { userId } } }).catch(() => undefined);
  await prisma.employeeFiling.deleteMany({ where: { employee: { userId } } }).catch(() => undefined);
  await prisma.tipProgress.deleteMany({ where: { employee: { userId } } }).catch(() => undefined);
  await prisma.tip.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.employee.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

async function openAskerMember(): Promise<{
  account: HarnessAccount;
  digitalEmployeeId: string;
  name: string;
}> {
  const account = await createHarnessAccount("טל", { digitalWorker: true });
  harnesses.push(account);
  await prisma.user.update({
    where: { id: account.userId },
    data: { consentPending: false },
  });
  await prisma.employee.update({
    where: { id: account.employeeId },
    data: { phone: ASKER_PHONE },
  });
  await prisma.contact.create({
    data: {
      userId: account.userId,
      ownerEmployeeId: account.employeeId,
      name: CONTACT_NAME,
      phone: PROSPECT_PHONE,
    },
  });
  // Private shopping item — must never leak to Prospect present.
  const list = await prisma.employeeList.create({
    data: {
      employeeId: account.employeeId,
      listType: "shopping",
      name: "",
      scope: "personal",
      visibleTo: [account.employeeId],
    },
  });
  await prisma.employeeListItem.create({
    data: {
      listId: list.id,
      itemKey: PRIVATE_ITEM,
      data: { "שם פריט": PRIVATE_ITEM },
      scope: "personal",
      addedById: account.employeeId,
      visibleTo: [account.employeeId],
    },
  });
  return {
    account,
    digitalEmployeeId: account.digitalEmployeeId!,
    name: "טל",
  };
}

async function openProspect(): Promise<{
  userId: string;
  employeeId: string;
  digitalEmployeeId: string;
}> {
  const speaker = await resolveWhatsAppSpeaker(PROSPECT_PHONE);
  extraUserIds.push(speaker.userId);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: speaker.userId } });
  expect(user.consentPending).toBe(true);
  const employees = await listEmployeesForUser(speaker.userId);
  const lucy = employees.find((row) => row.protected === true);
  if (!lucy) {
    throw new Error("Prospect missing Lucy");
  }
  return {
    userId: speaker.userId,
    employeeId: speaker.employeeId,
    digitalEmployeeId: lucy.id,
  };
}

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
});

afterAll(async () => {
  setLlmClientForTests(null);
  vi.restoreAllMocks();
  for (const id of [...extraUserIds]) {
    await destroyCreatedUser(id);
  }
  extraUserIds.length = 0;
  while (harnesses.length > 0) {
    const account = harnesses.pop();
    if (account) {
      await prisma.pendingProspectAction
        .deleteMany({ where: { userId: account.userId } })
        .catch(() => undefined);
      await prisma.pendingHighRiskConfirm
        .deleteMany({ where: { userId: account.userId } })
        .catch(() => undefined);
      await prisma.whatsAppInvite
        .deleteMany({ where: { userId: account.userId } })
        .catch(() => undefined);
      await destroyHarnessAccount(account);
    }
  }
  await cleanupPhone(ASKER_PHONE);
  await cleanupPhone(PROSPECT_PHONE);
  process.env.DEV_TEST_PHONES = process.env.DEV_TEST_PHONES ?? "";
  process.env.PROSPECT_MAX_INBOUND_MESSAGES = "15";
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
  resetEnvCache();
});

describe("Wave 1 PLG Prospect E2E simulation (eval-db)", () => {
  it(
    "runs setup + scenarios 1–3 with printable transcript",
    async () => {
      console.log("\n========== WAVE 1 PLG E2E SIMULATION ==========\n");
      vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
      vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
      vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
      vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);

      await cleanupPhone(ASKER_PHONE);
      await cleanupPhone(PROSPECT_PHONE);

      // ——— Setup: /as-prospect + /reset-me guards ———
      console.log("--- Setup: DEV tools guards ---");
      process.env.DEV_TEST_PHONES = ASKER_PHONE;
      process.env.NODE_ENV = "test";
      resetEnvCache();
      check(
        "DEV allowlist admits asker phone outside production",
        isDevTestPhoneAllowed(ASKER_PHONE) === true,
      );
      check(
        "DEV allowlist rejects unknown phone",
        isDevTestPhoneAllowed("972509999999") === false,
      );
      process.env.NODE_ENV = "production";
      resetEnvCache();
      const blockedProd = await handleDevProspectTool({
        phone: ASKER_PHONE,
        text: "/as-prospect",
      });
      check(
        "/as-prospect ignored in production",
        blockedProd.handled === false,
        blockedProd.reply || "(empty)",
      );
      process.env.NODE_ENV = "test";
      resetEnvCache();

      const asker = await openAskerMember();
      const asProspect = await handleDevProspectTool({
        phone: ASKER_PHONE,
        text: "/as-prospect",
      });
      check(
        "/as-prospect renames phone to _backup",
        asProspect.handled === true &&
          (asProspect.reply.includes(PHONE_BACKUP_SUFFIX) ||
            asProspect.reply.includes("_backup")),
        asProspect.reply,
      );
      const resetMe = await handleDevProspectTool({
        phone: ASKER_PHONE,
        text: "/reset-me",
      });
      check(
        "/reset-me restores asker phone",
        resetMe.handled === true && resetMe.reply.includes(ASKER_PHONE),
        resetMe.reply,
      );
      const askerEmp = await prisma.employee.findUniqueOrThrow({
        where: { id: asker.account.employeeId },
      });
      check("asker phone restored after /reset-me", askerEmp.phone === ASKER_PHONE);

      // ——— Scenario 1: Share → gate → join → execute ———
      console.log("\n========== SCENARIO 1: Shopping Share PLG ==========");
      const prospect = await openProspect();
      const prospectUser0 = await prisma.user.findUniqueOrThrow({
        where: { id: prospect.userId },
      });
      check("Prospect starts with consentPending=true", prospectUser0.consentPending === true);
      // openProspect marks inbound — clear it so Share hits the Cold Prospect
      // path (Pending + AskerNotice + wa.me), matching production cold send.
      await prisma.whatsAppInbound
        .deleteMany({ where: { phone: { contains: PROSPECT_PHONE.slice(-9) } } })
        .catch(() => undefined);

      // Asker NL → HighRisk confirm UX, then durable deferred Share invite (ממתין).
      sayIn("Asker", `תשתפי את הקניות עם ${CONTACT_NAME}: ${SHARE_ITEM}`);
      stubLlm({
        responses: [{ text: "שיתפתי את הקניות.", buttons: [] }],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              list_name: "",
              targets: [asker.name, CONTACT_NAME],
              items: [{ "שם פריט": SHARE_ITEM }],
            },
          ],
        },
      });
      const askerShare1 = await sendChatMessage({
        userId: asker.account.userId,
        employeeId: asker.account.employeeId,
        digitalEmployeeId: asker.digitalEmployeeId,
        message: `תשתפי את הקניות עם ${CONTACT_NAME}`,
      });
      sayOut("Asker", askerShare1.reply);
      const hrConfirm = confirmCommandFromReply(askerShare1.reply);
      const shareTurn1Text = parseLlmReply(askerShare1.reply).response;
      check(
        "Asker Share not silently done (Class V or Pending AskerNotice)",
        (Boolean(hrConfirm) || /ממתין/.test(shareTurn1Text)) &&
          !/שיתפתי את הקניות/.test(shareTurn1Text),
        hrConfirm ?? shareTurn1Text.slice(0, 180),
      );

      let askerPendingReply = askerShare1.reply;
      if (hrConfirm) {
        sayIn("Asker", hrConfirm);
        setLlmClientForTests(null);
        const askerConfirmTurn = await sendChatMessage({
          userId: asker.account.userId,
          employeeId: asker.account.employeeId,
          digitalEmployeeId: asker.digitalEmployeeId,
          message: hrConfirm,
        });
        sayOut("Asker", askerConfirmTurn.reply);
        askerPendingReply = askerConfirmTurn.reply;
      } else {
        setLlmClientForTests(null);
      }
      const confirmParsed = parseLlmReply(askerPendingReply);
      const confirmVisible = [
        confirmParsed.response,
        ...confirmParsed.responseBubbles.map((b) => b.text),
        confirmParsed.whatsappComposeUrl ?? "",
        ...confirmParsed.responseBubbles.map((b) => b.whatsappComposeUrl ?? ""),
      ]
        .filter(Boolean)
        .join("\n");
      check(
        "Asker sees ממתין (not בוצע) after confirm",
        /ממתין/.test(confirmVisible) && !/\bבוצע\b/.test(confirmVisible),
        confirmVisible.slice(0, 240),
      );
      check(
        "Asker Cold Prospect reply includes wa.me + forwardable draft",
        (/wa\.me\//.test(confirmVisible) ||
          Boolean(confirmParsed.whatsappComposeUrl) ||
          confirmParsed.responseBubbles.some((b) =>
            Boolean(b.whatsappComposeUrl),
          )) &&
          (/היי, כאן לוסי|«/.test(confirmVisible) ||
            /קישור מוכן|שלח בוואטסאפ|24/.test(confirmVisible)),
        confirmVisible.slice(0, 280),
      );
      const pendingShare = await prisma.whatsAppInvite.findFirst({
        where: {
          userId: asker.account.userId,
          recipientPhone: PROSPECT_PHONE,
          status: "pending",
        },
        orderBy: { createdAt: "desc" },
      });
      check("Share invite pending in DB", Boolean(pendingShare), pendingShare?.id ?? "");

      const factsSink = { facts: "", calls: 0 };
      sayIn("Prospect", "היי");
      stubLlm(
        {
          responses: [{ text: "היי! יש כאן משהו משותף בשבילך.", buttons: [] }],
          metadata: {},
        },
        factsSink,
      );
      const hi = await sendChatMessage({
        userId: prospect.userId,
        employeeId: prospect.employeeId,
        digitalEmployeeId: prospect.digitalEmployeeId,
        message: "היי",
      });
      sayOut("Prospect", hi.reply);
      check(
        "InviteValuePresenter exposes shared item in liveFacts",
        factsSink.facts.includes(SHARE_ITEM) &&
          factsSink.facts.includes("INVITE_VALUE"),
        factsSink.facts.includes(SHARE_ITEM)
          ? `found ${SHARE_ITEM}`
          : factsSink.facts.slice(0, 220),
      );
      check(
        "Asker private item NOT leaked to Prospect",
        !factsSink.facts.includes(PRIVATE_ITEM) &&
          !parseLlmReply(hi.reply).response.includes(PRIVATE_ITEM),
      );
      const stillProspect = await prisma.user.findUniqueOrThrow({
        where: { id: prospect.userId },
      });
      check("consentPending still true after present", stillProspect.consentPending === true);

      sayIn("Prospect", `תזכירי לי ${REMINDER_ITEM} ב-19:00`);
      stubLlm({
        responses: [{ text: "שמרתי לך תזכורת.", buttons: [] }],
        metadata: {
          reminders: [
            {
              action: "add",
              item: REMINDER_ITEM,
              date: "2031-06-15",
              time: "19:00",
              ping: ["אורח"],
              text: REMINDER_ITEM,
            },
          ],
        },
      });
      const gated = await sendChatMessage({
        userId: prospect.userId,
        employeeId: prospect.employeeId,
        digitalEmployeeId: prospect.digitalEmployeeId,
        message: `תזכירי לי ${REMINDER_ITEM} ב-19:00`,
      });
      sayOut("Prospect", gated.reply);
      const gatedText = parseLlmReply(gated.reply).response;
      const joinCmd = joinCommandFromReply(gated.reply);
      const reminderBefore = await prisma.reminder.findFirst({
        where: {
          ownerId: prospect.employeeId,
          status: "active",
          itemLabel: REMINDER_ITEM,
        },
      });
      check("ProspectWriteGate blocked reminder persistence", reminderBefore == null);
      check(
        "Join CTA is natural Hebrew (no saved claim / no registration jargon)",
        /בשמחה|אשרי/.test(gatedText) &&
          !/שמרתי|נרשמת|registration/i.test(gatedText),
        gatedText.slice(0, 160),
      );
      check(
        "explicit_join_accept button attached",
        Boolean(joinCmd?.startsWith(EXPLICIT_JOIN_ACCEPT_PREFIX)),
        joinCmd ?? "",
      );

      sayIn("Prospect", `[button_reply] ${joinCmd}`);
      const joined = await handleExplicitJoinAccept({
        userId: prospect.userId,
        employeeId: prospect.employeeId,
        digitalEmployeeId: prospect.digitalEmployeeId,
        joinCommand: joinCmd!,
        recipientPhone: PROSPECT_PHONE,
      });
      console.log(`◀ ExplicitJoinHandler → Prospect\n  ${joined.spoken}`);
      transcript.push({
        who: "Prospect",
        direction: "out",
        text: joined.spoken,
      });
      const afterJoin = await prisma.user.findUniqueOrThrow({
        where: { id: prospect.userId },
      });
      check("consentPending flipped to false", afterJoin.consentPending === false);
      const reminderAfter = await prisma.reminder.findFirst({
        where: {
          ownerId: prospect.employeeId,
          status: "active",
          itemLabel: REMINDER_ITEM,
        },
      });
      check(
        "pending reminder persisted after join",
        Boolean(reminderAfter),
        reminderAfter?.id ?? "",
      );
      check(
        "join confirmation spoken",
        /בוצע|שמרתי/.test(joined.spoken),
        joined.spoken,
      );
      const shareAfter = pendingShare
        ? await prisma.whatsAppInvite.findUnique({ where: { id: pendingShare.id } })
        : null;
      check(
        "Share invite connected (consumed) after join",
        shareAfter?.status === "consumed",
        shareAfter?.status ?? "missing",
      );

      // ——— Scenario 2: Assign double-consent ———
      console.log("\n========== SCENARIO 2: Assign double-consent ==========");
      // Reset Prospect: new WA account on same phone.
      await destroyCreatedUser(prospect.userId);
      extraUserIds.splice(extraUserIds.indexOf(prospect.userId), 1);
      // Keep asker; ensure phone still set.
      await prisma.employee.update({
        where: { id: asker.account.employeeId },
        data: { phone: ASKER_PHONE },
      });
      const prospect2 = await openProspect();
      check(
        "Scenario2 Prospect consentPending=true",
        (
          await prisma.user.findUniqueOrThrow({ where: { id: prospect2.userId } })
        ).consentPending === true,
      );

      sayIn("Asker", `תבקשי מ${CONTACT_NAME} ${ASSIGN_TASK} ב-17:00`);
      stubLlm({
        responses: [{ text: "ביקשתי.", buttons: [] }],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "tasks",
              list_name: "",
              targets: [CONTACT_NAME],
              items: [{ "שם משימה": ASSIGN_TASK }],
            },
          ],
        },
      });
      const askerAssign1 = await sendChatMessage({
        userId: asker.account.userId,
        employeeId: asker.account.employeeId,
        digitalEmployeeId: asker.digitalEmployeeId,
        message: `תבקשי ממנו ${ASSIGN_TASK} ב-17:00`,
      });
      sayOut("Asker", askerAssign1.reply);
      const assignHr = confirmCommandFromReply(askerAssign1.reply);
      check("Assign also requires high-risk confirm", Boolean(assignHr));
      sayIn("Asker", assignHr ?? "(missing)");
      setLlmClientForTests(null);
      await sendChatMessage({
        userId: asker.account.userId,
        employeeId: asker.account.employeeId,
        digitalEmployeeId: asker.digitalEmployeeId,
        message: assignHr!,
      });
      const assignRowId = randomUUID();
      const assignPayload = {
        v: 2 as const,
        kind: "assign" as const,
        domain: "list" as const,
        rowId: assignRowId,
        action: {
          action: "add" as const,
          listType: "tasks" as const,
          listName: "",
          items: [{ "שם משימה": ASSIGN_TASK }],
          targets: [] as string[],
        },
      };
      expect(parseCollabInvitePayload(assignPayload)).toBeTruthy();
      const assignCreated = await createWhatsAppInvite({
        userId: asker.account.userId,
        askerEmployeeId: asker.account.employeeId,
        digitalEmployeeId: asker.digitalEmployeeId,
        askerName: asker.name,
        recipientPhone: PROSPECT_PHONE,
        recipientLabel: CONTACT_NAME,
        askSummary: ASSIGN_TASK,
        expectsReply: true,
        intentKind: "assign",
        payload: assignPayload,
      });
      const assignPendingNotice = formatAskerPendingNotice({
        recipientLabel: CONTACT_NAME,
        intentKind: "assign",
      });
      sayOut(
        "Asker",
        JSON.stringify({
          responses: [
            {
              text: `${assignPendingNotice}\n\n${assignCreated?.notice ?? ""}`,
              buttons: [],
            },
          ],
          metadata: {},
        }),
      );
      check(
        "Assign asker notice is ממתין",
        assignPendingNotice.includes("ממתין"),
        assignPendingNotice,
      );
      const assignInvite = assignCreated?.invite ?? null;
      check("Assign invite pending", Boolean(assignInvite), assignInvite?.id ?? "");

      stubLlm({
        responses: [{ text: "יש בקשה לאחריות.", buttons: [] }],
        metadata: {},
      });
      sayIn("Prospect", "היי");
      const assignPresent = await sendChatMessage({
        userId: prospect2.userId,
        employeeId: prospect2.employeeId,
        digitalEmployeeId: prospect2.digitalEmployeeId,
        message: "היי",
      });
      sayOut("Prospect", assignPresent.reply);
      const assignAcceptCmd = confirmCommandFromReply(assignPresent.reply);
      check(
        "Assign Accept/Decline offered to Prospect",
        Boolean(assignAcceptCmd),
        assignAcceptCmd ?? "",
      );

      if (!assignAcceptCmd || !assignInvite) {
        check("Assign Accept while Prospect → join gate (invite still pending)", false, "missing accept cmd/invite");
        check("Join CTA uses אישור והצטרפות style path", false);
        check("consentPending=false after assign-gated join", false);
        check("Assign NOT silently auto-accepted", false);
        check("Assign re-present signal set", false);
      } else {
        sayIn("Prospect", `[Assign Accept] ${assignAcceptCmd}`);
        setLlmClientForTests(null);
        const assignGate = await sendChatMessage({
          userId: prospect2.userId,
          employeeId: prospect2.employeeId,
          digitalEmployeeId: prospect2.digitalEmployeeId,
          message: assignAcceptCmd,
        });
        sayOut("Prospect", assignGate.reply);
        const assignJoinCmd = joinCommandFromReply(assignGate.reply);
        const inviteStillPending = await prisma.whatsAppInvite.findUnique({
          where: { id: assignInvite.id },
        });
        check(
          "Assign Accept while Prospect → join gate (invite still pending)",
          Boolean(assignJoinCmd) && inviteStillPending?.status === "pending",
          assignJoinCmd ?? "",
        );
        const gateButtons = parseLlmReply(assignGate.reply).responseBubbles.flatMap(
          (b) => b.buttons ?? [],
        );
        check(
          "Join CTA uses אישור והצטרפות style path",
          /אישור והצטרפות|אשרי|בשמחה/.test(parseLlmReply(assignGate.reply).response) ||
            gateButtons.some((b) => /אישור|הצטרפ|תשמרי/.test(b.label)),
        );

        if (!assignJoinCmd) {
          check("consentPending=false after assign-gated join", false, "no join cmd");
          check("Assign NOT silently auto-accepted", false);
          check("Assign re-present signal set", false);
        } else {
          sayIn("Prospect", `[button_reply] ${assignJoinCmd}`);
          const assignJoined = await handleExplicitJoinAccept({
            userId: prospect2.userId,
            employeeId: prospect2.employeeId,
            digitalEmployeeId: prospect2.digitalEmployeeId,
            joinCommand: assignJoinCmd,
            recipientPhone: PROSPECT_PHONE,
          });
          console.log(`◀ ExplicitJoinHandler → Prospect\n  ${assignJoined.spoken}`);
          transcript.push({
            who: "Prospect",
            direction: "out",
            text: assignJoined.spoken,
            buttons: assignJoined.rePresentAssignInviteId
              ? ["(re-present Assign Accept/Decline)"]
              : [],
          });
          const afterAssignJoin = await prisma.user.findUniqueOrThrow({
            where: { id: prospect2.userId },
          });
          const inviteAfterJoin = await prisma.whatsAppInvite.findUnique({
            where: { id: assignInvite.id },
          });
          check(
            "consentPending=false after assign-gated join",
            afterAssignJoin.consentPending === false,
          );
          check(
            "Assign NOT silently auto-accepted",
            inviteAfterJoin?.status === "pending",
            inviteAfterJoin?.status ?? "",
          );
          check(
            "Assign re-present signal set",
            Boolean(assignJoined.rePresentAssignInviteId),
            assignJoined.rePresentAssignInviteId ?? "",
          );
        }
      }

      // ——— Scenario 3: Circuit breaker ———
      console.log("\n========== SCENARIO 3: Pre-LLM circuit breaker ==========");
      await destroyCreatedUser(prospect2.userId);
      extraUserIds.splice(extraUserIds.indexOf(prospect2.userId), 1);
      // Cancel leftover Assign invites for this phone so Scenario 3 is isolated.
      await prisma.whatsAppInvite.updateMany({
        where: {
          recipientPhone: { contains: PROSPECT_PHONE.slice(-9) },
          status: "pending",
        },
        data: { status: "cancelled" },
      });
      const prospect3 = await openProspect();
      process.env.PROSPECT_MAX_INBOUND_MESSAGES = "3";
      resetEnvCache();
      // Seed inbound messages to hit the hard cap without LLM.
      const conv = await prisma.chatConversation.create({
        data: {
          userId: prospect3.userId,
          employeeId: prospect3.employeeId,
          digitalEmployeeId: prospect3.digitalEmployeeId,
          openaiConversationId: `breaker-${randomUUID()}`,
        },
      });
      for (let i = 0; i < 3; i += 1) {
        await prisma.chatMessage.create({
          data: {
            conversationId: conv.id,
            author: "user",
            speaker: "אורח",
            text: `seed-${i}`,
          },
        });
      }
      const breakerSink = { facts: "", calls: 0 };
      stubLlm(
        {
          responses: [{ text: "זה לא אמור להגיע ל-LLM", buttons: [] }],
          metadata: {},
        },
        breakerSink,
      );
      sayIn("Prospect", "עוד הודעה אחרי המכסה");
      const broken = await sendChatMessage({
        userId: prospect3.userId,
        employeeId: prospect3.employeeId,
        digitalEmployeeId: prospect3.digitalEmployeeId,
        message: "עוד הודעה אחרי המכסה",
      });
      sayOut("Prospect", broken.reply);
      const breakerJoin = joinCommandFromReply(broken.reply);
      check(
        "Circuit breaker short-circuited before LLM",
        breakerSink.calls === 0,
        `llmCalls=${breakerSink.calls}`,
      );
      check(
        "Breaker returns fixed Hebrew CTA + join button",
        /להמשיך|בחופשיות|תנאי השימוש|אשרי/.test(parseLlmReply(broken.reply).response) &&
          Boolean(breakerJoin),
        parseLlmReply(broken.reply).response.slice(0, 160),
      );

      // ——— Summary table ———
      console.log("\n========== SUMMARY ==========");
      const pass = checks.filter((c) => c.pass).length;
      const fail = checks.filter((c) => !c.pass).length;
      console.log(`\n| # | Result | Check |`);
      console.log(`|---|--------|-------|`);
      checks.forEach((c, i) => {
        console.log(
          `| ${i + 1} | ${c.pass ? "PASS" : "FAIL"} | ${c.name}${c.detail ? ` (${c.detail.slice(0, 80)})` : ""} |`,
        );
      });
      console.log(`\nTOTAL: ${pass} PASS / ${fail} FAIL / ${checks.length} checks\n`);

      console.log("========== TRANSCRIPT (Scenarios 1–2) ==========");
      for (const row of transcript) {
        const arrow = row.direction === "in" ? "→" : "←";
        console.log(`${arrow} ${row.who}: ${row.text}`);
        if (row.buttons?.length) {
          console.log(`   buttons: ${row.buttons.join(" | ")}`);
        }
      }
      console.log("\n==============================================\n");

      expect(fail, `${fail} checks failed — see transcript above`).toBe(0);
    },
    240_000,
  );
});
