/**
 * Done vs Option-B snooze after a standing daily-task ping.
 * Real OpenAI via sendChatMessage; WhatsApp / fireDue mocked.
 *
 * CRITICAL: Done and Snooze each use a FRESH independent seed — never reuse
 * DB state left by the other test.
 *
 * Run (cwd backend):
 *   npm run test:eval-db -- tests/mark-done-vs-snooze.live-sendchat.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
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
  REMINDER_SNOOZE_MINUTES,
  reminderFireButtons,
} from "../src/services/outbound-text.js";
import { RECURRENCE_META_KEY } from "../src/services/list-recurrence.js";
import { jerusalemYmd } from "../src/utils/relative-date.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  injectProductEnvKey,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const TITLE = "להוריד את סקאזי לטיול ערב";

function loadLucyInstructions(): string {
  const path = resolve(process.cwd(), "..", "LLM.config.json");
  expect(existsSync(path), path).toBe(true);
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    systemMessage: string[];
  };
  return raw.systemMessage.join("\n");
}

type StandingSeed = {
  account: HarnessAccount;
  lucyId: string;
  itemId: string;
  reminderId: string;
  marker: string;
  beforeClock: {
    id: string;
    status: string | null;
    fireAt: Date | null;
    recurrence: unknown;
    repeat: string | null;
  };
  beforeDoneDates: unknown;
};

async function seedStandingDailyPing(marker: string): Promise<StandingSeed> {
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

  const list =
    (await prisma.employeeList.findFirst({
      where: {
        employeeId: account.employeeId,
        listType: "tasks",
        deletedAt: null,
      },
      select: { id: true },
    })) ??
    (await prisma.employeeList.create({
      data: {
        employeeId: account.employeeId,
        listType: "tasks",
        name: "",
        scope: "personal",
        visibleTo: [account.employeeId],
      },
      select: { id: true },
    }));

  // Lucy worker book — Option B «לשלוח נדנוד» lands here.
  const existingLucyList = await prisma.employeeList.findFirst({
    where: { employeeId: lucyId, listType: "tasks", deletedAt: null },
    select: { id: true },
  });
  if (!existingLucyList) {
    await prisma.employeeList.create({
      data: {
        employeeId: lucyId,
        listType: "tasks",
        name: "",
        scope: "personal",
        visibleTo: [lucyId, account.employeeId],
      },
    });
  }

  const itemId = randomUUID();
  const start = jerusalemYmd();
  await prisma.employeeListItem.create({
    data: {
      id: itemId,
      listId: list.id,
      itemKey: `${TITLE}-${marker}`,
      data: {
        "שם משימה": TITLE,
        "שעה לביצוע": "18:15",
        חוזר: "כל יום",
        [RECURRENCE_META_KEY]: {
          freq: "daily",
          interval: 1,
          time: "18:15",
          start,
        },
      },
      scope: "personal",
      addedById: account.employeeId,
      visibleTo: [account.employeeId],
    },
  });

  const fireAt = new Date(Date.now() + 60 * 60 * 1000);
  const reminder = await prisma.reminder.create({
    data: {
      userId: account.userId,
      ownerId: account.employeeId,
      actorId: account.employeeId,
      itemKey: `${TITLE}-${marker}`,
      itemLabel: TITLE,
      listType: "tasks",
      fireAt,
      repeat: "1:days",
      recurrence: { freq: "daily", interval: 1, time: "18:00" },
      pingIds: [account.employeeId],
      messageText: TITLE,
      status: "active",
      sendStatus: "sent",
      sentAt: new Date(),
    },
  });

  await prisma.employeeListItemReminderLink.create({
    data: {
      listItemId: itemId,
      reminderId: reminder.id,
    },
  });
  await prisma.employeeListItem.update({
    where: { id: itemId },
    data: { linkedReminderId: reminder.id },
  });

  vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue({
    ok: true as const,
    messageId: `md-${marker}`,
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

  const beforeClock = await prisma.reminder.findUnique({
    where: { id: reminder.id },
  });
  const beforeItem = await prisma.employeeListItem.findUnique({
    where: { id: itemId },
  });
  const beforeData =
    beforeItem?.data && typeof beforeItem.data === "object"
      ? (beforeItem.data as Record<string, unknown>)
      : {};
  const beforeMeta =
    beforeData[RECURRENCE_META_KEY] &&
    typeof beforeData[RECURRENCE_META_KEY] === "object"
      ? (beforeData[RECURRENCE_META_KEY] as Record<string, unknown>)
      : {};

  return {
    account,
    lucyId,
    itemId,
    reminderId: reminder.id,
    marker,
    beforeClock: {
      id: reminder.id,
      status: beforeClock?.status ?? null,
      fireAt: beforeClock?.fireAt ?? null,
      recurrence: beforeClock?.recurrence ?? null,
      repeat: beforeClock?.repeat ?? null,
    },
    beforeDoneDates: beforeMeta.done_dates ?? null,
  };
}

function isSnoozeAdd(meta: ReturnType<typeof parseReplyMetadata>): boolean {
  const reminderAdds = (meta.reminders ?? []).filter((r) => r.action === "add");
  const listReminderAdds = (meta.lists ?? []).filter(
    (l) =>
      l.action === "add" &&
      String(l.listType ?? "").toLowerCase() === "reminders",
  );
  const workerNudge = (meta.lists ?? []).some((l) => {
    if (l.action !== "add") return false;
    const items = Array.isArray(l.items) ? l.items : [];
    return items.some((it) => {
      const title = String(
        (it as Record<string, unknown>)["שם משימה"] ??
          (it as Record<string, unknown>).item ??
          "",
      );
      return title.includes("לשלוח נדנוד") || title.includes("נדנוד");
    });
  });
  const textHints = reminderAdds.some((r) => {
    const blob = JSON.stringify(r);
    return (
      blob.includes("נדנוד") ||
      blob.includes("10") ||
      /in["']?\s*:\s*["']?10/i.test(blob)
    );
  });
  return (
    reminderAdds.length > 0 ||
    listReminderAdds.length > 0 ||
    workerNudge ||
    textHints
  );
}

function hasOccurrenceDone(
  meta: ReturnType<typeof parseReplyMetadata>,
  itemId: string,
): boolean {
  for (const entry of meta.lists ?? []) {
    if (entry.action !== "update") continue;
    if (String(entry.listType ?? "").toLowerCase() !== "tasks") continue;
    for (const raw of entry.items ?? []) {
      const it = raw as Record<string, unknown>;
      if (String(it.item_id ?? it.itemId ?? "") !== itemId) continue;
      if (it.occurrence_done !== undefined && it.occurrence_done !== null) {
        return true;
      }
    }
  }
  return false;
}

function reminderRemoves(meta: ReturnType<typeof parseReplyMetadata>) {
  return (meta.reminders ?? []).filter((r) => r.action === "remove");
}

describe("mark-done vs snooze (real model, eval-db, independent seeds)", () => {
  let seeded: StandingSeed | null = null;

  beforeAll(async () => {
    const key = injectProductEnvKey("OPENAI_API_KEY");
    expect(key.present, "OPENAI_API_KEY required").toBe(true);
    resetEnvCache();
    await assertEvalDbAndGtfsUntouched();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (seeded) {
      await prisma.employeeListItemReminderLink
        .deleteMany({
          where: {
            OR: [
              { listItemId: seeded.itemId },
              { reminderId: seeded.reminderId },
            ],
          },
        })
        .catch(() => undefined);
      await prisma.reminder
        .deleteMany({ where: { userId: seeded.account.userId } })
        .catch(() => undefined);
      await prisma.employeeListItem
        .deleteMany({ where: { id: seeded.itemId } })
        .catch(() => undefined);
      await cleanupHarnessAccount(seeded.account);
      seeded = null;
    }
  });

  it(
    "Done: סמן כבוצע full command → occurrence_done; no snooze; series unchanged",
    async () => {
      seeded = await seedStandingDailyPing(`done-${Date.now().toString(36)}`);
      const command = `סמן כבוצע: ${TITLE}`;
      const before = seeded.beforeClock;

      const turn = await sendChatMessage({
        userId: seeded.account.userId,
        employeeId: seeded.account.employeeId,
        digitalEmployeeId: seeded.lucyId,
        message: command,
      });
      const meta = parseReplyMetadata(turn.reply);
      const spoken = parseLlmReply(turn.reply).response;
      const afterClock = await prisma.reminder.findUnique({
        where: { id: seeded.reminderId },
      });
      const afterItem = await prisma.employeeListItem.findUnique({
        where: { id: seeded.itemId },
      });
      const afterData =
        afterItem?.data && typeof afterItem.data === "object"
          ? (afterItem.data as Record<string, unknown>)
          : {};
      const afterMeta =
        afterData[RECURRENCE_META_KEY] &&
        typeof afterData[RECURRENCE_META_KEY] === "object"
          ? (afterData[RECURRENCE_META_KEY] as Record<string, unknown>)
          : {};
      const doneDates = afterMeta.done_dates;
      const activeCount = await prisma.reminder.count({
        where: { userId: seeded.account.userId, status: "active" },
      });

      // eslint-disable-next-line no-console
      console.log(
        "MARK_DONE_EVAL_REPORT\n" +
          JSON.stringify(
            {
              command,
              action: { lists: meta.lists, reminders: meta.reminders },
              beforeClock: {
                id: before.id,
                status: before.status,
                fireAt: before.fireAt?.toISOString() ?? null,
                recurrence: before.recurrence,
              },
              afterClock: {
                id: afterClock?.id,
                status: afterClock?.status,
                fireAt: afterClock?.fireAt?.toISOString() ?? null,
                recurrence: afterClock?.recurrence,
              },
              beforeDoneDates: seeded.beforeDoneDates,
              afterDoneDates: doneDates,
              spoken,
            },
            null,
            2,
          ),
      );

      expect(
        isSnoozeAdd(meta),
        `Done must not snooze; meta=${JSON.stringify({ lists: meta.lists, reminders: meta.reminders })}`,
      ).toBe(false);
      expect(reminderRemoves(meta).length).toBe(0);
      expect(
        hasOccurrenceDone(meta, seeded.itemId),
        `expected occurrence_done on ${seeded.itemId}; lists=${JSON.stringify(meta.lists)}`,
      ).toBe(true);

      expect(afterClock?.status).toBe("active");
      expect(afterClock?.id).toBe(before.id);
      expect(afterClock?.fireAt?.toISOString()).toBe(
        before.fireAt?.toISOString(),
      );
      expect(JSON.stringify(afterClock?.recurrence ?? null)).toBe(
        JSON.stringify(before.recurrence),
      );
      expect(activeCount).toBe(1);

      const today = jerusalemYmd();
      expect(
        Array.isArray(doneDates) &&
          doneDates.some(
            (d) => String(d) === today || String(d).startsWith(`${today} `),
          ),
        `done_dates should include today ${today}; got ${JSON.stringify(doneDates)}`,
      ).toBe(true);
    },
    180_000,
  );

  it(
    "Snooze: נדנדי לי after ping → one-shot ~10m; source series unchanged; no occurrence_done",
    async () => {
      // Fresh seed — independent of Done test DB state.
      seeded = await seedStandingDailyPing(`snooze-${Date.now().toString(36)}`);
      const command = `נדנדי לי ${TITLE} בעוד ${REMINDER_SNOOZE_MINUTES} דקות`;
      const before = seeded.beforeClock;
      const t0 = Date.now();

      const turn = await sendChatMessage({
        userId: seeded.account.userId,
        employeeId: seeded.account.employeeId,
        digitalEmployeeId: seeded.lucyId,
        message: command,
      });
      const meta = parseReplyMetadata(turn.reply);
      const spoken = parseLlmReply(turn.reply).response;
      const afterSource = await prisma.reminder.findUnique({
        where: { id: seeded.reminderId },
      });
      const allActive = await prisma.reminder.findMany({
        where: { userId: seeded.account.userId, status: "active" },
      });
      const snoozes = allActive.filter((r) => r.id !== seeded!.reminderId);
      const afterItem = await prisma.employeeListItem.findUnique({
        where: { id: seeded.itemId },
      });
      const afterData =
        afterItem?.data && typeof afterItem.data === "object"
          ? (afterItem.data as Record<string, unknown>)
          : {};
      const afterMeta =
        afterData[RECURRENCE_META_KEY] &&
        typeof afterData[RECURRENCE_META_KEY] === "object"
          ? (afterData[RECURRENCE_META_KEY] as Record<string, unknown>)
          : {};

      // eslint-disable-next-line no-console
      console.log(
        "SNOOZE_REGRESSION_EVAL_REPORT\n" +
          JSON.stringify(
            {
              command,
              action: { lists: meta.lists, reminders: meta.reminders },
              beforeClock: {
                id: before.id,
                status: before.status,
                fireAt: before.fireAt?.toISOString() ?? null,
                recurrence: before.recurrence,
              },
              afterSource: {
                id: afterSource?.id,
                status: afterSource?.status,
                fireAt: afterSource?.fireAt?.toISOString() ?? null,
                recurrence: afterSource?.recurrence,
              },
              newActiveClocks: snoozes.map((r) => ({
                id: r.id,
                fireAt: r.fireAt?.toISOString() ?? null,
                repeat: r.repeat,
                itemLabel: r.itemLabel,
              })),
              afterDoneDates: afterMeta.done_dates ?? null,
              spoken,
            },
            null,
            2,
          ),
      );

      expect(
        hasOccurrenceDone(meta, seeded.itemId),
        "Snooze must not emit occurrence_done",
      ).toBe(false);
      expect(afterMeta.done_dates ?? null).toEqual(seeded.beforeDoneDates);

      expect(afterSource?.status).toBe("active");
      expect(afterSource?.id).toBe(before.id);
      expect(afterSource?.fireAt?.toISOString()).toBe(
        before.fireAt?.toISOString(),
      );
      expect(JSON.stringify(afterSource?.recurrence ?? null)).toBe(
        JSON.stringify(before.recurrence),
      );

      expect(
        snoozes.length,
        `expected one new snooze clock; active=${JSON.stringify(
          allActive.map((r) => ({ id: r.id, label: r.itemLabel, fireAt: r.fireAt })),
        )} action=${JSON.stringify({ lists: meta.lists, reminders: meta.reminders })}`,
      ).toBeGreaterThanOrEqual(1);
      const snooze = snoozes[0]!;
      expect(
        snooze.itemLabel,
        `snooze clock title must be original chore, not worker prefix; got ${snooze.itemLabel}`,
      ).toBe(TITLE);
      expect(snooze.itemLabel).not.toMatch(/לשלוח נדנוד/);
      const fireButtons = reminderFireButtons({
        item: snooze.itemLabel ?? "",
        text: snooze.messageText ?? "",
        composeAtFire: false,
      });
      expect(fireButtons.map((b) => b.label)).toEqual(["נדנד", "סמן כבוצע"]);
      expect(fireButtons[0]?.command).toBe(
        `נדנדי לי ${TITLE} בעוד ${REMINDER_SNOOZE_MINUTES} דקות`,
      );
      expect(fireButtons[1]?.command).toBe(`סמן כבוצע: ${TITLE}`);

      const speakerTaskAdds = (meta.lists ?? []).filter(
        (l) =>
          l.action === "add" &&
          String(l.listType ?? "").toLowerCase() === "tasks" &&
          (!(l.targets ?? []).length ||
            (l.targets ?? []).some((t) => String(t).includes("טל"))),
      );
      expect(
        speakerTaskAdds.length,
        `no duplicate speaker-book chore for snooze; lists=${JSON.stringify(meta.lists)}`,
      ).toBe(0);

      const deltaMin =
        (snooze.fireAt!.getTime() - t0) / (60 * 1000);
      expect(deltaMin).toBeGreaterThan(7);
      expect(deltaMin).toBeLessThan(15);

      expect(spoken).not.toContain("לא הצלחתי להוסיף את המשימה לרשימה");
    },
    180_000,
  );
});
