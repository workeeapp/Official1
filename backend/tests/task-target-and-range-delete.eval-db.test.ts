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
import { pushRelayMessage, sendChatMessage } from "../src/services/chat.service.js";
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

  it("a tracking title aimed at the family and Lucy stays only on Lucy", async () => {
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

    expect(await ownedTaskTitles(account.employeeId)).toEqual(["לשתות מים"]);
    expect(await ownedTaskTitles(partner!.id)).toEqual([]);
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
    const partialTip =
      "טיפ-בדיקה: ההסרה החלקית נשארת גם כשמצורף טיפ.";
    await prisma.tip.create({
      data: {
        userId: account.userId,
        key: "partial_delete_tip_pin",
        audience: "member",
        digitalEmployeeId: lucyId,
        triggerKind: "action",
        triggerArea: "lists",
        triggerOp: "remove",
        tier: "basic",
        topic: "tasks",
        listType: "tasks",
        systemSeed: false,
        outputMode: "static",
        maxShows: 5,
        order: 0,
        text: partialTip,
        enabled: true,
      },
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
    expect(spoken).toContain(partialTip);
    expect(spoken.indexOf("הסרתי 3 פריטים.")).toBeLessThan(spoken.indexOf(partialTip));
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

  function idsOf(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  }

  async function persistDualResponsibility(lucyId: string) {
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
      ]),
    );
    await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "תזכירי לי מחר להתקשר לעמיר",
    });
    const speaker = await prisma.employeeListItem.findFirst({
      where: {
        deletedAt: null,
        list: { employeeId: account!.employeeId, listType: "tasks" },
      },
      select: {
        id: true,
        reminderId: true,
        addedById: true,
        visibleTo: true,
        data: true,
      },
    });
    const lucy = await prisma.employeeListItem.findFirst({
      where: {
        deletedAt: null,
        list: { employeeId: lucyId, listType: "tasks" },
      },
      select: {
        id: true,
        reminderId: true,
        addedById: true,
        visibleTo: true,
        data: true,
      },
    });
    const clocks = await prisma.reminder.findMany({
      where: { userId: account!.userId, status: "active" },
      select: { id: true, ownerId: true, workerItemId: true },
    });
    expect(speaker?.id).toBeTruthy();
    expect(lucy?.id).toBeTruthy();
    expect(speaker!.id).not.toBe(lucy!.id);
    expect(idsOf(speaker!.visibleTo)).toEqual([account!.employeeId]);
    expect(idsOf(lucy!.visibleTo)).toEqual([lucyId]);
    expect(speaker!.addedById).toBe(account!.employeeId);
    expect(lucy!.addedById).toBe(account!.employeeId);
    expect(speaker!.reminderId).toBeNull();
    expect(clocks).toHaveLength(1);
    expect(clocks[0]!.ownerId).toBe(account!.employeeId);
    expect(clocks[0]!.workerItemId).toBe(lucy!.id);
    expect(lucy!.reminderId).toBe(clocks[0]!.id);
    const joins = await prisma.employeeListItemReminderLink.findMany({
      where: { reminderId: clocks[0]!.id },
      select: { listItemId: true },
    });
    expect(joins.map((row) => row.listItemId)).toEqual([speaker!.id]);
    return { chore, speaker: speaker!, lucy: lucy!, clockId: clocks[0]!.id };
  }

  async function speakerDumpExcludesLucy(lucyItemId: string, chore: string) {
    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "הנה המשימות." }],
          metadata: { lists: [], show_dump: "tasks" },
        },
      ]),
    );
    const shown = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: (
        await prisma.employee.findFirst({
          where: { userId: account!.userId, kind: "digital", isProtected: true },
          select: { id: true },
        })
      )!.id,
      message: "הצג משימות",
    });
    const spoken = parseLlmReply(shown.reply).response;
    expect(spoken).toContain(chore);
    const dump = await latestNumberedDump(account!.userId);
    expect(dump.some((line) => line.id === lucyItemId)).toBe(false);
    return dump;
  }

  it("cancelling the user reminder deletes Lucy's follow-up and keeps the speaker task", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const { chore, speaker, lucy, clockId } = await persistDualResponsibility(lucyId);

    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "הפסקתי את התזכורת." }],
          metadata: {
            lists: [],
            reminders: [
              {
                action: "remove",
                reminder_id: clockId,
                item: chore,
                list_type: "tasks",
              },
            ],
          },
        },
      ]),
    );
    const cancelled = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תפסיקי את התזכורת",
    });
    expect(parseLlmReply(cancelled.reply).response).toBe("הפסקתי את התזכורת.");

    const clock = await prisma.reminder.findUnique({
      where: { id: clockId },
      select: { status: true, workerItemId: true },
    });
    expect(clock?.status).toBe("cancelled");
    expect(clock?.workerItemId).toBeNull();
    const lucyRow = await prisma.employeeListItem.findUnique({
      where: { id: lucy.id },
      select: { deletedAt: true, reminderId: true },
    });
    expect(lucyRow?.deletedAt).not.toBeNull();
    expect(lucyRow?.reminderId).toBeNull();
    const speakerRow = await prisma.employeeListItem.findUnique({
      where: { id: speaker.id },
      select: { deletedAt: true },
    });
    expect(speakerRow?.deletedAt).toBeNull();
    const joins = await prisma.employeeListItemReminderLink.findMany({
      where: { reminderId: clockId },
    });
    expect(joins).toEqual([]);

    const dump = await speakerDumpExcludesLucy(lucy.id, chore);
    expect(dump.map((line) => line.id)).toEqual([speaker.id]);
  }, 30000);

  it("removing Lucy's follow-up cancels her clock and leaves the speaker task", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const { chore, speaker, lucy, clockId } = await persistDualResponsibility(lucyId);

    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "הסרתי את המשימה שלי." }],
          metadata: {
            lists: [
              {
                action: "remove",
                list_type: "tasks",
                list_name: "",
                targets: ["טל", "לוסי"],
                items: [{ item_id: lucy.id }],
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
      message: "תמחקי את המשימה שלך על זה",
    });

    const lucyRow = await prisma.employeeListItem.findUnique({
      where: { id: lucy.id },
      select: { deletedAt: true, reminderId: true },
    });
    expect(lucyRow?.deletedAt).not.toBeNull();
    expect(lucyRow?.reminderId).toBeNull();
    const clock = await prisma.reminder.findUnique({
      where: { id: clockId },
      select: { status: true, workerItemId: true },
    });
    expect(clock?.status).toBe("cancelled");
    expect(clock?.workerItemId).toBeNull();
    const speakerRow = await prisma.employeeListItem.findUnique({
      where: { id: speaker.id },
      select: { deletedAt: true },
    });
    expect(speakerRow?.deletedAt).toBeNull();

    const dump = await speakerDumpExcludesLucy(lucy.id, chore);
    expect(dump.map((line) => line.id)).toEqual([speaker.id]);
  }, 30000);

  it("a dump-line update still hits that row after an automated message", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const milk = "לקנות חלב";
    const bread = "לקנות לחם";
    const internal = "לבדוק עם טל אם נקנה חלב";
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
                items: [{ "שם משימה": milk }, { "שם משימה": bread }],
              },
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                targets: ["לוסי"],
                items: [{ "שם משימה": internal }],
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
    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תוסיפי לקנות חלב ולקנות לחם",
    });
    const shown = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "הצג משימות",
    });
    expect(parseLlmReply(shown.reply).response).not.toContain(internal);
    const dump = await latestNumberedDump(account.userId);
    expect(dump.map((line) => line.title_stem).sort()).toEqual([bread, milk].sort());
    const breadLine = dump.find((line) => line.title_stem === bread)!;
    const milkLine = dump.find((line) => line.title_stem === milk)!;

    const relay = "עדכון אוטומטי: אין דיווח חדש.";
    const remembered: Array<{ conversationId: string; text: string }> = [];
    setLlmClientForTests({
      async createConversation() {
        return `conv-${randomUUID()}`;
      },
      async createResponse() {
        return { reply: "{}", raw: {} };
      },
      async appendAssistantMessage(conversationId: string, text: string) {
        remembered.push({ conversationId, text });
      },
    });
    await pushRelayMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      speaker: "לוסי",
      text: relay,
    });
    const thread = await prisma.chatConversation.findFirst({
      where: {
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
      },
      select: { id: true, openaiConversationId: true },
    });
    expect(remembered).toEqual([
      { conversationId: thread!.openaiConversationId, text: relay },
    ]);

    const seen: string[] = [];
    setLlmClientForTests({
      async createConversation() {
        return `conv-${randomUUID()}`;
      },
      async createResponse(input: { liveFacts?: string }) {
        seen.push(input.liveFacts ?? "");
        return {
          reply: JSON.stringify({
            responses: [{ text: "עדכנתי את הלחם." }],
            metadata: {
              lists: [
                {
                  action: "update",
                  list_type: "tasks",
                  list_name: "",
                  items: [
                    {
                      mutate_source: "dump_line",
                      dump_line: breadLine.n,
                      "שם משימה": "לקנות לחם מחר",
                    },
                  ],
                },
              ],
            },
          }),
          raw: {},
        };
      },
    });
    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תעדכני את 2 למחר",
    });
    const relayRow = await prisma.chatMessage.findFirst({
      where: {
        author: "assistant",
        text: relay,
        conversation: { userId: account.userId },
      },
      select: { id: true, conversationId: true },
    });
    expect(relayRow?.conversationId).toBe(thread!.id);
    expect(seen[0]).toContain("LAST_NUMBERED_DUMP:");
    expect(seen[0]).toContain(breadLine.id);
    expect(seen[0]).toContain(milkLine.id);
    expect(seen[0]).not.toContain(relay);

    const titles = taskTitles(await getEmployeeRecordSnapshot(account.employeeId));
    expect(titles.sort()).toEqual(["לקנות חלב", "לקנות לחם מחר"].sort());
    const lucyTitles = taskTitles(await getEmployeeRecordSnapshot(lucyId));
    expect(lucyTitles).toEqual([internal]);
    const shownAgain = await (async () => {
      setLlmClientForTests(
        stubLlmQueue([
          {
            responses: [{ text: "הנה המשימות." }],
            metadata: { lists: [], show_dump: "tasks" },
          },
        ]),
      );
      return sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "הצג משימות",
      });
    })();
    const spoken = parseLlmReply(shownAgain.reply).response;
    expect(spoken).toContain("לקנות לחם מחר");
    expect(spoken).toContain(milk);
    expect(spoken).not.toContain(internal);
    const finalDump = await latestNumberedDump(account.userId);
    expect(finalDump.map((line) => line.id).sort()).toEqual(
      [breadLine.id, milkLine.id].sort(),
    );
  }, 30000);
});
