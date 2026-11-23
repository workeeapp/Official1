/**
 * First Interaction Stage 1 — production-path eval-db.
 * Uses real sendChatMessage + PIE wire with stubbed LLM (no live model).
 * Isolated eval-db ONLY (`workee_test`). Never touches LIVE.
 *
 * Run:
 *   npm run test:eval-db -- tests/first-interaction-fi.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import {
  FI_COLD_SHOP_ITEM,
  FI_MEMBER_TASK_TITLE,
  fiColdOpportunityKey,
  fiInviteOpportunityKey,
  fiMemberOpportunityKey,
} from "../src/services/first-interaction.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import {
  resetPieArbitrationStateForTests,
} from "../src/services/pie-arbitration.js";
import { EXPLICIT_JOIN_ACCEPT_PREFIX } from "../src/services/pending-prospect-action.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";

function newInviteId(): string {
  return randomUUID();
}

const harnesses: HarnessAccount[] = [];

function stubLlm(
  payload: unknown,
  sink?: { facts: string; calls: number },
) {
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

function replyAllText(reply: string): string {
  const parsed = parseLlmReply(reply);
  return [
    parsed.response,
    ...(parsed.responseBubbles ?? []).map((b) => b.text),
  ]
    .filter(Boolean)
    .join("\n");
}

function replyButtons(reply: string): Array<{ label: string; command: string }> {
  const parsed = parseLlmReply(reply);
  return [
    ...(parsed.buttons ?? []),
    ...(parsed.responseBubbles ?? []).flatMap((b) => b.buttons ?? []),
  ];
}

function replyHasFiOffer(reply: string): boolean {
  const allText = replyAllText(reply);
  const buttons = replyButtons(reply);
  const hasYesNo =
    buttons.some((b) => b.label === "כן") &&
    buttons.some((b) => b.label === "לא");
  return hasYesNo && /רוצה ש/.test(allText);
}

function replyHasInviteDirectPresent(reply: string): boolean {
  const allText = replyAllText(reply);
  const buttons = replyButtons(reply);
  const hasAct = buttons.some(
    (b) =>
      b.label === "סמן כבוצע" || /^סמן כבוצע:/u.test(b.command.trim()),
  );
  return hasAct && /מאת /.test(allText) && !/רוצה שאראה/.test(allText);
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

async function openMemberEmpty(): Promise<{
  account: HarnessAccount;
  digitalEmployeeId: string;
}> {
  const account = await createHarnessAccount("נועה", { digitalWorker: true });
  harnesses.push(account);
  await prisma.user.update({
    where: { id: account.userId },
    data: { consentPending: false },
  });
  return { account, digitalEmployeeId: account.digitalEmployeeId! };
}

/** Prospect = consentPending user with Lucy (same production identity as WA bootstrap). */
async function openProspectEmpty(): Promise<{
  account: HarnessAccount;
  digitalEmployeeId: string;
}> {
  const account = await createHarnessAccount("דני", { digitalWorker: true });
  harnesses.push(account);
  await prisma.user.update({
    where: { id: account.userId },
    data: { consentPending: true },
  });
  return { account, digitalEmployeeId: account.digitalEmployeeId! };
}

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
});

beforeEach(() => {
  resetPieArbitrationStateForTests();
  vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
  vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
  vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
  vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);
});

afterAll(async () => {
  setLlmClientForTests(null);
  vi.restoreAllMocks();
  while (harnesses.length > 0) {
    const account = harnesses.pop();
    if (account) {
      await prisma.interactionOpportunity
        .deleteMany({ where: { userId: account.userId } })
        .catch(() => undefined);
      await prisma.pendingProspectAction
        .deleteMany({ where: { userId: account.userId } })
        .catch(() => undefined);
      await destroyHarnessAccount(account);
    }
  }
});

describe("First Interaction Stage 1 (eval-db production path)", () => {
  it(
    "invited prospect: direct present without show Offer/Accept",
    async () => {
      const inviteId = newInviteId();
      const { account, digitalEmployeeId } = await openProspectEmpty();
      stubLlm({
        responses: [{ text: "היי, ברוך הבא.", buttons: [] }],
        metadata: {},
      });
      const result = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "היי",
        pendingInvite: {
          inviteId,
          token: "WEE-FIINVITE",
          askerName: "מיכל",
          askSummary: "להביא לחם דגנים",
          recipientLabel: "דני",
        },
      });
      expect(replyHasInviteDirectPresent(result.reply)).toBe(true);
      expect(replyHasFiOffer(result.reply)).toBe(false);
      expect(replyAllText(result.reply)).toMatch(/לחם דגנים/);
      expect(replyAllText(result.reply)).not.toMatch(/רוצה שאראה/);
      const row = await prisma.interactionOpportunity.findFirst({
        where: {
          employeeId: account.employeeId,
          opportunityKey: fiInviteOpportunityKey(inviteId),
          status: "offered",
          kind: "fi_invite_act",
        },
      });
      expect(row).toBeTruthy();
      // Present is not Value — user has not acted yet.
      expect(row?.valueAt).toBeNull();
    },
    30_000,
  );

  it(
    "invite complete act sets Value; present alone does not",
    async () => {
      const inviteId = newInviteId();
      const { account, digitalEmployeeId } = await openProspectEmpty();
      stubLlm({
        responses: [{ text: "היי.", buttons: [] }],
        metadata: {},
      });
      const presentTurn = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "היי",
        pendingInvite: {
          inviteId,
          token: "WEE-FIINVITE",
          askerName: "מיכל",
          askSummary: "להביא לחם דגנים",
          recipientLabel: "דני",
        },
      });
      expect(replyHasInviteDirectPresent(presentTurn.reply)).toBe(true);
      const afterPresent = await prisma.interactionOpportunity.findFirst({
        where: {
          employeeId: account.employeeId,
          opportunityKey: fiInviteOpportunityKey(inviteId),
        },
      });
      expect(afterPresent?.valueAt).toBeNull();

      // Upgrade so mark-done can persist (ProspectWriteGate otherwise blocks).
      await prisma.user.update({
        where: { id: account.userId },
        data: { consentPending: false },
      });
      const list = await prisma.employeeList.create({
        data: {
          employeeId: account.employeeId,
          listType: "tasks",
          name: "",
          scope: "personal",
          visibleTo: [account.employeeId],
        },
      });
      const item = await prisma.employeeListItem.create({
        data: {
          listId: list.id,
          itemKey: "להביא לחם דגנים",
          data: { "שם משימה": "להביא לחם דגנים" },
          scope: "personal",
          addedById: account.employeeId,
          visibleTo: [account.employeeId],
        },
      });

      resetPieArbitrationStateForTests();
      stubLlm({
        responses: [{ text: "סגרתי את המשימה.", buttons: [] }],
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "tasks",
              list_name: "",
              targets: [],
              items: [
                { item_id: item.id, "שם משימה": "להביא לחם דגנים" },
              ],
            },
          ],
        },
      });
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "סמן כבוצע: להביא לחם דגנים",
      });
      const valued = await prisma.interactionOpportunity.findFirst({
        where: {
          employeeId: account.employeeId,
          opportunityKey: fiInviteOpportunityKey(inviteId),
        },
      });
      expect(valued?.status).toBe("accepted");
      expect(valued?.valueAt).toBeTruthy();
    },
    30_000,
  );

  it(
    "invite unavailable title: no Offer and no invented present",
    async () => {
      const inviteId = newInviteId();
      const { account, digitalEmployeeId } = await openProspectEmpty();
      stubLlm({
        responses: [{ text: "היי.", buttons: [] }],
        metadata: {},
      });
      const result = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "היי",
        pendingInvite: {
          inviteId,
          token: "WEE-FIINVITE",
          askerName: "מיכל",
          askSummary: "פריט",
          recipientLabel: "דני",
        },
      });
      expect(replyHasInviteDirectPresent(result.reply)).toBe(false);
      expect(replyHasFiOffer(result.reply)).toBe(false);
      const row = await prisma.interactionOpportunity.findFirst({
        where: {
          employeeId: account.employeeId,
          opportunityKey: fiInviteOpportunityKey(inviteId),
        },
      });
      expect(row).toBeNull();
    },
    30_000,
  );

  it(
    "cold prospect gets fi_first_try; failed act keeps offer without Value",
    async () => {
      const { account, digitalEmployeeId } = await openProspectEmpty();
      stubLlm({
        responses: [{ text: "היי.", buttons: [] }],
        metadata: {},
      });
      const offerTurn = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "היי",
      });
      expect(replyHasFiOffer(offerTurn.reply)).toBe(true);
      const key = fiColdOpportunityKey(account.employeeId);
      const offered = await prisma.interactionOpportunity.findFirst({
        where: { employeeId: account.employeeId, opportunityKey: key },
      });
      expect(offered?.status).toBe("offered");
      expect(offered?.kind).toBe("fi_first_try");

      // Accept command → durable write gated → Join CTA; no Value.
      resetPieArbitrationStateForTests();
      stubLlm({
        responses: [{ text: "אוסיף חלב.", buttons: [] }],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              items: [{ "שם פריט": FI_COLD_SHOP_ITEM }],
            },
          ],
        },
      });
      const acceptTurn = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: `תוסיפי ${FI_COLD_SHOP_ITEM} לקניות`,
      });
      expect(joinCommandFromReply(acceptTurn.reply)).toBeTruthy();
      const afterFail = await prisma.interactionOpportunity.findFirst({
        where: { employeeId: account.employeeId, opportunityKey: key },
      });
      expect(afterFail?.status).toBe("offered");
      expect(afterFail?.valueAt).toBeNull();
    },
    30_000,
  );

  it("new member gets fi_member_first_save; successful act sets Value", async () => {
    const { account, digitalEmployeeId } = await openMemberEmpty();
    stubLlm({
      responses: [{ text: "היי נועה.", buttons: [] }],
      metadata: {},
    });
    const offerTurn = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId,
      message: "היי",
    });
    expect(replyHasFiOffer(offerTurn.reply)).toBe(true);
    const key = fiMemberOpportunityKey(account.employeeId);
    expect(
      await prisma.interactionOpportunity.findFirst({
        where: { opportunityKey: key, status: "offered", kind: "fi_member_first_save" },
      }),
    ).toBeTruthy();

    resetPieArbitrationStateForTests();
    stubLlm({
      responses: [{ text: "שמרתי את המשימה.", buttons: [] }],
      metadata: {
        lists: [
          {
            action: "add",
            list_type: "tasks",
            items: [{ "שם משימה": FI_MEMBER_TASK_TITLE }],
          },
        ],
      },
    });
    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId,
      message: `תוסיפי משימה: ${FI_MEMBER_TASK_TITLE}`,
    });
    const valued = await prisma.interactionOpportunity.findFirst({
      where: { opportunityKey: key },
    });
    expect(valued?.status).toBe("accepted");
    expect(valued?.valueAt).toBeTruthy();
    const task = await prisma.employeeListItem.findFirst({
      where: {
        list: { employeeId: account.employeeId, listType: "tasks" },
        deletedAt: null,
      },
    });
    expect(task).toBeTruthy();
  });

  it("returning member with ESD records does not get FI", async () => {
    const { account, digitalEmployeeId } = await openMemberEmpty();
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
        itemKey: "לחם",
        data: { "שם פריט": "לחם" },
        scope: "personal",
        addedById: account.employeeId,
        visibleTo: [account.employeeId],
      },
    });
    stubLlm({
      responses: [{ text: "היי שוב.", buttons: [] }],
      metadata: {},
    });
    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId,
      message: "היי",
    });
    expect(replyHasFiOffer(result.reply)).toBe(false);
    const fiRows = await prisma.interactionOpportunity.count({
      where: {
        employeeId: account.employeeId,
        kind: { in: ["fi_invite_act", "fi_first_try", "fi_member_first_save"] },
      },
    });
    expect(fiRows).toBe(0);
  });

  it(
    "Join CTA open blocks FI",
    async () => {
      const { account, digitalEmployeeId } = await openProspectEmpty();
      stubLlm({
        responses: [{ text: "שמרתי.", buttons: [] }],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              items: [{ "שם פריט": "לחם" }],
            },
          ],
        },
      });
      const gated = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "תוסיפי לחם לקניות",
      });
      expect(joinCommandFromReply(gated.reply)).toBeTruthy();
      expect(replyHasFiOffer(gated.reply)).toBe(false);
    },
    30_000,
  );

  it("Quiet preference blocks FI", async () => {
    const { account, digitalEmployeeId } = await openMemberEmpty();
    stubLlm({
      responses: [{ text: "בסדר, פחות הצעות.", buttons: [] }],
      metadata: {},
    });
    // First turn sets Quiet via utterance; same turn should not inject FI.
    const quietTurn = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId,
      message: "תפסיקי להציע",
    });
    expect(replyHasFiOffer(quietTurn.reply)).toBe(false);

    resetPieArbitrationStateForTests();
    stubLlm({
      responses: [{ text: "היי.", buttons: [] }],
      metadata: {},
    });
    const next = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId,
      message: "היי",
    });
    expect(replyHasFiOffer(next.reply)).toBe(false);
  });

  it("soft Act already in bubbles: no second FI initiative", async () => {
    const { account, digitalEmployeeId } = await openMemberEmpty();
    stubLlm({
      responses: [
        {
          text: "רוצה שאוסיף לזה גם תזכורת?",
          buttons: [
            { label: "כן", command: "כן" },
            { label: "לא", command: "לא" },
          ],
        },
      ],
      metadata: {},
    });
    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId,
      message: "היי",
    });
    const parsed = parseLlmReply(result.reply);
    const softBubbles = (parsed.responseBubbles ?? []).filter((b) =>
      (b.buttons ?? []).some((btn) => btn.label === "כן"),
    );
    // At most one soft yes/no initiative bubble (reminder soft OR FI — not both).
    expect(softBubbles.length).toBeLessThanOrEqual(1);
    const fiRows = await prisma.interactionOpportunity.count({
      where: {
        employeeId: account.employeeId,
        kind: { in: ["fi_invite_act", "fi_first_try", "fi_member_first_save"] },
        status: "offered",
      },
    });
    expect(fiRows).toBe(0);
  });

  it(
    "PIE regression: consentOwnsTurn still wins (Join path)",
    async () => {
      const { account, digitalEmployeeId } = await openProspectEmpty();
      stubLlm({
        responses: [{ text: "ok", buttons: [] }],
        metadata: {
          reminders: [
            {
              action: "add",
              item: "רופא",
              date: "2031-06-15",
              time: "09:00",
              ping: ["אורח"],
              text: "רופא",
            },
          ],
        },
      });
      const gated = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "תזכירי לי מחר ב-9 לרופא",
      });
      expect(joinCommandFromReply(gated.reply)).toBeTruthy();
      expect(replyHasFiOffer(gated.reply)).toBe(false);
    },
    30_000,
  );

  it(
    "follow-up details: facts switch to follow-up; no re-present FI; no tip",
    async () => {
      const inviteId = newInviteId();
      const pending = {
        inviteId,
        token: "WEE-FIFOLLOW",
        askerName: "מיכל",
        askSummary: "להביא לחם דגנים",
        recipientLabel: "דני",
      };
      const { account, digitalEmployeeId } = await openProspectEmpty();

      stubLlm({
        responses: [{ text: "היי.", buttons: [] }],
        metadata: {},
      });
      const present = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "היי",
        pendingInvite: pending,
      });
      expect(replyHasInviteDirectPresent(present.reply)).toBe(true);

      // Clear cadence so tips would otherwise be eligible — engagement must block.
      resetPieArbitrationStateForTests();
      const sink = { facts: "", calls: 0 };
      stubLlm(
        {
          responses: [
            {
              text: "מיכל ביקשה להביא לחם דגנים. אין פרטי כמות בהזמנה.",
              buttons: [],
            },
          ],
          metadata: {},
        },
        sink,
      );
      const follow = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "מה בדיוק צריך לעשות?",
        pendingInvite: pending,
      });
      expect(sink.facts).toMatch(/INVITE CONTEXT \(follow-up/);
      expect(sink.facts).toMatch(/already presented/);
      expect(sink.facts).not.toMatch(
        /First reply: warm Hebrew greeting that clearly presents/,
      );
      expect(replyHasInviteDirectPresent(follow.reply)).toBe(false);
      expect(replyHasFiOffer(follow.reply)).toBe(false);
      expect(replyAllText(follow.reply)).not.toMatch(/רוצה שאראה/);
      const stillOpen = await prisma.interactionOpportunity.findFirst({
        where: {
          employeeId: account.employeeId,
          opportunityKey: fiInviteOpportunityKey(inviteId),
        },
      });
      expect(stillOpen?.status).toBe("offered");
      expect(stillOpen?.valueAt).toBeNull();
    },
    30_000,
  );

  it(
    "two follow-ups keep invite context; failed mutate keeps no Value",
    async () => {
      const inviteId = newInviteId();
      const pending = {
        inviteId,
        token: "WEE-FIFOLLOW2",
        askerName: "מיכל",
        askSummary: "להביא לחם דגנים",
        recipientLabel: "דני",
      };
      const { account, digitalEmployeeId } = await openProspectEmpty();

      stubLlm({
        responses: [{ text: "היי.", buttons: [] }],
        metadata: {},
      });
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "היי",
        pendingInvite: pending,
      });

      resetPieArbitrationStateForTests();
      const sink1 = { facts: "", calls: 0 };
      stubLlm(
        {
          responses: [{ text: "מיכל ביקשה את זה.", buttons: [] }],
          metadata: {},
        },
        sink1,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "מי ביקש את זה?",
        pendingInvite: pending,
      });
      expect(sink1.facts).toMatch(/follow-up/);

      resetPieArbitrationStateForTests();
      const sink2 = { facts: "", calls: 0 };
      stubLlm(
        {
          responses: [{ text: "אין שעת יעד בהזמנה.", buttons: [] }],
          metadata: {},
        },
        sink2,
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "עד איזו שעה?",
        pendingInvite: pending,
      });
      expect(sink2.facts).toMatch(/follow-up/);
      expect(sink2.facts).toMatch(/not in the invite details|FORBIDDEN invent/i);

      // Prospect mark-done → Join gate → no Value.
      resetPieArbitrationStateForTests();
      stubLlm({
        responses: [{ text: "סגרתי.", buttons: [] }],
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "tasks",
              list_name: "",
              targets: [],
              items: [{ "שם משימה": "להביא לחם דגנים" }],
            },
          ],
        },
      });
      const failTurn = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "סמן כבוצע: להביא לחם דגנים",
        pendingInvite: pending,
      });
      expect(joinCommandFromReply(failTurn.reply)).toBeTruthy();
      const row = await prisma.interactionOpportunity.findFirst({
        where: {
          employeeId: account.employeeId,
          opportunityKey: fiInviteOpportunityKey(inviteId),
        },
      });
      expect(row?.status).toBe("offered");
      expect(row?.valueAt).toBeNull();
    },
    45_000,
  );

  it(
    "new topic after present: follow-up facts still available; no second FI present",
    async () => {
      const inviteId = newInviteId();
      const pending = {
        inviteId,
        token: "WEE-FINEW",
        askerName: "מיכל",
        askSummary: "להביא לחם דגנים",
        recipientLabel: "דני",
      };
      const { account, digitalEmployeeId } = await openProspectEmpty();
      stubLlm({
        responses: [{ text: "היי.", buttons: [] }],
        metadata: {},
      });
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "היי",
        pendingInvite: pending,
      });

      resetPieArbitrationStateForTests();
      const sink = { facts: "", calls: 0 };
      stubLlm(
        {
          responses: [{ text: "עכשיו 22 מעלות בתל אביב.", buttons: [] }],
          metadata: { weather: { place: "תל אביב", aspects: ["temp"] } },
        },
        sink,
      );
      const weather = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId,
        message: "מה מזג האוויר בתל אביב?",
        pendingInvite: pending,
      });
      expect(sink.facts).toMatch(/follow-up/);
      expect(sink.facts).toMatch(/new unrelated topic/i);
      expect(replyHasInviteDirectPresent(weather.reply)).toBe(false);
      expect(replyHasFiOffer(weather.reply)).toBe(false);
    },
    30_000,
  );
});
