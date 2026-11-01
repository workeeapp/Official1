/**
 * QA E — ApplyResult completeness=unknown through full sendChatMessage (eval-db).
 *
 * Filing remove of a non-existent id has no apply/miss channel → domain
 * completeness stays unknown (same production path as offline Result-B unknown).
 * Stub LLM; no real WhatsApp.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import * as applyResultReply from "../src/services/apply-result-reply.js";
import {
  APPLY_RESULT_UNKNOWN_CAUTION,
  decideReplyFromApplyResult,
} from "../src/services/apply-result-reply.js";
import type { ApplyResult } from "../src/services/apply-result.js";
import { LIST_FIND_MISS } from "../src/services/employee-records.service.js";
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

describe("QA E — unknown ApplyResult via sendChatMessage", () => {
  let account: HarnessAccount | null = null;
  let lucyId = "";
  let lastApply: ApplyResult | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  beforeEach(async () => {
    await assertEvalDbAndGtfsUntouched();
    account = await createHarnessAccount("טל");
    lucyId = await ensureLucy(account, "You answer in Hebrew.");
    lastApply = null;
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue({
      ok: true as const,
      messageId: "qa-e",
    });
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(undefined);
    vi.spyOn(reminderFire, "scheduleSoon").mockReturnValue(undefined as never);
    const original = decideReplyFromApplyResult;
    vi.spyOn(applyResultReply, "decideReplyFromApplyResult").mockImplementation(
      (input) => {
        lastApply = input.applyResult;
        return original(input);
      },
    );
  });

  afterEach(async () => {
    setLlmClientForTests(null);
    vi.restoreAllMocks();
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  it("optimistic success + missing filing → unknown; wholesale replace", async () => {
    const fakeFilingId = "00000000-0000-4000-8000-0000000000e1";
    setLlmClientForTests(
      stubLlmReply({
        responses: [
          { text: "מחקתי את התיוק.", buttons: [] },
          { text: "בועה נוספת שלא אמורה לשרוד.", buttons: [] },
        ],
        metadata: {
          filing: [
            {
              action: "remove_filing",
              filing_id: fakeFilingId,
              item_name: "",
              item_info: "",
              item_description: "",
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
      message: "תמחק את התיוק שלא קיים",
    });

    expect(lastApply).not.toBeNull();
    expect(lastApply!.completeness).toBe("unknown");
    expect(lastApply!.domains.filing?.applied ?? []).toHaveLength(0);

    const bubbles = parseLlmReply(result.reply).responses.map(String);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toBe(APPLY_RESULT_UNKNOWN_CAUTION);
    expect(bubbles[0]).not.toContain("מחקתי");
    expect(bubbles.join("\n")).not.toContain("בועה נוספת");
    expect(bubbles[0]).not.toMatch(/הצלחתי למחוק|נמחק בהצלחה/);
  }, 60_000);

  it("control: ordinary miss still LIST_FIND_MISS (unknown path did not leak)", async () => {
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "מחקתי את החלב.", buttons: [] }],
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "shopping",
              list_name: "",
              items: [{ item_id: "00000000-0000-4000-8000-0000000000c1" }],
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
      message: "תמחק חלב חסר",
    });
    expect(lastApply?.completeness).toBe("complete");
    expect(parseLlmReply(result.reply).responses).toEqual([LIST_FIND_MISS]);
  }, 60_000);
});
