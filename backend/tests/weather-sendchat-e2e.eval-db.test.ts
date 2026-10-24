/**
 * Real Open-Meteo weather E2E (eval-db, non-destructive).
 * resolveWeatherReply + stubbed-LLM sendChatMessage; real HTTP.
 *
 * Run: npm run test:eval-db -w backend -- tests/weather-sendchat-e2e.eval-db.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { resolveWeatherReply } from "../src/services/weather.js";
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

describe("Weather sendChat E2E (eval-db, real Open-Meteo)", () => {
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

  it("resolver + sendChat: Tel Aviv weather via real Open-Meteo", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const probe = installRealFetchHostProbe([
      "geocoding-api.open-meteo.com",
      "api.open-meteo.com",
      "marine-api.open-meteo.com",
    ]);

    const serviceText = await resolveWeatherReply({
      place: PLACE,
      date: "",
      aspects: ["summary", "temp"],
    });

    expect(probe.probes.some((p) => p.host.includes("open-meteo.com"))).toBe(
      true,
    );
    expect(serviceText).toMatch(/מזג האוויר|טמפרטורה/);
    expect(serviceText).toMatch(/תל אביב|Tel Aviv/i);
    expect(serviceText).toMatch(/\d/);
    expect(serviceText).not.toMatch(/לא הצלחתי|לא מצאתי נתוני מזג/);

    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account, "You answer weather in Hebrew.");
    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת מזג אוויר.", buttons: [] }],
        metadata: {
          weather: {
            place: PLACE,
            date: "",
            aspects: ["summary", "temp"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "מה מזג האוויר בתל אביב?",
    });

    expect(whatsappTextSpy).not.toHaveBeenCalled();
    expect(fireDueSpy).not.toHaveBeenCalled();
    expect(scheduleSoonSpy).not.toHaveBeenCalled();

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/מזג האוויר|טמפרטורה|°C|בודקת/);
    expect(spoken).toMatch(/\d/);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
    probe.restore();
  }, 30_000);
});
