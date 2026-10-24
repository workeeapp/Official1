/**
 * Real Yahoo Finance market E2E (eval-db, non-destructive).
 * resolveMarketReply + stubbed-LLM sendChatMessage; real HTTP.
 *
 * Run: npm run test:eval-db -w backend -- tests/market-sendchat-e2e.eval-db.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { resolveMarketReply } from "../src/services/market.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  installRealFetchHostProbe,
  stubLlmReply,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

describe("Market sendChat E2E (eval-db, real Yahoo Finance)", () => {
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
    vi.unstubAllGlobals();
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

  it("resolver + sendChat: AAPL quote via real Yahoo", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const probe = installRealFetchHostProbe([
      "query1.finance.yahoo.com",
      "query2.finance.yahoo.com",
    ]);

    const serviceText = await resolveMarketReply({
      queries: ["AAPL"],
      aspects: ["summary", "price"],
    });

    expect(probe.probes.some((p) => p.host.includes("yahoo.com"))).toBe(true);
    expect(serviceText).toMatch(/AAPL|Apple/i);
    expect(serviceText).toMatch(/\d/);
    expect(serviceText).not.toMatch(/לא הצלחתי לשלוף|לאיזה מניה/);
    // Disclaimer is part of product format
    expect(serviceText.length).toBeGreaterThan(20);

    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account, "You answer market quotes in Hebrew.");
    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת מחיר.", buttons: [] }],
        metadata: {
          market: {
            queries: ["AAPL"],
            aspects: ["summary", "price"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "מה מחיר אפל?",
    });

    expect(whatsappTextSpy).not.toHaveBeenCalled();
    expect(fireDueSpy).not.toHaveBeenCalled();
    expect(scheduleSoonSpy).not.toHaveBeenCalled();

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/AAPL|Apple|בודקת/i);
    expect(spoken).toMatch(/\d/);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
    probe.restore();
  }, 30_000);
});
