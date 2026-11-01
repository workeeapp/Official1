/**
 * QA F fix — mutate+show_dump: strip model-invented inventory; keep confirm.
 * Eval-db + stub LLM; no real WhatsApp.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
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
  stubLlmReply,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

describe("show_dump confirm sanitize (eval-db sendChat)", () => {
  let account: HarnessAccount | null = null;
  let lucyId = "";

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  beforeEach(async () => {
    await assertEvalDbAndGtfsUntouched();
    account = await createHarnessAccount("טל");
    lucyId = await ensureLucy(account, "You answer in Hebrew.");
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue({
      ok: true as const,
      messageId: "qa-f",
    });
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(undefined);
    vi.spyOn(reminderFire, "scheduleSoon").mockReturnValue(undefined as never);
  });

  afterEach(async () => {
    setLlmClientForTests(null);
    vi.restoreAllMocks();
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  it("QA F: single invented numbered line stripped; engine dump + confirm kept", async () => {
    const marker = `לחם-QAF-${Date.now()}`;
    setLlmClientForTests(
      stubLlmReply({
        responses: [
          {
            text: `הוספתי ${marker}. הנה הרשימה המלאה שהמצאתי: 1. פריט-בדוי-xyz`,
            buttons: [],
          },
        ],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              list_name: "",
              items: [{ "שם פריט": marker }],
              targets: [],
            },
          ],
          show_dump: "shopping",
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: `תוסיפי ${marker} ותראי קניות`,
    });
    const spoken = parseLlmReply(result.reply).response;
    const snap = await getEmployeeRecordSnapshot(account!.employeeId);
    const blob = JSON.stringify(snap.lists ?? []);
    expect(blob).toContain(marker);
    expect(spoken).toMatch(/🛒|קניות:/);
    expect(spoken).toContain(marker);
    expect(spoken).toMatch(/הוספתי/);
    expect(spoken).not.toContain("פריט-בדוי-xyz");
    expect(spoken).not.toContain("שהמצאתי");
  }, 60_000);

  it("7. failed mutation still Stage-2B full replace (no invented leftover)", async () => {
    setLlmClientForTests(
      stubLlmReply({
        responses: [
          { text: "מחקתי את החלב.", buttons: [] },
          { text: "בועה שנייה", buttons: [] },
        ],
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "shopping",
              list_name: "",
              items: [{ item_id: "00000000-0000-4000-8000-000000000066" }],
              targets: [],
            },
          ],
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "תמחק פריט חסר",
    });
    const bubbles = parseLlmReply(result.reply).responses;
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toBe(LIST_FIND_MISS);
    expect(bubbles[0]).not.toContain("בועה שנייה");
  }, 60_000);

  it("8. Stage 2A empty responses + successful add still recovers", async () => {
    const marker = `ביצה-QAF-I-${Date.now()}`;
    setLlmClientForTests(
      stubLlmReply({
        responses: [],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              list_name: "",
              items: [{ "שם פריט": marker }],
              targets: [],
            },
          ],
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: `תוסיפי ${marker}`,
    });
    const spoken = parseLlmReply(result.reply).response.trim();
    expect(spoken.length).toBeGreaterThan(0);
    const snap = await getEmployeeRecordSnapshot(account!.employeeId);
    expect(JSON.stringify(snap.lists ?? [])).toContain(marker);
  }, 60_000);
});
