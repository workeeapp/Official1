/**
 * Self-nudge after a shopping LAST_NUMBERED_DUMP: speaker tasks add must apply.
 *
 * Stubbed LLM + production sendChatMessage. Proves dump guard no longer drops
 * builtin tasks adds, and the speaker book gains the task.
 *
 * Run: npm run test:eval-db -- tests/self-nudge-after-shopping-dump.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addJerusalemDays, emptyLlmMetadata, parseLlmReply } from "@workee/shared";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import {
  applyEmployeeRecords,
  getEmployeeRecordSnapshot,
} from "../src/services/employee-records.service.js";
import { formatJerusalemDateTime } from "../src/services/reminder.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const ZIP_TASK = "להוסיף קבצי זיפ לאוטומציה בשביל ניר-eval";
const SHOP_ITEM = "חלב-eval-dump";

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

describe("self-nudge after shopping dump (eval-db, stubbed LLM)", () => {
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

  it("shopping dump then self-nudge → speaker task + reminder; dual claim kept", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
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
            listType: "shopping",
            listName: "",
            targets: [],
            items: [{ "שם פריט": SHOP_ITEM, כמות: "1" }],
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

    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");

    setLlmClientForTests(
      stubLlmQueue([
        // 1) Shopping dump → LAST_NUMBERED_DUMP = shopping.
        {
          responses: [{ text: "הנה הקניות." }],
          metadata: {
            lists: [],
            show_dump: "shopping",
          },
        },
        // 2) Self-nudge NEW task: nested items[].remind + worker להזכיר (no top-level duplicate; no mint UUID).
        {
          responses: [
            {
              text: `הוספתי את המטלה ${ZIP_TASK}. קבעתי תזכורת למחר ב־10:00: תזכורת: ${ZIP_TASK}.`,
            },
          ],
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                items: [
                  {
                    "שם מטלה": ZIP_TASK,
                    "תאריך לביצוע": tomorrow,
                    remind: {
                      date: tomorrow,
                      time: "10:00",
                      ping: ["טל"],
                      text: ZIP_TASK,
                    },
                  },
                ],
                targets: [],
              },
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                items: [{ "שם מטלה": `להזכיר לטל: ${ZIP_TASK}` }],
                targets: ["לוסי"],
              },
            ],
          },
        },
      ]),
    );

    const dump = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "הצג קניות",
    });
    expect(parseLlmReply(dump.reply).response).toContain(SHOP_ITEM);

    const nudge = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: `תזכירי לי מחר ב־10:00 ${ZIP_TASK}`,
    });
    const spoken = parseLlmReply(nudge.reply).response;
    expect(spoken).toContain("הוספתי");
    expect(spoken).toMatch(/תזכורת/);
    // Must not be rewritten to reminder-only partial.
    expect(spoken).not.toContain("לא הצלחתי להוסיף את המטלה");

    expect(whatsappTextSpy).not.toHaveBeenCalled();
    expect(fireDueSpy).not.toHaveBeenCalled();
    // scheduleSoon may arm the new clock — that is expected after reminder apply.

    const after = await getEmployeeRecordSnapshot(account.employeeId);
    expect(tasksTitles(after)).toContain(ZIP_TASK);

    // Nested remind must create a linked clock (not orphan / exact-key-only).
    const clocks = after.reminders ?? [];
    expect(clocks.length).toBeGreaterThanOrEqual(1);
    const zipClock = clocks.find(
      (r) =>
        String(r.item ?? r.text ?? "").includes("קבצי זיפ") ||
        String(r.item ?? r.text ?? "").includes(ZIP_TASK.slice(0, 12)),
    );
    expect(zipClock, "expected nested clock for ZIP task").toBeTruthy();
    const zipTask = after.lists
      .flatMap((l) => (l.list_type === "tasks" ? l.items : []))
      .find((it) => String(it["שם מטלה"] ?? it.title ?? "") === ZIP_TASK);
    expect(zipTask?.item_id, "speaker task id").toBeTruthy();
    const linked =
      String(zipTask?.reminder_id ?? "") === String(zipClock?.reminder_id ?? "") ||
      String(zipClock?.item_id ?? "") === String(zipTask?.item_id ?? "") ||
      (Array.isArray(zipTask?.reminder_ids) &&
        zipTask!.reminder_ids.includes(String(zipClock?.reminder_id ?? "")));
    expect(linked, "clock must soft-link to speaker task via nested remind").toBe(
      true,
    );
  });
});
