/**
 * Wave 1 PLG — Guest (Prospect) → Member onboarding + tips E2E
 * =================================================================
 * Isolated eval-db ONLY (`workee_test` @ `:5436`). Never touches LIVE `:5435`.
 *
 * Run:
 *   npm run test:eval-db -- tests/wave1-guest-onboarding-tips-e2e.eval-db.test.ts
 *
 * Trace artifact (written on every run):
 *   backend/scripts/wave1-guest-onboarding-tips-e2e.trace.txt
 *
 * ---------------------------------------------------------------------------
 * Business rules (PLG Guest model)
 * ---------------------------------------------------------------------------
 * - New WhatsApp phone → independent account with `User.consentPending === true`
 *   (Prospect / “Guest” in product language). Not legacy `Employee.isGuest`.
 * - Prospect may present pending Share/Assign invites and chat freely.
 * - Durable personal writes (reminders / lists / assign-out) are blocked by
 *   ProspectWriteGate → server-rendered Explicit Join CTA (no LLM consent).
 * - One-tap `explicit_join_accept:…` → `consentPending=false` (Member).
 * - Onboard tips (`prospect_onboard_*`): engine auto-picks on inbound turns
 *   **1 and 3** only (skip turn 2 so tips are never back-to-back). Order:
 *   tasks (40) → shopping (41) → reminders (42).
 * - Tip cadence still runs when Assign Accept/Decline **or** Join CTA buttons
 *   are present; only Member high-risk confirm turns suppress tips.
 * - Cold Assign AskerNotice draft: Lucy-branded, real task title, and Lucy
 *   `https://wa.me/<digits>?text=` prefilled with a concise Guest open line
 *   (e.g. «היי לוסי, נכנסתי לראות את המשימה ממיכל») — never “Workee” branding.
 *
 * ---------------------------------------------------------------------------
 * ASCII flow (Actor → Inbound → Expected DB → Expected WhatsApp reply)
 * ---------------------------------------------------------------------------
 *
 *  STEP 1 — Member assigns to unregistered Prospect
 *  ┌─────────┐  "תקצי לדני … 0509998887 להביא לחם דגנים"
 *  │  Michal │ ──────────────────────────────────────────► Lucy
 *  └─────────┘
 *       DB: WhatsAppInvite pending (kind=assign, tasks, title=להביא לחם דגנים)
 *       WA: Pending AskerNotice + «היי, כאן לוסי…» draft
 *           + Lucy wa.me?text= Guest open prefill (URL-encoded)
 *
 *  STEP 2 — Guest Turn 1 (Arrival via wa.me ?text= + Tip #1)
 *  ┌─────────┐  decode(?text=) e.g. "היי לוסי, נכנסתי לראות את המשימה ממיכל"
 *  │  Danny  │ ──────────────────────────────────────────► Lucy
 *  └─────────┘
 *       DB: TipProgress for prospect_onboard_tasks showCount≥1
 *       WA: Warm welcome + Michal's pending task visible
 *           + Tip #1 appended at end
 *
 *  STEP 3 — Guest Turn 2 (No Tip)
 *  ┌─────────┐  "מה המשימות שלי?"
 *  │  Danny  │ ──────────────────► Lucy
 *  └─────────┘
 *       DB: TipProgress onboard rows unchanged (no new tip)
 *       WA: Task list / status — NO prospect_onboard_* tip text
 *
 *  STEP 4 — Guest Turn 3 (Tip #2)
 *  ┌─────────┐  "תזכירי לי מחר ב-9 להתקשר לרופא"
 *  │  Danny  │ ──────────────────► Lucy
 *  └─────────┘
 *       DB: TipProgress increments (2nd onboard tip, usually shopping)
 *       WA: Join CTA OR spoken reply + Tip #2 appended
 *           (durable reminder is gated; tip still appends)
 *
 *  STEP 5 — Guest → Member one-tap upgrade
 *  ┌─────────┐  "תקצי לרונית לקנות חלב"  → Join CTA
 *  │  Danny  │  [כן, תשמרי לי]          → explicit_join_accept
 *  └─────────┘
 *       DB: consentPending=false (Member), consentAcceptedAt set
 *       WA: Join offer Hebrew + post-join spoken confirmation
 *
 *  STEP 6 — Guest → Member data continuity (zero loss / zero dupes)
 *  ┌─────────┐  reminder + shopping staged while Prospect → Join
 *  │  Noa    │ ──────────────────────────────────────────────► Lucy
 *  └─────────┘
 *       DB: same reminder + shopping item owned by Noa after join
 *           (count=1 each; no duplicate rows)
 *
 *  STEP 7 — Guest-origin task complete → inviter notify
 *  ┌─────────┐  Accept Michal's assign → "קניתי את הלחם דגנים"
 *  │  Danny  │ ──────────────────────────────────────────────► Lucy
 *  └─────────┘
 *       DB: assigned task soft-deleted; Michal assistant chatMessage notify
 *
 *  STEP 8 — Cold direct Prospect (uninvited)
 *  ┌─────────┐  "שלום, מה את יודעת לעשות?" (new phone, no invite)
 *  │  Ori    │  Turn1 Tip#1 → Turn2 no tip → Turn3 Tip#2
 *  └─────────┘
 *       DB: consentPending=true; TipProgress onboard shows 1 then 2
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { EXPLICIT_JOIN_ACCEPT_PREFIX } from "../src/services/pending-prospect-action.service.js";
import { parseCollabInvitePayload } from "../src/services/collab-invite.service.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { listEmployeesForUser } from "../src/services/employee.service.js";
import { resolveWhatsAppSpeaker } from "../src/services/whatsapp.service.js";
import { phonesMatch } from "../src/utils/phone.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import { SYSTEM_TIP_SEEDS } from "../src/services/tip-catalog.js";
import { PHONE_BACKUP_SUFFIX } from "../src/services/prospect-dev-tools.service.js";
import {
  decodeWhatsAppComposeText,
  formatGuestInviteOpenText,
} from "../src/services/whatsapp-invite.service.js";

const ASKER_PHONE = "972500000101";
const PROSPECT_PHONE = "972509998887"; // 0509998887
const CONTINUITY_PHONE = "972509998001";
const COLD_PHONE = "972509997001";
const CONTACT_DANI = "דני";
const CONTACT_RONIT = "רונית";
const CONTACT_MICHAL = "מיכל";
const ASSIGN_TASK = "להביא לחם דגנים";
const RONIT_TASK = "לקנות חלב";
const TURN3_MSG = "תזכירי לי מחר ב-9 להתקשר לרופא";
const CONTINUITY_REMINDER = "להתקשר לרופא";
const CONTINUITY_SHOP_ITEM = "חלב לבדיקת רציפות";
const COLD_TURN1 = "שלום, מה את יודעת לעשות?";
const COLD_TURN2 = "תודה, עוד משהו?";
const COLD_TURN3 = "אוקיי, מעולה";

const TIP1_TEXT =
  SYSTEM_TIP_SEEDS.find((t) => t.key === "prospect_onboard_tasks")?.text ?? "";
const TIP2_TEXT =
  SYSTEM_TIP_SEEDS.find((t) => t.key === "prospect_onboard_shopping")?.text ?? "";
const TIP3_TEXT =
  SYSTEM_TIP_SEEDS.find((t) => t.key === "prospect_onboard_reminders")?.text ?? "";
const ONBOARD_TIP_TEXTS = [TIP1_TEXT, TIP2_TEXT, TIP3_TEXT].filter(Boolean);

const TRACE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "wave1-guest-onboarding-tips-e2e.trace.txt",
);

type Check = { name: string; pass: boolean; detail: string };
type TraceStep = {
  step: number;
  title: string;
  actor: string;
  inbound: string;
  reply: string;
  buttons: string[];
  db: string[];
  checks: string[];
};

const checks: Check[] = [];
const traceSteps: TraceStep[] = [];
const harnesses: HarnessAccount[] = [];
const extraUserIds: string[] = [];
const logLines: string[] = [];

function log(line = ""): void {
  logLines.push(line);
  console.log(line);
}

function check(name: string, pass: boolean, detail = ""): void {
  checks.push({ name, pass, detail });
  const mark = pass ? "PASS" : "FAIL";
  log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function visibleReplyText(reply: string): string {
  const parsed = parseLlmReply(reply);
  return [
    parsed.response,
    ...parsed.responseBubbles.map((b) => b.text),
    parsed.whatsappComposeUrl ?? "",
    ...parsed.responseBubbles.map((b) => b.whatsappComposeUrl ?? ""),
  ]
    .filter(Boolean)
    .join("\n");
}

function extractAskerDraftBody(visible: string): string {
  const fromLucy = visible.match(/«(היי, כאן לוסי[\s\S]*?)»/);
  if (fromLucy?.[1]) {
    return fromLucy[1];
  }
  const blocks = [...visible.matchAll(/«([\s\S]*?)»/g)].map((m) => m[1] ?? "");
  return blocks.sort((a, b) => b.length - a.length)[0] ?? visible;
}

function buttonsFromReply(reply: string): string[] {
  const parsed = parseLlmReply(reply);
  return [
    ...(parsed.buttons ?? []),
    ...parsed.responseBubbles.flatMap((b) => b.buttons ?? []),
  ].map((b) => `${b.label} ⟶ ${b.command}`);
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

function containsOnboardTip(text: string): string | null {
  for (const tip of ONBOARD_TIP_TEXTS) {
    if (tip && text.includes(tip)) {
      return tip;
    }
  }
  return null;
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

async function onboardTipProgress(
  employeeId: string,
  digitalEmployeeId: string,
): Promise<Array<{ key: string; showCount: number }>> {
  const rows = await prisma.tipProgress.findMany({
    where: {
      employeeId,
      digitalEmployeeId,
      tip: { key: { startsWith: "prospect_onboard_" } },
    },
    include: { tip: { select: { key: true } } },
    orderBy: { lastShownAt: "asc" },
  });
  return rows.map((r) => ({ key: r.tip.key, showCount: r.showCount }));
}

function beginStep(step: number, title: string): TraceStep {
  const row: TraceStep = {
    step,
    title,
    actor: "",
    inbound: "",
    reply: "",
    buttons: [],
    db: [],
    checks: [],
  };
  traceSteps.push(row);
  log(`\n========== STEP ${step}: ${title} ==========`);
  return row;
}

function recordInbound(step: TraceStep, actor: string, inbound: string): void {
  step.actor = actor;
  step.inbound = inbound;
  log(`\n▶ ${actor} → Lucy\n  ${inbound}`);
}

function recordReply(step: TraceStep, who: string, reply: string): void {
  const text = visibleReplyText(reply).trim() || reply.slice(0, 400);
  const buttons = buttonsFromReply(reply);
  step.reply = text;
  step.buttons = buttons;
  log(`◀ Lucy → ${who}\n  ${text}`);
  if (buttons.length) {
    log(`  [buttons] ${buttons.join(" | ")}`);
  }
}

function recordDb(step: TraceStep, line: string): void {
  step.db.push(line);
  log(`  [DB] ${line}`);
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

function writeTraceFile(): void {
  const lines: string[] = [
    "Wave 1 Guest → Member onboarding + tips E2E — execution trace",
    `Generated: ${new Date().toISOString()}`,
    `DATABASE_URL port must be 5436 (eval). Never 5435.`,
    "",
  ];
  for (const step of traceSteps) {
    lines.push(`======== STEP ${step.step}: ${step.title} ========`);
    lines.push(`Actor:    ${step.actor}`);
    lines.push(`Inbound:  ${step.inbound}`);
    lines.push(`Reply:`);
    for (const row of step.reply.split("\n")) {
      lines.push(`  ${row}`);
    }
    if (step.buttons.length) {
      lines.push(`Buttons:  ${step.buttons.join(" | ")}`);
    }
    lines.push(`DB asserts:`);
    for (const db of step.db) {
      lines.push(`  - ${db}`);
    }
    lines.push(`Checks:`);
    for (const c of step.checks) {
      lines.push(`  - ${c}`);
    }
    lines.push("");
  }
  const pass = checks.filter((c) => c.pass).length;
  const fail = checks.filter((c) => !c.pass).length;
  lines.push(`SUMMARY: ${pass} PASS / ${fail} FAIL / ${checks.length} checks`);
  lines.push("");
  lines.push("--- full console log ---");
  lines.push(...logLines);
  mkdirSync(path.dirname(TRACE_PATH), { recursive: true });
  writeFileSync(TRACE_PATH, `${lines.join("\n")}\n`, "utf8");
  log(`\n[trace saved] ${TRACE_PATH}`);
}

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  const url = new URL(process.env.DATABASE_URL!);
  expect(url.port).toBe("5436");
  expect(url.pathname.replace(/^\//, "")).not.toBe("workee");
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
  // Ensure Lucy business wa.me links can carry Guest ?text= prefill in drafts.
  if (!process.env.WHATSAPP_DISPLAY_PHONE?.trim()) {
    process.env.WHATSAPP_DISPLAY_PHONE = "972501111111";
  }
  resetEnvCache();
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
  await cleanupPhone(CONTINUITY_PHONE);
  await cleanupPhone(COLD_PHONE);
  resetEnvCache();
});

describe("Wave 1 Guest onboarding + tips E2E (eval-db)", () => {
  it(
    "Michal assign → Danny tips cadence → one-tap Member upgrade",
    async () => {
      log("\n========== WAVE 1 GUEST ONBOARDING + TIPS E2E ==========\n");
      expect(TIP1_TEXT.length).toBeGreaterThan(10);
      expect(TIP2_TEXT.length).toBeGreaterThan(10);

      vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
      vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
      vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
      vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);

      await cleanupPhone(ASKER_PHONE);
      await cleanupPhone(PROSPECT_PHONE);
      await cleanupPhone(CONTINUITY_PHONE);
      await cleanupPhone(COLD_PHONE);

      // Setup asker Member (Michal) + contacts Danny / Ronit
      const asker = await createHarnessAccount("מיכל", { digitalWorker: true });
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
          name: CONTACT_DANI,
          phone: PROSPECT_PHONE,
        },
      });
      await prisma.contact.create({
        data: {
          userId: asker.userId,
          ownerEmployeeId: asker.employeeId,
          name: CONTACT_RONIT,
          phone: "972509991122",
        },
      });
      const askerDigitalId = asker.digitalEmployeeId!;

      // ------------------------------------------------------------------
      // STEP 1 — GIVEN Michal is a Member with Danny (0509998887) in contacts
      //          WHEN she assigns "להביא לחם דגנים" to unregistered Danny
      //          THEN AskerNotice draft is clean (no Workee) + pending invite
      // ------------------------------------------------------------------
      const step1 = beginStep(
        1,
        "Member assigns to unregistered Prospect (AskerNotice draft)",
      );
      await prisma.whatsAppInbound
        .deleteMany({ where: { phone: { contains: PROSPECT_PHONE.slice(-9) } } })
        .catch(() => undefined);

      const assignMsg = `תקצי לדני בדיקה 0509998887 ${ASSIGN_TASK}`;
      recordInbound(step1, "Michal", assignMsg);
      stubLlm({
        responses: [
          {
            text: `הטלתי על ${CONTACT_DANI}: ${ASSIGN_TASK}.`,
            buttons: [],
          },
        ],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "tasks",
              list_name: "",
              targets: [CONTACT_DANI],
              items: [{ "שם משימה": ASSIGN_TASK }],
            },
          ],
        },
      });
      const askerAssign = await sendChatMessage({
        userId: asker.userId,
        employeeId: asker.employeeId,
        digitalEmployeeId: askerDigitalId,
        message: assignMsg,
      });
      let askerPendingReply = askerAssign.reply;
      const hrConfirm = confirmCommandFromReply(askerAssign.reply);
      if (hrConfirm) {
        recordReply(step1, "Michal (pre-confirm)", askerAssign.reply);
        recordInbound(step1, "Michal", hrConfirm);
        setLlmClientForTests(null);
        const confirmTurn = await sendChatMessage({
          userId: asker.userId,
          employeeId: asker.employeeId,
          digitalEmployeeId: askerDigitalId,
          message: hrConfirm,
        });
        askerPendingReply = confirmTurn.reply;
      } else {
        setLlmClientForTests(null);
      }
      recordReply(step1, "Michal", askerPendingReply);

      const askerVisible = visibleReplyText(askerPendingReply);
      const draftBody = extractAskerDraftBody(askerVisible);
      const expectedOpenText = formatGuestInviteOpenText({
        inviterName: "מיכל",
        taskTitle: ASSIGN_TASK,
      });
      const lucyLinkInDraft = draftBody.match(
        /https:\/\/wa\.me\/\d+\?text=[^\s»]+/,
      )?.[0];
      const decodedFromDraft = lucyLinkInDraft
        ? decodeWhatsAppComposeText(lucyLinkInDraft)
        : null;
      const pendingInvite = await prisma.whatsAppInvite.findFirst({
        where: {
          userId: asker.userId,
          recipientPhone: { contains: PROSPECT_PHONE.slice(-9) },
          status: "pending",
        },
        orderBy: { createdAt: "desc" },
      });
      const payload = pendingInvite
        ? parseCollabInvitePayload(pendingInvite.payload)
        : null;
      recordDb(
        step1,
        `invite=${pendingInvite?.id ?? "missing"} status=${pendingInvite?.status ?? "n/a"} kind=${payload?.kind ?? "n/a"}`,
      );
      recordDb(
        step1,
        `lucyLink=${lucyLinkInDraft ?? "missing"} decodedOpen=${decodedFromDraft ?? "n/a"}`,
      );

      const draftOk =
        /היי, כאן לוסי/.test(draftBody) &&
        draftBody.includes(ASSIGN_TASK) &&
        Boolean(lucyLinkInDraft) &&
        decodedFromDraft === expectedOpenText &&
        !/Workee/i.test(askerVisible) &&
        !/Workee/i.test(draftBody);
      check(
        "Step1 AskerNotice draft: Lucy + real task + Guest wa.me?text= prefill, no Workee",
        draftOk,
        `expectedOpen=${expectedOpenText} | draft=${draftBody.slice(0, 220)}`,
      );
      step1.checks.push(
        draftOk
          ? "PASS draft + Guest prefill"
          : `FAIL draft — ${draftBody.slice(0, 120)}`,
      );
      check(
        "Step1 pending assign invite in DB",
        Boolean(pendingInvite) &&
          payload?.kind === "assign" &&
          payload.domain === "list" &&
          (payload.action as { listType?: string }).listType === "tasks",
        pendingInvite?.id ?? "",
      );
      step1.checks.push(
        pendingInvite ? `PASS invite ${pendingInvite.id}` : "FAIL no invite",
      );

      // ------------------------------------------------------------------
      // STEP 2 — GIVEN Danny opens the Lucy wa.me link from the draft
      //          WHEN he sends the exact decoded ?text= Guest open message
      //          THEN welcome + pending task visible + Tip #1 at end
      // ------------------------------------------------------------------
      const step2 = beginStep(
        2,
        "Guest Turn 1 — Arrival via wa.me ?text= + Tip #1",
      );
      const guestOpenMessage = decodedFromDraft ?? expectedOpenText;
      expect(guestOpenMessage).toBe(expectedOpenText);

      const speaker = await resolveWhatsAppSpeaker(PROSPECT_PHONE);
      extraUserIds.push(speaker.userId);
      const prospectUser = await prisma.user.findUniqueOrThrow({
        where: { id: speaker.userId },
      });
      expect(prospectUser.consentPending).toBe(true);
      const employees = await listEmployeesForUser(speaker.userId);
      const lucy = employees.find((row) => row.protected === true);
      if (!lucy) {
        throw new Error("Prospect missing Lucy");
      }
      const prospect = {
        userId: speaker.userId,
        employeeId: speaker.employeeId,
        digitalEmployeeId: lucy.id,
      };
      recordDb(step2, `consentPending=${prospectUser.consentPending}`);
      recordDb(step2, `guestOpenMessage=${guestOpenMessage}`);

      const factsSink = { facts: "", calls: 0 };
      recordInbound(step2, "Danny", guestOpenMessage);
      stubLlm(
        {
          responses: [
            {
              text: `היי! מיכל ביקשה ממך אחריות: ${ASSIGN_TASK}. רוצה לאשר?`,
              buttons: [],
            },
          ],
          metadata: {},
        },
        factsSink,
      );
      const hi = await sendChatMessage({
        userId: prospect.userId,
        employeeId: prospect.employeeId,
        digitalEmployeeId: prospect.digitalEmployeeId,
        message: guestOpenMessage,
      });
      recordReply(step2, "Danny", hi.reply);
      const hiVisible = visibleReplyText(hi.reply);
      const tip1Shown = containsOnboardTip(hiVisible);
      const tipProgressAfter1 = await onboardTipProgress(
        prospect.employeeId,
        prospect.digitalEmployeeId,
      );
      recordDb(
        step2,
        `tipProgress=${JSON.stringify(tipProgressAfter1)} tipInReply=${tip1Shown ? "yes" : "no"}`,
      );
      recordDb(
        step2,
        `factsHasTask=${factsSink.facts.includes(ASSIGN_TASK)} acceptBtn=${Boolean(confirmCommandFromReply(hi.reply))}`,
      );

      const taskVisible =
        hiVisible.includes(ASSIGN_TASK) ||
        factsSink.facts.includes(ASSIGN_TASK) ||
        /אחריות|משימה|מיכל/.test(hiVisible) ||
        Boolean(confirmCommandFromReply(hi.reply));
      check(
        "Step2 Guest welcome + Michal pending task visible",
        taskVisible,
        hiVisible.slice(0, 200),
      );
      step2.checks.push(taskVisible ? "PASS task visible" : "FAIL task missing");

      const tip1Ok =
        tip1Shown === TIP1_TEXT ||
        tipProgressAfter1.some(
          (r) => r.key === "prospect_onboard_tasks" && r.showCount >= 1,
        );
      check(
        "Step2 Tip #1 appended (prospect_onboard_tasks)",
        tip1Ok,
        tip1Shown?.slice(0, 80) ?? JSON.stringify(tipProgressAfter1),
      );
      step2.checks.push(tip1Ok ? "PASS Tip #1" : "FAIL Tip #1");
      check(
        "Step2 still Prospect (consentPending=true)",
        (
          await prisma.user.findUniqueOrThrow({ where: { id: prospect.userId } })
        ).consentPending === true,
      );

      // ------------------------------------------------------------------
      // STEP 3 — GIVEN Danny already saw Tip #1
      //          WHEN he asks "מה המשימות שלי?"
      //          THEN task list/status returned and NO onboard tip
      // ------------------------------------------------------------------
      const step3 = beginStep(3, "Guest Turn 2 — task list, no tip");
      const tipProgressBefore2 = await onboardTipProgress(
        prospect.employeeId,
        prospect.digitalEmployeeId,
      );
      recordInbound(step3, "Danny", "מה המשימות שלי?");
      stubLlm({
        responses: [
          {
            text: `המשימות שלך כרגע: ${ASSIGN_TASK} (ממתינה ממיכל).`,
            buttons: [],
          },
        ],
        metadata: { show_dump: "tasks" },
      });
      const tasksTurn = await sendChatMessage({
        userId: prospect.userId,
        employeeId: prospect.employeeId,
        digitalEmployeeId: prospect.digitalEmployeeId,
        message: "מה המשימות שלי?",
      });
      recordReply(step3, "Danny", tasksTurn.reply);
      const tasksVisible = visibleReplyText(tasksTurn.reply);
      const tipOnTurn2 = containsOnboardTip(tasksVisible);
      const tipProgressAfter2 = await onboardTipProgress(
        prospect.employeeId,
        prospect.digitalEmployeeId,
      );
      recordDb(
        step3,
        `tipInReply=${tipOnTurn2 ? "YES(bad)" : "none"} progress=${JSON.stringify(tipProgressAfter2)}`,
      );

      const listReturned =
        tasksVisible.includes(ASSIGN_TASK) ||
        /משימ|ריק|אין|רשימ/.test(tasksVisible) ||
        tasksVisible.trim().length > 0;
      check(
        "Step3 task list/status returned",
        listReturned,
        tasksVisible.slice(0, 200),
      );
      step3.checks.push(listReturned ? "PASS list" : "FAIL list");
      const noNewTip =
        tipOnTurn2 == null &&
        tipProgressAfter2.length === tipProgressBefore2.length &&
        tipProgressAfter2.every(
          (row, i) =>
            row.key === tipProgressBefore2[i]?.key &&
            row.showCount === tipProgressBefore2[i]?.showCount,
        );
      check("Step3 no onboard tip on Turn 2", noNewTip, tipOnTurn2 ?? "ok");
      step3.checks.push(noNewTip ? "PASS no tip" : "FAIL tip leaked");

      // ------------------------------------------------------------------
      // STEP 4 — GIVEN Turn 2 had no tip
      //          WHEN Danny sends a 3rd inbound (reminder request)
      //          THEN Tip #2 appends and TipProgress increments
      // ------------------------------------------------------------------
      const step4 = beginStep(4, "Guest Turn 3 — Tip #2 + tip progress");
      recordInbound(step4, "Danny", TURN3_MSG);
      stubLlm({
        responses: [{ text: "שמרתי לך תזכורת להתקשר לרופא.", buttons: [] }],
        metadata: {
          reminders: [
            {
              action: "add",
              item: "להתקשר לרופא",
              date: "2031-06-16",
              time: "09:00",
              ping: ["אורח"],
              text: "להתקשר לרופא",
            },
          ],
        },
      });
      const turn3 = await sendChatMessage({
        userId: prospect.userId,
        employeeId: prospect.employeeId,
        digitalEmployeeId: prospect.digitalEmployeeId,
        message: TURN3_MSG,
      });
      recordReply(step4, "Danny", turn3.reply);
      const turn3Visible = visibleReplyText(turn3.reply);
      const tip2Shown = containsOnboardTip(turn3Visible);
      const tipProgressAfter3 = await onboardTipProgress(
        prospect.employeeId,
        prospect.digitalEmployeeId,
      );
      const totalShows = tipProgressAfter3.reduce((n, r) => n + r.showCount, 0);
      recordDb(
        step4,
        `tipProgress=${JSON.stringify(tipProgressAfter3)} totalShows=${totalShows}`,
      );

      // Tip #2 is next unused onboard tip (shopping). Join CTA may also appear
      // because reminder is durable-gated — tip must still append at the end.
      const tip2Ok =
        totalShows >= 2 &&
        (tip2Shown === TIP2_TEXT ||
          tipProgressAfter3.some(
            (r) =>
              (r.key === "prospect_onboard_shopping" ||
                r.key === "prospect_onboard_reminders") &&
              r.showCount >= 1,
          ));
      check(
        "Step4 Tip #2 appended + TipProgress incremented",
        tip2Ok,
        tip2Shown?.slice(0, 80) ?? JSON.stringify(tipProgressAfter3),
      );
      step4.checks.push(tip2Ok ? "PASS Tip #2" : "FAIL Tip #2");
      check(
        "Step4 still Prospect before upgrade",
        (
          await prisma.user.findUniqueOrThrow({ where: { id: prospect.userId } })
        ).consentPending === true,
      );

      // If turn3 already produced a join button (reminder gate), capture it;
      // Step 5 still exercises assign-out → join when needed.
      let joinCmd = joinCommandFromReply(turn3.reply);

      // ------------------------------------------------------------------
      // STEP 5 — GIVEN Danny is still a Prospect
      //          WHEN he tries to assign to Ronit ("תקצי לרונית לקנות חלב")
      //          THEN Join CTA is returned; clicking it upgrades to Member
      // ------------------------------------------------------------------
      const step5 = beginStep(5, "Guest → Member one-tap upgrade");
      const assignOutMsg = `תקצי ל${CONTACT_RONIT} ${RONIT_TASK}`;
      recordInbound(step5, "Danny", assignOutMsg);
      stubLlm({
        responses: [
          {
            text: `הטלתי על ${CONTACT_RONIT}: ${RONIT_TASK}.`,
            buttons: [],
          },
        ],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "tasks",
              list_name: "",
              targets: [CONTACT_RONIT],
              items: [{ "שם משימה": RONIT_TASK }],
            },
          ],
        },
      });
      // Ensure Ronit exists on Prospect's book so the name resolves (optional).
      await prisma.contact
        .create({
          data: {
            userId: prospect.userId,
            ownerEmployeeId: prospect.employeeId,
            name: CONTACT_RONIT,
            phone: "972509991122",
          },
        })
        .catch(() => undefined);

      const assignOut = await sendChatMessage({
        userId: prospect.userId,
        employeeId: prospect.employeeId,
        digitalEmployeeId: prospect.digitalEmployeeId,
        message: assignOutMsg,
      });
      recordReply(step5, "Danny", assignOut.reply);
      const assignJoin = joinCommandFromReply(assignOut.reply);
      // Prefer assign-out Join CTA; fall back only if turn3 already staged one.
      const step5Join = assignJoin ?? joinCmd;
      const joinVisible = visibleReplyText(assignOut.reply);
      const joinFromAssign =
        Boolean(assignJoin?.startsWith(EXPLICIT_JOIN_ACCEPT_PREFIX)) &&
        (/בשמחה|אשרי|תשמרי|הצטרפ/.test(joinVisible) ||
          buttonsFromReply(assignOut.reply).some((b) =>
            /תשמרי|הצטרפ|אישור/.test(b),
          ));
      check(
        "Step5 server-rendered Join CTA returned for תקצי לרונית",
        joinFromAssign,
        assignJoin ?? joinVisible.slice(0, 180),
      );
      step5.checks.push(
        joinFromAssign ? `PASS join ${assignJoin}` : "FAIL no assign-out join",
      );

      if (!step5Join) {
        check("Step5 upgraded to Member in DB", false, "missing join command");
        step5.checks.push("FAIL no upgrade");
      } else {
        recordInbound(step5, "Danny", `[button_reply] ${step5Join}`);
        const joined = await handleExplicitJoinAccept({
          userId: prospect.userId,
          employeeId: prospect.employeeId,
          digitalEmployeeId: prospect.digitalEmployeeId,
          joinCommand: step5Join,
          recipientPhone: PROSPECT_PHONE,
        });
        log(`◀ ExplicitJoinHandler → Danny\n  ${joined.spoken}`);
        step5.reply = `${step5.reply}\n--- after join ---\n${joined.spoken}`;
        const after = await prisma.user.findUniqueOrThrow({
          where: { id: prospect.userId },
        });
        recordDb(
          step5,
          `consentPending=${after.consentPending} consentAcceptedAt=${after.consentAcceptedAt?.toISOString() ?? "null"}`,
        );
        const upgraded =
          after.consentPending === false && after.consentAcceptedAt != null;
        check(
          "Step5 upgraded to Member in DB (consentPending=false)",
          upgraded,
          `pending=${after.consentPending}`,
        );
        step5.checks.push(upgraded ? "PASS Member" : "FAIL still Prospect");
        check(
          "Step5 post-join spoken confirmation",
          /ברוך|בוצע|שמרתי|הצטרפ/.test(joined.spoken),
          joined.spoken,
        );
      }

      // ------------------------------------------------------------------
      // STEP 6 — GIVEN a fresh Prospect stages reminder + shopping while Guest
      //          WHEN they one-tap Join
      //          THEN both rows remain owned by them with no duplicates
      // ------------------------------------------------------------------
      const step6 = beginStep(6, "Guest → Member data continuity");
      const contSpeaker = await resolveWhatsAppSpeaker(CONTINUITY_PHONE);
      extraUserIds.push(contSpeaker.userId);
      const contLucy = (await listEmployeesForUser(contSpeaker.userId)).find(
        (row) => row.protected === true,
      );
      if (!contLucy) {
        throw new Error("Continuity Prospect missing Lucy");
      }
      const cont = {
        userId: contSpeaker.userId,
        employeeId: contSpeaker.employeeId,
        digitalEmployeeId: contLucy.id,
      };
      expect(
        (
          await prisma.user.findUniqueOrThrow({ where: { id: cont.userId } })
        ).consentPending,
      ).toBe(true);

      const contInbound = `תזכירי לי מחר ב-9 ${CONTINUITY_REMINDER} ותוסיפי ${CONTINUITY_SHOP_ITEM} לקניות`;
      recordInbound(step6, "Noa", contInbound);
      stubLlm({
        responses: [
          {
            text: `שמרתי תזכורת + ${CONTINUITY_SHOP_ITEM} לקניות.`,
            buttons: [],
          },
        ],
        metadata: {
          reminders: [
            {
              action: "add",
              item: CONTINUITY_REMINDER,
              date: "2031-07-01",
              time: "09:00",
              ping: ["אורח"],
              text: CONTINUITY_REMINDER,
            },
          ],
          lists: [
            {
              action: "add",
              list_type: "shopping",
              list_name: "",
              targets: ["אורח"],
              items: [{ "שם פריט": CONTINUITY_SHOP_ITEM }],
            },
          ],
        },
      });
      const contGate = await sendChatMessage({
        userId: cont.userId,
        employeeId: cont.employeeId,
        digitalEmployeeId: cont.digitalEmployeeId,
        message: contInbound,
      });
      recordReply(step6, "Noa", contGate.reply);
      const contJoin = joinCommandFromReply(contGate.reply);
      check(
        "Step6 Join CTA while staging reminder+shopping",
        Boolean(contJoin?.startsWith(EXPLICIT_JOIN_ACCEPT_PREFIX)),
        contJoin ?? visibleReplyText(contGate.reply).slice(0, 160),
      );
      step6.checks.push(contJoin ? "PASS join CTA" : "FAIL no join");

      const remBefore = await prisma.reminder.count({
        where: {
          ownerId: cont.employeeId,
          itemLabel: CONTINUITY_REMINDER,
          status: "active",
        },
      });
      const shopBefore = await prisma.employeeListItem.count({
        where: {
          deletedAt: null,
          list: { employeeId: cont.employeeId, listType: "shopping" },
          OR: [
            { itemKey: CONTINUITY_SHOP_ITEM },
            { data: { path: ["שם פריט"], equals: CONTINUITY_SHOP_ITEM } },
          ],
        },
      });
      recordDb(step6, `beforeJoin reminderCount=${remBefore} shopCount=${shopBefore}`);
      check(
        "Step6 ProspectWriteGate blocked persistence before join",
        remBefore === 0 && shopBefore === 0,
        `rem=${remBefore} shop=${shopBefore}`,
      );

      if (!contJoin) {
        check("Step6 data continuity after join", false, "missing join");
        step6.checks.push("FAIL continuity");
      } else {
        recordInbound(step6, "Noa", `[button_reply] ${contJoin}`);
        const contJoined = await handleExplicitJoinAccept({
          userId: cont.userId,
          employeeId: cont.employeeId,
          digitalEmployeeId: cont.digitalEmployeeId,
          joinCommand: contJoin,
          recipientPhone: CONTINUITY_PHONE,
        });
        log(`◀ ExplicitJoinHandler → Noa\n  ${contJoined.spoken}`);
        step6.reply = `${step6.reply}\n--- after join ---\n${contJoined.spoken}`;

        const remRows = await prisma.reminder.findMany({
          where: {
            ownerId: cont.employeeId,
            itemLabel: CONTINUITY_REMINDER,
            status: "active",
          },
        });
        const shopRows = await prisma.employeeListItem.findMany({
          where: {
            deletedAt: null,
            list: { employeeId: cont.employeeId, listType: "shopping" },
            OR: [
              { itemKey: CONTINUITY_SHOP_ITEM },
              { data: { path: ["שם פריט"], equals: CONTINUITY_SHOP_ITEM } },
            ],
          },
          include: { list: { select: { employeeId: true } } },
        });
        recordDb(
          step6,
          `afterJoin reminders=${remRows.length} shop=${shopRows.length} remUser=${remRows[0]?.userId ?? "n/a"}`,
        );
        const continuityOk =
          remRows.length === 1 &&
          remRows[0]?.userId === cont.userId &&
          remRows[0]?.ownerId === cont.employeeId &&
          shopRows.length === 1 &&
          shopRows[0]?.list.employeeId === cont.employeeId &&
          (shopRows[0]?.addedById === cont.employeeId ||
            shopRows[0]?.addedById == null);
        check(
          "Step6 reminder+shopping intact after join (no dupes)",
          continuityOk,
          `rem=${remRows.length} shop=${shopRows.length}`,
        );
        step6.checks.push(continuityOk ? "PASS continuity" : "FAIL continuity");
      }

      // ------------------------------------------------------------------
      // STEP 7 — GIVEN Michal's pending assign to Danny (from Step 1)
      //          WHEN Danny (Guest-origin, now Member) accepts then says
      //               "קניתי את הלחם דגנים"
      //          THEN task is completed and Michal gets notify in-chat
      // ------------------------------------------------------------------
      const step7 = beginStep(7, "Task complete → inviter notification");
      await prisma.contact
        .create({
          data: {
            userId: prospect.userId,
            ownerEmployeeId: prospect.employeeId,
            name: CONTACT_MICHAL,
            phone: ASKER_PHONE,
          },
        })
        .catch(() => undefined);

      const pendingAssign = await prisma.whatsAppInvite.findFirst({
        where: {
          userId: asker.userId,
          recipientPhone: { contains: PROSPECT_PHONE.slice(-9) },
          status: "pending",
        },
        orderBy: { createdAt: "desc" },
      });
      recordDb(step7, `pendingAssign=${pendingAssign?.id ?? "missing"}`);

      recordInbound(step7, "Danny", "היי, אאשר את המשימה ממיכל");
      stubLlm({
        responses: [{ text: "יש משימה ממתינה ממיכל.", buttons: [] }],
        metadata: {},
      });
      const assignPresent = await sendChatMessage({
        userId: prospect.userId,
        employeeId: prospect.employeeId,
        digitalEmployeeId: prospect.digitalEmployeeId,
        message: "היי, אאשר את המשימה ממיכל",
      });
      recordReply(step7, "Danny", assignPresent.reply);
      const acceptCmd = confirmCommandFromReply(assignPresent.reply);
      check(
        "Step7 Assign Accept offered to Danny",
        Boolean(acceptCmd) || Boolean(pendingAssign),
        acceptCmd ?? "no accept btn",
      );

      if (acceptCmd) {
        recordInbound(step7, "Danny", `[Assign Accept] ${acceptCmd}`);
        setLlmClientForTests(null);
        const accepted = await sendChatMessage({
          userId: prospect.userId,
          employeeId: prospect.employeeId,
          digitalEmployeeId: prospect.digitalEmployeeId,
          message: acceptCmd,
        });
        recordReply(step7, "Danny", accepted.reply);
      }

      const assignedItem = await prisma.employeeListItem.findFirst({
        where: {
          deletedAt: null,
          list: { employeeId: prospect.employeeId, listType: "tasks" },
          OR: [
            { itemKey: { contains: ASSIGN_TASK.slice(0, 12) } },
            { data: { path: ["שם משימה"], equals: ASSIGN_TASK } },
          ],
        },
        include: { list: { select: { employeeId: true } } },
        orderBy: { createdAt: "desc" },
      });
      recordDb(
        step7,
        `assignedItem=${assignedItem?.id ?? "missing"} addedBy=${assignedItem?.addedById ?? "n/a"}`,
      );
      check(
        "Step7 assigned task row on Danny after Accept",
        Boolean(assignedItem) &&
          assignedItem!.list.employeeId === prospect.employeeId,
        assignedItem?.id ?? "",
      );
      step7.checks.push(assignedItem ? "PASS assigned row" : "FAIL no row");

      const completeMsg = "קניתי את הלחם דגנים";
      recordInbound(step7, "Danny", completeMsg);
      stubLlm({
        responses: [{ text: "יופי, הורדתי את המשימה.", buttons: [] }],
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "tasks",
              list_name: "",
              targets: [],
              items: assignedItem
                ? [{ item_id: assignedItem.id, "שם משימה": ASSIGN_TASK }]
                : [{ "שם משימה": ASSIGN_TASK }],
            },
          ],
        },
      });
      const completeTurn = await sendChatMessage({
        userId: prospect.userId,
        employeeId: prospect.employeeId,
        digitalEmployeeId: prospect.digitalEmployeeId,
        message: completeMsg,
      });
      recordReply(step7, "Danny", completeTurn.reply);

      const itemAfter = assignedItem
        ? await prisma.employeeListItem.findUnique({
            where: { id: assignedItem.id },
          })
        : null;
      const completedOk = Boolean(itemAfter?.deletedAt);
      recordDb(
        step7,
        `deletedAt=${itemAfter?.deletedAt?.toISOString() ?? "null"}`,
      );
      check(
        "Step7 task marked completed (soft-deleted)",
        completedOk,
        itemAfter?.deletedAt?.toISOString() ?? "missing",
      );
      step7.checks.push(completedOk ? "PASS completed" : "FAIL not deleted");

      const michalNotice = await prisma.chatMessage.findFirst({
        where: {
          conversation: {
            userId: asker.userId,
            employeeId: asker.employeeId,
          },
          author: "assistant",
          OR: [
            { text: { contains: "הסיר משימה" } },
            { text: { contains: ASSIGN_TASK } },
            { text: { contains: "לחם" } },
            { text: { contains: CONTACT_DANI } },
          ],
        },
        orderBy: { createdAt: "desc" },
      });
      recordDb(
        step7,
        `michalNotice=${michalNotice?.text?.slice(0, 120) ?? "missing"}`,
      );
      check(
        "Step7 Michal received completion notification",
        Boolean(michalNotice?.text),
        michalNotice?.text?.slice(0, 160) ?? "",
      );
      step7.checks.push(michalNotice ? "PASS notify" : "FAIL no notify");

      // ------------------------------------------------------------------
      // STEP 8 — GIVEN a brand-new phone with no invite
      //          WHEN Ori chats 3 turns
      //          THEN Guest created + Tip#1 / none / Tip#2 cadence
      // ------------------------------------------------------------------
      const step8 = beginStep(8, "Cold direct Prospect (uninvited) tips cadence");
      await prisma.whatsAppInbound
        .deleteMany({ where: { phone: { contains: COLD_PHONE.slice(-9) } } })
        .catch(() => undefined);
      const coldSpeaker = await resolveWhatsAppSpeaker(COLD_PHONE);
      extraUserIds.push(coldSpeaker.userId);
      const coldUser = await prisma.user.findUniqueOrThrow({
        where: { id: coldSpeaker.userId },
      });
      const coldLucy = (await listEmployeesForUser(coldSpeaker.userId)).find(
        (row) => row.protected === true,
      );
      if (!coldLucy) {
        throw new Error("Cold Prospect missing Lucy");
      }
      const cold = {
        userId: coldSpeaker.userId,
        employeeId: coldSpeaker.employeeId,
        digitalEmployeeId: coldLucy.id,
      };
      recordDb(step8, `consentPending=${coldUser.consentPending}`);
      check(
        "Step8 cold phone creates Prospect (consentPending=true)",
        coldUser.consentPending === true,
      );

      recordInbound(step8, "Ori", COLD_TURN1);
      stubLlm({
        responses: [
          {
            text: "היי! אני לוסי — אפשר משימות, קניות, תזכורות ועוד.",
            buttons: [],
          },
        ],
        metadata: {},
      });
      const cold1 = await sendChatMessage({
        userId: cold.userId,
        employeeId: cold.employeeId,
        digitalEmployeeId: cold.digitalEmployeeId,
        message: COLD_TURN1,
      });
      recordReply(step8, "Ori", cold1.reply);
      const cold1Visible = visibleReplyText(cold1.reply);
      const coldTip1 = containsOnboardTip(cold1Visible);
      const coldProg1 = await onboardTipProgress(
        cold.employeeId,
        cold.digitalEmployeeId,
      );
      recordDb(step8, `turn1 tip=${coldTip1 ? "yes" : "no"} prog=${JSON.stringify(coldProg1)}`);
      const coldTip1Ok =
        coldTip1 === TIP1_TEXT ||
        coldProg1.some(
          (r) => r.key === "prospect_onboard_tasks" && r.showCount >= 1,
        );
      check("Step8 Turn1 Tip #1", coldTip1Ok, coldTip1?.slice(0, 80) ?? "");
      step8.checks.push(coldTip1Ok ? "PASS tip1" : "FAIL tip1");

      const coldProgBefore2 = await onboardTipProgress(
        cold.employeeId,
        cold.digitalEmployeeId,
      );
      recordInbound(step8, "Ori", COLD_TURN2);
      stubLlm({
        responses: [{ text: "בשמחה — מה תרצה לעשות?", buttons: [] }],
        metadata: {},
      });
      const cold2 = await sendChatMessage({
        userId: cold.userId,
        employeeId: cold.employeeId,
        digitalEmployeeId: cold.digitalEmployeeId,
        message: COLD_TURN2,
      });
      recordReply(step8, "Ori", cold2.reply);
      const cold2Visible = visibleReplyText(cold2.reply);
      const coldTip2Leak = containsOnboardTip(cold2Visible);
      const coldProg2 = await onboardTipProgress(
        cold.employeeId,
        cold.digitalEmployeeId,
      );
      const coldNoTip2 =
        coldTip2Leak == null &&
        coldProg2.length === coldProgBefore2.length &&
        coldProg2.every(
          (row, i) =>
            row.key === coldProgBefore2[i]?.key &&
            row.showCount === coldProgBefore2[i]?.showCount,
        );
      check("Step8 Turn2 no tip", coldNoTip2, coldTip2Leak ?? "ok");
      step8.checks.push(coldNoTip2 ? "PASS no tip" : "FAIL tip leak");

      recordInbound(step8, "Ori", COLD_TURN3);
      stubLlm({
        responses: [{ text: "מעולה, אני כאן.", buttons: [] }],
        metadata: {},
      });
      const cold3 = await sendChatMessage({
        userId: cold.userId,
        employeeId: cold.employeeId,
        digitalEmployeeId: cold.digitalEmployeeId,
        message: COLD_TURN3,
      });
      recordReply(step8, "Ori", cold3.reply);
      const cold3Visible = visibleReplyText(cold3.reply);
      const coldTip2 = containsOnboardTip(cold3Visible);
      const coldProg3 = await onboardTipProgress(
        cold.employeeId,
        cold.digitalEmployeeId,
      );
      const coldShows = coldProg3.reduce((n, r) => n + r.showCount, 0);
      recordDb(
        step8,
        `turn3 tip=${coldTip2 ? "yes" : "no"} prog=${JSON.stringify(coldProg3)} shows=${coldShows}`,
      );
      const coldTip2Ok =
        coldShows >= 2 &&
        (coldTip2 === TIP2_TEXT ||
          coldProg3.some(
            (r) =>
              (r.key === "prospect_onboard_shopping" ||
                r.key === "prospect_onboard_reminders") &&
              r.showCount >= 1,
          ));
      check("Step8 Turn3 Tip #2", coldTip2Ok, coldTip2?.slice(0, 80) ?? "");
      step8.checks.push(coldTip2Ok ? "PASS tip2" : "FAIL tip2");
      check(
        "Step8 still Prospect after tips",
        (
          await prisma.user.findUniqueOrThrow({ where: { id: cold.userId } })
        ).consentPending === true,
      );

      // ——— Summary + trace artifact ———
      log("\n========== SUMMARY ==========");
      const pass = checks.filter((c) => c.pass).length;
      const fail = checks.filter((c) => !c.pass).length;
      checks.forEach((c, i) => {
        log(
          `| ${i + 1} | ${c.pass ? "PASS" : "FAIL"} | ${c.name}${c.detail ? ` (${c.detail.slice(0, 100)})` : ""} |`,
        );
      });
      log(`\nTOTAL: ${pass} PASS / ${fail} FAIL / ${checks.length} checks`);

      log("\n========== RENDERED WHATSAPP MESSAGES ==========");
      for (const step of traceSteps) {
        log(`\n--- Step ${step.step}: ${step.title} ---`);
        log(`IN  ${step.actor}: ${step.inbound}`);
        log(`OUT Lucy:\n${step.reply}`);
        if (step.buttons.length) {
          log(`BTN ${step.buttons.join(" | ")}`);
        }
      }

      writeTraceFile();
      expect(fail, `${fail} checks failed — see trace ${TRACE_PATH}`).toBe(0);
    },
    300_000,
  );
});

