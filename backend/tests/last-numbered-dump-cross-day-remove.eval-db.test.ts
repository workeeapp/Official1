/**
 * LAST_NUMBERED_DUMP: today agenda → tomorrow agenda → complete a today ESD task.
 *
 * Proves the same-domain shopping|tasks guard lets lists.remove of a live ESD
 * id that is outside the current date-filtered dump map (no LIST_FIND_MISS).
 *
 * Stubbed LLM only. Run:
 *   npm run test:eval-db -- tests/last-numbered-dump-cross-day-remove.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addJerusalemDays, emptyLlmMetadata, parseLlmReply } from "@workee/shared";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import {
  applyEmployeeRecords,
  getEmployeeRecordSnapshot,
  LIST_FIND_MISS,
} from "../src/services/employee-records.service.js";
import { formatJerusalemDateTime } from "../src/services/reminder.service.js";
import { jerusalemYmd } from "../src/utils/relative-date.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const YES_TASK = "לדבר עם yes-eval-dump";
const TOMORROW_TASK = "לקנות חלב-eval-dump";

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

function taskItemId(
  snapshot: Awaited<ReturnType<typeof getEmployeeRecordSnapshot>>,
  needle: string,
): string {
  for (const list of snapshot.lists) {
    if (list.list_type !== "tasks") continue;
    for (const item of list.items) {
      if (!JSON.stringify(item).includes(needle)) continue;
      for (const key of ["item_id", "itemId", "id"] as const) {
        const raw = item[key];
        if (typeof raw === "string" && raw.trim()) return raw.trim();
      }
    }
  }
  throw new Error(`expected tasks item containing ${needle}`);
}

function tasksTitles(
  snapshot: Awaited<ReturnType<typeof getEmployeeRecordSnapshot>>,
): string[] {
  const out: string[] = [];
  for (const list of snapshot.lists) {
    if (list.list_type !== "tasks") continue;
    for (const item of list.items) {
      const title =
        (typeof item["שם מטלה"] === "string" && item["שם מטלה"]) ||
        (typeof item.title === "string" && item.title) ||
        "";
      if (title) out.push(title);
    }
  }
  return out;
}

describe("LAST_NUMBERED_DUMP cross-day ESD remove (eval-db, stubbed LLM)", () => {
  let account: HarnessAccount | null = null;
  let whatsappTextSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fireDueSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scheduleSoonSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  beforeEach(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  afterEach(async () => {
    setLlmClientForTests(null);
    whatsappTextSpy?.mockRestore();
    fireDueSpy?.mockRestore();
    scheduleSoonSpy?.mockRestore();
    whatsappTextSpy = null;
    fireDueSpy = null;
    scheduleSoonSpy = null;
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  it("today dump → tomorrow dump → דיברתי עם yes removes ESD row (no LIST_FIND_MISS)", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    const today = jerusalemYmd();
    const tomorrow = formatJerusalemDateTime(addJerusalemDays(new Date(), 1)).slice(
      0,
      10,
    );

    await applyEmployeeRecords(
      account.employeeId,
      {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            targets: [],
            items: [
              {
                "שם מטלה": YES_TASK,
                "תאריך לביצוע": today,
              },
              {
                "שם מטלה": TOMORROW_TASK,
                "תאריך לביצוע": tomorrow,
              },
            ],
          },
        ],
      },
      {
        scope: "personal",
        addedById: account.employeeId,
        visibleTo: [account.employeeId],
      },
      account.employeeId,
    );

    const seeded = await getEmployeeRecordSnapshot(account.employeeId);
    const yesId = taskItemId(seeded, YES_TASK);
    expect(tasksTitles(seeded)).toEqual(
      expect.arrayContaining([YES_TASK, TOMORROW_TASK]),
    );

    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");

    setLlmClientForTests(
      stubLlmQueue([
        // 1) Show today's tasks → LAST_NUMBERED_DUMP = today (includes yes).
        {
          responses: [{ text: "הנה להיום." }],
          metadata: {
            lists: [],
            show_dump: "tasks",
            show_dump_from: today,
            show_dump_to: today,
          },
        },
        // 2) Show tomorrow → replaces LAST_NUMBERED_DUMP (yes id not in map).
        {
          responses: [{ text: "הנה למחר." }],
          metadata: {
            lists: [],
            show_dump: "tasks",
            show_dump_from: tomorrow,
            show_dump_to: tomorrow,
          },
        },
        // 3) Model resolves «דיברתי עם yes» from live ESD (not dump line n).
        {
          responses: [{ text: "סימנתי שדיברת עם yes." }],
          metadata: {
            lists: [
              {
                action: "remove",
                list_type: "tasks",
                list_name: "",
                items: [{ item_id: yesId, "שם מטלה": YES_TASK }],
                targets: [],
              },
            ],
          },
        },
      ]),
    );

    const todayDump = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "מה יש לי היום",
    });
    const todaySpoken = parseLlmReply(todayDump.reply).response;
    expect(todaySpoken).toContain(YES_TASK);
    expect(todaySpoken).not.toContain(TOMORROW_TASK);

    const tomorrowDump = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "ומחר?",
    });
    const tomorrowSpoken = parseLlmReply(tomorrowDump.reply).response;
    expect(tomorrowSpoken).toContain(TOMORROW_TASK);
    expect(tomorrowSpoken).not.toContain(YES_TASK);

    const done = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "דיברתי עם yes",
    });
    const doneSpoken = parseLlmReply(done.reply).response;
    expect(doneSpoken).not.toBe(LIST_FIND_MISS);
    expect(doneSpoken).not.toContain(LIST_FIND_MISS);
    expect(doneSpoken).toContain("yes");

    expect(whatsappTextSpy).not.toHaveBeenCalled();
    expect(fireDueSpy).not.toHaveBeenCalled();
    expect(scheduleSoonSpy).not.toHaveBeenCalled();

    const after = await getEmployeeRecordSnapshot(account.employeeId);
    const titles = tasksTitles(after);
    expect(titles).not.toContain(YES_TASK);
    expect(titles).toContain(TOMORROW_TASK);
  });
});
