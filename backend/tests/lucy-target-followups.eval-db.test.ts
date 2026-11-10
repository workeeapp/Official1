/**
 * Lucy targeting follow-ups: update/remove of a tracking title stays on Lucy,
 * a shopping add that names Lucy is two personal rows, and a named custom list
 * is not a share with Lucy.
 *
 * Real path: sendChatMessage + persisted rows on workee_test. Stubbed model.
 *
 * Run: npm run test:eval-db -- tests/lucy-target-followups.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/database/prisma.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

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

function silenceOutbound() {
  vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
  vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
  vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
  vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);
}

function idsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
}

describe("Lucy targeting follow-ups persist on the right books", () => {
  let account: HarnessAccount | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  it("a shopping add that names the speaker and Lucy is saved on both personal books", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "הוספתי חלב." }],
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "shopping",
                list_name: "",
                targets: ["טל", "לוסי"],
                items: [{ "שם פריט": "חלב" }],
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
      message: "תוסיפי חלב לקניות שלי ושל לוסי",
    });

    const rows = await prisma.employeeListItem.findMany({
      where: {
        deletedAt: null,
        list: { listType: "shopping", deletedAt: null, employee: { userId: account.userId } },
      },
      select: {
        data: true,
        visibleTo: true,
        list: { select: { employeeId: true, scope: true, visibleTo: true } },
      },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.data).toMatchObject({ "שם פריט": "חלב" });
      expect(row.list.scope).toBe("personal");
      expect(idsOf(row.list.visibleTo)).not.toContain(
        row.list.employeeId === account.employeeId ? lucyId : account.employeeId,
      );
      expect(idsOf(row.visibleTo)).toEqual([row.list.employeeId]);
    }
    expect(rows.map((row) => row.list.employeeId).sort()).toEqual(
      [account.employeeId, lucyId].sort(),
    );
  }, 30000);

  it("a named custom list that names Lucy is not shared with her", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "רשמתי." }],
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "custom",
                list_name: "מה מביאים",
                targets: ["טל", "לוסי"],
                items: [{ פריט: "שתייה" }],
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
      message: "תוסיפי שתייה לרשימה מה מביאים שלי ושל לוסי",
    });

    const lists = await prisma.employeeList.findMany({
      where: {
        name: "מה מביאים",
        deletedAt: null,
        employee: { userId: account.userId },
      },
      select: {
        employeeId: true,
        scope: true,
        visibleTo: true,
        items: { where: { deletedAt: null }, select: { visibleTo: true, data: true } },
      },
    });
    expect(lists.map((row) => row.employeeId).sort()).toEqual(
      [account.employeeId, lucyId].sort(),
    );
    for (const list of lists) {
      const other = list.employeeId === account.employeeId ? lucyId : account.employeeId;
      expect(list.scope).toBe("personal");
      expect(idsOf(list.visibleTo)).not.toContain(other);
      expect(list.items).toHaveLength(1);
      expect(idsOf(list.items[0]?.visibleTo)).toEqual([list.employeeId]);
      expect(idsOf(list.items[0]?.visibleTo)).not.toContain(other);
    }
  }, 30000);

  it("updating and removing Lucy's tracking task does not write it on the speaker", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    silenceOutbound();
    const tracking = "להזכיר לטל לקנות חלב";
    const renamed = "להזכיר לטל לקנות חלב מחר";
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
                targets: ["לוסי"],
                items: [{ "שם משימה": tracking }],
              },
            ],
          },
        },
        {
          responses: [{ text: "עדכנתי." }],
          metadata: { lists: [] },
        },
        {
          responses: [{ text: "הסרתי." }],
          metadata: { lists: [] },
        },
      ]),
    );

    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "לוסי, תזכירי לי לקנות חלב",
    });
    const created = await prisma.employeeListItem.findFirst({
      where: {
        deletedAt: null,
        list: { employeeId: lucyId, listType: "tasks" },
      },
      select: { id: true },
    });
    expect(created?.id).toBeTruthy();

    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "עדכנתי." }],
          metadata: {
            lists: [
              {
                action: "update",
                list_type: "tasks",
                list_name: "",
                targets: ["טל", "לוסי"],
                items: [{ item_id: created!.id, "שם משימה": renamed }],
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
      message: "תעדכני את המשימה של לוסי",
    });

    const speakerAfterUpdate = await prisma.employeeListItem.findMany({
      where: {
        deletedAt: null,
        list: { employeeId: account.employeeId, listType: "tasks" },
      },
      select: { id: true },
    });
    expect(speakerAfterUpdate).toEqual([]);
    const lucyAfterUpdate = await prisma.employeeListItem.findMany({
      where: {
        deletedAt: null,
        list: { employeeId: lucyId, listType: "tasks" },
      },
      select: { id: true, data: true },
    });
    expect(lucyAfterUpdate).toHaveLength(1);
    expect(lucyAfterUpdate[0]?.id).toBe(created!.id);
    expect(lucyAfterUpdate[0]?.data).toMatchObject({ "שם משימה": renamed });

    setLlmClientForTests(
      stubLlmQueue([
        {
          responses: [{ text: "הסרתי." }],
          metadata: {
            lists: [
              {
                action: "remove",
                list_type: "tasks",
                list_name: "",
                targets: ["טל", "לוסי"],
                items: [{ item_id: created!.id }],
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
      message: "תמחקי את המשימה של לוסי",
    });

    const speakerAfterRemove = await prisma.employeeListItem.findMany({
      where: {
        deletedAt: null,
        list: { employeeId: account.employeeId, listType: "tasks" },
      },
      select: { id: true },
    });
    expect(speakerAfterRemove).toEqual([]);
    const lucyRow = await prisma.employeeListItem.findUnique({
      where: { id: created!.id },
      select: { deletedAt: true },
    });
    expect(lucyRow?.deletedAt).not.toBeNull();
  }, 30000);
});
