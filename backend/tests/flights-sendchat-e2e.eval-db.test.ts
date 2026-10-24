/**
 * Real AviationStack flights E2E (eval-db, non-destructive).
 * resolveFlightsReply + stubbed-LLM sendChatMessage; real HTTP.
 * Skips when AVIATIONSTACK_ACCESS_KEY is absent from product .env.
 *
 * Run: npm run test:eval-db -w backend -- tests/flights-sendchat-e2e.eval-db.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { resolveFlightsReply } from "../src/services/flights.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  injectProductEnvKey,
  installRealFetchHostProbe,
  stubLlmReply,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

describe("Flights sendChat E2E (eval-db, real AviationStack)", () => {
  let account: HarnessAccount | null = null;
  let whatsappTextSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fireDueSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scheduleSoonSpy: ReturnType<typeof vi.spyOn> | null = null;
  let keyPresent = false;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
    const injected = injectProductEnvKey("AVIATIONSTACK_ACCESS_KEY");
    keyPresent = injected.present;
    // Do not print key; length-only signal is enough for operators.
    expect(
      injected.len,
      "AVIATIONSTACK_ACCESS_KEY should be set in repo .env for this suite",
    ).toBeGreaterThan(0);
  });

  beforeEach(async () => {
    await assertEvalDbAndGtfsUntouched();
    if (!keyPresent) {
      injectProductEnvKey("AVIATIONSTACK_ACCESS_KEY");
    }
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

  it("resolver + sendChat: TLV arrivals board via real AviationStack", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const probe = installRealFetchHostProbe(["api.aviationstack.com"]);

    const serviceText = await resolveFlightsReply({
      airport: "TLV",
      direction: "arrivals",
      aspects: ["board"],
      withinMinutes: 180,
      requireLiveSelect: false,
    });

    expect(probe.probes.some((p) => p.host === "api.aviationstack.com")).toBe(
      true,
    );
    // Free tier / empty window may yield empty board — still must not be key-missing.
    expect(serviceText).not.toMatch(/חסר מפתח API/);
    expect(serviceText.length).toBeGreaterThan(10);
    const okContent =
      /נחיתות|טיסות|אין/.test(serviceText) ||
      /TLV|נתב/.test(serviceText);
    expect(okContent).toBe(true);

    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account, "You answer flights in Hebrew.");
    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת לוח טיסות.", buttons: [] }],
        metadata: {
          flights: {
            airport: "TLV",
            direction: "arrivals",
            within_minutes: 180,
            aspects: ["board"],
            require_live_select: false,
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "איזה טיסות נוחתות בנתב״ג בשעתיים הקרובות?",
    });

    expect(whatsappTextSpy).not.toHaveBeenCalled();
    expect(fireDueSpy).not.toHaveBeenCalled();
    expect(scheduleSoonSpy).not.toHaveBeenCalled();

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).not.toMatch(/חסר מפתח API/);
    expect(spoken.length).toBeGreaterThan(10);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
    probe.restore();
  }, 60_000);
});
