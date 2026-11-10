/**
 * An add that names the speaker and Lucy persists both task rows and one
 * reminder. A Lucy-only tracking task stays off the speaker dump. A numbered
 * range delete removes exactly the dump-line ids.
 *
 * Real path: sendChatMessage + persisted rows on workee_test. Stubbed model.
 * No WhatsApp send, no reminder fire.
 *
 * Run: npm run test:eval-db -- tests/task-target-and-range-delete.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { formatJerusalemDateTime, parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { parseItemNavRef } from "../src/services/builtin-lists.js";
import {
  getEmployeeRecordSnapshot,
  LIST_FIND_MISS,
} from "../src/services/employee-records.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

type DumpLine = { n: number; id: string; title_stem: string; kind: string };

function stubLlmQueue(payloads: unknown[]) {
  let i = 0;
  return {
    async createConversation() {
      return `conv-${randomUUID()}`;
    },
    async createResponse() {
      const payload = payloads[Math.min(i, payloads.length - 1)]!;
      i += 1;
      return { reply: JSON.stringify(payload), raw: {} };
    },
  };
}

function taskTitles(
  snapshot: Awaited<ReturnType<typeof getEmployeeRecordSnapshot>>,
): string[] {
  const out: string[] = [];
  for (const list of snapshot.lists) {
    if (list.list_type !== "tasks") continue;
    for (const item of list.items) {
      const title = item["שם משימה"];
      if (typeof title === "string" && title.trim()) out.push(title.trim());
    }
  }
  return out;
}

function buttonIds(reply: string): string[] {
  const buttons = parseLlmReply(reply).responseBubbles.flatMap(
    (bubble) => bubble.buttons ?? [],
  );
  const ids: string[] = [];
  for (const button of buttons) {
    for (const ref of parseItemNavRef(button.command) ?? []) {
      ids.push(ref.id);
    }
  }
  return ids;
}

async function latestNumberedDump(userId: string): Promise<DumpLine[]> {
  const recent = await prisma.chatMessage.findMany({
    where: { author: "assistant", conversation: { userId } },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { raw: true },
  });
  for (const row of recent) {
    const raw = row.raw as { lastNumberedDump?: unknown } | null;
    if (!Array.isArray(raw?.lastNumberedDump)) continue;
    const lines: DumpLine[] = [];
    for (const entry of raw.lastNumberedDump) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      const n = rec.n;
      const id = rec.id;
      if (typeof n !== "number" || typeof id !== "string" || !id.trim()) continue;
      lines.push({
        n,
        id: id.trim(),
        title_stem: typeof rec.title_stem === "string" ? rec.title_stem : "",
        kind: typeof rec.kind === "string" ? rec.kind : "",
      });
    }
    if (lines.length > 0) return lines;
  }
  return [];
}

describe("digital-worker tasks stay off the speaker dump, and range delete uses those lines", () => {
  let account: HarnessAccount | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (account) {
      await prisma.reminder
        .deleteMany({ where: { userId: account.userId } })
        .catch(() => undefined);
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  function silenceOutbound() {
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);
  }

  const tomorrow = formatJerusalemDateTime(
    new Date(Date.now() + 24 * 3600_000),
  ).slice(0, 10);

  async function ownedTasks(employeeId: string) {
    return prisma.employeeListItem.findMany({
      where: {
        deletedAt: null,
        list: { employeeId, listType: "tasks" },
      },
      select: {
        id: true,
        reminderId: true,
        itemKey: true,
        data: true,
        list: { select: { employeeId: true, scope: true } },
      },
    });
  }

  function rowTitle(row: { data: unknown; itemKey: string }): string {
    const data = row.data as { "שם משימה"?: unknown } | null;
    const title = data?.["שם משימה"];
    return typeof title === "string" && title.trim() ? title.trim() : row.itemKey;
  }

  it("one add targeting the speaker and Lucy persists both tasks and one reminder", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const chore = "להתקשר לעמיר";
    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "אזכיר לך מחר ב־18:00 להתקשר לעמיר." }],
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                targets: ["טל", "לוסי"],
                items: [
                  {
                    "שם משימה": chore,
                    "תאריך לביצוע": tomorrow,
                    "שעה לביצוע": "18:00",
                  },
                ],
              },
            ],
            reminders: [
              {
                action: "add",
                item: chore,
                date: tomorrow,
                time: "18:00",
                ping: ["טל"],
                text: chore,
              },
            ],
          },
        },
        {
          responses: [{ text: "הנה המשימות." }],
          metadata: { lists: [], show_dump: "tasks" },
        },
      ]),
    );

    const saved = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תזכירי לי מחר להתקשר לעמיר",
    });
    const speakerRows = await ownedTasks(account.employeeId);
    const lucyRows = await ownedTasks(lucyId);
    expect(speakerRows.map(rowTitle)).toEqual([chore]);
    expect(lucyRows.map(rowTitle)).toEqual([chore]);
    expect(speakerRows[0]!.list.employeeId).toBe(account.employeeId);
    expect(lucyRows[0]!.list.employeeId).toBe(lucyId);
    expect(speakerRows[0]!.list.scope).toBe("personal");
    expect(lucyRows[0]!.list.scope).toBe("personal");

    const clocks = await prisma.reminder.findMany({
      where: { userId: account.userId, status: "active" },
      select: {
        id: true,
        ownerId: true,
        actorId: true,
        pingIds: true,
        workerItemId: true,
      },
    });
    expect(clocks).toHaveLength(1);
    const clock = clocks[0]!;
    expect(clock.ownerId).toBe(account.employeeId);
    expect(clock.actorId).toBe(account.employeeId);
    expect(clock.pingIds).toEqual([account.employeeId]);
    expect(clock.workerItemId).toBe(lucyRows[0]!.id);
    expect(lucyRows[0]!.reminderId).toBe(clock.id);

    const speaker = await getEmployeeRecordSnapshot(account.employeeId);
    expect(taskTitles(speaker)).toEqual([chore]);
    const visibleIds = new Set<string>();
    for (const list of speaker.lists) {
      if (list.list_type !== "tasks") continue;
      for (const item of list.items) {
        const id = item.item_id ?? item.id;
        if (typeof id === "string") visibleIds.add(id);
      }
    }
    expect(visibleIds).toEqual(new Set([speakerRows[0]!.id]));
    expect(buttonIds(saved.reply)).not.toContain(lucyRows[0]!.id);

    const shown = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "הצג משימות",
    });
    const spoken = parseLlmReply(shown.reply).response;
    expect(spoken).toContain(chore);
    const dump = await latestNumberedDump(account.userId);
    expect(dump.map((line) => line.id)).toEqual([speakerRows[0]!.id]);
    expect(dump.some((line) => line.id === lucyRows[0]!.id)).toBe(false);
  }, 30000);

  it("two separate adds keep the speaker chore and Lucy's tracking task apart", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const chore = "להתקשר לעמיר";
    const tracking = "להזכיר לטל להתקשר לעמיר";
    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "אזכיר לך מחר ב־18:00 להתקשר לעמיר." }],
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                items: [
                  {
                    "שם משימה": chore,
                    "תאריך לביצוע": tomorrow,
                    "שעה לביצוע": "18:00",
                  },
                ],
              },
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                targets: ["לוסי"],
                items: [
                  {
                    "שם משימה": tracking,
                    "תאריך לביצוע": tomorrow,
                    "שעה לביצוע": "18:00",
                  },
                ],
              },
            ],
            reminders: [
              {
                action: "add",
                item: chore,
                date: tomorrow,
                time: "18:00",
                ping: ["טל"],
                text: chore,
              },
            ],
          },
        },
        {
          responses: [{ text: "הנה המשימות." }],
          metadata: { lists: [], show_dump: "tasks" },
        },
      ]),
    );

    const saved = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תזכירי לי מחר להתקשר לעמיר",
    });
    const speakerRows = await ownedTasks(account.employeeId);
    const lucyRows = await ownedTasks(lucyId);
    expect(speakerRows.map(rowTitle)).toEqual([chore]);
    expect(lucyRows.map(rowTitle)).toEqual([tracking]);
    const clocks = await prisma.reminder.findMany({
      where: { userId: account.userId, status: "active" },
      select: { id: true, ownerId: true, pingIds: true, workerItemId: true },
    });
    expect(clocks).toHaveLength(1);
    expect(clocks[0]!.ownerId).toBe(account.employeeId);
    expect(clocks[0]!.pingIds).toEqual([account.employeeId]);
    expect(clocks[0]!.workerItemId).toBe(lucyRows[0]!.id);
    expect(lucyRows[0]!.reminderId).toBe(clocks[0]!.id);
    expect(buttonIds(saved.reply)).not.toContain(lucyRows[0]!.id);

    const shown = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "הצג משימות",
    });
    const spoken = parseLlmReply(shown.reply).response;
    expect(spoken).toContain(chore);
    expect(spoken).not.toContain(tracking);
    const dump = await latestNumberedDump(account.userId);
    expect(dump.map((line) => line.id)).toEqual([speakerRows[0]!.id]);
  }, 30000);

  it("user + family + Lucy keeps the speaker row and the family assignment", async () => {
    account = await createHarnessAccount("טל", { partners: ["עמית"] });
    const partner = account.partners[0];
    expect(partner?.id).toBeTruthy();
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const sharedTitle = "להזכיר לטל ולעמית לסגור את החלון";
    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "רשמתי." }],
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                items: [{ "שם משימה": "לשתות מים" }],
              },
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                targets: ["טל", "עמית", "לוסי"],
                items: [{ "שם משימה": sharedTitle }],
              },
            ],
          },
        },
      ]),
    );

    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תזכירי לי ולעמית לסגור את החלון",
    });

    async function ownedTaskTitles(employeeId: string): Promise<string[]> {
      const rows = await prisma.employeeListItem.findMany({
        where: {
          deletedAt: null,
          list: { employeeId, listType: "tasks" },
        },
        select: { data: true, itemKey: true },
      });
      return rows.map((row) => {
        const data = row.data as { "שם משימה"?: unknown } | null;
        const title = data?.["שם משימה"];
        return typeof title === "string" && title.trim()
          ? title.trim()
          : row.itemKey;
      });
    }

    expect(new Set(await ownedTaskTitles(account.employeeId))).toEqual(
      new Set(["לשתות מים", sharedTitle]),
    );
    expect(await ownedTaskTitles(partner!.id)).toEqual([sharedTitle]);
    expect(await ownedTaskTitles(lucyId)).toEqual([sharedTitle]);
  });

  it("filtered dump line numbers are the ids a range delete removes", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const titles = Array.from({ length: 15 }, (_, index) => {
      return `משימה ${String(index + 1).padStart(2, "0")}`;
    });
    const workerTitle = "להזכיר לטל לסגור את החלון";
    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "רשמתי את המשימות." }],
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                items: titles.map((title) => ({ "שם משימה": title })),
              },
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                targets: ["לוסי"],
                items: [{ "שם משימה": workerTitle }],
              },
            ],
          },
        },
        {
          responses: [{ text: "הנה המשימות." }],
          metadata: { lists: [], show_dump: "tasks" },
        },
        {
          responses: [{ text: "הסרתי 4 פריטים." }],
          metadata: {
            lists: [
              {
                action: "remove",
                list_type: "tasks",
                list_name: "",
                items: [7, 8, 9, 10].map((n) => ({
                  mutate_source: "dump_line",
                  dump_line: n,
                })),
              },
            ],
          },
        },
      ]),
    );

    const saved = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תוסיפי משימות",
    });
    const lucyTasks = await prisma.employeeListItem.findMany({
      where: { deletedAt: null, list: { employeeId: lucyId, listType: "tasks" } },
      select: { id: true },
    });
    expect(lucyTasks).toHaveLength(1);
    expect(buttonIds(saved.reply)).not.toContain(lucyTasks[0]!.id);

    const shown = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "הצג משימות",
    });
    const spoken = parseLlmReply(shown.reply).response;
    expect(spoken).not.toContain(workerTitle);
    const dump = await latestNumberedDump(account.userId);
    expect(dump).toHaveLength(15);
    expect(dump.map((line) => line.n)).toEqual(titles.map((_, index) => index + 1));
    const speakerBefore = await getEmployeeRecordSnapshot(account.employeeId);
    const speakerIds = new Set<string>();
    for (const list of speakerBefore.lists) {
      if (list.list_type !== "tasks") continue;
      for (const item of list.items) {
        const id = item.item_id ?? item.id;
        if (typeof id === "string") speakerIds.add(id);
      }
    }
    expect(new Set(dump.map((line) => line.id))).toEqual(speakerIds);
    for (const line of dump) {
      expect(spoken).toContain(`${line.n}. ${line.title_stem}`);
      expect(line.kind).toBe("tasks");
    }
    expect(dump.some((line) => line.id === lucyTasks[0]!.id)).toBe(false);

    const removed = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "מחקי 7 עד 10",
    });
    const removedSpoken = parseLlmReply(removed.reply).response;
    expect(removedSpoken).not.toContain(LIST_FIND_MISS);
    const range = dump.filter((line) => line.n >= 7 && line.n <= 10);
    expect(range).toHaveLength(4);
    const deleted = await prisma.employeeListItem.findMany({
      where: { id: { in: range.map((line) => line.id) } },
      select: { id: true, deletedAt: true },
    });
    expect(deleted).toHaveLength(4);
    expect(deleted.every((row) => row.deletedAt != null)).toBe(true);
    const speakerAfter = await getEmployeeRecordSnapshot(account.employeeId);
    const remainingIds = new Set<string>();
    for (const list of speakerAfter.lists) {
      if (list.list_type !== "tasks") continue;
      for (const item of list.items) {
        const id = item.item_id ?? item.id;
        if (typeof id === "string") remainingIds.add(id);
      }
    }
    expect(remainingIds.size).toBe(11);
    for (const line of range) {
      expect(remainingIds.has(line.id)).toBe(false);
    }
    const lucyStill = await prisma.employeeListItem.findFirst({
      where: { id: lucyTasks[0]!.id, deletedAt: null },
      select: { id: true },
    });
    expect(lucyStill?.id).toBe(lucyTasks[0]!.id);
  });

  it("a failed line in a filtered range names what was not removed", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const titles = ["משימה א", "משימה ב", "משימה ג", "משימה ד"];
    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "רשמתי." }],
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                items: titles.map((title) => ({ "שם משימה": title })),
              },
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                targets: ["לוסי"],
                items: [{ "שם משימה": "להזכיר לטל לבדוק" }],
              },
            ],
          },
        },
        {
          responses: [{ text: "הנה." }],
          metadata: { lists: [], show_dump: "tasks" },
        },
        {
          responses: [{ text: "הסרתי 4 פריטים." }],
          metadata: {
            lists: [
              {
                action: "remove",
                list_type: "tasks",
                list_name: "",
                items: [1, 2, 3, 4].map((n) => ({
                  mutate_source: "dump_line",
                  dump_line: n,
                })),
              },
            ],
          },
        },
      ]),
    );

    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תוסיפי ארבע משימות",
    });
    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "הצג משימות",
    });
    const dump = await latestNumberedDump(account.userId);
    expect(dump).toHaveLength(titles.length);
    expect(new Set(dump.map((line) => line.title_stem))).toEqual(new Set(titles));
    expect(dump.map((line) => line.n)).toEqual(titles.map((_, index) => index + 1));
    const missed = dump.find((line) => line.n === 2);
    expect(missed?.title_stem).toBeTruthy();
    await prisma.employeeListItem.update({
      where: { id: missed!.id },
      data: { deletedAt: new Date() },
    });

    const removed = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "מחקי 1 עד 4",
    });
    const spoken = parseLlmReply(removed.reply).response;
    expect(spoken).toContain("הסרתי 3 פריטים.");
    expect(spoken).toContain(`לא הוסר: 2. «${missed!.title_stem}».`);
    expect(spoken).not.toContain("הסרתי 4");
    expect(spoken).not.toContain(LIST_FIND_MISS);

    const after = await getEmployeeRecordSnapshot(account.employeeId);
    expect(taskTitles(after)).toEqual([]);
    const rows = await prisma.employeeListItem.findMany({
      where: { id: { in: dump.map((line) => line.id) } },
      select: { id: true, deletedAt: true },
    });
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.deletedAt != null)).toBe(true);
  });
});
