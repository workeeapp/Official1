/**
 * Link a reminder onto an EXISTING tasks row (e.g. תור לווטרינר).
 * Real OpenAI via sendChatMessage; proves item_id link + 🔔 dump; no duplicate task.
 *
 * Run (cwd backend):
 *   npm run test:eval-db -- tests/reminder-link-existing-task.live-sendchat.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
import { getEmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import { formatShowDumpFromKind } from "../src/services/show-button-dump.js";
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

const TITLE = "תור לווטרינר";

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
  itemId: string;
  marker: string;
};

async function seedVetTaskNoClock(marker: string): Promise<Seeded> {
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

  const itemId = randomUUID();
  await prisma.employeeListItem.create({
    data: {
      id: itemId,
      listId: list.id,
      itemKey: `${TITLE}-${marker}`,
      data: {
        "שם משימה": TITLE,
        "תאריך לביצוע": "2026-11-05",
        "שעה לביצוע": "10:00",
      },
      scope: "personal",
      addedById: account.employeeId,
      visibleTo: [account.employeeId],
    },
  });

  vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue({
    ok: true as const,
    messageId: `link-${marker}`,
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

  return { account, lucyId, itemId, marker };
}

function actionUsesItemId(
  meta: ReturnType<typeof parseReplyMetadata>,
  itemId: string,
): boolean {
  const blob = JSON.stringify(meta);
  return blob.includes(itemId);
}

function listsAddTasksCount(meta: ReturnType<typeof parseReplyMetadata>): number {
  return (meta.lists ?? []).filter(
    (l) =>
      l.action === "add" &&
      String(l.listType ?? "").toLowerCase() === "tasks",
  ).length;
}

describe("link reminder to existing vet task (real model, eval-db)", () => {
  let seeded: Seeded | null = null;

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
        .deleteMany({ where: { listItemId: seeded.itemId } })
        .catch(() => undefined);
      await prisma.reminder
        .deleteMany({ where: { userId: seeded.account.userId } })
        .catch(() => undefined);
      await prisma.employeeListItem
        .deleteMany({
          where: {
            list: { employeeId: seeded.account.employeeId },
            deletedAt: null,
          },
        })
        .catch(() => undefined);
      await cleanupHarnessAccount(seeded.account);
      seeded = null;
    }
  });

  it(
    "תזכירי לי על תור לווטרינר → same item_id link + 🔔; no duplicate task; no orphan-only clock",
    async () => {
      seeded = await seedVetTaskNoClock(`vet-${Date.now().toString(36)}`);
      const utterance =
        "תזכירי לי מחר ב־09:00 על התור לווטרינר שכבר יש לי במשימות";

      const turn = await sendChatMessage({
        userId: seeded.account.userId,
        employeeId: seeded.account.employeeId,
        digitalEmployeeId: seeded.lucyId,
        message: utterance,
      });
      const meta = parseReplyMetadata(turn.reply);
      const spoken = parseLlmReply(turn.reply).response;

      const taskRows = await prisma.employeeListItem.findMany({
        where: {
          list: { employeeId: seeded.account.employeeId, listType: "tasks" },
          deletedAt: null,
        },
      });
      const titleMatches = taskRows.filter((row) => {
        const data =
          row.data && typeof row.data === "object"
            ? (row.data as Record<string, unknown>)
            : {};
        return String(data["שם משימה"] ?? row.itemKey).includes("וטרינר");
      });
      const links = await prisma.employeeListItemReminderLink.findMany({
        where: { listItemId: seeded.itemId },
      });
      const soft = await prisma.employeeListItem.findUnique({
        where: { id: seeded.itemId },
        select: { linkedReminderId: true, reminderId: true },
      });
      const clocks = await prisma.reminder.findMany({
        where: { userId: seeded.account.userId, status: "active" },
      });

      const snap = await getEmployeeRecordSnapshot(seeded.account.employeeId, {
        accountOwner: true,
      });
      const dump =
        formatShowDumpFromKind("tasks", snap, {
          viewerName: "טל",
        }) ?? "";

      // Evidence for flaky model runs (one JSON line per run; .tmp = untracked).
      appendFileSync(
        resolve(process.cwd(), ".tmp-reminder-link-reports.jsonl"),
        JSON.stringify({
          at: new Date().toISOString(),
          spoken,
          action: { lists: meta.lists ?? [], reminders: meta.reminders ?? [] },
        }) + "\n",
      );
      // eslint-disable-next-line no-console
      console.log(
        "REMINDER_LINK_EXISTING_EVAL_REPORT\n" +
          JSON.stringify(
            {
              utterance,
              seededItemId: seeded.itemId,
              action: { lists: meta.lists, reminders: meta.reminders },
              listsAddTasks: listsAddTasksCount(meta),
              actionUsesSeededItemId: actionUsesItemId(meta, seeded.itemId),
              titleMatchCount: titleMatches.length,
              titleMatchIds: titleMatches.map((r) => r.id),
              joins: links.map((l) => ({
                listItemId: l.listItemId,
                reminderId: l.reminderId,
              })),
              softLinkedReminderId: soft?.linkedReminderId ?? null,
              activeClocks: clocks.map((c) => ({
                id: c.id,
                itemLabel: c.itemLabel,
                fireAt: c.fireAt?.toISOString() ?? null,
              })),
              dumpHasBell: dump.includes("🔔"),
              dumpSlice: dump.slice(0, 800),
              spoken,
            },
            null,
            2,
          ),
      );

      expect(
        listsAddTasksCount(meta),
        `must not lists.add a duplicate vet task; lists=${JSON.stringify(meta.lists)}`,
      ).toBe(0);
      expect(
        actionUsesItemId(meta, seeded.itemId),
        `ACTION must reference seeded item_id ${seeded.itemId}`,
      ).toBe(true);
      expect(
        titleMatches.map((r) => r.id),
        "original item_id must remain the vet task identity",
      ).toContain(seeded.itemId);
      expect(
        titleMatches.length,
        `no duplicate vet task rows; ids=${titleMatches.map((r) => r.id).join(",")}`,
      ).toBe(1);

      const linked =
        links.some((l) => l.listItemId === seeded!.itemId) ||
        soft?.linkedReminderId != null;
      expect(
        linked,
        "reminder must be linked to the seeded item_id in DB",
      ).toBe(true);

      // Orphan-only = active clocks that are not linked to the item (join or soft).
      const linkedIds = new Set([
        ...links.map((l) => l.reminderId),
        ...(soft?.linkedReminderId ? [soft.linkedReminderId] : []),
      ]);
      const orphanOnly = clocks.filter((c) => !linkedIds.has(c.id));
      expect(
        linkedIds.size,
        `expected at least one linked clock; orphans=${JSON.stringify(orphanOnly)} clocks=${JSON.stringify(clocks)}`,
      ).toBeGreaterThanOrEqual(1);
      // Worker tracking clock without item link is allowed IN ADDITION, but there
      // must still be a linked clock (asserted above). Orphans alone are not OK.
      expect(dump).toContain("🔔");
      expect(dump).toMatch(/וטרינר/);
    },
    180_000,
  );
});
