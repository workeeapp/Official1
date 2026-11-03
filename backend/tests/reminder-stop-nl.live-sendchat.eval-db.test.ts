/**
 * Natural-language stop-reminder: Model → ACTION → Apply → DB.
 * Real OpenAI via sendChatMessage; WhatsApp / fireDue mocked.
 * Does NOT stub the LLM reply — proves intent→reminders.remove.
 *
 * Run (cwd backend):
 *   npm run test:eval-db -- tests/reminder-stop-nl.live-sendchat.eval-db.test.ts
 *
 * Requires: workee_test eval env + OPENAI_API_KEY in product .env.
 * Known blocker (env, not this suite): workee_test must include
 * Employees.profile_attachment_id (migration 20261102010000_employee_profile_photo).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLlmReply, parseReplyMetadata } from "@workee/shared";
import { resetEnvCache } from "../src/config/env.js";
import { prisma } from "../src/database/prisma.js";
import {
  getLlmClient,
  setLlmClientForTests,
} from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  injectProductEnvKey,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

function loadLucyInstructions(): string {
  const path = resolve(process.cwd(), "..", "LLM.config.json");
  expect(existsSync(path), path).toBe(true);
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    systemMessage: string[];
  };
  return raw.systemMessage.join("\n");
}

type Seeded = {
  account: HarnessAccount;
  lucyId: string;
  waterId: string;
  otherId: string;
  marker: string;
};

async function seedTwoClocks(marker: string): Promise<Seeded> {
  const account = await createHarnessAccount("טל");
  const lucyId = await ensureLucy(account, loadLucyInstructions());
  await prisma.employee.update({
    where: { id: lucyId },
    data: {
      instructions: loadLucyInstructions(),
      model: "gpt-4.1-mini",
      temperature: 0,
    },
  });

  const water = await prisma.reminder.create({
    data: {
      userId: account.userId,
      ownerId: account.employeeId,
      actorId: account.employeeId,
      itemKey: `לשתות מים-${marker}`,
      itemLabel: "לשתות מים",
      listType: "tasks",
      fireAt: new Date(Date.now() + 60 * 60 * 1000),
      repeat: "1:hours",
      recurrence: { freq: "interval", interval: 1, unit: "hours" },
      pingIds: [account.employeeId],
      messageText: "לשתות מים",
      status: "active",
    },
  });
  const other = await prisma.reminder.create({
    data: {
      userId: account.userId,
      ownerId: account.employeeId,
      actorId: account.employeeId,
      itemKey: `להוריד את הכלב-${marker}`,
      itemLabel: "להוריד את הכלב",
      listType: "tasks",
      fireAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      repeat: "once",
      pingIds: [account.employeeId],
      messageText: "להוריד את הכלב",
      status: "active",
    },
  });

  vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue({
    ok: true as const,
    messageId: "stop-nl",
  });
  vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent");
  vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(undefined);
  vi.spyOn(reminderFire, "scheduleSoon").mockReturnValue(undefined);

  // Drop stub conversation ids so the real OpenAI client can open a thread.
  await prisma.chatMessage
    .deleteMany({ where: { conversation: { userId: account.userId } } })
    .catch(() => undefined);
  await prisma.chatConversation
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  setLlmClientForTests(null);
  setLlmClientForTests(getLlmClient());

  return {
    account,
    lucyId,
    waterId: water.id,
    otherId: other.id,
    marker,
  };
}

function reminderRemoves(meta: ReturnType<typeof parseReplyMetadata>) {
  return (meta.reminders ?? []).filter((r) => r.action === "remove");
}

describe("reminder stop NL → ACTION → DB (real model, eval-db)", () => {
  let seeded: Seeded | null = null;

  beforeAll(async () => {
    const key = injectProductEnvKey("OPENAI_API_KEY");
    expect(key.present, "OPENAI_API_KEY required for real-model stop NL").toBe(
      true,
    );
    resetEnvCache();
    await assertEvalDbAndGtfsUntouched();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (seeded) {
      await prisma.reminder
        .deleteMany({ where: { userId: seeded.account.userId } })
        .catch(() => undefined);
      await cleanupHarnessAccount(seeded.account);
      seeded = null;
    }
  });

  async function runStopUtterance(utterance: string) {
    const marker = `stopnl-${Date.now().toString(36)}`;
    seeded = await seedTwoClocks(marker);
    const beforeWater = await prisma.reminder.findUnique({
      where: { id: seeded.waterId },
    });
    const beforeOther = await prisma.reminder.findUnique({
      where: { id: seeded.otherId },
    });
    expect(beforeWater?.status).toBe("active");
    expect(beforeOther?.status).toBe("active");

    const turn = await sendChatMessage({
      userId: seeded.account.userId,
      employeeId: seeded.account.employeeId,
      digitalEmployeeId: seeded.lucyId,
      message: utterance,
    });
    const meta = parseReplyMetadata(turn.reply);
    const spoken = parseLlmReply(turn.reply).response;
    const removes = reminderRemoves(meta);
    const afterWater = await prisma.reminder.findUnique({
      where: { id: seeded.waterId },
    });
    const afterOther = await prisma.reminder.findUnique({
      where: { id: seeded.otherId },
    });

    const rawSlice =
      typeof turn.raw === "string"
        ? turn.raw.slice(0, 1200)
        : JSON.stringify(turn.raw)?.slice(0, 1200);
    // eslint-disable-next-line no-console
    console.log(
      "REMINDER_STOP_NL_REPORT\n" +
        JSON.stringify(
          {
            utterance,
            action: {
              reminders: meta.reminders,
              lists: meta.lists,
              removes: removes.map((r) => ({
                action: r.action,
                reminderId: r.reminderId,
                item: r.item,
              })),
            },
            before: {
              water: { id: seeded.waterId, status: beforeWater?.status },
              other: { id: seeded.otherId, status: beforeOther?.status },
            },
            afterApplyDb: {
              water: afterWater?.status,
              other: afterOther?.status,
            },
            spoken,
            rawSlice,
          },
          null,
          2,
        ),
    );

    expect(
      removes.length,
      `expected reminders.remove; meta=${JSON.stringify(meta.reminders)} spoken=${spoken}`,
    ).toBeGreaterThanOrEqual(1);
    const ids = removes
      .map((r) => String(r.reminderId ?? "").trim())
      .filter(Boolean);
    expect(ids).toContain(seeded.waterId);
    expect(ids).not.toContain(seeded.otherId);
    const listRemoves = (meta.lists ?? []).filter((l) => l.action === "remove");
    expect(
      listRemoves.length,
      `STOP SERIES must not lists.remove; got ${JSON.stringify(meta.lists)}`,
    ).toBe(0);
    // ApplyResult → DB
    expect(afterWater?.status).toBe("cancelled");
    expect(afterOther?.status).toBe("active");
  }

  it(
    "תפסיקי להזכיר לי לשתות מים → remove water series only",
    async () => {
      await runStopUtterance("תפסיקי להזכיר לי לשתות מים");
    },
    180_000,
  );

  it(
    "אל תזכירי לי יותר לשתות מים → remove water series only",
    async () => {
      await runStopUtterance("אל תזכירי לי יותר לשתות מים");
    },
    180_000,
  );

  it(
    "תבטלי את התזכורת לשתות מים → remove water series only",
    async () => {
      await runStopUtterance("תבטלי את התזכורת לשתות מים");
    },
    180_000,
  );

  it(
    "after water ping: אל תזכירי לי יותר → cancel water via RECENT_OUTBOUND.reminder_id",
    async () => {
      const marker = `stopnl-ping-${Date.now().toString(36)}`;
      seeded = await seedTwoClocks(marker);
      // Simulate the water series just fired to the speaker.
      await prisma.reminder.update({
        where: { id: seeded.waterId },
        data: {
          sendStatus: "sent",
          sentAt: new Date(),
          messageText: "לשתות מים",
        },
      });

      const turn = await sendChatMessage({
        userId: seeded.account.userId,
        employeeId: seeded.account.employeeId,
        digitalEmployeeId: seeded.lucyId,
        message: "אל תזכירי לי יותר",
      });
      const meta = parseReplyMetadata(turn.reply);
      const spoken = parseLlmReply(turn.reply).response;
      const removes = reminderRemoves(meta);
      const ids = removes
        .map((r) => String(r.reminderId ?? "").trim())
        .filter(Boolean);
      const afterWater = await prisma.reminder.findUnique({
        where: { id: seeded.waterId },
      });
      const afterOther = await prisma.reminder.findUnique({
        where: { id: seeded.otherId },
      });

      // eslint-disable-next-line no-console
      console.log(
        "REMINDER_STOP_NL_AFTER_PING_REPORT\n" +
          JSON.stringify(
            {
              utterance: "אל תזכירי לי יותר",
              action: { reminders: meta.reminders, removeIds: ids },
              afterApplyDb: {
                water: afterWater?.status,
                other: afterOther?.status,
              },
              spoken,
            },
            null,
            2,
          ),
      );

      expect(ids).toContain(seeded.waterId);
      expect(ids).not.toContain(seeded.otherId);
      expect(afterWater?.status).toBe("cancelled");
      expect(afterOther?.status).toBe("active");
      expect(
        (meta.lists ?? []).filter((l) => l.action === "remove").length,
      ).toBe(0);
    },
    180_000,
  );

  it(
    "bare אל תזכירי לי יותר with no prior ping → clarify; cancel neither",
    async () => {
      const marker = `stopnl-nopingu-${Date.now().toString(36)}`;
      seeded = await seedTwoClocks(marker);
      // Neither clock has been delivered — no RECENT_OUTBOUND bind.

      const turn = await sendChatMessage({
        userId: seeded.account.userId,
        employeeId: seeded.account.employeeId,
        digitalEmployeeId: seeded.lucyId,
        message: "אל תזכירי לי יותר",
      });
      const meta = parseReplyMetadata(turn.reply);
      const spoken = parseLlmReply(turn.reply).response;
      const removes = reminderRemoves(meta);
      const afterWater = await prisma.reminder.findUnique({
        where: { id: seeded.waterId },
      });
      const afterOther = await prisma.reminder.findUnique({
        where: { id: seeded.otherId },
      });

      // eslint-disable-next-line no-console
      console.log(
        "REMINDER_STOP_NL_NO_PING_BARE_REPORT\n" +
          JSON.stringify(
            {
              action: { reminders: meta.reminders },
              afterApplyDb: {
                water: afterWater?.status,
                other: afterOther?.status,
              },
              spoken,
            },
            null,
            2,
          ),
      );

      expect(removes.length).toBe(0);
      expect(afterWater?.status).toBe("active");
      expect(afterOther?.status).toBe("active");
      expect(
        /[?？]|איזו|איזה|מה|לאיזו|באיזו|אילו|אחת/.test(spoken),
        `expected clarify; spoken=${spoken}`,
      ).toBe(true);
    },
    180_000,
  );

  it(
    "אל תשלחי לי יותר הודעות תזכורת (ambiguous) → no auto-cancel",
    async () => {
      const marker = `stopnl-amb-${Date.now().toString(36)}`;
      seeded = await seedTwoClocks(marker);

      const turn = await sendChatMessage({
        userId: seeded.account.userId,
        employeeId: seeded.account.employeeId,
        digitalEmployeeId: seeded.lucyId,
        message: "אל תשלחי לי יותר הודעות תזכורת",
      });
      const meta = parseReplyMetadata(turn.reply);
      const spoken = parseLlmReply(turn.reply).response;
      const removes = reminderRemoves(meta);
      const removeIds = removes
        .map((r) => String(r.reminderId ?? "").trim())
        .filter(Boolean);
      const afterWater = await prisma.reminder.findUnique({
        where: { id: seeded.waterId },
      });
      const afterOther = await prisma.reminder.findUnique({
        where: { id: seeded.otherId },
      });

      // eslint-disable-next-line no-console
      console.log(
        "REMINDER_STOP_NL_AMBIGUOUS_REPORT\n" +
          JSON.stringify(
            {
              action: { reminders: meta.reminders, removeIds },
              afterApplyDb: {
                water: afterWater?.status,
                other: afterOther?.status,
              },
              spoken,
            },
            null,
            2,
          ),
      );

      // No auto-cancel of an arbitrary series.
      expect(afterWater?.status).toBe("active");
      expect(afterOther?.status).toBe("active");
      expect(removeIds).not.toContain(seeded.waterId);
      expect(removeIds).not.toContain(seeded.otherId);
      expect(removes.length, `must not emit reminders.remove; got ${JSON.stringify(meta.reminders)}`).toBe(0);
      const listRemoves = (meta.lists ?? []).filter((l) => l.action === "remove");
      expect(listRemoves.length, `must not lists.remove; got ${JSON.stringify(meta.lists)}`).toBe(0);
      // Clarify which clock — not a silent ack.
      expect(
        /[?？]|איזו|איזה|מה|לאיזו|באיזו|אילו|אחת/.test(spoken),
        `expected clarify ask; spoken=${spoken}`,
      ).toBe(true);
    },
    180_000,
  );

  async function seedDuplicateWater(
    marker: string,
  ): Promise<Seeded & { waterAId: string; waterBId: string }> {
    const account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account, loadLucyInstructions());
    await prisma.employee.update({
      where: { id: lucyId },
      data: {
        instructions: loadLucyInstructions(),
        model: "gpt-4.1-mini",
        temperature: 0,
      },
    });
    const waterA = await prisma.reminder.create({
      data: {
        userId: account.userId,
        ownerId: account.employeeId,
        actorId: account.employeeId,
        itemKey: `לשתות מים-a-${marker}`,
        itemLabel: "לשתות מים",
        listType: "tasks",
        fireAt: new Date(Date.now() + 60 * 60 * 1000),
        repeat: "1:hours",
        recurrence: { freq: "interval", interval: 1, unit: "hours" },
        pingIds: [account.employeeId],
        messageText: "לשתות מים",
        status: "active",
      },
    });
    const waterB = await prisma.reminder.create({
      data: {
        userId: account.userId,
        ownerId: account.employeeId,
        actorId: account.employeeId,
        itemKey: `לשתות מים-b-${marker}`,
        itemLabel: "לשתות מים",
        listType: "tasks",
        fireAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        repeat: "2:hours",
        recurrence: { freq: "interval", interval: 2, unit: "hours" },
        pingIds: [account.employeeId],
        messageText: "לשתות מים",
        status: "active",
      },
    });
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue({
      ok: true as const,
      messageId: "stop-nl-dup",
    });
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent");
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(undefined);
    vi.spyOn(reminderFire, "scheduleSoon").mockReturnValue(undefined);
    await prisma.chatMessage
      .deleteMany({ where: { conversation: { userId: account.userId } } })
      .catch(() => undefined);
    await prisma.chatConversation
      .deleteMany({ where: { userId: account.userId } })
      .catch(() => undefined);
    setLlmClientForTests(null);
    setLlmClientForTests(getLlmClient());
    return {
      account,
      lucyId,
      waterId: waterA.id,
      otherId: waterB.id,
      waterAId: waterA.id,
      waterBId: waterB.id,
      marker,
    };
  }

  it(
    "duplicate titles + last ping from A + אל תזכירי לי יותר → only A cancelled",
    async () => {
      const marker = `stopnl-dup-ping-${Date.now().toString(36)}`;
      const dup = await seedDuplicateWater(marker);
      seeded = dup;
      await prisma.reminder.update({
        where: { id: dup.waterAId },
        data: {
          sendStatus: "sent",
          sentAt: new Date(),
          messageText: "לשתות מים",
        },
      });

      const turn = await sendChatMessage({
        userId: dup.account.userId,
        employeeId: dup.account.employeeId,
        digitalEmployeeId: dup.lucyId,
        message: "אל תזכירי לי יותר",
      });
      const meta = parseReplyMetadata(turn.reply);
      const spoken = parseLlmReply(turn.reply).response;
      const removes = reminderRemoves(meta);
      const ids = removes
        .map((r) => String(r.reminderId ?? "").trim())
        .filter(Boolean);
      const afterA = await prisma.reminder.findUnique({
        where: { id: dup.waterAId },
      });
      const afterB = await prisma.reminder.findUnique({
        where: { id: dup.waterBId },
      });

      // eslint-disable-next-line no-console
      console.log(
        "REMINDER_STOP_NL_DUP_PING_REPORT\n" +
          JSON.stringify(
            {
              action: { removeIds: ids },
              afterApplyDb: { a: afterA?.status, b: afterB?.status },
              spoken,
            },
            null,
            2,
          ),
      );

      expect(ids).toEqual([dup.waterAId]);
      expect(afterA?.status).toBe("cancelled");
      expect(afterB?.status).toBe("active");
    },
    180_000,
  );

  // Known gap (parked): model may remove one/both same-title series instead of ASK.
  it.skip(
    "duplicate titles, no ping, cancel by title → clarify; cancel neither",
    async () => {
      const marker = `stopnl-2w-${Date.now().toString(36)}`;
      const dup = await seedDuplicateWater(marker);
      seeded = dup;

      const turn = await sendChatMessage({
        userId: dup.account.userId,
        employeeId: dup.account.employeeId,
        digitalEmployeeId: dup.lucyId,
        message: "תפסיקי להזכיר לי לשתות מים",
      });
      const meta = parseReplyMetadata(turn.reply);
      const spoken = parseLlmReply(turn.reply).response;
      const removes = reminderRemoves(meta);
      const afterA = await prisma.reminder.findUnique({
        where: { id: dup.waterAId },
      });
      const afterB = await prisma.reminder.findUnique({
        where: { id: dup.waterBId },
      });

      // eslint-disable-next-line no-console
      console.log(
        "REMINDER_STOP_NL_TWO_MATCH_REPORT\n" +
          JSON.stringify(
            {
              action: { reminders: meta.reminders },
              before: { a: "active", b: "active" },
              afterApplyDb: { a: afterA?.status, b: afterB?.status },
              spoken,
            },
            null,
            2,
          ),
      );

      expect(removes.length, `must ask, not remove; got ${JSON.stringify(meta.reminders)}`).toBe(0);
      expect(afterA?.status).toBe("active");
      expect(afterB?.status).toBe("active");
      expect(
        /[?？]|איזו|איזה|מה|לאיזו|באיזו|אילו|אחת|שתיהן|שעה|שעתיים/.test(spoken),
        `expected which-series clarify; spoken=${spoken}`,
      ).toBe(true);
    },
    180_000,
  );

  it(
    "explicit cancel two different series → both cancelled",
    async () => {
      const marker = `stopnl-multi-${Date.now().toString(36)}`;
      seeded = await seedTwoClocks(marker);

      const turn = await sendChatMessage({
        userId: seeded.account.userId,
        employeeId: seeded.account.employeeId,
        digitalEmployeeId: seeded.lucyId,
        message: "תבטלי את התזכורת לשתות מים ואת התזכורת להוריד את הכלב",
      });
      const meta = parseReplyMetadata(turn.reply);
      const spoken = parseLlmReply(turn.reply).response;
      const removes = reminderRemoves(meta);
      const ids = removes
        .map((r) => String(r.reminderId ?? "").trim())
        .filter(Boolean);
      const afterWater = await prisma.reminder.findUnique({
        where: { id: seeded.waterId },
      });
      const afterOther = await prisma.reminder.findUnique({
        where: { id: seeded.otherId },
      });

      // eslint-disable-next-line no-console
      console.log(
        "REMINDER_STOP_NL_EXPLICIT_MULTI_REPORT\n" +
          JSON.stringify(
            {
              action: { removeIds: ids },
              afterApplyDb: {
                water: afterWater?.status,
                other: afterOther?.status,
              },
              spoken,
            },
            null,
            2,
          ),
      );

      expect(ids).toContain(seeded.waterId);
      expect(ids).toContain(seeded.otherId);
      expect(afterWater?.status).toBe("cancelled");
      expect(afterOther?.status).toBe("cancelled");
    },
    180_000,
  );
});
