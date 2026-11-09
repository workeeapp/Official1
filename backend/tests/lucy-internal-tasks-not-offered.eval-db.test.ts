/**
 * Lucy's internal tasks are never offered for viewing (owner decision 2026-11-10).
 * A self-nudge reminder creates Lucy's tracking task «להזכיר ל…» (targets = Lucy)
 * next to the clock. The confirm must show the reminder and the speaker's own
 * content — never «המשימות שלך» / «הצג משימות של לוסי», and never an item tap
 * on Lucy's task. Enforced on structured data: worker-inventory commands are
 * dropped, digital workers' rows get no item tap.
 *
 * Real production path: sendChatMessage with a scripted model on approved
 * workee_test. No OpenAI / WhatsApp / reminder fire.
 *
 * Run: npm run test:eval-db -- tests/lucy-internal-tasks-not-offered.eval-db.test.ts
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { formatJerusalemDateTime, parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { parseItemNavRef } from "../src/services/builtin-lists.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  stubLlmReply,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
});

describe("Lucy's internal tasks are never offered on a confirm", () => {
  let account: HarnessAccount | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (account) {
      await prisma.reminder.deleteMany({ where: { userId: account.userId } }).catch(() => undefined);
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  async function turn(payload: unknown) {
    account = await createHarnessAccount("טל");
    await prisma.employee.update({
      where: { id: account.employeeId },
      data: { phone: `9725${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}` },
    });
    const lucyId = await ensureLucy(account);
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);
    setLlmClientForTests(stubLlmReply(payload));
    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תזכירי לי מחר ב־18:00 לקנות חלב",
    });
    const buttons = parseLlmReply(result.reply).responseBubbles.flatMap((bubble) => bubble.buttons ?? []);
    const lucyTasks = await prisma.employeeListItem.findMany({
      where: { deletedAt: null, list: { employeeId: lucyId } },
      select: { id: true },
    });
    const reminders = await prisma.reminder.findMany({
      where: { userId: account.userId, status: "active" },
      select: { id: true },
    });
    return { buttons, lucyTaskIds: lucyTasks.map((row) => row.id), reminderIds: reminders.map((row) => row.id) };
  }

  const tomorrow = formatJerusalemDateTime(new Date(Date.now() + 24 * 3600_000)).slice(0, 10);
  const selfNudge = (buttons: Array<{ label: string; command: string }>) => ({
    responses: [{ text: "אזכיר לך מחר ב־18:00 לקנות חלב.", buttons }],
    metadata: {
      lists: [
        { action: "add", list_type: "shopping", list_name: "", items: [{ "שם פריט": "חלב" }] },
        {
          action: "add",
          list_type: "tasks",
          list_name: "",
          targets: ["לוסי"],
          items: [{ "שם משימה": "להזכיר לטל לקנות חלב", "תאריך לביצוע": tomorrow, "שעה לביצוע": "18:00" }],
        },
      ],
      reminders: [
        { action: "add", item: "לקנות חלב", date: tomorrow, time: "18:00", ping: ["טל"], text: "לקנות חלב" },
      ],
    },
  });

  function expectNoLucyTaskExposure(
    buttons: Array<{ label: string; command: string }>,
    lucyTaskIds: string[],
  ) {
    for (const button of buttons) {
      expect(button.command, `worker inventory offered: ${JSON.stringify(button)}`).not.toMatch(/^הצג משימות של /u);
      expect(button.label, `worker inventory offered: ${JSON.stringify(button)}`).not.toBe("המשימות שלך");
      const refs = parseItemNavRef(button.command) ?? [];
      for (const ref of refs) {
        expect(
          lucyTaskIds.includes(ref.id),
          `item tap on Lucy's internal task: ${JSON.stringify(button)}`,
        ).toBe(false);
      }
    }
  }

  it("self-nudge reminder (no speaker task): no «המשימות שלך», no tap on Lucy's task; the reminder is offered", async () => {
    const t = await turn(selfNudge([]));
    expect(t.lucyTaskIds.length, "Lucy's tracking task was created").toBeGreaterThan(0);
    expect(t.reminderIds.length, "reminder saved").toBe(1);
    expectNoLucyTaskExposure(t.buttons, t.lucyTaskIds);
    const reminderTap = t.buttons.some((button) =>
      (parseItemNavRef(button.command) ?? []).some((ref) => ref.kind === "r"),
    );
    const remindersNav = t.buttons.some((button) => button.command === "הצג תזכורות");
    expect(reminderTap || remindersNav, `the reminder is the result: ${JSON.stringify(t.buttons)}`).toBe(true);
  });

  it("a model-emitted «המשימות שלך» button is dropped; the speaker's own content button stays", async () => {
    const t = await turn(
      selfNudge([
        { label: "המשימות שלך", command: "הצג משימות של לוסי" },
        { label: "מה לקנות", command: "מה יש לי לקנות" },
      ]),
    );
    expectNoLucyTaskExposure(t.buttons, t.lucyTaskIds);
    expect(t.buttons.map((button) => button.command)).toContain("מה יש לי לקנות");
  });
});
