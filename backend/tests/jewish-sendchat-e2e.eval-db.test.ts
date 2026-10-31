/**
 * Real Hebcal Jewish/Shabbat E2E (eval-db, non-destructive).
 * resolveJewishReply + stubbed-LLM sendChatMessage; real HTTP.
 *
 * Run: npm run test:eval-db -w backend -- tests/jewish-sendchat-e2e.eval-db.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { resolveJewishReply } from "../src/services/jewish.js";
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

const PLACE = "תל אביב";

describe("Jewish sendChat E2E (eval-db, real Hebcal)", () => {
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

  it("resolver + sendChat: candle lighting via real Hebcal", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const probe = installRealFetchHostProbe([
      "www.hebcal.com",
      "hebcal.com",
      "geocoding-api.open-meteo.com",
    ]);

    const { text: serviceText } = await resolveJewishReply({
      place: PLACE,
      date: "",
      aspects: ["candles"],
    });

    expect(
      probe.probes.some(
        (p) => p.host.includes("hebcal.com") || p.host.includes("open-meteo"),
      ),
    ).toBe(true);
    expect(serviceText).toMatch(/הדלקת נרות|נרות/);
    expect(serviceText).toMatch(/\d{1,2}:\d{2}/);
    expect(serviceText).not.toMatch(/לא הצלחתי לבדוק|באיזה יישוב/);

    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account, "You answer Shabbat times in Hebrew.");
    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת זמני שבת.", buttons: [] }],
        metadata: {
          jewish: {
            place: PLACE,
            date: "",
            aspects: ["candles"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "מתי מדליקים נרות בתל אביב?",
    });

    expect(whatsappTextSpy).not.toHaveBeenCalled();
    expect(fireDueSpy).not.toHaveBeenCalled();
    expect(scheduleSoonSpy).not.toHaveBeenCalled();

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/נרות|בודקת/);
    expect(spoken).toMatch(/\d{1,2}:\d{2}/);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
    probe.restore();
  }, 30_000);
});
